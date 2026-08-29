/**
 * The market list's pure display decisions — formatting only.
 *
 * Row *building* (joins, sorting, filtering) lives in `hyperliquid/markets`;
 * this module turns already-chosen wire strings into the exact text and
 * animation cues the list renders. It lives beside `fetchedView.ts` for the
 * same reason that file does: importing a component under Jest drags in
 * Reanimated/Worklets/Skia, none of which load there, so the logic with rules
 * in it is a `.ts` module and the markup stays markup.
 *
 * Two wire facts drive the null rules:
 * - `change24hPct` is null-honest upstream: 55/210 perp ctxs arrive with
 *   co-null `midPx`, and a fresh listing has no `prevDayPx` to change *from*.
 *   Null renders as `"--"`, never as a fake `0.00%`.
 * - A prediction side's `markPx` IS its probability (price of a share paying
 *   0 or 1), and the two sides of one book sum to exactly `1.000000` —
 *   measured on all 8 live mainnet pairs.
 */

import { BigNumber } from "bignumber.js";

import { toBigNumber } from "@/hyperliquid/core/precision";
import { change24hPct, type MarketRow, type MarketSortMode } from "@/hyperliquid/markets/rows";

/**
 * A signed 24h percent change, two places — `"2.33"` → `"+2.33%"`,
 * `"-1.5"` → `"-1.50%"`.
 *
 * The `+` is explicit: on a list where gains and losses interleave, an
 * unsigned gain reads as a label, not a direction. A genuine zero shows
 * unsigned as `"0.00%"` — no direction to claim. Null and malformed input
 * render as `"--"`, because "unknowable" printed as a percent is a lie.
 */
export function formatChangePct(pct: string | null): string {
  if (pct === null) return "--";
  const value = toBigNumber(pct);
  if (!value.isFinite()) return "--";
  const fixed = value.toFixed(2);
  return value.gt(0) ? `+${fixed}%` : `${fixed}%`;
}

/**
 * A prediction side's price as its probability — `"0.624"` → `"62.4%"`.
 *
 * One decimal, always: outcome prices carry 5 decimals on the wire and a
 * whole-percent round would collapse adjacent markets into the same number,
 * while the full five would print noise. Null (side absent from the ctx map,
 * or the read has not landed) renders as `"--"` — never `"0%"`, which would
 * assert an impossibility the market did not state.
 */
export function probabilityPct(markPx: string | null): string {
  if (markPx === null) return "--";
  const price = toBigNumber(markPx);
  if (!price.isFinite()) return "--";
  return `${price.multipliedBy(100).toFixed(1)}%`;
}

/**
 * A probability's 24h move in percentage POINTS — `("0.624", "0.55")` →
 * `"+7.4 pts"`.
 *
 * Points, deliberately not percent change: a move from 2% to 4% is "+100%"
 * relative, which reads as a certainty doubling rather than a 2-point drift.
 * Points are how a probability's movement is honestly stated.
 *
 * `"--"` when either end is missing or malformed — a fresh listing has no
 * previous day to move from, and inventing one as zero would print a fake
 * flat. A genuine zero move shows unsigned as `"0.0 pts"`.
 */
export function formatProbabilityChangePts(
  markPx: string | null,
  prevDayPx: string | null
): string {
  if (markPx === null || prevDayPx === null) return "--";
  const now = toBigNumber(markPx);
  const prev = toBigNumber(prevDayPx);
  if (!now.isFinite() || !prev.isFinite()) return "--";
  const points = now.minus(prev).multipliedBy(100);
  const fixed = points.toFixed(1);
  return points.gt(0) ? `+${fixed} pts` : `${fixed} pts`;
}

/**
 * Fraction-digit count of the wire string ITSELF — `"63645.0"` → 1,
 * `"0.624"` → 3, `"12"` → 0.
 *
 * This pins NumberFlow's fraction digits to the precision the exchange
 * actually quoted. Deriving digits from the parsed number instead strips the
 * trailing zero (`63645.0` → `63645`), so the display width jumps whenever a
 * price crosses a round number and the rolling digits jitter. The wire
 * string's own shape is the only stable source of that width.
 *
 * Anything that is not a plain decimal (empty, malformed, exponent form —
 * which the wire never sends) counts as 0 rather than guessing.
 */
export function decimalsOf(wire: string): number {
  const match = /^-?\d+\.(\d+)$/.exec(wire);
  return match ? match[1]!.length : 0;
}

