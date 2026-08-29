/**
 * Sub-account domain types.
 *
 * A sub-account is an address the master controls but that holds **no private
 * key of its own**. It can never sign. Everything done to it is signed by the
 * master, and everything traded on it is signed by the master's agent with
 * `vaultAddress` set — verified live across 6 masters and both networks, where
 * 19 of 19 sub-accounts reported `extraAgents: []` while being actively traded.
 *
 * That single fact drives the whole design: a sub-account is an *address
 * dimension*, not a separate wallet.
 */

import type { Hex } from "@/hyperliquid/types/domain";

declare const NameBrand: unique symbol;
/**
 * A sub-account name that passed `canonicalSubAccountName`.
 *
 * Branded because the length limit is measured in **UTF-16 code units**, not
 * characters: a nine-emoji name is 18 units and rejected by the wire, after the
 * user has already been prompted to sign.
 */
export type SubAccountName = string & { readonly [NameBrand]: true };

/** The wire's limit, in UTF-16 code units. */
export const SUB_ACCOUNT_NAME_MAX = 16;

/**
 * The account's margin mode.
 *
 * `null` means the field was **absent**, which is the platform default — not
 * `"disabled"`. Observed 26 absent against 24 explicitly disabled across 67
 * sub-accounts, so collapsing the two mislabels a quarter of them. A
 * sub-account's mode is also its own, never inherited from its master.
 */
export type AbstractionMode = "unifiedAccount" | "portfolioMargin" | "disabled" | null;

export interface SubAccountSummary {
  /** wire `subAccountUser`, lowercased. */
  address: Hex;
  /** wire `master`, lowercased. */
  master: Hex;
  name: string;
  /**
   * Perp account value per dex. The main dex is keyed `null`, matching
   * `HlIdentity.dex`, rather than the wire's `""`.
   *
   * **Sparse.** The SDK's "always includes the main DEX" comment is false — 48
   * of 67 sampled sub-accounts had no `""` entry at all, so an absent dex means
   * zero, never an error.
   */
  perpEquityByDex: ReadonlyMap<string | null, string>;
  /**
   * Summed across **every** dex.
   *
   * Reading only the main dex is how a picker shows `$0.01` for an account
   * holding $50m on a HIP-3 dex — a user reads "empty" and abandons it.
   *
   * Named `perpEquity`, not `total`: spot is reported separately and is
   * deliberately not folded in, because that would need prices this module has
   * no business fetching.
   */
  perpEquityTotal: string;
  spotBalances: readonly { coin: string; total: string }[];
  abstraction: AbstractionMode;
}

export interface CreateSubAccountResult {
  /** The new address, or `null` when the response could not be parsed. */
  address: Hex | null;
  name: SubAccountName;
}
