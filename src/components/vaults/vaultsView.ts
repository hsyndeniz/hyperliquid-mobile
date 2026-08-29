/**
 * Vaults screen logic — strings and tones, computed where Jest can reach.
 *
 * The rendering rules the vault wire imposes, restated at the edge:
 *
 * - **`ApproximateNumber`s render as approximations.** `apr`, commissions and
 *   margins arrive float-damaged; they are formatted with a `≈` and coloured
 *   only by raw sign at this display leaf — never signed, summed or compared
 *   upstream (the brand forbids it).
 * - **`unknown` lockup is not `unlocked`.** The two render differently and
 *   only one of them permits a withdrawal.
 * - **Countdowns count toward a server timestamp.** The house rule against
 *   relative time ("x ago") is about the server clock LEADING the device's;
 *   a future countdown to an absolute server stamp is the safe direction,
 *   and past the stamp it says "unlocking…" rather than counting up.
 * - **A flat series is not a line.** {@link pnlSpark} refuses one outright
 *   rather than drawing a mid-height rule, because a rule reads as "steady"
 *   where the truth is "nothing happened at all".
 */

import type { Tone } from "@/components/account/accountView";
import type { LockupState } from "@/hyperliquid/vaults/lockup";
import type { FollowerPage, FollowerRow } from "@/hyperliquid/vaults/types";

/** One day. Shared so the age label and the caller's clock floor agree. */
export const DAY_MS = 86_400_000;

export interface StatusLine {
  label: string;
  tone: Tone;
}

/** `≈ 12.4%` from a float-damaged APR, coloured at the leaf. `--` for null. */
export function aprLabel(apr: string | null): StatusLine {
  if (apr === null) return { label: "--", tone: "muted" };
  const value = Number(apr);
  if (!Number.isFinite(value)) return { label: "--", tone: "muted" };
  const percent = (value * 100).toFixed(1);
  if (value > 0) return { label: `≈ ${percent}%`, tone: "success" };
  if (value < 0) return { label: `≈ ${percent}%`, tone: "danger" };
  return { label: "≈ 0.0%", tone: "muted" };
}

/** `≈ 10%` for a leader commission. `--` when unread, `0%` is a real answer. */
export function commissionLabel(commission: string | null): string {
  if (commission === null) return "--";
  const value = Number(commission);
  if (!Number.isFinite(value)) return "--";
  return `≈ ${(value * 100).toFixed(0)}%`;
}

