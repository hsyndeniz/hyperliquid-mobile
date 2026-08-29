/**
 * A user's positions **in** vaults — the follower side.
 *
 * Two sources, and they are not interchangeable:
 *
 * 1. **`userVaultEquities`** (HTTP) — the per-vault breakdown: address, equity,
 *    unlock timestamp. This is the only source of the lockup, so it is the only
 *    source that can gate a withdrawal.
 * 2. **`webData3`** (websocket, ~4–5 s) — the **aggregate only**.
 *    `perpDexStates[0].totalVaultEquity` arrives as a *string* and was measured
 *    equal to the sum of `userVaultEquities` to within mark-to-market drift
 *    (`599637.071547` against `599637.131483`, ~2 s apart). There is no per-vault
 *    breakdown in it, no pnl, and no lockup.
 *
 * So the useful pattern is: poll `userVaultEquities` for the breakdown, and let
 * `webData3` keep the headline number live between polls. The value is a
 * continuous mark-to-market — it moves on essentially every sample — so a
 * polling interval *is* the staleness bound, and there is no "unchanged" state to
 * wait for.
 *
 * `userVaultEquities` answers `[]`, never `null`, for a user with no positions.
 * That is the opposite of `subAccounts2`, which uses `null` for "none" — the two
 * sit one phase apart and disagree, so neither convention may be assumed.
 */

import { BigNumber } from "bignumber.js";

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { weightBudget, type WeightBudget } from "@/hyperliquid/api/weightBudget";
import type { Hex } from "@/hyperliquid/types/domain";
import { lockupState, type LockupState } from "@/hyperliquid/vaults/lockup";
import type { VaultAddress, VaultPosition } from "@/hyperliquid/vaults/types";

const logger = log.child("vaults.equities");

export interface VaultEquitiesProbe {
  userVaultEquities(params: { user: string }): Promise<unknown>;
}

/** Parse one `userVaultEquities` row, or `null` if it is unusable. */
export function parseVaultPosition(raw: unknown): VaultPosition | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;

  const vault =
    typeof row.vaultAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(row.vaultAddress)
      ? (row.vaultAddress.toLowerCase() as Hex)
      : null;
  if (!vault) return null;

  return {
    vault: vault as VaultAddress,
    // A string on the wire and kept one: equities run to twelve significant
    // digits on real accounts and a double would drop the tail silently.
    equity: typeof row.equity === "string" ? row.equity : "0",
    lockedUntilMs:
      typeof row.lockedUntilTimestamp === "number" && Number.isFinite(row.lockedUntilTimestamp)
        ? row.lockedUntilTimestamp
        : 0,
  };
}

/**
 * Parse a whole `userVaultEquities` response.
 *
 * `null` is tolerated and coalesced to `[]` even though the endpoint has never
 * been observed sending it — the sibling endpoint one phase away *does* use
 * `null` for "none", and the cost of being wrong here is a crash at launch.
 */
export function parseVaultPositions(raw: unknown): VaultPosition[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new HlError("userVaultEquities returned neither an array nor null", {
      code: "validation_error",
    });
  }
  return raw.flatMap((row) => {
    const parsed = parseVaultPosition(row);
    return parsed ? [parsed] : [];
  });
}

export interface VaultPositionsResult {
  /** `null` only when the weight budget refused — never for "has none". */
  value: VaultPosition[] | null;
  deferred: boolean;
}

/** Fetch a user's vault positions, through the weight budget. */
export async function fetchVaultPositions(params: {
  probe: VaultEquitiesProbe;
  user: string;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<VaultPositionsResult> {
  const budget = params.budget ?? weightBudget;
  const at = (params.now ?? Date.now)();

  // Wrapped for the same reason as everywhere else in this phase: `tryRun`
  // signals refusal with `null`, and an empty result must stay distinguishable
  // from a refused call.
  const wrapped = await budget.tryRun(
    "userVaultEquities",
    async () => ({ raw: await params.probe.userVaultEquities({ user: params.user }) }),
    { now: () => at }
  );
  if (wrapped === null) return { value: null, deferred: true };

  const value = parseVaultPositions(wrapped.raw);
  logger.info("vaults.positions", { context: { count: value.length } });
  return { value, deferred: false };
}

/** A position with its lockup already classified. */
export interface HeldVaultPosition extends VaultPosition {
  lockup: LockupState;
}

/** Attach lockup state, so no caller re-derives it from the raw timestamp. */
export function withLockup(
  positions: readonly VaultPosition[],
  now: number = Date.now()
): HeldVaultPosition[] {
  return positions.map((position) => ({
    ...position,
    lockup: lockupState(position.lockedUntilMs, now),
  }));
}

/**
 * Total equity across every vault, as an exact decimal string.
 *
 * BigNumber, not a float sum: individual equities carry twelve significant
 * digits and adding them as doubles introduces error at the cent level on a
 * six-figure position.
 */
export function totalVaultEquity(positions: readonly VaultPosition[]): string {
  return positions
    .reduce((total, position) => total.plus(position.equity), new BigNumber(0))
    .toFixed();
}

/** Find a user's position in one specific vault. */
export function positionIn(
  positions: readonly VaultPosition[],
  vault: string
): VaultPosition | null {
  const wanted = vault.toLowerCase();
  return positions.find((position) => position.vault === wanted) ?? null;
}

/**
 * The aggregate vault equity carried by a `webData3` frame.
 *
 * **Aggregate only** — one number for every vault the user is in, with no
 * breakdown, no pnl and no lockup. Its value is that it is *pushed*: frames
 * arrive every ~4–5 s, so a headline figure stays live between the HTTP polls
 * that supply everything else.
 *
 * Returns `null` when the frame carries no such field, which is not an error: a
 * user with no vault positions still receives `webData3`.
 *
 * The index is `perpDexStates[0]`, the main dex. Vaults cannot trade HIP-3 perps
 * or spot, so there is nothing at the other indices to miss.
 */
export function readPushedVaultEquity(frame: unknown): string | null {
  if (typeof frame !== "object" || frame === null) return null;

  // Accepts either the payload or the whole `{channel, data}` envelope. The
  // measured payload has top-level keys `userState` and `perpDexStates` and no
  // `data`, so unwrapping is unambiguous — and without it a caller who passed the
  // envelope would get `null`, which reads as "no vault positions" rather than as
  // "you handed me the wrong object".
  const payload = "data" in frame ? (frame as { data?: unknown }).data : frame;
  if (typeof payload !== "object" || payload === null) return null;

  const states = (payload as { perpDexStates?: unknown }).perpDexStates;
  if (!Array.isArray(states) || states.length === 0) return null;

  const main = states[0];
  if (typeof main !== "object" || main === null) return null;
  const total = (main as { totalVaultEquity?: unknown }).totalVaultEquity;

  // A string on the wire, unlike the five float-damaged fields on `vaultDetails`.
  // Rejecting a number rather than coercing one keeps that distinction honest: if
  // this ever arrives as a double, the value is no longer exact and the caller
  // should learn that from a null rather than from a silently rounded string.
  return typeof total === "string" ? total : null;
}
