/**
 * The market detail screen's pure decisions — chart points, stat tiles, and
 * the prediction side rows.
 *
 * Same split as `marketsView.ts`: the components render, this module decides.
 * Inputs are structural (plain strings and small objects) so the module
 * depends on no store, hook, or row builder — the screen assembles the view
 * from whatever snapshot it holds.
 *
 * The null contract is per-tile: a tile whose source has not spoken carries
 * `value: null` and the leaf renders `"--"`. The tile itself never disappears
 * — a vanishing label reads as "this market has no funding", which is a
 * different claim than "not loaded yet". The one deliberate exception is
 * {@link aboutRows}: those are token *attributes* (most tokens genuinely have
 * no EVM contract), so an absent attribute omits the row rather than dashing
 * it.
 */

import { BigNumber } from "bignumber.js";

import { compactUsd } from "@/components/portfolio/fetchedView";
import { toBigNumber } from "@/hyperliquid/core/precision";

import type { Candle, CandleInterval } from "@/hyperliquid/types/domain";
import type { CandlePoint } from "react-native-livechart";

/**
 * The intervals the detail chart offers, in segment order.
 *
 * **Casing is load-bearing.** `1m` is one minute and `1M` is one month — the
 * wire distinguishes them by case alone, and `1M`/`1D`/`1W` would silently
 * subscribe to feeds ~43,000× slower than intended (or, for `1D`, to nothing).
 * The `CandleInterval` type admits both spellings, so only this constant and
 * its test pin the correct ones.
 */
export const DETAIL_INTERVALS: readonly CandleInterval[] = [
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "1w",
];

/**
 * Wire string → chart number.
 *
 * This is a sanctioned display leaf — the one place in these modules where
 * `Number()` touches a price. `LiveChart` consumes IEEE doubles inside a
 * worklet; there is no BigNumber on the other side of that boundary. It is
 * `Number()` directly rather than `displayNumber` from
 * `components/portfolio/primitives` because that file is a `.tsx` whose
 * imports (Skia, Reanimated) do not load under Jest.
 */
function chartNumber(wire: string): number {
  return Number(wire);
}

/**
 * Our candles as the points `LiveChart`'s candle mode wants.
 *
 * `CandlePoint.time` is **seconds**, our `openTime` is ms — the ÷1000 here is
 * the only unit conversion, and it stays exact because buckets are epoch-
 * floor aligned. A row with a non-finite field is dropped rather than mapped
 * to 0: a zero-priced candle draws a wick to the axis, while a missing bucket
 * is a state the chart already handles (the feed legitimately leaves holes
 * where nothing traded).
 */
export function toCandlePoints(candles: readonly Candle[]): CandlePoint[] {
  const points: CandlePoint[] = [];
  for (const candle of candles) {
    const open = chartNumber(candle.open);
    const high = chartNumber(candle.high);
    const low = chartNumber(candle.low);
    const close = chartNumber(candle.close);
    const volume = chartNumber(candle.volume);
    if (![open, high, low, close].every(Number.isFinite)) continue;
    points.push({
      time: candle.openTime / 1000,
      open,
      high,
      low,
      close,
      ...(Number.isFinite(volume) ? { volume } : {}),
    });
  }
  return points;
}

/**
 * The forming bucket for the chart's `liveCandle` slot; null passes through.
 *
 * Null is a real state, not a gap to paper over: a seed on a quiet market
 * legitimately leaves nothing forming until the first trade, and the chart's
 * `SharedValue<CandlePoint | null>` models exactly that.
 */
export function formingToCandlePoint(forming: Candle | null): CandlePoint | null {
  if (forming === null) return null;
  const [point] = toCandlePoints([forming]);
  return point ?? null;
}

/** One stat tile. `value: null` renders as `"--"` — the label never vanishes. */
export interface StatTile {
  label: string;
  value: string | null;
  /** Sign cue for the component's colour mapping. Set only where sign is meaning. */
  tone?: "up" | "down" | "neutral";
}