/**
 * Which way a price flash should point, or null for "do not flash".
 *
 * BigNumber compare, never string compare: the wire legitimately re-spells a
 * value (`"1.0"` vs `"1"`, a mid recomputed to the same level), and a string
 * inequality would flash a price that did not move.
 *
 * Null on first render (`prev === null`) — there is no direction from
 * nowhere, and a mount-time flash claims a move nobody saw. Null on equal or
 * on malformed input for the same reason: a flash is an assertion.
 */
export function flashDirection(prev: string | null, next: string): "up" | "down" | null {
  if (prev === null) return null;
  const cmp = toBigNumber(next).comparedTo(toBigNumber(prev));
  if (cmp === null || cmp === 0) return null;
  return cmp > 0 ? "up" : "down";
}

/**
 * The direction a 24h change chip should claim, or null for "no claim".
 *
 * Shared by the price rows (percent) and the prediction rows (points): both
 * chips colour by the same day-over-day comparison, and both must stay silent
 * when either end is missing or malformed — the caller renders `"--"` with no
 * chip, because a coloured chip around dashes still claims a direction.
 * BigNumber compare for the same reason as {@link flashDirection}: the wire
 * re-spells values, and a string compare would colour a flat market.
 *
 * The chip is only rendered when its LABEL exists (`formatChangePct` /
 * `formatProbabilityChangePts` returned text), so cases those functions
 * refuse — a `prevDayPx` of `"0.0"` on a fresh price listing — never consult
 * this.
 */
export function changeTrend(
  px: string | null,
  prevDayPx: string | null
): "up" | "down" | "neutral" | null {
  if (px === null || prevDayPx === null) return null;
  const cmp = toBigNumber(px).comparedTo(toBigNumber(prevDayPx));
  if (cmp === null) return null;
  return cmp > 0 ? "up" : cmp < 0 ? "down" : "neutral";
}

/**
 * A USD figure at list scale — `"2140000000"` → `"$2.14B"`, `"288129.86"` →
 * `"$288.12K"`, `"0.0"` → `"$0"`.
 *
 * Two decimals, rounded DOWN, trailing zeros trimmed. Down for the reason
 * `fetchedView.compactUsd` states — a total is never overstated — but NOT that
 * function: it fixes one decimal because a fee ladder's cutoffs are round
 * numbers, and widening it would rewrite the fee card's copy. Two decimals is
 * what keeps the exchange total ("$2.14B") and the row it summarises
 * ("$288.12K vol") legible as the same quantity orders of magnitude apart.
 *
 * Malformed input renders `"--"`. A volume that could not be read is not a
 * market that did not trade.
 */
export function formatCompactUsd(value: string | BigNumber): string {
  const amount = toBigNumber(value);
  if (!amount.isFinite()) return "--";
  const unit = (divisor: number, suffix: string): string =>
    `$${amount.dividedBy(divisor).decimalPlaces(2, BigNumber.ROUND_DOWN).toFixed()}${suffix}`;
  if (amount.gte(1e9)) return unit(1e9, "B");
  if (amount.gte(1e6)) return unit(1e6, "M");
  if (amount.gte(1e3)) return unit(1e3, "K");
  return `$${amount.decimalPlaces(2, BigNumber.ROUND_DOWN).toFixed()}`;
}

/**
 * The row subtitle: the metric the list is CURRENTLY ordered by, stated on
 * every row so the ordering is legible rather than inferred.
 *
 * Under `gainers`/`losers` this is the percent change for every kind,
 * predictions included — even though a prediction row's own chip states its
 * move in POINTS. The subtitle names the sort KEY, and `orderRows` ranks on
 * `change24hPct`; printing points here would show a list whose numbers do not
 * descend and read as a sorting bug.
 *
 * `oi` on a row with no open interest renders `"-- OI"`, never `"$0 OI"` —
 * spot and prediction rows carry `openInterest: null` because the concept does
 * not exist there. The mode is perps-only in the UI, so this is the total
 * function's honest edge rather than a state the list reaches.
 */
export function rowMetric(row: MarketRow, mode: MarketSortMode): string {
  switch (mode) {
    case "volume":
      return `${formatCompactUsd(row.dayNtlVlm)} vol`;
    case "gainers":
    case "losers":
      return `${formatChangePct(change24hPct(row.px, row.prevDayPx))} 24h`;
    case "oi":
      return row.openInterest === null
        ? "-- OI"
        : `${formatCompactUsd(toBigNumber(row.openInterest).times(toBigNumber(row.markPx)))} OI`;
  }
}

export interface MarketsSummary {
  /** Every row the section holds, before search and before ranking. */
  all: readonly MarketRow[];
  /** How many rows the list will actually render. */
  shown: number;
  /** How many rows the active sort could not rank. */
  unranked: number;
  query: string;
}

