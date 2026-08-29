/**
 * Market-list rows — the pure join layer under the Markets screen.
 *
 * One response per section, and **each one joins differently**. All counts
 * measured live on testnet (2026-08-15):
 *
 * - `metaAndAssetCtxs` is index-aligned: 210 universe rows, 210 ctxs, and no
 *   key on the ctx side at all — the position IS the join. That is why a
 *   length mismatch **throws** instead of zipping short: with no key to check,
 *   a one-row gap silently dresses every later market in its neighbour's
 *   prices. 53 of the 210 are delisted; 55 carry `midPx`/`premium`/`impactPxs`
 *   co-null (no book); 63 have `dayNtlVlm === "0.0"`, which is a real zero.
 * - `spotMetaAndAssetCtxs` is NOT index-aligned: 1,309 universe rows against
 *   2,492 ctxs — 1,305 of the 1,309 same-index pairs name different markets.
 *   The extra 1,183 ctxs are 724 `#N` prediction sides plus pairs beyond the
 *   universe; the only join that works is by `ctx.coin`. `midPx` is null on
 *   1,523 of 2,492 (thin books), where the mark is the honest fallback.
 * - Prediction ctxs ride in the SAME spot response. The two sides of one
 *   market share one book — `markPx_yes + markPx_no = 1.000000` exactly — so
 *   the list shows **one row per outcome**, priced by the yes side's mark
 *   (prediction books are routinely one-sided, so a bid/ask mid is null right
 *   when a number is most needed; the mark never is). Volume is the
 *   BigNumber sum of both sides. An outcome the catalog cannot name is
 *   dropped entirely — a name may be missing, never invented.
 *
 * Every asset-id decode delegates to `core/assetIds`; nothing here does the
 * arithmetic. Wire strings stay strings — `BigNumber` for comparison and
 * arithmetic, `Number()` never.
 */

import type { BigNumber } from "bignumber.js";

import { HlError } from "@/hyperliquid/core/errors";
import { decomposeAssetId, outcomeAssetIdFromWireCoin } from "@/hyperliquid/core/assetIds";
import { toBigNumber } from "@/hyperliquid/core/precision";
import type { IPerpAssetCtx, ISpotAssetCtx } from "@/hyperliquid/types/sdk";
import type { PredictionOutcome } from "@/hyperliquid/predictions/types";

export type MarketKind = "perp" | "spot" | "prediction";

/**
 * One list row, shaped for rendering rather than for the wire.
 *
 * `null` means "this market does not have the concept" — funding on a spot
 * pair, leverage on a prediction — not "zero" and not "loading". A prediction
 * row's `szDecimals` is null because no single value exists for an outcome
 * market (price needs 1, size needs 0 — see `core/assetIds`).
 */
