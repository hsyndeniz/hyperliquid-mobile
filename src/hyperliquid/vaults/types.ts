/**
 * Vault domain types.
 *
 * A vault is a **keyless address that pools other people's USDC** under one
 * leader's trading. Structurally it is a sibling of a sub-account — Hyperliquid's
 * own wording covers both: "Subaccounts and vaults do not have private keys… to
 * perform actions on behalf of a subaccount or vault signing should be done by
 * the master account and the `vaultAddress` field should be set."
 *
 * Four measured differences drive everything here:
 *
 * 1. `userRole` on a vault returns a bare `{"role":"vault"}` — **no `data`, no
 *    pointer back to the leader**, where a sub-account returns
 *    `{"role":"subAccount","data":{"master":"0x…"}}`.
 * 2. A vault **never appears in its leader's `subAccounts2`**, so the Phase 8
 *    ownership check cannot be reused. `leadingVaults` is the only source.
 * 3. `extraAgents` on a vault is `[]` — like a sub-account, it holds no key.
 * 4. **It holds third-party money**, with a lockup and a profit share. That is
 *    why this module has a preflight and Phase 8 did not.
 */

import type { Hex } from "@/hyperliquid/types/domain";

declare const VaultAddressBrand: unique symbol;
/**
 * A 42-character lowercase address **confirmed to be a vault**.
 *
 * Branded because the confusable failure is expensive and silent: `vaultDetails`
 * answers `null` with HTTP 200 for any address that is not a vault, so a mistyped
 * one produces an empty page rather than an error — and a deposit to it is
 * irreversible. Only `list.ts` and `details.ts` may produce this.
 */
export type VaultAddress = Hex & { readonly [VaultAddressBrand]: true };

/**
 * `createVault` limits, in **UTF-16 code units** — valibot's `minLength`/`maxLength`
 * measure, so an emoji counts twice. Confirmed live: a 2-character name was
 * refused with `"Invalid length: Expected >=3 but received 2"` and a 9-character
 * description with `"Expected >=10 but received 9"`.
 */
export const VAULT_NAME_MIN = 3;
export const VAULT_NAME_MAX = 50;
export const VAULT_DESCRIPTION_MIN = 10;
export const VAULT_DESCRIPTION_MAX = 250;

/**
 * The minimum initial deposit, in USDC.
 *
 * Enforced by the SDK before the request leaves — measured: a $5 attempt was
 * refused with `"Invalid value: Expected >=100000000 but received 5000000"`, the
 * micro-USD form of $100. Matches Hyperliquid's documented figure.
 */
export const VAULT_CREATION_MIN_USDC = "100";

/**
 * The one-off gas fee Hyperliquid charges to create a vault, in USDC.
 *
 * **Documented, not measured, and deliberately so** — measuring it costs $10,000.
 * A testnet attempt with an underfunded account is refused with a bare
 * `"Insufficient balance to create vault"` that names no figure, so the wire will
 * not confirm it either. Treat as the best available number and show it as such.
 */
export const VAULT_CREATION_FEE_USDC = "10000";

declare const VaultNameBrand: unique symbol;
/** A name that passed `canonicalVaultName`. **Immutable once the vault exists.** */
export type VaultName = string & { readonly [VaultNameBrand]: true };

declare const VaultDescriptionBrand: unique symbol;
/** A description that passed `canonicalVaultDescription`. **Immutable once set.** */
export type VaultDescription = string & { readonly [VaultDescriptionBrand]: true };

/**
 * How a vault relates to others.
 *
 * `parent` was observed on exactly one vault in 9,467 — HLP, with 7 children. A
 * child reports only its own slice, so a parent's own `clearinghouseState`
 * understates the pooled equity; the rest lives in the children.
 *
 * **The link is one-way.** A parent lists `data.childAddresses`, but a child
 * arrives as a bare `{"type":"child"}` with **no `data` object at all** — on the
 * `vaultDetails` endpoint *and* on the CDN list, measured on all three of HLP's
 * children present in the fixture. So a child cannot name its parent, and the
 * only way to resolve one is to scan every parent's child list. The type says so
 * rather than offering a `parentAddress` that is always absent.
 */
export type VaultRelationship =
  { kind: "normal" } | { kind: "parent"; childAddresses: readonly Hex[] } | { kind: "child" };

/**
 * One row of the vault directory.
 *
 * Sourced from the stats CDN, not from `vaultSummaries` — that endpoint returns
 * `[]` on both networks (measured: a 2-byte response). See `list.ts`.
 */
export interface VaultSummary {
  address: VaultAddress;
  /**
   * Verbatim from the wire, **never trimmed**.
   *
   * Names are globally unique as sent (9,467 distinct of 9,467) but only 9,438
   * distinct after trimming, so trimming for display manufactures 29 collisions.
   * A display layer may trim; the identity must not.
   */
  name: string;
  leader: Hex;
  /** Decimal string. Total value locked. */
  tvl: string;
  isClosed: boolean;
  relationship: VaultRelationship;
  createdAtMs: number;
  /**
   * Annualised return **as sent** — a JSON number, so already float-damaged.
   * See `ApproximateNumber`.
   */
  apr: ApproximateNumber;
  /**
   * The **month** slice of the entry's `pnls` field: cumulative PnL in USDC,
   * as decimal strings, ascending, anchored at `"0.0"`.
   *
   * The CDN entry carries all four periods — `day`, `week`, `month`,
   * `allTime` — and only this one is kept. Parsing all four across 9,467
   * entries allocates ~450k transient strings in the middle of a 14.2 MB
   * parse; month alone is ~113k. See `readPeriodPnl`.
   *
   * **The series is not an equity curve.** Every period restarts at `"0.0"`
   * (verified on all four tuples of all 18 fixture entries), so a point is
   * "profit since the period began", not a balance. It is also **not fixed
   * length** — the observed month tuples run 11 to 14 points, so nothing may
   * index a twelfth element or assume a per-point interval.
   *
   * `null` below two points: one point is not a line.
   */
  monthPnl: readonly string[] | null;
}