/** `2 d 4 h` / `3 h 12 m` / `45 m` / `under a minute`. */
export function remainingLabel(remainingMs: number): string {
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 1) return "under a minute";
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${mins} m`;
  return `${mins} m`;
}

/**
 * The lockup as a chip. `unknown` is its own state — rendering it as either
 * of the others would be a guess about whether money can move.
 */
export function lockupLine(lockup: LockupState): StatusLine {
  switch (lockup.kind) {
    case "unlocked":
      return { label: "Unlocked", tone: "success" };
    case "locked":
      // At the boundary the server may still hold the lock for a beat —
      // "unlocking" is honest where a count-up would read as a defect.
      return lockup.remainingMs <= 0
        ? { label: "Unlocking…", tone: "warning" }
        : { label: `Locked · ${remainingLabel(lockup.remainingMs)}`, tone: "warning" };
    case "unknown":
      return { label: "Lockup unknown", tone: "muted" };
  }
}

/** `Mar 2025` from the directory's creation stamp. `null` for a zero stamp. */
export function sinceLabel(createdAtMs: number): string | null {
  if (createdAtMs <= 0) return null;
  const date = new Date(createdAtMs);
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][date.getUTCMonth()];
  return `${month} ${date.getUTCFullYear()}`;
}

/**
 * `1199 days old` — how long the vault has existed, from the directory stamp.
 *
 * Day-granular on purpose: the caller floors its clock to the day before
 * passing `nowMs`, so a list of cards does not re-render four times a minute
 * for a label that can only change at midnight.
 *
 * Three refusals, each a different absence:
 * - a **zero stamp** is the directory's "unknown", not 1970 — dating it would
 *   print "20000 days old" on every vault whose stamp failed to parse;
 * - a **future stamp** is clock skew or a corrupt entry, and neither deserves
 *   a negative day count;
 * - **under a day** says so in words. `Math.floor` would say "0 days old",
 *   which reads as a defect rather than as a brand-new vault.
 */
export function ageLabel(createdAtMs: number, nowMs: number): string | null {
  if (createdAtMs <= 0) return null;
  const elapsedMs = nowMs - createdAtMs;
  if (elapsedMs < 0) return null;
  const days = Math.floor(elapsedMs / DAY_MS);
  if (days < 1) return "less than a day old";
  return days === 1 ? "1 day old" : `${days} days old`;
}

/** A sparkline point in livechart's shape. See {@link pnlSpark} on the x unit. */
export interface PnlSparkPoint {
  time: number;
  value: number;
}

export interface PnlSpark {
  points: readonly PnlSparkPoint[];
  /** livechart's `timeWindow`: the series' exact span, so it fills edge to edge. */
  window: number;
  /** livechart's `nowOverride`: the dataset's own end, never the wall clock. */
  end: number;
  /** Net direction across the whole window, for the accent colour. */
  trend: "up" | "down" | "flat";
}

/**
 * A vault's month PnL as static-sparkline points, or `null` when there is no
 * line to draw.
 *
 * **The x axis is ordinal, not a clock.** `pnls` arrives as bare decimals with
 * no timestamps and a length that varies 11–14, so the only honest spacing is
 * "one point per point". livechart types `time` as unix seconds, but with
 * `xAxis`, `badge` and `scrub` all off nothing renders a clock — the axis is a
 * pure linear map, and `window`/`end` are handed to `timeWindow`/`nowOverride`
 * so the series fills the canvas exactly (livechart's own documented
 * historical-fill pattern). Spreading the points over a real 30-day window
 * would claim a bucket size the wire never states, and draw the identical
 * geometry.
 *
 * **A flat series returns `null`.** 8 of the 18 recorded mainnet vaults have an
 * all-zero month — one of them holding $30m — and a flat line at mid-height
 * looks like a steady position rather than like no movement at all. The card
 * renders an empty gap of the same height and says why.
 *
 * `Number()` here is the sanctioned display leaf: livechart consumes IEEE
 * doubles inside a worklet and there is no BigNumber on that side. A
 * non-finite point rejects the whole series for the same reason
 * `readPeriodPnl` does — position is the axis, so a hole shifts the shape.
 */
export function pnlSpark(monthPnl: readonly string[] | null): PnlSpark | null {
  const outcome = classifySpark(monthPnl);
  return outcome.kind === "line" ? outcome.spark : null;
}

/**
 * The caption the sparkline slot wears when {@link pnlSpark} refused; `null`
 * when it did not refuse and a line is drawn instead.
 *
 * **The two refusals are different claims and must not share a caption.**
 * "Flat" is a measured fact about the vault — it traded and gained nothing.
 * "No history" is a fact about our data — the CDN entry carried no usable
 * series. Printing either one for the other is the `null != 0` rule breaking
 * in the direction that invents a measurement.
 */
export function pnlSparkAbsence(monthPnl: readonly string[] | null): string | null {
  switch (classifySpark(monthPnl).kind) {
    case "line":
      return null;
    case "flat":
      return "flat this month";
    case "absent":
      return "no P&L history";
  }
}

type SparkOutcome = { kind: "line"; spark: PnlSpark } | { kind: "flat" } | { kind: "absent" };

/** The single decision both public readers above are views onto. */
function classifySpark(monthPnl: readonly string[] | null): SparkOutcome {
  if (monthPnl === null || monthPnl.length < 2) return { kind: "absent" };

  const points: PnlSparkPoint[] = [];
  for (let index = 0; index < monthPnl.length; index += 1) {
    const value = Number(monthPnl[index]);
    if (!Number.isFinite(value)) return { kind: "absent" };
    points.push({ time: index, value });
  }

  const first = points[0].value;
  const last = points[points.length - 1].value;
  if (points.every((point) => point.value === first)) return { kind: "flat" };

  return {
    kind: "line",
    spark: {
      points,
      window: points.length - 1,
      end: points.length - 1,
      trend: last > first ? "up" : last < first ? "down" : "flat",
    },
  };
}

/** Followers count for a tile: exact, or `100+` when the page was capped. */
export function followerCountLabel(page: FollowerPage): string {
  return page.truncated ? `${page.rows.length}+` : String(page.rows.length);
}

/**
 * The follower rows worth showing: the leader pinned first, then the largest
 * of THE FETCHED PAGE by equity. The page is capped at 100 sorted ascending
 * by address, so this is honest only as "top of the first page" — the caller
 * labels it that way and shows the truncation notice.
 */
export function topFollowers(page: FollowerPage, limit: number): FollowerRow[] {
  const leader = page.rows.find((row) => row.isLeader) ?? null;
  const rest = page.rows
    .filter((row) => !row.isLeader)
    .sort((a, b) => Number(b.vaultEquity) - Number(a.vaultEquity))
    .slice(0, Math.max(0, limit - (leader ? 1 : 0)));
  return leader ? [leader, ...rest] : rest;
}

/** The monogram a vault's badge wears: first two significant characters. */
export function vaultMonogram(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}]/gu, "");
  return (cleaned.slice(0, 2) || "??").toUpperCase();
}
