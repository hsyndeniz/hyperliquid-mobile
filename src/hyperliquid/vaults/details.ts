/**
 * `vaultDetails` — the boundary where the vault wire shape stops.
 *
 * Four things this does that the obvious implementation does not, each measured
 * against live mainnet rather than read off the SDK's types:
 *
 * 1. **The response is `null` for anything that is not a vault** — HTTP 200 with
 *    a two-byte body. The SDK's own doc comment says so ("or null if the vault
 *    does not exist") while its declared return type is `Promise<VaultDetailsResponse>`
 *    with no `| null`, so the natural `data.name` throws on a mistyped address.
 *    Here `null` is a first-class answer, and it is kept distinct from a failed
 *    read: one means "not a vault", the other means "we do not know".
 * 2. **`followers` is silently truncated to 100 rows**, sorted ascending by
 *    address rather than by equity. On HLP the returned rows sum to $138.1m
 *    against a `maxDistributable` of $177.5m. Nothing may read `rows.length` as a
 *    follower count or sum `vaultEquity` as a TVL, so the truncation flag travels
 *    with the data instead of living in a comment.
 * 3. **Five fields arrive as JSON numbers, not decimal strings** — `apr`,
 *    `leaderFraction`, `leaderCommission`, `maxDistributable`, `maxWithdrawable`.
 *    `leaderFraction` was observed as `0.0016483967568351689`: seventeen
 *    significant digits, which is IEEE-754 admitting it has already lost the
 *    exact value. They become `ApproximateNumber`, which cannot be signed.
 * 4. **`maxWithdrawable` is not a withdrawal gate.** It ignores the lockup
 *    entirely and reports a follower's full equity while the funds are locked,
 *    and it is `0` whenever the request omitted `user`. The lockup lives in
 *    `lockupUntil`; see `lockup.ts`.
 */

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { weightBudget, type WeightBudget } from "@/hyperliquid/api/weightBudget";
import type { Hex } from "@/hyperliquid/types/domain";
import {
  approximate,
  type FollowerPage,
  type FollowerRow,
  type PortfolioPeriod,
  type VaultAddress,
  type VaultDetail,
  type VaultRelationship,
} from "@/hyperliquid/vaults/types";

const logger = log.child("vaults.details");

/**
 * The observed cap on `followers`.
 *
 * Not documented anywhere. Measured: HLP returns exactly 100 rows and four other
 * large vaults returned exactly 100. A page at the cap is assumed truncated,
 * which errs toward telling the user the list is partial when it is merely
 * exactly full — the harmless direction.
 */
export const FOLLOWER_PAGE_CAP = 100;

export interface VaultDetailsProbe {
  vaultDetails(params: { vaultAddress: string; user?: string }): Promise<unknown>;
}

function lower(value: unknown): Hex | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value.toLowerCase() as Hex)
    : null;
}

function str(value: unknown, fallback = "0"): string {
  return typeof value === "string" ? value : fallback;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readRelationship(raw: unknown): VaultRelationship {
  if (typeof raw !== "object" || raw === null) return { kind: "normal" };
  const record = raw as { type?: unknown; data?: unknown };

  if (record.type === "parent") {
    const children = (record.data as { childAddresses?: unknown })?.childAddresses;
    return {
      kind: "parent",
      childAddresses: Array.isArray(children) ? children.flatMap((c) => lower(c) ?? []) : [],
    };
  }
  if (record.type === "child") return { kind: "child" };
  return { kind: "normal" };
}

/**
 * One follower row.
 *
 * The leader's own row spells its address as the literal string `"Leader"` in an
 * address-typed field. That is why `user` is `Hex | null` with a separate
 * `isLeader` flag rather than a bare string: a caller comparing `user` to an
 * address would otherwise silently never match the leader.
 *
 * HLP has **no leader row at all**, so nothing may assume one exists.
 */
export function parseFollowerRow(raw: unknown): FollowerRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;

  const isLeader = row.user === "Leader";
  const user = isLeader ? null : lower(row.user);
  // Neither a resolvable address nor the leader marker: not a row we can attribute.
  if (!isLeader && !user) return null;

  return {
    user,
    isLeader,
    vaultEquity: str(row.vaultEquity),
    pnl: str(row.pnl),
    allTimePnl: str(row.allTimePnl),
    daysFollowing: int(row.daysFollowing),
    entryTimeMs: int(row.vaultEntryTime),
    lockupUntilMs: int(row.lockupUntil),
  };
}

function readFollowers(raw: unknown): FollowerPage {
  if (!Array.isArray(raw)) return { rows: [], truncated: false };
  const rows = raw.flatMap((entry) => {
    const parsed = parseFollowerRow(entry);
    return parsed ? [parsed] : [];
  });
  // Measured against the RAW length, not the parsed one: dropping an unusable row
  // must not make a truncated page look complete.
  return { rows, truncated: raw.length >= FOLLOWER_PAGE_CAP };
}

