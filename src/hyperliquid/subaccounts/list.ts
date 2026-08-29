/**
 * Reading a master's sub-accounts.
 *
 * The single boundary where `subAccounts2`'s wire shape stops. Four things it
 * does that the obvious implementation does not, each measured rather than
 * guessed:
 *
 * 1. **The response is `null`, not `[]`, when there are none** — 77 of 88
 *    sampled mainnet addresses. That is the majority case and every new user's
 *    first session, so `.length` or `.map` on it crashes on launch.
 * 2. **`dexToClearinghouseState` is sparse.** The SDK's "always includes the
 *    main DEX" comment is false: 48 of 67 sampled sub-accounts had no `""`
 *    entry, so the natural `find(e => e[0] === "")[1]` throws on 72% of them.
 *    An absent dex means zero.
 * 3. **Equity is summed across every dex.** v1 (`subAccounts`) reports only the
 *    main dex, which displayed `$0.009981` for an account actually holding
 *    `$50,555,968` on a HIP-3 dex. A user reads "empty" and abandons it.
 * 4. **`abstraction` absent is the default, not `"disabled"`** — 26 absent
 *    against 24 explicitly disabled.
 *
 * `subAccounts` (v1) is never called.
 */

import { BigNumber } from "bignumber.js";

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { weightBudget, type WeightBudget } from "@/hyperliquid/api/weightBudget";
import type { Hex } from "@/hyperliquid/types/domain";
import type { AbstractionMode, SubAccountSummary } from "@/hyperliquid/subaccounts/types";

const logger = log.child("subaccounts.list");

export interface SubAccountProbe {
  subAccounts2(params: { user: string }): Promise<unknown>;
}

export interface SubAccountListResult {
  value: SubAccountSummary[] | null;
  /** Set when the weight budget refused the call; `value` is then null. */
  deferred: boolean;
}

function lower(value: unknown): Hex | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value.toLowerCase() as Hex)
    : null;
}

function readAbstraction(raw: unknown): AbstractionMode {
  // Absent is the platform default and must stay distinguishable from an
  // explicit "disabled" — they render as different badges.
  if (typeof raw !== "string") return null;
  return raw === "unifiedAccount" || raw === "portfolioMargin" || raw === "disabled" ? raw : null;
}

/**
 * Parse the per-dex equity pairs.
 *
 * Keyed `null` for the main dex, matching `HlIdentity.dex`, so a caller never
 * has to remember that the wire spells it `""`.
 */
function readEquityByDex(raw: unknown): Map<string | null, string> {
  const byDex = new Map<string | null, string>();
  if (!Array.isArray(raw)) return byDex;

  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [dex, state] = entry;
    if (typeof dex !== "string") continue;

    const summary =
      typeof state === "object" && state !== null
        ? (state as { marginSummary?: { accountValue?: unknown } }).marginSummary
        : undefined;
    const value = summary?.accountValue;
    if (typeof value !== "string") continue;

    byDex.set(dex === "" ? null : dex, value);
  }
  return byDex;
}

function readSpotBalances(raw: unknown): { coin: string; total: string }[] {
  const state = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const balances = state.balances;
  if (!Array.isArray(balances)) return [];

  return balances.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.coin !== "string" || typeof row.total !== "string") return [];
    return [{ coin: row.coin, total: row.total }];
  });
}

/** Parse one `subAccounts2` entry, or `null` if it is unusable. */
export function parseSubAccount(raw: unknown): SubAccountSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const address = lower(record.subAccountUser);
  const master = lower(record.master);
  if (!address || !master) return null;

  const perpEquityByDex = readEquityByDex(record.dexToClearinghouseState);
  const perpEquityTotal = [...perpEquityByDex.values()]
    .reduce((total, value) => total.plus(value), new BigNumber(0))
    .toFixed();

  return {
    address,
    master,
    name: typeof record.name === "string" ? record.name : "",
    perpEquityByDex,
    perpEquityTotal,
    spotBalances: readSpotBalances(record.spotState),
    abstraction: readAbstraction(record.abstraction),
  };
}

