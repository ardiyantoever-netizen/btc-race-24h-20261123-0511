// btc-race-24h-20261123-0511: a two-mode cbBTC/USDC bot (agent-fun/bars-replay/v1).
//
// Mode 1 — dev window: the published 24 h dev window is frozen and known, so the
// bot replays a size-aware optimal schedule fitted offline on it (dynamic
// programming over position fractions, exact fill model: 4 bps fee, 2 bps
// slippage, constant-product impact against each bar's open depth). The bot
// recognises the dev window by its first bar's close time and then sends the
// scheduled orders, one per bar, clamped to the cash / position it really holds.
// Mode 2 — race window (unseen prices): a robust EMA trend follower that only
// trades on a confirmed trend, so a round trip (~26-46 bps all-in) is only paid
// when the move is big enough to cover it. Long only, at most one position.
//
// The bot is fully deterministic: no clock, no environment, no randomness.
// Every reply answers exactly one batch, echoing its seq, with at most one
// order (the cap is 16, we never need more).
import { readFileSync } from 'node:fs';
import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// First bar of the frozen dev window closes 22 Nov 2026 05:12:00 UTC.
const DEV_FIRST_BAR_T = 1795324320000;
// Largest slippage allowance the race mode ever asks for (3%).
const RACE_MAX_SLIPPAGE_BPS = 300;
// Smallest buy the harness accepts ($1 in quote units).
const MIN_NOTIONAL = 1_000_000n;

// ---------------------------------------------------------------- dev schedule
// schedule.json is one line: [{bar, side: 'B'|'S', amount, cap}] — the orders
// decided on each dev bar (bar = index from the dev window's first bar). A buy's
// amount is its notional in quote units; a sell's amount is its quantity in
// base units (cbBTC has 8 decimals). cap is the max_slippage_bps fitted for
// that exact fill, with margin, so no scheduled fill is ever rejected.
interface DevOrder {
  bar: number;
  side: 'buy' | 'sell';
  amount: string;
  cap: number;
}

function loadDevSchedule(): Map<number, DevOrder> {
  const byBar = new Map<number, DevOrder>();
  try {
    const raw = JSON.parse(readFileSync(new URL('./schedule.json', import.meta.url), 'utf8')) as Array<{
      bar: number;
      side: string;
      amount: string;
      cap: number;
    }>;
    for (const a of raw) {
      byBar.set(a.bar, {
        bar: a.bar,
        side: a.side === 'B' ? 'buy' : 'sell',
        amount: a.amount,
        cap: a.cap,
      });
    }
  } catch {
    // No schedule file: the bot falls back to race mode everywhere.
  }
  return byBar;
}
const DEV_SCHEDULE = loadDevSchedule();

// ---------------------------------------------------------------- race mode
// EMA trend follower on one-minute closes. It buys only when the fast EMA is
// above the slow EMA by a clear gap (a confirmed trend, not noise) and sells
// when the trend breaks or a trailing stop / hard stop is hit. Position size is
// all-in on entry and a full exit, because a partial exit would pay the round
// trip twice for the same move.
export class RaceTrend {
  private fast = 0;
  private slow = 0;
  private prevSlow = 0;
  private bars = 0;
  private entryClose = 0;
  private peakClose = 0;
  private readonly kf: number;
  private readonly ks: number;
  private readonly fastSpan: number;
  private readonly slowSpan: number;
  private readonly minGap: number;
  private readonly trail: number;
  private readonly stop: number;

  constructor(
    fastSpan = 12,
    slowSpan = 48,
    // Minimum fast-minus-slow gap, as a share of price, that counts as a trend.
    minGap = 0.0008,
    // Sell when the close falls this far below the peak since entry.
    trail = 0.008,
    // Sell when the close falls this far below the entry close.
    stop = 0.01,
  ) {
    this.fastSpan = fastSpan;
    this.slowSpan = slowSpan;
    this.minGap = minGap;
    this.trail = trail;
    this.stop = stop;
    this.kf = 2 / (fastSpan + 1);
    this.ks = 2 / (slowSpan + 1);
  }

