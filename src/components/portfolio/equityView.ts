/**
 * The account's total value, split into the three places money actually sits:
 * the perp clearinghouse, spot balances, and vault deposits.
 *
 * This exists because the hero card's big number was the PERP account value
 * alone — $2.62 on an account holding ~$18 across spot and a vault — which is
 * the exact "zero the account does not have" lie the screen's rules ban, in a
 * subtler form. The web app's summary panel shows the split; this is that.
 *
 * ## Null propagation is the contract
 *
 * Each part is `null` until its source has actually spoken:
 * - `perp` — the websocket account frame (`null` before the first frame);
 * - `spot` — the spot balances store (`null` before its first frame; `"0.00"`
 *   for an account that genuinely holds nothing);
 * - `vaults` — the `userVaultEquities` read (`null` while loading/deferred;
 *   `"0.00"` for `[]`, which that endpoint uses for "has none").
 *
 * `total` is non-null **only when all three are** — a total over two of three
 * parts would understate the account with a confident-looking number, which is
 * worse than a skeleton.
 *
 * ## Unpriced spot coins are named, not silently dropped
 *
 * `valueOf` returns `null` for a token with no quote. Such a coin cannot be
 * added to the spot total, but omitting it silently would make the total read
 * as complete. The caller gets the names and must disclose them.
 */

import { BigNumber } from "bignumber.js";

import { toBigNumber } from "@/hyperliquid/core/precision";
import { valueOf, type SpotPrices } from "@/hyperliquid/hooks/prices";
import type { SubAccountSummary } from "@/hyperliquid/subaccounts/types";
import type { SpotBalance } from "@/hyperliquid/types/domain";
import type { VaultPosition } from "@/hyperliquid/vaults/types";

export interface EquityBreakdown {
  /** Perp clearinghouse account value. `null` before the first frame. */
  perp: string | null;
  /** Priced spot holdings, USD. `null` before the store speaks. */
  spot: string | null;
  /** Coins excluded from `spot` because they have no quote. Disclose them. */
  unpriced: readonly string[];
  /** Total vault equity. `null` while the read is pending or refused. */
  vaults: string | null;
  /** Sum of the three — `null` unless every part is known. */
  total: string | null;
}

/**
 * Master + every sub-account's perp equity, or `null` when it cannot be stated.
 *
 * **Perps only, and the label must say so.** `SubAccountSummary` deliberately
 * reports `perpEquityTotal` without spot (valuing a sub's spot needs prices
 * that module refuses to fetch), so folding the master's spot in here would
 * compare unlike quantities and overstate the master's share.
 *
 * `null` when the master's value or the sub list has not loaded, and — by the
 * caller's gate — never shown for an account with no sub-accounts, where
 * "combined" would just repeat the number above it.
 */
export function combinedPerpEquity(
  masterPerpValue: string | null,
  subAccounts: readonly SubAccountSummary[] | null
): string | null {
  if (masterPerpValue === null || subAccounts === null) return null;
  let total = toBigNumber(masterPerpValue);
  if (!total.isFinite()) return null;
  for (const sub of subAccounts) {
    const equity = toBigNumber(sub.perpEquityTotal);
    if (equity.isFinite()) total = total.plus(equity);
  }
  return total.toFixed(2);
}

export function equityBreakdown(params: {
  perpValue: string | null;
  balances: readonly SpotBalance[] | null;
  prices: SpotPrices;
  vaultPositions: readonly VaultPosition[] | null;
}): EquityBreakdown {
  const perp = params.perpValue;

  let spot: string | null = null;
  const unpriced: string[] = [];
  if (params.balances !== null) {
    let sum = new BigNumber(0);
    for (const balance of params.balances) {
      // A zero holding contributes nothing and must not NAME anything either —
      // the wire really does send 0.0 rows (the other side of an outcome buy),
      // and listing one as "unpriced" would disclose a problem that isn't.
      if (!toBigNumber(balance.total).gt(0)) continue;
      const value = valueOf(balance.coin, balance.total, params.prices);
      if (value === null) {
        unpriced.push(balance.coin);
        continue;
      }
      sum = sum.plus(value);
    }
    spot = sum.toFixed(2);
  }

  let vaults: string | null = null;
  if (params.vaultPositions !== null) {
    vaults = params.vaultPositions
      .reduce((total, position) => total.plus(position.equity), new BigNumber(0))
      .toFixed(2);
  }

  const total =
    perp !== null && spot !== null && vaults !== null
      ? toBigNumber(perp).plus(spot).plus(vaults).toFixed(2)
      : null;

  return { perp, spot, unpriced, vaults, total };
}