export interface MarketRow {
  kind: MarketKind;
  /** Display name: perp coin, spot BASE token, prediction outcome name. */
  symbol: string;
  /**
   * The spelling every feed uses for this market: `BTC`, `@107`, `#102380`.
   * For a prediction this is the YES side — the side the row prices and the
   * side a detail chart plots.
   */
  wireCoin: string;
  /** The price the row shows: mid when the book has one, else mark. */
  px: string;
  markPx: string;
  midPx: string | null;
  prevDayPx: string;
  /** For a prediction: both sides' volume, BigNumber-summed. */
  dayNtlVlm: string;
  funding: string | null;
  openInterest: string | null;
  maxLeverage: number | null;
  szDecimals: number | null;
  isDelisted: boolean;
  /** The priced side's name on a prediction row (`"Yes"`); null elsewhere. */
  sideName: string | null;
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------
// Structural subsets of the SDK responses, listing only the fields consumed.
// The full `IMetaAndAssetCtxsResponse` / `ISpotMetaAndAssetCtxsResponse`
// tuples assign to these unchanged; fixtures and probes carry no more than
// this either.

export interface PerpUniverseInput {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
}

export type PerpCtxInput = Pick<
  IPerpAssetCtx,
  "prevDayPx" | "dayNtlVlm" | "markPx" | "midPx" | "funding" | "openInterest"
>;

export type PerpCtxsInput = readonly [
  meta: { universe: readonly PerpUniverseInput[] },
  ctxs: readonly PerpCtxInput[],
];

export interface SpotPairInput {
  name: string;
  /** `[baseTokenIndex, quoteTokenIndex]` — the BASE names the row. */
  tokens: readonly number[];
}

export interface SpotTokenInput {
  name: string;
  index: number;
  szDecimals: number;
}

export type SpotCtxInput = Pick<
  ISpotAssetCtx,
  "coin" | "prevDayPx" | "dayNtlVlm" | "markPx" | "midPx"
>;

export type SpotCtxsInput = readonly [
  meta: { universe: readonly SpotPairInput[]; tokens: readonly SpotTokenInput[] },
  ctxs: readonly SpotCtxInput[],
];

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export interface BuildPerpRowsOptions {
  /**
   * Keep delisted markets (53 of 210 live). Off by default: a delisted perp
   * cannot be traded and its ctx is a fossil — `midPx`/`premium`/`impactPxs`
   * co-null, volume `"0.0"`. The row keeps `isDelisted` either way.
   */
  includeDelisted?: boolean;
}

/**
 * Perp rows from `metaAndAssetCtxs`, joined **by index**.
 *
 * @throws {HlError} `validation_error` when the two sides differ in length.
 *   Measured 210/210; a mismatch means the positional join is misattributing
 *   prices to markets, which no row of output should survive.
 */
export function buildPerpRows(
  response: PerpCtxsInput,
  options: BuildPerpRowsOptions = {}
): MarketRow[] {
  const [meta, ctxs] = response;
  if (meta.universe.length !== ctxs.length) {
    throw new HlError("metaAndAssetCtxs universe and ctxs lengths differ", {
      code: "validation_error",
      context: { universe: meta.universe.length, ctxs: ctxs.length },
    });
  }

  const rows: MarketRow[] = [];
  for (let i = 0; i < meta.universe.length; i += 1) {
    const entry = meta.universe[i];
    const ctx = ctxs[i];
    const isDelisted = entry.isDelisted === true;
    if (isDelisted && options.includeDelisted !== true) continue;
    rows.push({
      kind: "perp",
      symbol: entry.name,
      wireCoin: entry.name,
      px: ctx.midPx ?? ctx.markPx,
      markPx: ctx.markPx,
      midPx: ctx.midPx,
      prevDayPx: ctx.prevDayPx,
      dayNtlVlm: ctx.dayNtlVlm,
      funding: ctx.funding,
      openInterest: ctx.openInterest,
      maxLeverage: entry.maxLeverage,
      szDecimals: entry.szDecimals,
      isDelisted,
      sideName: null,
    });
  }
  return rows;
}

export interface SpotRowsResult {
  spot: MarketRow[];
  /** The `#N` prediction ctxs, keyed by wire coin, for {@link buildPredictionRows}. */
  predictionCtxs: Map<string, SpotCtxInput>;
}

/**
 * Spot rows from `spotMetaAndAssetCtxs`, joined **by `ctx.coin`** — never by
 * index (1,305 of 1,309 same-index pairs disagree).
 *
 * One pass over the ctxs routes `#N` prediction sides into a map — they
 * arrive in this response, so predictions cost no extra read — and everything
 * else into a coin-keyed lookup for the universe join. A pair's display name
 * is its BASE token's (`@107` → `HYPE`), the same universe/token join
 * `hooks/prices.ts` uses; a universe row whose ctx or base token is missing
 * is skipped rather than rendered priceless (measured 0 of 1,309 missing).
 */
export function buildSpotRows(response: SpotCtxsInput): SpotRowsResult {
  const [meta, ctxs] = response;

  const predictionCtxs = new Map<string, SpotCtxInput>();
  const ctxByCoin = new Map<string, SpotCtxInput>();
  for (const ctx of ctxs) {
    if (ctx.coin.startsWith("#")) predictionCtxs.set(ctx.coin, ctx);
    else ctxByCoin.set(ctx.coin, ctx);
  }

  const tokensByIndex = new Map<number, SpotTokenInput>();
  for (const token of meta.tokens) tokensByIndex.set(token.index, token);

  const spot: MarketRow[] = [];
  for (const pair of meta.universe) {
    const ctx = ctxByCoin.get(pair.name);
    if (ctx === undefined) continue;
    const baseIndex = pair.tokens[0];
    const base = typeof baseIndex === "number" ? tokensByIndex.get(baseIndex) : undefined;
    if (base === undefined) continue;
    spot.push({
      kind: "spot",
      symbol: base.name,
      wireCoin: pair.name,
      px: ctx.midPx ?? ctx.markPx,
      markPx: ctx.markPx,
      midPx: ctx.midPx,
      prevDayPx: ctx.prevDayPx,
      dayNtlVlm: ctx.dayNtlVlm,
      funding: null,
      openInterest: null,
      maxLeverage: null,
      szDecimals: base.szDecimals,
      isDelisted: false,
      sideName: null,
    });
  }
  return { spot, predictionCtxs };
}

/**
 * One row per prediction OUTCOME, from the `#N` ctxs and the catalog.
 *
 * The yes side (side 0) prices the row: its mark is the probability, and the
 * two marks sum to exactly 1, so the no side adds no information — only its
 * volume, which is summed in. Dropped entirely, never renamed:
 *
 * - an outcome the catalog does not list (settled outcomes are deleted from
 *   `outcomeMeta`, so their ctxs can outlive their names);
 * - an outcome the catalog lists without a name;
 * - an outcome whose side-0 ctx is absent, because without the yes mark the
 *   row has no honest price.
 */
export function buildPredictionRows(
  predictionCtxs: ReadonlyMap<string, SpotCtxInput>,
  catalog: { outcomes: readonly PredictionOutcome[] }
): MarketRow[] {
  const outcomesById = new Map<number, PredictionOutcome>();
  for (const outcome of catalog.outcomes) outcomesById.set(outcome.outcomeId, outcome);

  // Group sides by outcome. The decode goes through `core/assetIds` — the
  // `#N` payload is `outcomeId * 10 + sideIndex`, and that arithmetic must
  // not be re-derived here.
  const sidesByOutcome = new Map<
    number,
    { sideIndex: number; coin: string; ctx: SpotCtxInput }[]
  >();
  for (const [coin, ctx] of predictionCtxs) {
    const assetId = outcomeAssetIdFromWireCoin(coin);
    if (assetId === undefined) continue;
    const decoded = decomposeAssetId(assetId);
    if (decoded.kind !== "outcome") continue;
    const group = sidesByOutcome.get(decoded.outcomeId);
    const side = { sideIndex: decoded.sideIndex, coin, ctx };
    if (group === undefined) sidesByOutcome.set(decoded.outcomeId, [side]);
    else group.push(side);
  }

  const rows: MarketRow[] = [];
  for (const [outcomeId, sides] of sidesByOutcome) {
    const outcome = outcomesById.get(outcomeId);
    if (outcome === undefined || outcome.name === "") continue;
    const yes = sides.find((side) => side.sideIndex === 0);
    if (yes === undefined) continue;

    let volume = toBigNumber(0);
    for (const side of sides) {
      const sideVolume = toBigNumber(side.ctx.dayNtlVlm);
      if (sideVolume.isFinite()) volume = volume.plus(sideVolume);
    }

    rows.push({
      kind: "prediction",
      symbol: outcome.name,
      wireCoin: yes.coin,
      px: yes.ctx.markPx,
      markPx: yes.ctx.markPx,
      midPx: yes.ctx.midPx,
      prevDayPx: yes.ctx.prevDayPx,
      dayNtlVlm: volume.toFixed(),
      funding: null,
      openInterest: null,
      maxLeverage: null,
      szDecimals: null,
      isDelisted: false,
      sideName: outcome.sides.find((side) => side.sideIndex === 0)?.name ?? null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Derivations over rows
// ---------------------------------------------------------------------------

/**
 * 24h change as a percentage string, or `null` when it cannot be known.
 *
 * `prevDayPx` is `"0.0"` on a market that did not exist yesterday; dividing
 * by it would claim an infinite rally, and substituting `"0.00"` would claim
 * the price never moved. Both are lies — `null` renders as `--`.
 */
export function change24hPct(px: string | null, prevDayPx: string | null): string | null {
  if (px === null || prevDayPx === null) return null;
  const prev = toBigNumber(prevDayPx);
  if (!prev.isFinite() || prev.lte(0)) return null;
  const change = toBigNumber(px).minus(prev).dividedBy(prev).times(100);
  return change.isFinite() ? change.toFixed(2) : null;
}

/**
 * Re-price rows from an `allMids` poll: `px = mids[wireCoin] ?? markPx`.
 *
 * `allMids` keys are exactly the wire spellings (211 perp + 1,767 `@N` +
 * 724 `#N` measured), so the lookup needs no translation. A coin absent from
 * the poll falls back to the snapshot's mark rather than keeping a stale mid.
 *
 * Returns the **same array reference** when no price moved, and reuses the
 * unmoved row objects otherwise — this runs on a 15 s poll over up to 1,309
 * rows, and every fresh object is a list row re-rendered for nothing.
 */
export function overlayMids(
  rows: readonly MarketRow[],
  mids: Readonly<Record<string, string>>
): readonly MarketRow[] {
  let next: MarketRow[] | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const mid = mids[row.wireCoin];
    const px = typeof mid === "string" ? mid : row.markPx;
    if (px === row.px) continue;
    if (next === null) next = rows.slice();
    next[i] = { ...row, px };
  }
  return next ?? rows;
}

/**
 * Volume descending, symbol as the tiebreak.
 *
 * The compare is BigNumber, not lexicographic — `"9.5"` sorts as a string
 * above `"1000.0"` — and the tiebreak matters at real scale: 63 of 210 perps
 * report `dayNtlVlm === "0.0"`, and without a total order they would shuffle
 * on every rebuild. Non-finite volume (unparseable, never seen on the wire)
 * sorts last. Returns a new array; the input is not touched.
 */
export function sortRows(rows: readonly MarketRow[]): MarketRow[] {
  return [...rows].sort((a, b) => {
    const va = toBigNumber(a.dayNtlVlm);
    const vb = toBigNumber(b.dayNtlVlm);
    const aFinite = va.isFinite();
    const bFinite = vb.isFinite();
    if (aFinite && bFinite) {
      const cmp = vb.comparedTo(va);
      if (cmp !== null && cmp !== 0) return cmp;
    } else if (aFinite !== bFinite) {
      return aFinite ? -1 : 1;
    }
    return a.symbol.localeCompare(b.symbol);
  });
}

/**
 * How the list is ordered. `oi` is perps-only — spot and prediction rows carry
 * `openInterest: null` because the concept does not exist there, and a section
 * that has none must not offer the mode.
 */
export type MarketSortMode = "volume" | "gainers" | "losers" | "oi";

export interface OrderedRows {
  /** The rows the list renders, in the mode's order. */
  rows: readonly MarketRow[];
  /**
   * Rows the mode could not rank, excluded from {@link OrderedRows.rows}
   * rather than sorted as zero. The header states the shortfall
   * ("153 of 210 ranked") so the missing markets are announced, not hidden.
   */
  unranked: readonly MarketRow[];
}

/** One shared empty tail, so the volume path allocates nothing per render. */
const NO_ROWS: readonly MarketRow[] = [];

/**
 * The ranking key, or `null` for "this row cannot be ranked by this mode".
 *
 * Every input is a SNAPSHOT field. Ranking on a live mid would re-sort the
 * list under the user's finger every 15 s poll — the same rule that keeps
 * `sortRows` snapshot-bound, restated for the modes that rank on price.
 */
function rankValue(row: MarketRow, mode: MarketSortMode): BigNumber | null {
  if (mode === "oi") {
    // Notional, not contracts: 7,055 SOL and 7,055 BTC are three orders of
    // magnitude apart, and an OI list ordered by contract count would put the
    // cheapest market on top.
    if (row.openInterest === null) return null;
    const notional = toBigNumber(row.openInterest).times(toBigNumber(row.markPx));
    return notional.isFinite() ? notional : null;
  }
  const pct = change24hPct(row.px, row.prevDayPx);
  if (pct === null) return null;
  const value = toBigNumber(pct);
  return value.isFinite() ? value : null;
}

/**
 * Reorder a section for the active sort mode.
 *
 * `volume` returns the **input array reference** unchanged: the hook already
 * volume-sorted the section once per TTL (`sortRows`), and handing back a
 * fresh array would defeat every identity check downstream — `filterRows`'s
 * blank-query passthrough, `overlayMids`'s unmoved-row reuse, and the list's
 * own data comparison.
 *
 * The other modes rank on snapshot fields and drop what they cannot rank:
 * 55 of 210 perp ctxs arrive with a co-null mid and a fresh listing has
 * `prevDayPx === "0.0"`, so `change24hPct` is null for real markets. Sorting
 * those as zero would seat them in the middle of the gainers list as if the
 * exchange had reported a flat day.
 *
 * `symbol.localeCompare` breaks every tie, for the reason `sortRows`
 * documents: 63 of 210 perps report exactly `"0.0"` volume, and a partial
 * order shuffles them on each rebuild.
 */
export function orderRows(rows: readonly MarketRow[], mode: MarketSortMode): OrderedRows {
  if (mode === "volume") return { rows, unranked: NO_ROWS };

  const ranked: { row: MarketRow; value: BigNumber }[] = [];
  const unranked: MarketRow[] = [];
  for (const row of rows) {
    const value = rankValue(row, mode);
    if (value === null) unranked.push(row);
    else ranked.push({ row, value });
  }

  ranked.sort((a, b) => {
    const cmp = mode === "losers" ? a.value.comparedTo(b.value) : b.value.comparedTo(a.value);
    if (cmp !== null && cmp !== 0) return cmp;
    return a.row.symbol.localeCompare(b.row.symbol);
  });

  return { rows: ranked.map((entry) => entry.row), unranked };
}

/**
 * Case-insensitive match over `symbol` and `sideName`.
 *
 * A blank query returns the input array unchanged (same reference) — this
 * runs on every keystroke, and the empty state must not rebuild the list.
 */
export function filterRows(rows: readonly MarketRow[], query: string): readonly MarketRow[] {
  const q = query.trim().toLowerCase();
  if (q === "") return rows;
  return rows.filter(
    (row) =>
      row.symbol.toLowerCase().includes(q) ||
      (row.sideName !== null && row.sideName.toLowerCase().includes(q))
  );
}