declare const ApproximateBrand: unique symbol;
/**
 * A number that arrived as a **JSON number rather than a decimal string**.
 *
 * Five fields on the vault surface do this — `apr`, `leaderFraction`,
 * `leaderCommission`, `maxDistributable`, `maxWithdrawable` — while every other
 * money quantity in the whole codebase is a string. `leaderFraction` was observed
 * as `0.0016483967568351689`: seventeen significant digits, which is IEEE-754
 * telling us it has already lost the exact value.
 *
 * Branded so it cannot be mistaken for a `WireAmount`. The precision was lost
 * **upstream**, before this process saw it, so no amount of BigNumber discipline
 * recovers it — the only correct handling is to render it as an approximation and
 * never to sign it, sum it, or compare it for equality.
 */
export type ApproximateNumber = string & { readonly [ApproximateBrand]: true };

/** Wrap a wire JSON number, recording that its precision is already spent. */
export function approximate(value: unknown): ApproximateNumber | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // `toFixed()`-free: String(n) is the shortest round-tripping form, which is
    // the most faithful rendering of a double we are stuck with.
    return String(value) as ApproximateNumber;
  }
  // Some of these fields could plausibly become strings in a future API version.
  // Accepting that here means the client improves silently rather than breaking.
  if (typeof value === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(value)) {
    return value as ApproximateNumber;
  }
  return null;
}

/** A follower's row inside `vaultDetails`. */
export interface FollowerRow {
  /**
   * The follower's address, or `null` for the leader's own row.
   *
   * The wire spells the leader's row as the literal string `"Leader"` in an
   * address-typed field. HLP has **no such row at all**, so a parser that
   * assumes one exists finds nothing.
   */
  user: Hex | null;
  isLeader: boolean;
  /** Decimal string. */
  vaultEquity: string;
  /** Decimal string. Since entry. */
  pnl: string;
  allTimePnl: string;
  daysFollowing: number;
  entryTimeMs: number;
  /** Epoch ms until which this follower's funds are locked. */
  lockupUntilMs: number;
}

/**
 * The follower list, with its truncation made explicit.
 *
 * `vaultDetails.followers` is **silently capped at 100 rows**, sorted ascending
 * by address rather than by equity. On HLP the returned rows sum to $138.1m
 * against a `maxDistributable` of $177.5m. Anything that reads `rows.length` as a
 * follower count, or sums `vaultEquity` as a TVL, is wrong by an unknown margin —
 * so the flag travels with the data rather than living in a comment.
 */
export interface FollowerPage {
  rows: readonly FollowerRow[];
  /** True when the page is at the cap and more followers certainly exist. */
  truncated: boolean;
}

/** One period of the portfolio history. */
export interface PortfolioPeriod {
  period: string;
  /** `[timestampMs, value]` pairs, ascending. */
  accountValueHistory: readonly (readonly [number, string])[];
  pnlHistory: readonly (readonly [number, string])[];
  vlm: string;
}

export interface VaultDetail {
  address: VaultAddress;
  name: string;
  leader: Hex;
  description: string;
  isClosed: boolean;
  /**
   * Whether the vault accepts new deposits.
   *
   * **Not a deposit gate on its own.** It stays `true` on many closed vaults, so
   * `isClosed` must be checked first. The two are independent axes, as is
   * zero-TVL.
   */
  allowDeposits: boolean;
  alwaysCloseOnWithdraw: boolean;
  relationship: VaultRelationship;
  followers: FollowerPage;
  portfolio: readonly PortfolioPeriod[];
  /** The caller's own position, when `vaultDetails` was asked with a `user`. */
  followerState: FollowerRow | null;

  // --- already float-damaged on the wire; see `ApproximateNumber` -------------
  apr: ApproximateNumber | null;
  leaderFraction: ApproximateNumber | null;
  leaderCommission: ApproximateNumber | null;
  /** The vault's free margin — **not** its TVL. Caps `vaultDistribute`. */
  maxDistributable: ApproximateNumber | null;
  /**
   * **Ignores the lockup entirely** — it reports a follower's full equity while
   * the funds are still locked. Never use it as a "can I withdraw now" gate; use
   * `lockup.ts` against `lockupUntilMs`.
   *
   * Also scoped to the `user` parameter, and `0` whenever `user` was omitted.
   */
  maxWithdrawable: ApproximateNumber | null;
}

/** A user's stake in one vault, from `userVaultEquities`. */
export interface VaultPosition {
  vault: VaultAddress;
  /** Decimal string. */
  equity: string;
  lockedUntilMs: number;
}