/** The perp ctx fields the tiles read. All non-null strings on the wire. */
export interface PerpCtxView {
  markPx: string;
  oraclePx: string;
  dayNtlVlm: string;
  funding: string;
  openInterest: string;
}

/** The universe row fields the tiles read. */
export interface PerpUniverseView {
  maxLeverage: number;
}

/** Finite guard: format only what parses; a malformed source stays null. */
function finiteOrNull(wire: string): string | null {
  return toBigNumber(wire).isFinite() ? wire : null;
}

/**
 * The perp detail card's six tiles, in card order.
 *
 * A null `ctx` (store empty, or `read()` refused a stale snapshot) nulls the
 * five live tiles; max leverage survives, because it comes from the cached
 * universe row, not the live feed — the two sources go stale independently
 * and each tile answers only for its own.
 *
 * - **OI** is `openInterest × markPx` in BigNumber — open interest arrives in
 *   base units and a USD figure is the only one comparable across markets.
 * - **Funding/hr** is ×100 at FULL precision, signed. Hourly funding lives in
 *   the 4th–5th decimal of a percent; a 2dp round would print `+0.00%` for
 *   every market on the exchange.
 */
export function perpStatTiles(
  ctx: PerpCtxView | null,
  universe: PerpUniverseView | null
): StatTile[] {
  let funding: StatTile = { label: "Funding / hr", value: null };
  if (ctx) {
    const rate = toBigNumber(ctx.funding);
    if (rate.isFinite()) {
      const pct = rate.multipliedBy(100);
      // Significant digits, not fixed decimals: hourly funding spans testnet's
      // 0.00125%/hr to a squeezed listing's whole percents. Fixed decimals
      // either round the small one to a lying zero or print the large one as
      // noise ("+0.02533821%", seen on device); three significant figures
      // keep the tiny rate exact and trim the mantissa everywhere else.
      const fixed = pct.abs().gte(1) ? pct.toFixed(2) : pct.precision(3).toFixed();
      funding = {
        label: "Funding / hr",
        value: pct.gt(0) ? `+${fixed}%` : `${fixed}%`,
        tone: pct.gt(0) ? "up" : pct.lt(0) ? "down" : "neutral",
      };
    }
  }

  let openInterestUsd: string | null = null;
  if (ctx) {
    const oi = toBigNumber(ctx.openInterest).multipliedBy(toBigNumber(ctx.markPx));
    if (oi.isFinite()) openInterestUsd = compactUsd(oi.toFixed());
  }

  const maxLeverage =
    universe && Number.isFinite(universe.maxLeverage) && universe.maxLeverage > 0
      ? `${universe.maxLeverage}x`
      : null;

  return [
    { label: "Mark", value: ctx ? finiteOrNull(ctx.markPx) : null },
    { label: "Oracle", value: ctx ? finiteOrNull(ctx.oraclePx) : null },
    { label: "24h volume", value: ctx ? usdOrNull(ctx.dayNtlVlm) : null },
    { label: "Open interest", value: openInterestUsd },
    funding,
    { label: "Max leverage", value: maxLeverage },
  ];
}

/** `compactUsd`, but null-honest: a malformed source is absence, not `"--"`-as-data. */
function usdOrNull(wire: string): string | null {
  return toBigNumber(wire).isFinite() ? compactUsd(wire) : null;
}

/**
 * A compact COUNT — `compactUsd` with the currency marker removed, so the
 * one rounding rule (floor, never overstate) lives in exactly one place.
 * Supplies are token quantities; a `$` on them would misprice the token at
 * exactly 1 USD.
 */
function compactCount(wire: string): string | null {
  if (!toBigNumber(wire).isFinite()) return null;
  return compactUsd(wire).replace(/^\$/, "");
}

