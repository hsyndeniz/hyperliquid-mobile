/**
 * The trade screen's pure decisions: the funding countdown, the local spread,
 * the book's buy/sell ratio and depth-bar geometry, the grouping menu, the
 * tape clock, and the chart's collapse cycle.
 *
 * Lives beside the trade components for the reason `chartView.ts` states:
 * importing a component under Jest drags in Reanimated/Worklets/Skia, none of
 * which load there, so the logic with rules in it is a `.ts` module and the
 * markup stays markup.
 */

import { BigNumber } from "bignumber.js";

import { OUTCOME_PRICE_SZ_DECIMALS } from "@/hyperliquid/core/assetIds";
import { getPriceTick, toBigNumber } from "@/hyperliquid/core/precision";
import type { L2Aggregation } from "@/hyperliquid/types/domain";

/** Hyperliquid funding pays hourly, on the hour. */
export const FUNDING_PERIOD_MS = 3_600_000;

/**
 * Milliseconds until the next UTC hour boundary.
 *
 * Funding pays on the hour UTC, and epoch milliseconds are already
 * UTC-anchored, so a plain modulus needs no timezone arithmetic. The instant
 * this is fed is SERVER time — `serverTimeAtReceipt + local elapsed` — never
 * the raw device clock: a device seconds ahead would count through 00:00
 * before funding actually paid, and one behind would pay funding while the
 * timer still showed time left.
 *
 * Exactly on the boundary the answer is a full {@link FUNDING_PERIOD_MS},
 * never 0 — the modulus lands in [0, period), so the subtraction lands in
 * (0, period]. The moment funding pays, the next payment is an hour away;
 * a 0 here would render a "00:00" that lingers for a tick and reads as a
 * stuck timer.
 */
export function msToNextHour(epochMs: number): number {
  const intoHour = epochMs % FUNDING_PERIOD_MS;
  return FUNDING_PERIOD_MS - intoHour;
}

/**
 * A countdown as `"mm:ss"` — floored, clamped at `"00:00"`.
 *
 * Floor, not round: a countdown that rounds 59.6 s up to "01:00" ticks the
 * same second twice on the way down. The clamp covers the frame where an
 * anchor computed against a slightly-ahead server clock goes momentarily
 * negative — a countdown must never show "-0:01". A full hour renders as
 * `"60:00"` rather than rolling into an hours place the layout never needs.
 */