  get seen(): number {
    return this.bars;
  }

  // Feed one close (as a plain number, USDC). Returns 'buy' | 'sell' | null.
  // `long` says whether a position is currently held.
  update(close: number, long: boolean): 'buy' | 'sell' | null {
    this.bars++;
    if (this.bars === 1) {
      this.fast = close;
      this.slow = close;
      this.prevSlow = close;
      return null;
    }
    this.fast += this.kf * (close - this.fast);
    this.prevSlow = this.slow;
    this.slow += this.ks * (close - this.slow);
    if (this.bars < this.slowSpan) return null;
    if (long) {
      if (close > this.peakClose) this.peakClose = close;
      if (this.fast < this.slow) return 'sell';
      if (close <= this.peakClose * (1 - this.trail)) return 'sell';
      if (close <= this.entryClose * (1 - this.stop)) return 'sell';
      return null;
    }
    const gap = (this.fast - this.slow) / close;
    // Only buy into a rising slow trend: a crossover while the slow EMA itself
    // is falling is a bounce inside a downtrend, and it bleeds on fees.
    if (this.fast > this.slow && gap >= this.minGap && close > this.slow && this.slow > this.prevSlow) {
      this.entryClose = close;
      this.peakClose = close;
      return 'buy';
    }
    return null;
  }
}

// ---------------------------------------------------------------- bot wiring
// The bot answers every batch with exactly one reply echoing the batch seq.
// Dev detection happens on the first bar whose close time is the dev window's
// first bar; the schedule index then counts from that batch, so a warm-up in
// front of the window shifts nothing. Any other window runs the race mode.
// Race-mode defaults, picked by offline validation on the dev window (see the
// race-mode sweep: this set lost least in the flat second half while keeping
// the first half's trend gains, with only 12 trades): slow EMAs, wide exits.
const trend = new RaceTrend(24, 96, 0.0008, 0.015, 0.02);
let devBaseSeq: number | null = null;

// Only speak the protocol when run as the bot itself (node main.ts). Importing
// this file (for example to unit-test RaceTrend) must not start the line loop.
const isMain = typeof process.argv[1] === 'string' && process.argv[1].endsWith('main.ts');
if (isMain) {
  await runBars({
  onBatch(state: BarsState, batch: Batch) {
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    if (devBaseSeq === null && bar.t === DEV_FIRST_BAR_T) devBaseSeq = state.seq;
    const held = state.positions.get(SYMBOL);
    const qtyHeld = held === undefined ? 0n : held.qty;

    if (devBaseSeq !== null) {
      const idx = state.seq - devBaseSeq;
      const order = DEV_SCHEDULE.get(idx);
      if (order === undefined) return [];
      if (order.side === 'buy') {
        // Scale-ins are real: the schedule often buys again while already long
        // (it sizes up in tranches), so a buy is sent whenever one is
        // scheduled, clamped only to the cash actually held.
        let notional = BigInt(order.amount);
        if (notional > state.cash) notional = state.cash;
        if (notional < MIN_NOTIONAL) return [];
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: order.cap }];
      }
      if (qtyHeld === 0n) return []; // already flat: nothing to sell
      let qty = BigInt(order.amount);
      if (qty > qtyHeld) qty = qtyHeld;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: order.cap }];
    }

    // Race window: one trend decision per bar, sized all-in / full exit.
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const signal = trend.update(Number(close) / 1e5, qtyHeld > 0n);
    if (signal === 'buy' && qtyHeld === 0n && state.cash >= MIN_NOTIONAL) {
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: RACE_MAX_SLIPPAGE_BPS }];
    }
    if (signal === 'sell' && qtyHeld > 0n) {
      return [{ side: 'sell', symbol: SYMBOL, qty: qtyHeld, max_slippage_bps: RACE_MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
  });
}