/** The token field the spot tiles read. */
export interface SpotTokenView {
  name: string;
}

/** The spot ctx fields the tiles read. */
export interface SpotCtxView {
  markPx: string;
  dayNtlVlm: string;
  circulatingSupply: string;
}

/**
 * The spot detail card's three tiles.
 *
 * These are the cached snapshot — spot has no live ctx feed wired (the plan
 * bans `activeSpotAssetCtx`), so the live price on this screen comes from the
 * candle feed's forming close, not from here. Supply is suffixed with the
 * token name when known: a bare "334.4M" tile answers "of what?" with
 * nothing.
 */
export function spotStatTiles(token: SpotTokenView | null, ctx: SpotCtxView | null): StatTile[] {
  let supply: string | null = null;
  if (ctx) {
    const count = compactCount(ctx.circulatingSupply);
    if (count !== null) supply = token ? `${count} ${token.name}` : count;
  }
  return [
    { label: "Mark", value: ctx ? finiteOrNull(ctx.markPx) : null },
    { label: "24h volume", value: ctx ? usdOrNull(ctx.dayNtlVlm) : null },
    { label: "Circulating supply", value: supply },
  ];
}

/**
 * The About card's inputs, assembled by the caller: `fullName` and
 * `evmContract` ride on the spot **token** metadata, `totalSupply` on the
 * **ctx** — the wire splits them, the card does not.
 */
export interface AboutTokenView {
  fullName: string | null;
  totalSupply: string | null;
  evmContract: { address: string } | null;
}

export interface AboutRow {
  label: string;
  value: string;
}

/**
 * The About card's rows — **nullable rows omitted**, not dashed.
 *
 * The opposite of the stat-tile rule, deliberately: these are attributes, not
 * measurements. `fullName` is null on most tokens and `evmContract` on every
 * non-EVM one — a card of dashes would present ordinary absence as three
 * loading failures. An empty result means the caller skips the card.
 */
export function aboutRows(token: AboutTokenView | null): AboutRow[] {
  if (token === null) return [];
  const rows: AboutRow[] = [];
  if (token.fullName !== null && token.fullName !== "") {
    rows.push({ label: "Full name", value: token.fullName });
  }
  if (token.totalSupply !== null) {
    const count = compactCount(token.totalSupply);
    if (count !== null) rows.push({ label: "Total supply", value: count });
  }
  // The all-zero address means "no contract" on this chain — rendering it
  // implies a deployment that does not exist (observed live on HYPE testnet).
  if (token.evmContract !== null && !/^0x0+$/i.test(token.evmContract.address)) {
    rows.push({ label: "Contract", value: truncateAddress(token.evmContract.address) });
  }
  return rows;
}

/** The outcome fields the side rows read. */
export interface OutcomeSideView {
  name: string;
  wireCoin: string;
}

export interface PredictionSideRow {
  name: string;
  wireCoin: string;
  /** `"62.4%"`, or null when this side's ctx has not arrived. */
  probability: string | null;
}

/**
 * A probability as a one-decimal percent BigNumber, or null. Kept as a number
 * so the complement in {@link predictionSideRows} subtracts the *rounded*
 * value, not the raw price.
 */
function probabilityPercent(markPx: string | undefined): BigNumber | null {
  if (markPx === undefined) return null;
  const price = toBigNumber(markPx);
  if (!price.isFinite()) return null;
  return price.multipliedBy(100).decimalPlaces(1, BigNumber.ROUND_HALF_UP);
}

/**
 * Both sides of an outcome with probabilities that **visibly sum to 100%**.
 *
 * The wire guarantees `markPx_yes + markPx_no = 1.000000` exactly (measured
 * on all 8 live mainnet pairs — one shared book, mirrored ladders), but
 * rounding each side independently can still print 62.5% + 37.6%: both sides
 * of an exact `x.x5` round up. So when exactly two sides are both priced, the
 * second side displays as `100 − first` — a derivation the shared book makes
 * faithful, and the only way the two numbers a user will add can never
 * disagree with the invariant the market itself enforces.
 *
 * A side missing from `ctxByCoin` stays null (`"--"` at the leaf), and the
 * priced side falls back to its own independent rounding — deriving a number
 * from a missing one would invent data. Sides beyond two (the encoding
 * permits up to ten) each round independently; there is no pairwise
 * complement to preserve.
 */