export function countdownLabel(ms: number): string {
  if (!Number.isFinite(ms)) return "00:00";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The hourly funding rate as a percentage label — `"0.0013%"`, `"4.00%"`.
 *
 * Precision follows magnitude, because funding does: a major perp funds at
 * ~0.001 %/h and a thin listing can fund at whole percents (measured live on
 * testnet — BTC `0.0000125`, HYPE `0.04`). Four decimals is the right
 * resolution for the first and prints a silly `"4.0000%"` for the second; two
 * decimals is right for the second and rounds the first to a lying `"0.00%"`.
 * So: two decimals at or above 1 %, four below.
 *
 * `null` in, `"--"` out — a market whose ctx has not arrived has no rate, and
 * zero is a real funding value that must not stand in for "unknown".
 */
export function fundingPercentLabel(rate: string | null): string {
  if (rate === null) return "--";
  const pct = toBigNumber(rate).multipliedBy(100);
  if (!pct.isFinite()) return "--";
  return `${pct.abs().gte(1) ? pct.toFixed(2) : pct.toFixed(4)}%`;
}

/**
 * The spread computed locally from the best bid and ask.
 *
 * The wire sends a `spread` field only when the subscription carries a
 * non-null `nSigFigs` — the ungrouped (finest) book arrives without one, and
 * this is its fallback. BigNumber throughout: both ends are wire price
 * strings, and the difference of two ticks is exactly the kind of small
 * number float subtraction mangles.
 *
 * `abs` is the exact difference; `pct` is `abs / mid × 100` at three
 * significant digits — spreads span from ~0.0001% on BTC to whole percents on
 * an illiquid listing, so fixed decimal places either print noise or print a
 * zero that lies.
 *
 * `null` when either side is missing or malformed (an empty side has no
 * spread — rendering "0" there would call a one-sided book tight), when the
 * book is crossed (bid above ask is transient wire nonsense, not a negative
 * spread), or when the mid is not positive (a ratio against zero is
 * undefined). A locked book (bid = ask) genuinely IS `"0"` — that one is a
 * measurement.
 */
export function localSpread(
  bestBid: string | null,
  bestAsk: string | null
): { abs: string; pct: string } | null {
  if (bestBid === null || bestAsk === null) return null;
  const bid = toBigNumber(bestBid);
  const ask = toBigNumber(bestAsk);
  if (!bid.isFinite() || !ask.isFinite()) return null;
  const abs = ask.minus(bid);
  if (abs.lt(0)) return null;
  const mid = bid.plus(ask).dividedBy(2);
  if (mid.lte(0)) return null;
  const pct = abs.dividedBy(mid).multipliedBy(100);
  return { abs: abs.toFixed(), pct: pct.precision(3).toFixed() };
}

/**
 * The buy side's share of visible book size, for the bid/ask ratio bar.
 *
 * Sums are BigNumber — sizes are wire strings and a book can stack hundreds
 * of contracts against fractions of one — but the returned percentage is a
 * plain number: it becomes a bar width, which is a display leaf, and no
 * further arithmetic happens on it.
 *
 * A size that will not parse is skipped, not counted as zero: the ratio
 * weighs what the exchange reported. `null` when both sides sum to zero —
 * an empty book has no ratio, and rendering a bar at 50% would claim a
 * balance nobody measured.
 */
export function bookRatio(
  bidSizes: readonly string[],
  askSizes: readonly string[]
): { buyPct: number } | null {
  const sum = (sizes: readonly string[]): BigNumber => {
    let total = new BigNumber(0);
    for (const raw of sizes) {
      const size = toBigNumber(raw);
      if (size.isFinite()) total = total.plus(size);
    }
    return total;
  };
  const bidTotal = sum(bidSizes);
  const askTotal = sum(askSizes);
  const total = bidTotal.plus(askTotal);
  if (total.lte(0)) return null;
  return { buyPct: bidTotal.dividedBy(total).multipliedBy(100).toNumber() };
}

/**
 * Running-total fractions of a side's final total, in [0, 1] — the widths of
 * the depth bars behind the book rows.
 *
 * Summed as BigNumber, emitted as numbers: a bar width is a display leaf.
 * One fraction per input level, always — a level whose size will not parse
 * contributes nothing to the running total but still gets a bar slot, so the
 * rows and their bars cannot drift out of register. An all-zero side renders
 * every bar at 0 rather than dividing by zero, and empty input is an empty
 * array.
 */
export function cumulativeDepth(sizes: readonly string[]): readonly number[] {
  const running: BigNumber[] = [];
  let total = new BigNumber(0);
  for (const raw of sizes) {
    const size = toBigNumber(raw);
    if (size.isFinite()) total = total.plus(size);
    running.push(total);
  }
  if (running.length === 0) return [];
  if (total.lte(0)) return running.map(() => 0);
  return running.map((sum) => sum.dividedBy(total).toNumber());
}

/**
 * One grouping choice, stated as the exact aggregation the subscription layer
 * keys on. The type IS `L2Aggregation` rather than a lookalike: aggregation
 * is part of the subscription's identity, and a menu shape that drifted from
 * it would open a second server subscription racing the first into one store.
 */
export type BookGrouping = L2Aggregation;

/**
 * The grouping menu, in display order.
 *
 * Every entry is a PRICE grouping and nothing else. Depth used to be a choice
 * here too ("20 levels · 5s"), which put two unrelated axes in one menu and
 * made the reader pay for depth in refresh rate; depth is now measured from
 * the space the ladder has and filled from both feeds at once
 * ({@link mergeBookSide}), so the menu asks only the question it names.
 *
 * The wire rule that shapes the list: `mantissa` is only legal when
 * `nSigFigs` is 5 — it widens the tick at the finest grouping (a ×2 / ×5 step
 * on the fifth significant figure), and at 4 or fewer sig figs the grouping is
 * already coarser than any mantissa multiple, so the server rejects the
 * combination rather than guessing. No entry here may pair a mantissa with
 * anything but 5.
 *
 * Every entry is `fast: true`: this is the feed the touch is read from, and
 * the deep feed rides alongside it with the SAME nSigFigs/mantissa so the two
 * halves of the ladder share one price grid.
 */
export const BOOK_GROUPINGS: readonly { key: string; label: string; aggregation: BookGrouping }[] =
  [
    {
      key: "default",
      label: "Finest",
      aggregation: { nSigFigs: null, mantissa: null, fast: true },
    },
    { key: "5", label: "5 figs", aggregation: { nSigFigs: 5, mantissa: null, fast: true } },
    { key: "5x2", label: "5 figs · ×2", aggregation: { nSigFigs: 5, mantissa: 2, fast: true } },
    { key: "5x5", label: "5 figs · ×5", aggregation: { nSigFigs: 5, mantissa: 5, fast: true } },
    { key: "4", label: "4 figs", aggregation: { nSigFigs: 4, mantissa: null, fast: true } },
    { key: "3", label: "3 figs", aggregation: { nSigFigs: 3, mantissa: null, fast: true } },
    { key: "2", label: "2 figs", aggregation: { nSigFigs: 2, mantissa: null, fast: true } },
  ];

/**
 * The price grid a grouping actually quotes on, as a display string.
 *
 * A trader reads a book by its tick, not by a count of significant figures —
 * the official web app labels this control `0.001`, and "5 figs" only becomes
 * a tick once you know the price. So the label is DERIVED from a price:
 *
 * - `nSigFigs: n`, no mantissa → `10^(e − n + 1)`, where `e` is the anchor's
 *   decimal exponent. Keeping n significant figures fixes the last one at
 *   that power.
 * - `nSigFigs: 5` with mantissa `m` → `m × 10^(e − 4)`: the mantissa widens
 *   the step on the fifth significant figure, which is why the wire only
 *   accepts it there.
 * - `nSigFigs: null` ("Finest") → the asset's own tick, {@link getPriceTick}.
 *
 * Every result is then clamped UP to the native tick: the server cannot quote
 * a grid finer than the asset allows, so a label promising one would lie.
 *
 * `null` when the anchor is unusable — the caller keeps the English label
 * rather than inventing a number. Rendered with `.toFixed()` and NO argument:
 * `toString()` goes exponential below 1e-7 and would print a spot tick as
 * "1e-8".
 */
export function groupingTickLabel(
  aggregation: BookGrouping,
  anchorPx: string | null,
  szDecimals: number | null,
  marketType: "perp" | "spot"
): string | null {
  if (anchorPx === null) return null;
  const anchor = toBigNumber(anchorPx);
  if (!anchor.isFinite() || anchor.lte(0)) return null;

  const decimals = szDecimals ?? OUTCOME_PRICE_SZ_DECIMALS;
  const native = getPriceTick(anchor, decimals, marketType);
  if (native === null) return null;

  const { nSigFigs, mantissa } = aggregation;
  if (nSigFigs === null) return native.toFixed();

  const exponentPart = anchor.toExponential().split("e")[1];
  if (exponentPart === undefined) return null;
  const exponent = Number(exponentPart);
  if (!Number.isFinite(exponent)) return null;

  const step =
    mantissa === null
      ? new BigNumber(10).pow(exponent - nSigFigs + 1)
      : new BigNumber(mantissa).multipliedBy(new BigNumber(10).pow(exponent - 4));

  return BigNumber.maximum(step, native).toFixed();
}

/**
 * The grouping menu, labelled by tick where a tick can be derived.
 *
 * Adjacent duplicates collapse: once clamped to the native tick, "Finest" and
 * "5 figs" land on the same grid for most assets, and two menu entries
 * reading `0.001` are a choice with no difference. The KEY is preserved —
 * `appearance.defaultGrouping` names one, and dropping it would strand the
 * book's opening grouping.
 *
 * Call this memoised on `(anchorPx, szDecimals, marketType)`. The anchor must
 * be the SCREEN's price, which moves on the mids cadence — feeding it the
 * book's own touch would rebuild the menu on every 0.5 s frame and re-render
 * the popover the LiveBook split exists to keep still.
 */
export function bookGroupingOptions(
  anchorPx: string | null,
  szDecimals: number | null,
  marketType: "perp" | "spot"
): readonly { id: string; label: string }[] {
  const options: { id: string; label: string }[] = [];
  let previousLabel: string | null = null;

  for (const grouping of BOOK_GROUPINGS) {
    const tick = groupingTickLabel(grouping.aggregation, anchorPx, szDecimals, marketType);
    const label = tick ?? grouping.label;
    // Only ADJACENT duplicates collapse: the list runs finest-first, so equal
    // neighbours are the clamp flattening the top of the ladder, while a
    // repeat further down would be a real coincidence worth showing.
    if (tick !== null && label === previousLabel) continue;
    options.push({ id: grouping.key, label });
    previousLabel = label;
  }

  return options;
}

/**
 * The ladder's column header cells.
 *
 * Mirrored over the bid column in `columns`, because {@link BookRow} mirrors
 * that column — bids read size-outward so the two sides' prices meet in the
 * middle. A single "Price | Size" header would sit over the wrong cells there.
 */
export function bookColumnHeader(
  layout: BookLayout,
  side: "bid" | "ask" | "both",
  symbol: string
): { left: string; right: string } {
  const size = `Size (${symbol})`;
  if (layout === "columns" && side === "bid") return { left: size, right: "Price" };
  return { left: "Price", right: size };
}

/**
 * The touch's midpoint, for the row between the sides.
 *
 * Deliberately NOT {@link localSpread}'s contract. That function refuses a
 * crossed book and a one-sided book because a spread is meaningless there —
 * but the mid row is the ladder's anchor and still wants to show a number in
 * both cases. A crossed book is a transient wire artefact, not a reason to
 * blank the price the whole column is read against.
 *
 * `null` only when a side is missing or unreadable, or the mid is not
 * positive. `.toFixed()` with no argument: the mid of two adjacent ticks
 * carries one more decimal than either side (63645/63646 → "63645.5"), and
 * `toString()` would go exponential on a small spot price.
 */
export function bookMid(bestBid: string | null, bestAsk: string | null): string | null {
  if (bestBid === null || bestAsk === null) return null;
  const bid = toBigNumber(bestBid);
  const ask = toBigNumber(bestAsk);
  if (!bid.isFinite() || !ask.isFinite()) return null;
  const mid = bid.plus(ask).dividedBy(2);
  if (!mid.isFinite() || mid.lte(0)) return null;
  return mid.toFixed();
}

/**
 * Levels per side on a `fast: true` book subscription.
 *
 * Measured on the testnet wire, not assumed: `fast: true` delivered exactly 5
 * levels a side on all 57 pushes of a 30 s window (median gap 522 ms), and
 * `fast: false` exactly 20 on all 7 (median gap 5.28 s). That is the whole
 * trade-off — 10x the refresh rate for a quarter of the depth.
 */
export const FAST_BOOK_LEVELS = 5;

/**
 * One side of the ladder, assembled from BOTH book feeds.
 *
 * A ladder that measures 8 rows a side has nothing to put in rows 6–8 on the
 * fast feed, and the honest way to fill them is not to give up the fast feed:
 * a 5-second book is not something to place an order against. So the panel
 * runs both subscriptions on one market and each vouches for the part it is
 * good at — the touch and the four levels behind it refresh twice a second,
 * the tail behind THEM refreshes every five. Both are websocket pushes, so
 * the second feed costs no request weight at all.
 *
 * The seam rule: a deep level is kept only when it lies strictly BEYOND the
 * last fast level (lower for bids, higher for asks). The deep snapshot can be
 * five seconds old, so anywhere the two overlap the fast feed is simply more
 * correct — and a level that both carry must appear once, at one size. This
 * also survives the deep snapshot being the stale one: its levels are all
 * beyond the touch, so a lagging tail misstates depth far from the price, not
 * the price itself.
 *
 * Both feeds must be subscribed with the same `nSigFigs`/`mantissa`, or the
 * two halves are on different price grids; the panel passes one aggregation
 * to both. Passing an empty or absent deep side returns the fast side
 * unchanged, which is also the correct answer while the deep feed is stale.
 */
export function mergeBookSide(
  fast: readonly { px: string; sz: string; n?: number }[],
  deep: readonly { px: string; sz: string; n?: number }[],
  side: "bids" | "asks"
): { px: string; sz: string; n?: number }[] {
  if (fast.length === 0) return [...deep];
  if (deep.length === 0) return [...fast];

  const edge = toBigNumber(fast[fast.length - 1]!.px);
  if (!edge.isFinite()) return [...fast];

  const beyond = deep.filter((level) => {
    const px = toBigNumber(level.px);
    if (!px.isFinite()) return false;
    return side === "bids" ? px.lt(edge) : px.gt(edge);
  });

  return [...fast, ...beyond];
}

/**
 * A trade's server timestamp as a fixed-width `"HH:MM:SS"` clock for the tape.
 *
 * Follows `shortTime` in `portfolio/primitives` on both of its conventions:
 * local device time for the instant given (the server clock can lead the
 * device clock by seconds, so this formats the instant and never computes
 * "x seconds ago", which would render "in 3 seconds" for a fill that already
 * happened), and `"--"` for non-finite or non-positive input. It pads a
 * 24-hour clock by hand instead of `toLocaleTimeString` — the tape is a
 * column, and a 12-hour locale appends AM/PM, changing every row's width.
 */
export function shortClock(timeMs: number): string {
  if (!Number.isFinite(timeMs) || timeMs <= 0) return "--";
  const date = new Date(timeMs);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * The chart's height in the chart view — the only view that draws a chart.
 * Not larger: the hero header and the Buy/Sell row are fixed costs, and every
 * point here comes out of the book beneath — at 320 the ladder measured ZERO
 * rows on a 6.9" phone (observed live), which is a chart view with a dead
 * book under it. 240 → 200 when the book gained its column header and the
 * taller mid-price touch row: at 240 the chart view's ladder lands exactly on
 * the 5-a-side usefulness floor with zero margin (header measured 192pt on
 * perps — the arithmetic is in the phase plan).
 */
export const CHART_VIEW_CHART_HEIGHT = 200;

/** A day's traded range, wire strings preserved. */
export interface DayRange {
  high: string;
  low: string;
}

/**
 * The 24h high/low, derived from the candles already on screen.
 *
 * No wire field carries these — `activeAssetCtx` has mark/oracle/funding but
 * no range — and the candle feed is live and already paid for, so the range
 * is a fold over it rather than a new read. A candle counts when any part of
 * it lies inside the window (`closeTime` test): dropping a bar that OPENED
 * 25 h ago would discard the extreme it printed 23 h ago. The cost of that
 * inclusion is bounded by one bar's width, and on coarse intervals (1d+) a
 * partial bar IS the honest source of the day's extreme anyway. The forming
 * bucket always participates — the day's high is quite often being printed
 * right now.
 *
 * `null` before any candle lands, and when nothing overlaps the window —
 * rendered as `--`, never as a held zero.
 */
export function dayRange(
  committed: readonly { closeTime: number; high: string; low: string }[],
  forming: { closeTime: number; high: string; low: string } | null,
  nowMs: number,
  windowMs = 24 * 60 * 60 * 1000
): DayRange | null {
  const cutoff = nowMs - windowMs;
  let high: BigNumber | null = null;
  let low: BigNumber | null = null;
  let highWire = "";
  let lowWire = "";

  const bars = forming === null ? committed : [...committed, forming];
  for (const bar of bars) {
    if (bar.closeTime < cutoff) continue;
    const h = toBigNumber(bar.high);
    const l = toBigNumber(bar.low);
    if (h.isFinite() && (high === null || h.gt(high))) {
      high = h;
      highWire = bar.high;
    }
    if (l.isFinite() && (low === null || l.lt(low))) {
      low = l;
      lowWire = bar.low;
    }
  }

  return high === null || low === null ? null : { high: highWire, low: lowWire };
}

/**
 * The screen's two arrangements — the reference exchanges' toggle.
 *
 * `trade` puts the form and book side by side: the placing arrangement.
 * `chart` gives the chart the screen with the book beneath it: the watching
 * arrangement, with Buy/Sell shortcuts that jump back to `trade` carrying
 * the chosen side.
 */
export type TradeScreenView = "trade" | "chart";

/** Where the persisted {@link TradeScreenView} choice lives in MMKV.
 *  DORMANT since the HL-mobile redesign removed the chart view (2026-08-18);
 *  kept, with the type above, for the chart's planned return. */
export const TRADE_VIEW_KEY = "hl:trade:view";

/** The kinds the trade screen can actually submit. Predictions are not one. */
export type TradableKind = "perp" | "spot";

/**
 * Which sides of the book are shown.
 *
 * `both` is the book proper. The single-sided views are for reading one side's
 * depth without the other half stealing rows — the reference exchanges all
 * offer them, and on a phone the payoff is bigger because the frame is
 * shorter.
 */
export type BookSides = "both" | "asks" | "bids";

export type BookLayout = "stacked" | "columns";

/**
 * The narrowest panel that can hold two price+size columns without either
 * truncating. Below it, `columns` is not offered — a layout control that
 * produces an unreadable layout is not a choice.
 */
export const COLUMNS_MIN_WIDTH = 340;

/** Whether a panel of this width can draw the side-by-side layout at all. */
export function canUseColumns(width: number): boolean {
  return width >= COLUMNS_MIN_WIDTH;
}

/**
 * Everything about the book that is taste rather than protocol.
 *
 * Split out as one resolved object so the component has a real surface — a
 * second book on another screen (a position's market, a watchlist preview)
 * can be denser, chrome-free, or pinned to one side without forking the
 * component or threading a dozen loose props.
 */
export interface OrderBookAppearance {
  /** Row height in points. */
  rowHeight: number;
  /**
   * Space between rows in points. Small by default: enough to separate the
   * rows without breaking the depth column into stripes — the shape a book
   * is read by lives in that column's continuity.
   */
  rowGap: number;
  /**
   * The touch row's height — the mid price with the spread beneath it. Taller
   * than a level row because the mid is the ladder's anchor and is read at a
   * glance; the spread rides under it at label size.
   */
  spreadHeight: number;
  /**
   * The ratio bar's total height INCLUDING the gap above it. It sits inside
   * the same measured box as the ladder, so {@link fittedRowCount} has to be
   * told about it or the ladder claims rows that do not exist.
   */
  ratioHeight: number;
  /** The `Price | Size (COIN)` header above the ladder. */
  showColumnHeader: boolean;
  /** The column header's height. */
  columnHeaderHeight: number;
  /** Cumulative-depth bars behind the rows. */
  showDepth: boolean;
  /** The spread row between the sides. */
  showSpread: boolean;
  /** The buy/sell pressure bar beneath the ladder. */
  showRatio: boolean;
  /** The Book/Trades toggle — off leaves a book with no tape. */
  showTape: boolean;
  /** The grouping / sides / layout control row beneath the ladder. */
  showControls: boolean;
  /** Hard cap on rows per side, whatever the space allows. */
  maxRows: number | null;
  /** Which grouping the book opens on — a key from {@link BOOK_GROUPINGS}. */
  defaultGrouping: string;
  /** Which sides the book opens on. */
  defaultSides: BookSides;
  /**
   * Force a layout instead of choosing by width. `null` keeps the automatic
   * behaviour: side-by-side once the panel is wide enough for it.
   */
  forceLayout: BookLayout | null;
}

/** The house book: dense, hairline-separated, fully chromed, auto layout. */
export const BOOK_APPEARANCE: OrderBookAppearance = {
  rowHeight: 24,
  rowGap: 1,
  // The mid row carries the screen's ONLY price now — a 19pt mid over a 10pt
  // dashed mark — so it is taller than the bare 40pt anchor it replaced.
  // One slim line now — mid and mark share a baseline (the screen header
  // owns the hero price). The freed ~26pt buys the ladder another row.
  spreadHeight: 26,
  ratioHeight: 26,
  showColumnHeader: true,
  // Two lines per column ("Price" over "(USD)"): at a 35% column the label
  // and its unit do not fit side by side.
  columnHeaderHeight: 24,
  showDepth: true,
  showSpread: true,
  // Off by default (2026-08-29): the reference book has no ratio bar, and
  // its 26pt is a whole row of depth. An embed can opt back in.
  showRatio: false,
  // Off by user call (2026-08-29): the official app has no tape either, and
  // the toggle was one more control between the eye and the ladder. The tape
  // component and its store stay — an embed that wants one can opt back in.
  showTape: false,
  showControls: true,
  maxRows: null,
  defaultGrouping: "default",
  defaultSides: "both",
  forceLayout: null,
};

/**
 * Fill a partial appearance from {@link BOOK_APPEARANCE}.
 *
 * A flat spread, so every field of {@link OrderBookAppearance} MUST have a
 * default above: one without resolves to `undefined`, and the first arithmetic
 * that touches it yields NaN rather than failing loudly.
 *
 * Returns the shared constant when there are no overrides — callers pass this
 * result into the per-frame path, and a fresh object every render would churn
 * memoised props. An override object should itself be module-scope.
 */
export function resolveBookAppearance(
  overrides?: Partial<OrderBookAppearance>
): OrderBookAppearance {
  return overrides === undefined ? BOOK_APPEARANCE : { ...BOOK_APPEARANCE, ...overrides };
}

/**
 * Total fixed chrome inside the ladder's MEASURED box, in points.
 *
 * The one term {@link fittedRowCount} subtracts, so a newly added in-box
 * element is accounted for here once rather than at each call site.
 *
 * This exists because the box was previously charged only for the touch row
 * while it also contained the ratio bar — 26pt, almost exactly one row pitch,
 * unaccounted for. The ladder therefore claimed one row more than it had, and
 * the stacked layout's centring hid it by clipping the overflow symmetrically.
 *
 * The three terms are NOT uniform, and the difference is deliberate:
 *
 * - The touch row is charged ALWAYS. `showSpread: false` renders an empty
 *   view of the same height rather than closing the gap, so that hiding the
 *   spread cannot reflow the ladder by a row — the sides stay where the eye
 *   left them.
 * - The ratio bar and the column header are charged only when DRAWN, because
 *   they are genuinely unmounted. An embedded book that turns them off should
 *   spend their points on levels, which is the whole reason to turn them off.
 */
export function bookChromeHeight(appearance: OrderBookAppearance): number {
  return (
    appearance.spreadHeight +
    (appearance.showRatio ? appearance.ratioHeight : 0) +
    (appearance.showColumnHeader ? appearance.columnHeaderHeight : 0)
  );
}

/**
 * How many level rows fit in a ladder of `availableHeight` points.
 *
 * MEASURED, not assumed: the book fills whatever vertical space the screen
 * hands it, so a taller phone shows a deeper book rather than a fixed count
 * with padding under it. The fixed chrome is placed first and the remainder
 * is divided by the row's full pitch, height plus gap. Charging the gap to
 * every row (rather than to the n−1 gaps between them) over-reserves by a
 * single gap, which is the safe direction: the ladder never overflows the box
 * it measured.
 *
 * `chromeHeight` is EVERY fixed element inside the measured box, not just the
 * touch row — see {@link bookChromeHeight}. Passing only the touch row's
 * height was a live defect: the ratio bar shares the box, and its 26pt is one
 * row pitch, so the ladder claimed a row that did not exist.
 *
 * `0` before the first layout pass, and whenever the space cannot hold even
 * one row. Callers render the skeleton at that count rather than guessing a
 * number and reflowing later.
 */
export function fittedRowCount(
  availableHeight: number,
  rowHeight: number,
  chromeHeight: number,
  rowGap = 0
): number {
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) return 0;
  const pitch = rowHeight + Math.max(0, rowGap);
  if (pitch <= 0) return 0;
  const forRows = availableHeight - chromeHeight;
  if (forRows < pitch) return 0;
  return Math.floor(forRows / pitch);
}

/**
 * Levels to draw PER SIDE, given the rows that fit.
 *
 * - `stacked` + `both` splits them, floored — an odd row is left unused
 *   rather than given to one side, which would put the spread off-centre.
 * - `stacked` + one side gives that side ALL of them: hiding a side buys
 *   depth, not whitespace.
 * - `columns` gives BOTH sides all of them at once — twice the stacked depth
 *   in the same height, which is the layout's real payoff.
 *
 * The fast feed carries only 5 levels per side, so a deep frame fills part-way
 * from it and completely from the 20-level grouping. Rows with no level are
 * not drawn; no empty row is dressed up as a price.
 */
export function bookRowsPerSide(sides: BookSides, layout: BookLayout, fittedRows: number): number {
  if (fittedRows <= 0) return 0;
  if (layout === "columns") return fittedRows;
  return sides === "both" ? Math.floor(fittedRows / 2) : fittedRows;
}

/**
 * The header's pair name, in the official mobile app's spelling: `BTC-USDC`.
 *
 * Every Hyperliquid perp is USDC-margined and the testnet spot pairs this app
 * lists are USDC-quoted, so the quote leg is a constant — revisit if a
 * non-USDC spot quote ever reaches the picker. Predictions never reach the
 * trade screen, so the outcome spellings need no case here.
 */
export function pairTitle(symbol: string): string {
  return `${symbol}-USDC`;
}

/**
 * Which source the displayed price came from, and therefore whose age applies.
 *
 * `useTradeScreen` resolves the price as `mid ?? ctx.midPx ?? ctx.markPx ??
 * row.px`, so a single "is the ctx channel stale?" flag describes a value the
 * screen may not be showing. It gets the answer wrong in both directions — a
 * fresh mid over a stalled ctx reads as stale, and a stalled mid over a live
 * ctx reads as FRESH, which is the direction that costs money on a screen that
 * sizes an order and estimates a liquidation from the number.
 *
 * The last fallback, `row.px`, is a one-shot REST snapshot from
 * `useMarketList` with no age of its own. It applies only before the first mid
 * or ctx frame arrives, so the mids age is the closest honest proxy: a null
 * age means the poll has not run, which for a snapshot just fetched is
 * correctly "not stale" rather than "unknown, assume bad".
 */
export function priceIsStale(sources: {
  /** The polled mid, or `null` when the poll has not answered for this coin. */
  mid: string | null;
  /** Whichever ctx price the screen would fall back to. */
  ctxPrice: string | null;
  midsStale: boolean;
  ctxStale: boolean;
}): boolean {
  if (sources.mid !== null) return sources.midsStale;
  if (sources.ctxPrice !== null) return sources.ctxStale;
  return sources.midsStale;
}

// ---------------------------------------------------------------------------
// Liquidation buffer
// ---------------------------------------------------------------------------

/**
 * Below this much room to liquidation the bar turns amber; below the second,
 * red. Judgment calls, and stated as such — no exchange publishes a "getting
 * close" number — but they are keyed to how far a crypto perp actually moves
 * rather than picked for looks: **15% is a bad day** and **5% is a single
 * volatile hour**. The consequence is deliberate and worth knowing before
 * anyone "fixes" it: a position 14% clear reads amber, not green, because a
 * 14% drawdown would in fact liquidate it.
 */
const BUFFER_WARNING = 0.15;
const BUFFER_DANGER = 0.05;

/**
 * The buffer at which the bar reads FULL. Anything further from liquidation
 * than this is simply "safe" — a scale that kept extending would spend its
 * whole range on positions in no danger and compress the ones that are.
 */
const BUFFER_FULL_SCALE = 0.5;

export interface LiquidationBuffer {
  /** Room to liquidation as a fraction of mark: `|mark − liq| / mark`. */
  fraction: number;
  /**
   * What a bar should fill: 100 = plenty of room, 0 = at the liquidation
   * price. A **fuel gauge, not a risk meter** — it was written the other way
   * up first, and a 70%-full bar sat above the words "14.7% from
   * liquidation", which is two contradictory readings of one number. Emptying
   * as danger rises means the bar and its caption fall together.
   */
  room: number;
  severity: "success" | "warning" | "danger";
}

/**
 * How much room a position has before liquidation.
 *
 * **Mark is derived, not read.** `Position` carries no mark price; it carries
 * `notionalValue`, which the wire defines as `|szi| × markPx`, so mark is that
 * over size. Division, hence `BigNumber` — and a guard on every degenerate
 * input, because each one has a plausible source: size is "0" for a position
 * the snapshot is about to drop, and a liquidation price can arrive as the
 * empty string.
 *
 * Returns `null` whenever the answer would be invented. A position with no
 * liquidation price is the COMMON case (410 of 1,044 mainnet positions), and
 * a bar drawn for one of those would be pure decoration.
 */
export function liquidationBuffer(position: {
  size: string;
  notionalValue: string;
  liquidationPx: string | null;
}): LiquidationBuffer | null {
  if (position.liquidationPx === null) return null;

  // `toBigNumber` answers NaN, never null, for anything it cannot parse.
  const size = toBigNumber(position.size).abs();
  const notional = toBigNumber(position.notionalValue).abs();
  const liq = toBigNumber(position.liquidationPx);

  // A negative liquidation price is the one bad input that survives the
  // arithmetic looking healthy: |mark − (−1)| / mark is a perfectly finite
  // ~1.0, which would report a nonsense row as the safest on screen.
  if (liq.isNegative()) return null;

  const mark = notional.dividedBy(size);
  const fraction = mark.minus(liq).abs().dividedBy(mark).toNumber();

  // ONE finiteness test covers every other degenerate input, and explicit
  // guards for them were written, verified to match nothing, and deleted: an
  // unparsable string is already NaN, a zero size makes `mark` Infinite, a
  // zero notional makes it zero — and each propagates to a non-finite
  // `fraction` right here. See the guard note in CLAUDE.md.
  if (!Number.isFinite(fraction)) return null;

  const room = Math.min(fraction / BUFFER_FULL_SCALE, 1) * 100;
  const severity =
    fraction >= BUFFER_WARNING ? "success" : fraction >= BUFFER_DANGER ? "warning" : "danger";

  return { fraction, room, severity };
}
