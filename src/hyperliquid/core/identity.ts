/**
 * Identity — the scoping key for all Hyperliquid state.
 *
 * Every cache entry, state slice, subscription target and rate-limit bucket is
 * keyed by an `HlIdentity`. Getting this wrong does not throw; it shows one
 * account's positions under another, or spends a second account's request
 * budget. So the key is built in exactly one place.
 *
 * `dex` and `subAccount` are dimensions from day one even though their features
 * ship later — Hyperliquid treats sub-accounts as **separate users** (including
 * for rate limiting), and HIP-3 DEXs have wholly separate universes and
 * balances. Adding a dimension later means revisiting every key in the app.
 */

import type { Hex, HlEnv, HlIdentity, SubscriptionTarget } from "@/hyperliquid/types/domain";

/**
 * Lowercase an address.
 *
 * Hyperliquid echoes addresses in mixed case; comparing or keying on the raw
 * value produces two entries for one account.
 */
export function normalizeAddress(address: string): Hex {
  return address.toLowerCase() as Hex;
}

/**
 * Build an identity, normalising addresses.
 *
 * Prefer this over an object literal so normalisation cannot be forgotten.
 */
export function createIdentity(params: {
  env: HlEnv;
  accountId: string;
  address: string;
  dex?: string | null;
  subAccount?: string | null;
}): HlIdentity {
  return {
    env: params.env,
    accountId: params.accountId,
    address: normalizeAddress(params.address),
    // Hyperliquid's main perp DEX is the empty string on the wire; `null` is
    // our canonical form so "main" has exactly one representation.
    dex: params.dex ? params.dex : null,
    subAccount: params.subAccount ? normalizeAddress(params.subAccount) : null,
  };
}

/**
 * Canonical cache/state key.
 *
 * Field order is fixed and every dimension is always present (`-` for absent),
 * so keys never collide across dimensions — `dex: "a"` with no sub-account
 * cannot produce the same string as no dex with `subAccount: "a"`.
 */
export function identityKey(identity: HlIdentity): string {
  return [
    identity.env,
    identity.accountId,
    identity.address,
    identity.dex ?? "-",
    identity.subAccount ?? "-",
  ].join("|");
}

/**
 * The address Hyperliquid attributes activity to: the sub-account when one is
 * selected, otherwise the main address. This is the value that goes into API
 * calls taking a `user` parameter.
 */
export function effectiveAddress(identity: HlIdentity): Hex {
  return identity.subAccount ?? identity.address;
}

/**
 * How a *signed action* reaches the acting account: `{ vaultAddress }`, or
 * nothing at all.
 *
 * The counterpart to {@link effectiveAddress}, which answers the same question
 * for a `user` parameter on a read. A sub-account has no agent of its own — the
 * master's agent signs and this field says who the action is FOR — so every
 * order, cancel, modify, TWAP and margin change has to carry it.
 *
 * Named rather than spread at the call site because forgetting it is silent and
 * expensive: the action succeeds, against the master account, and the user is
 * looking at the sub-account. That is exactly how `cancelOrder` came to target
 * an oid that did not exist on the account it was sent to. `screenGuards`
 * enforces that this is the only place the mapping is written.
 *
 * Returns `{}` and never `{ vaultAddress: undefined }` — the request schema
 * rejects an explicit undefined.
 */
export function actingRoute(identity: HlIdentity): { vaultAddress?: Hex } {
  return identity.subAccount ? { vaultAddress: identity.subAccount } : {};
}

/**
 * The scope an **agent key** belongs to: `env | accountId | address`.
 *
 * Deliberately drops both `dex` and `subAccount`, unlike `identityKey`.
 *
 * A sub-account has no private key and can never hold an agent of its own —
 * verified live: 19 of 19 sub-accounts across 6 masters and both networks
 * returned `extraAgents: []`, a sub address never appears in its master's list,
 * and `userRole` on an agent resolves to the master every time. Sub-accounts
 * with thousands of fills trade today with zero agents of their own, because
 * the **master's** agent acts for them via `vaultAddress`.
 *
 * Scoping an agent by the full `identityKey` therefore demanded a key that
 * cannot exist, and left every sub-account permanently `approval_required`.
 *
 * `dex` is dropped for the same reason: one agent covers every dex, so keying
 * on it would mint a fresh agent and re-prompt on every HIP-3 dex switch.
 *
 * A named function rather than a call-site decision, for the same reason
 * `effectiveAddress` is one.
 */
export function agentScopeKey(identity: HlIdentity): string {
  return [identity.env, identity.accountId, identity.address].join("|");
}

/** The wire form of `dex` — Hyperliquid uses `""` for the main perp DEX. */
export function dexParam(identity: HlIdentity): string {
  return identity.dex ?? "";
}

export function sameIdentity(a: HlIdentity | null, b: HlIdentity | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return identityKey(a) === identityKey(b);
}

/**
 * True when `state` belongs to `current`.
 *
 * The guard for the "stale data after an account switch" class of bug: data
 * arriving from an in-flight request for a previous identity must be dropped,
 * not rendered.
 */
export function isForIdentity(state: { identity: HlIdentity }, current: HlIdentity): boolean {
  return sameIdentity(state.identity, current);
}

/**
 * Canonical subscription key.
 *
 * The one string the mutation queue, the reconcile queue and the store must all
 * agree on. Built with the same discipline as {@link identityKey}: every
 * dimension always present, fixed order, `-` for absent — so no two different
 * targets can produce the same key and a stale create cannot be mistaken for
 * the active one.
 *
 * Aggregation is included because the SDK treats it as part of the
 * subscription's identity.
 */
export function subscriptionKey(target: SubscriptionTarget): string {
  const aggregation = target.aggregation
    ? [
        target.aggregation.nSigFigs ?? "-",
        target.aggregation.mantissa ?? "-",
        target.aggregation.fast ? "f" : "s",
      ].join("/")
    : "-";
  return [
    identityKey(target.identity),
    target.channel,
    target.coin ?? "-",
    aggregation,
    target.interval ?? "-",
  ].join("|");
}