export function predictionSideRows(
  outcome: { sides: readonly OutcomeSideView[] },
  ctxByCoin: ReadonlyMap<string, { markPx: string }>
): PredictionSideRow[] {
  const percents = outcome.sides.map((side) =>
    probabilityPercent(ctxByCoin.get(side.wireCoin)?.markPx)
  );

  if (outcome.sides.length === 2) {
    const first = percents[0] ?? null;
    const second = percents[1] ?? null;
    // Only a sane first side anchors the complement; a corrupt price outside
    // [0, 100] must not manufacture a negative "probability" on the other side.
    if (first !== null && second !== null && first.gte(0) && first.lte(100)) {
      percents[1] = new BigNumber(100).minus(first);
    }
  }

  return outcome.sides.map((side, index) => {
    const percent = percents[index] ?? null;
    return {
      name: side.name,
      wireCoin: side.wireCoin,
      probability: percent === null ? null : `${percent.toFixed(1)}%`,
    };
  });
}

/**
 * A hex address at reading length — first six, one ellipsis, last four:
 * `0x1baA…34d5`.
 *
 * Display-only. Anything short enough that truncation would not shorten it
 * passes through unchanged; the full address belongs behind a copy action,
 * never reconstructed from this.
 */
export function truncateAddress(address: string): string {
  if (address.length <= 11) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Detail-screen joins over the raw spot response
// ---------------------------------------------------------------------------
// The list caches BUILT rows only (`hooks/markets.ts`), and a `MarketRow`
// deliberately carries none of the token attributes below — so the detail
// screen re-reads `spotMetaAndAssetCtxs` through its own cache key and joins
// here. Structural inputs, listing only the fields consumed (the
// `markets/rows.ts` idiom): the SDK response types assign unchanged.

/** The universe fields the spot-detail join reads. */
export interface SpotDetailPairInput {
  name: string;
  /** `[baseTokenIndex, quoteTokenIndex]` — the BASE names the pair. */
  tokens: readonly number[];
}

/** The token fields the spot-detail join reads. */
export interface SpotDetailTokenInput {
  name: string;
  index: number;
  fullName: string | null;
  evmContract: { address: string } | null;
}

/** The ctx fields the spot-detail join reads. */
export interface SpotDetailCtxInput {
  coin: string;
  markPx: string;
  prevDayPx: string;
  dayNtlVlm: string;
  circulatingSupply: string;
  totalSupply: string;
}

export interface SpotDetail {
  token: SpotTokenView | null;
  ctx: SpotCtxView | null;
  /** Null when the base token was not found — attributes cannot be invented. */
  about: AboutTokenView | null;
  /** For the hero's 24h chip when the list row is not in cache. */
  prevDayPx: string | null;
  markPx: string | null;
}

/**
 * The spot detail's sources from one `spotMetaAndAssetCtxs` response.
 *
 * Three joins, each the only one the wire allows (measured in
 * `markets/rows.ts`): the pair by its universe NAME — `@N` for most pairs but
 * the literal pair name for canonical ones (`PURR/USDC`, smoke-measured), so
 * nothing here assumes an `@` prefix — the base token by the pair's first
 * token INDEX field (never by array position, which the wire does not promise
 * to align), and the ctx by its own `coin`.
 *
 * Each absence stays its own null: a pair whose ctx is missing still names
 * its token (the tiles dash independently — the `perpStatTiles` rule), and
 * only a found base token yields an About view, because `fullName` and
 * `evmContract` live on the token and cannot be conjured from the ctx side.
 * `totalSupply` rides the CTX (the wire splits it from the token), so an
 * About view for a ctx-less pair carries it as null and `aboutRows` omits
 * the row.
 */
export function spotDetailFor(
  meta: { universe: readonly SpotDetailPairInput[]; tokens: readonly SpotDetailTokenInput[] },
  ctxs: readonly SpotDetailCtxInput[],
  wireCoin: string
): SpotDetail {
  const pair = meta.universe.find((entry) => entry.name === wireCoin) ?? null;
  const baseIndex = pair?.tokens[0];
  const token =
    baseIndex === undefined
      ? null
      : (meta.tokens.find((entry) => entry.index === baseIndex) ?? null);
  const ctx = ctxs.find((entry) => entry.coin === wireCoin) ?? null;

  return {
    token: token ? { name: token.name } : null,
    ctx: ctx
      ? {
          markPx: ctx.markPx,
          dayNtlVlm: ctx.dayNtlVlm,
          circulatingSupply: ctx.circulatingSupply,
        }
      : null,
    about: token
      ? {
          fullName: token.fullName,
          totalSupply: ctx?.totalSupply ?? null,
          evmContract: token.evmContract,
        }
      : null,
    prevDayPx: ctx?.prevDayPx ?? null,
    markPx: ctx?.markPx ?? null,
  };
}

/**
 * The catalog outcome that owns a wire coin — matched over EVERY side, not
 * just the yes side, so a detail opened on either spelling still resolves.
 * Null for an unknown coin or an unresolved (`null`) catalog; the screen
 * renders the encoding, never an invented name.
 */
export function outcomeByWireCoin<T extends { sides: readonly { wireCoin: string }[] }>(
  outcomes: readonly T[] | null,
  wireCoin: string
): T | null {
  if (outcomes === null) return null;
  for (const outcome of outcomes) {
    if (outcome.sides.some((side) => side.wireCoin === wireCoin)) return outcome;
  }
  return null;
}

/** The prediction-detail fields the tiles read. */
export interface PredictionDetailView {
  /** Both sides' volume, already BigNumber-summed by the row builder. */
  dayNtlVlm: string | null;
  quoteToken: string | null;
  venue: string | null;
}

/**
 * The prediction detail's tiles. Volume and Quote follow the tile rule (null
 * dashes, the label never vanishes); **Venue is omitted when null, not
 * dashed** — absent on 116 of 362 mainnet outcomes as ordinary metadata, so
 * a dashed Venue would present a third of all markets as failing to load a
 * field they never had. (`aboutRows` makes the same call for token
 * attributes.)
 */
export function predictionStatTiles(view: PredictionDetailView): StatTile[] {
  const tiles: StatTile[] = [
    { label: "24h volume", value: view.dayNtlVlm === null ? null : usdOrNull(view.dayNtlVlm) },
    { label: "Quote", value: view.quoteToken },
  ];
  if (view.venue !== null) {
    tiles.push({ label: "Venue", value: view.venue });
  }
  return tiles;
}

/** A sparkline point in livechart's shape: seconds, and a display-leaf Number. */
export interface SparkPoint {
  time: number;
  value: number;
}

/** The sparkline's window: 24 hourly closes. */
export const SPARK_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Hourly closes as static-sparkline points. Milliseconds become seconds
 * (livechart's clock) and the wire string becomes a Number at this sanctioned
 * display leaf. A non-finite close drops its point — a sparkline with a hole
 * beats one spiked to zero.
 */
export function toSparkPoints(closes: readonly (readonly [number, string])[]): SparkPoint[] {
  const points: SparkPoint[] = [];
  for (const [timeMs, close] of closes) {
    const value = Number(close);
    if (!Number.isFinite(value)) continue;
    points.push({ time: timeMs / 1000, value });
  }
  return points;
}