/**
 * The muted line under the title: what is on screen right now.
 *
 * Three shapes, in precedence order, because three different questions are
 * being answered:
 *
 * - searching → `"3 of 210 markets"`. The count the user is looking at against
 *   the count they filtered.
 * - a sort excluded rows → `"153 of 210 ranked"`. `orderRows` drops what it
 *   cannot rank rather than seating it at zero, and a list 57 rows shorter
 *   than its section must SAY so — an unexplained shortfall reads as data loss.
 * - otherwise → `"210 markets · $2.14B 24h volume"`.
 *
 * `null` for an empty section: the list's own empty state already says it, and
 * "0 markets" under the title states the same absence twice. A section still
 * loading never reaches here — the caller renders a skeleton, because "0
 * markets" during a cold mount is a claim about the exchange, not about the
 * read.
 *
 * The volume total is summed as BigNumber and only in the branch that prints
 * it: this runs on every keystroke over up to 1,309 rows, and the searching
 * branch needs no total.
 */
export function summarizeMarkets({ all, shown, unranked, query }: MarketsSummary): string | null {
  const total = all.length;
  if (total === 0) return null;
  if (query.trim() !== "") return `${shown} of ${total} markets`;
  if (unranked > 0) return `${shown} of ${total} ranked`;

  let volume = toBigNumber(0);
  for (const row of all) {
    const day = toBigNumber(row.dayNtlVlm);
    // A row whose volume will not parse is skipped, not counted as zero: the
    // total is a sum of what the exchange reported, not of what it might have.
    if (day.isFinite()) volume = volume.plus(day);
  }
  return `${total} ${total === 1 ? "market" : "markets"} · ${formatCompactUsd(volume)} 24h volume`;
}

/**
 * Which section a wire spelling belongs to — the routing rule for a detail
 * screen opened by coin alone (a deep link may carry no `kind` param).
 *
 * Measured spellings, never guessed: perps are bare tickers (`BTC`),
 * prediction sides are `#N`, and spot pairs are `@N` — EXCEPT canonical
 * pairs, which use the literal pair name as their wire coin (`PURR/USDC`,
 * smoke-measured on testnet). The `/` test is what keeps canonical spot
 * pairs out of the perp branch; no branch may assume every spot coin is
 * `@`-prefixed.
 */
export function kindOfWireCoin(wireCoin: string): "perp" | "spot" | "prediction" {
  if (wireCoin.startsWith("#")) return "prediction";
  if (wireCoin.startsWith("@") || wireCoin.includes("/")) return "spot";
  return "perp";
}

/**
 * The home strip's three headliners: highest volume, biggest riser, biggest
 * faller — deduped in that priority order, so a coin that is both the volume
 * leader and the top gainer appears once and the next-best gainer is NOT
 * promoted (three near-identical cards would say less than two distinct ones).
 *
 * Rows with a null 24h change cannot be a riser or faller — a fresh listing
 * with no `prevDayPx` is unknowable, not flat — and rows are compared with
 * BigNumber because volumes differ across nine orders of magnitude.
 */
export interface MarketHighlight {
  row: MarketRow;
  role: "Top volume" | "Top gainer" | "Top loser";
}

export function selectHighlights(rows: readonly MarketRow[]): MarketHighlight[] {
  let topVolume: MarketRow | null = null;
  let topGainer: { row: MarketRow; pct: BigNumber } | null = null;
  let topFaller: { row: MarketRow; pct: BigNumber } | null = null;

  for (const row of rows) {
    const volume = toBigNumber(row.dayNtlVlm);
    if (volume.isFinite() && (topVolume === null || volume.gt(toBigNumber(topVolume.dayNtlVlm)))) {
      topVolume = row;
    }
    const pct = change24hPct(row.px ?? row.markPx, row.prevDayPx);
    if (pct === null) continue;
    const value = toBigNumber(pct);
    if (!value.isFinite()) continue;
    if (value.gt(0) && (topGainer === null || value.gt(topGainer.pct))) {
      topGainer = { row, pct: value };
    }
    if (value.lt(0) && (topFaller === null || value.lt(topFaller.pct))) {
      topFaller = { row, pct: value };
    }
  }

  const picks: MarketHighlight[] = [];
  const candidates: [MarketRow | null, MarketHighlight["role"]][] = [
    [topVolume, "Top volume"],
    [topGainer?.row ?? null, "Top gainer"],
    [topFaller?.row ?? null, "Top loser"],
  ];
  for (const [candidate, role] of candidates) {
    if (candidate === null) continue;
    if (picks.some((pick) => pick.row.wireCoin === candidate.wireCoin)) continue;
    picks.push({ row: candidate, role });
  }
  return picks;
}