/**
 * Parse a whole `subAccounts2` response.
 *
 * `null` is coalesced to `[]` here and nowhere else, so nothing downstream ever
 * sees it.
 */
export function parseSubAccounts(raw: unknown): SubAccountSummary[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new HlError("subAccounts2 returned neither an array nor null", {
      code: "validation_error",
    });
  }
  return raw.flatMap((entry) => {
    const parsed = parseSubAccount(entry);
    return parsed ? [parsed] : [];
  });
}

/** Fetch a master's sub-accounts, through the weight budget. */
export async function fetchSubAccounts(params: {
  probe: SubAccountProbe;
  /** The MASTER address. A sub-account has none of its own — see `nests`. */
  master: string;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<SubAccountListResult> {
  const budget = params.budget ?? weightBudget;
  const at = (params.now ?? Date.now)();

  // Wrapped in an object because `tryRun` signals refusal with `null` — and
  // `null` is ALSO this endpoint's legitimate answer for "no sub-accounts",
  // which is the majority case. Unwrapped, a budget refusal and an empty
  // account are indistinguishable, and the app would show "no sub-accounts"
  // whenever it was merely rate-limited.
  const wrapped = await budget.tryRun(
    "subAccounts2",
    async () => ({ raw: await params.probe.subAccounts2({ user: params.master }) }),
    { now: () => at }
  );
  if (wrapped === null) return { value: null, deferred: true };

  const value = parseSubAccounts(wrapped.raw);
  logger.info("subaccounts.listed", { context: { count: value.length } });
  return { value, deferred: false };
}

/**
 * Whether an address is one of this master's sub-accounts.
 *
 * The membership check that must run before a sub-account is selected. A
 * mistyped or foreign address otherwise passes `createIdentity` untouched, and
 * the store's echo guard compares against that *same* wrong address — so it
 * agrees, and the user gets a calm, well-formed, empty portfolio.
 */
export function isOwnedSubAccount(
  subAccounts: readonly SubAccountSummary[],
  candidate: string
): boolean {
  const wanted = candidate.toLowerCase();
  return subAccounts.some((account) => account.address === wanted);
}

/** As above, but throws — for the path that is about to switch identity. */
export function assertOwnedSubAccount(
  subAccounts: readonly SubAccountSummary[],
  candidate: string
): void {
  if (!isOwnedSubAccount(subAccounts, candidate)) {
    throw new HlError("That address is not one of this account's sub-accounts", {
      code: "not_authorized",
      context: { reason: "not_owned", known: subAccounts.length },
    });
  }
}

/**
 * Whether a counterparty is one of the user's own sub-accounts.
 *
 * `subAccountSpotTransfer` produces **no ledger row of its own** — zero across
 * ~9,300 entries scanned — and surfaces as an ordinary `spotTransfer`. The only
 * way to tell an internal move from a real send is the counterparty. `nonce`
 * separates nothing: it is null on 20 of 26 internal rows but also on 99 of 345
 * external ones.
 */
export function isInternalCounterparty(
  subAccounts: readonly SubAccountSummary[],
  master: string,
  counterparty: string | null
): boolean {
  if (!counterparty) return false;
  const other = counterparty.toLowerCase();
  return other === master.toLowerCase() || isOwnedSubAccount(subAccounts, other);
}

/**
 * Whether this identity may create a sub-account.
 *
 * They do not nest — `subAccounts2` on a sub-account returned `null` on 21 of
 * 21 sampled. Gated on the identity rather than on an empty list, because
 * `null` is overloaded: it means "has none", "is itself a sub-account", and
 * "you passed an address that is not an account at all".
 */
export function canCreateSubAccount(subAccountSelected: string | null): boolean {
  return subAccountSelected === null;
}