function readHistory(raw: unknown): (readonly [number, string])[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((pair) => {
    if (!Array.isArray(pair) || pair.length < 2) return [];
    const [at, value] = pair;
    if (typeof at !== "number" || typeof value !== "string") return [];
    return [[at, value] as const];
  });
}

/**
 * The portfolio histories.
 *
 * An array of `[period, data]` **pairs**, not an object map — the same shape trap
 * that produced garbage in Phase 6 when `tokenToAvailableAfterMaintenance` was
 * read with `Object.entries`. Eight periods observed: day, week, month, allTime
 * and their four `perp*` counterparts. Values are strings up to 18 significant
 * digits (`"218435639.169077009"`), so they stay strings.
 */
export function readPortfolio(raw: unknown): PortfolioPeriod[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((pair) => {
    if (!Array.isArray(pair) || pair.length < 2) return [];
    const [period, data] = pair;
    if (typeof period !== "string" || typeof data !== "object" || data === null) return [];
    const record = data as Record<string, unknown>;
    return [
      {
        period,
        accountValueHistory: readHistory(record.accountValueHistory),
        pnlHistory: readHistory(record.pnlHistory),
        vlm: str(record.vlm),
      },
    ];
  });
}

/**
 * Parse a `vaultDetails` response.
 *
 * Returns `null` when the address is not a vault — the wire's own answer, which
 * a caller must handle rather than treat as an error. Throws only when the
 * payload is a shape neither a vault nor `null`.
 */
export function parseVaultDetails(raw: unknown): VaultDetail | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") {
    throw new HlError("vaultDetails returned neither an object nor null", {
      code: "validation_error",
    });
  }
  const record = raw as Record<string, unknown>;

  const address = lower(record.vaultAddress);
  const leader = lower(record.leader);
  if (!address || !leader) {
    throw new HlError("vaultDetails returned an object with no vault address", {
      code: "validation_error",
    });
  }

  return {
    address: address as VaultAddress,
    // Verbatim, like the list: names are the identity the wire enforces, and
    // trimming them merges genuinely distinct vaults.
    name: str(record.name, ""),
    leader,
    description: str(record.description, ""),
    isClosed: record.isClosed === true,
    allowDeposits: record.allowDeposits === true,
    alwaysCloseOnWithdraw: record.alwaysCloseOnWithdraw === true,
    relationship: readRelationship(record.relationship),
    followers: readFollowers(record.followers),
    portfolio: readPortfolio(record.portfolio),
    followerState: parseFollowerRow(record.followerState),

    apr: approximate(record.apr),
    leaderFraction: approximate(record.leaderFraction),
    leaderCommission: approximate(record.leaderCommission),
    maxDistributable: approximate(record.maxDistributable),
    maxWithdrawable: approximate(record.maxWithdrawable),
  };
}

export interface VaultDetailsResult {
  /**
   * The vault, or `null` when the address is **not a vault**.
   *
   * `null` here is a fact, not a failure. It is distinguished from a deferred or
   * failed read by `deferred` — collapsing the two is how a rate-limited app
   * tells a user their vault does not exist.
   */
  value: VaultDetail | null;
  /** Set when the weight budget refused the call; `value` is then null. */
  deferred: boolean;
}

/**
 * Fetch one vault's details, through the weight budget.
 *
 * Pass `user` to populate `followerState` and to make `maxWithdrawable` mean
 * anything — without it that field is `0` on every vault.
 *
 * **This endpoint throttles hard.** Measured at roughly one call per second,
 * well below what the documented weight table implies, and retrying during the
 * penalty prolongs it. A list screen must not hydrate rows from here.
 */
export async function fetchVaultDetails(params: {
  probe: VaultDetailsProbe;
  vaultAddress: string;
  /** The viewer, for `followerState` and a meaningful `maxWithdrawable`. */
  user?: string;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<VaultDetailsResult> {
  const budget = params.budget ?? weightBudget;
  const at = (params.now ?? Date.now)();

  // Wrapped, because `tryRun` signals refusal with `null` — and `null` is ALSO
  // this endpoint's legitimate answer for "not a vault". Unwrapped, a
  // rate-limited call and a mistyped address are indistinguishable.
  const wrapped = await budget.tryRun(
    "vaultDetails",
    async () => ({
      raw: await params.probe.vaultDetails({
        vaultAddress: params.vaultAddress,
        ...(params.user ? { user: params.user } : {}),
      }),
    }),
    { now: () => at }
  );
  if (wrapped === null) return { value: null, deferred: true };

  const value = parseVaultDetails(wrapped.raw);
  logger.info("vault.details", {
    context: {
      found: value !== null,
      followers: value?.followers.rows.length ?? 0,
      truncated: value?.followers.truncated ?? false,
    },
  });
  return { value, deferred: false };
}

/**
 * Whether this vault will accept a deposit.
 *
 * Both flags, in this order, because they are **independent axes**:
 * `allowDeposits` stays `true` on the large majority of closed vaults, so it is
 * not a gate on its own. Zero TVL is a third axis and implies neither.
 */
export function acceptsDeposits(vault: VaultDetail): boolean {
  return !vault.isClosed && vault.allowDeposits;
}
