/**
 * A vault family's activity feeds — trades, orders, funding, transfers.
 *
 * Everything here is a fan-out over `familyAddresses()`, for the reason
 * `family.ts` documents at length: a parent vault does not trade. Mainnet HLP's
 * own address has an empty book and an empty fill history; all of it belongs to
 * the children. A "Trade History" tab that read the vault address alone would
 * render "no trades" for a vault doing thousands a day.
 *
 * **These feeds are expensive and positions are not.** `clearinghouseState` is
 * weight 2, so the whole HLP family costs 16 and the positions view loads with
 * the screen. Every feed below is weight **20 per member** — 160 for the same
 * family — which is why:
 *
 * - each tab loads **only when opened**, never on mount;
 * - the fetched page is a **single page per member**, never the 20-page walk
 *   `fetchFillHistory` performs (that would be up to 400 weight per member,
 *   3,200 for the family, nearly three times the entire per-minute allowance);
 * - the cost is **disclosed in the UI** before the tap, from `ACTIVITY_WEIGHT`.
 *
 * A partial read is reported, never smoothed over: `missing` names the members
 * whose page was declined, and the caller says so rather than presenting the
 * survivors as the whole vault.
 */

import { log } from "@/hyperliquid/core/logger";
import type { Hex } from "@/hyperliquid/types/domain";

const logger = log.child("vaults.activity");

/**
 * Every feed the vault page offers, in the official page's order.
 *
 * `positions` and `depositors` are in this list even though neither issues a
 * request of its own — both are derived from data the screen already holds
 * (the family snapshot and `vaultDetails.followers`). They belong here anyway:
 * they are two of the nine things a reader looks for, and keeping them outside
 * the strip as loose cards made the surface arbitrary — some feeds in tabs,
 * two not, for no reason a reader could infer.
 */
export type ActivityKind =
  | "balances"
  | "positions"
  | "openOrders"
  | "twap"
  | "trades"
  | "funding"
  | "orderHistory"
  | "ledger"
  | "depositors";

/** Left-to-right, matching the official page exactly. */
export const ACTIVITY_ORDER: readonly ActivityKind[] = [
  "balances",
  "positions",
  "openOrders",
  "twap",
  "trades",
  "funding",
  "orderHistory",
  "ledger",
  "depositors",
];

/**
 * Request weight **per family member**, for disclosure before a tap.
 *
 * Three feeds are free. `balances` and `positions` come off the family
 * snapshot the screen already paid 2/member for; `depositors` rides on the
 * `vaultDetails` call that filled the header. No second request exists for
 * any of them.
 */
export const ACTIVITY_WEIGHT: Record<ActivityKind, number> = {
  balances: 0,
  positions: 0,
  // TWO requests: `fetchOpenOrders` fires `frontendOpenOrders` AND `openOrders`.
  openOrders: 40,
  twap: 20,
  trades: 20,
  funding: 20,
  orderHistory: 20,
  ledger: 20,
  depositors: 0,
};

/** The official page's own wording, so the two can be read side by side. */
export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  balances: "Balances",
  positions: "Positions",
  openOrders: "Open Orders",
  twap: "TWAP",
  trades: "Trade History",
  funding: "Funding History",
  orderHistory: "Order History",
  ledger: "Deposits and Withdrawals",
  depositors: "Depositors",
};

/** What one member's page costs the whole family. */
export function activityCost(kind: ActivityKind, members: number): number {
  return ACTIVITY_WEIGHT[kind] * members;
}

/** A row tagged with the family member that produced it. */
export type Sourced<T> = T & { sourceAddress: Hex };

export interface FanOutResult<T> {
  rows: readonly Sourced<T>[];
  /** Members whose page was declined or threw — the feed is partial. */
  missing: readonly Hex[];
}

/**
 * Read one page from every family member and merge them newest-first.
 *
 * `read` returning `null` means the member was DECLINED (budget or error) and
 * lands in `missing`; returning `[]` means that member genuinely has nothing,
 * which is a fact and not a gap. Keeping those apart is the whole reason this
 * helper exists rather than a bare `Promise.all`.
 *
 * Requests go out together — they are independent, and eight sequential round
 * trips on a phone is a visible wait.
 */
export async function fanOutFamily<T>(
  addresses: readonly Hex[],
  read: (address: Hex) => Promise<readonly T[] | null>,
  timeOf: (row: T) => number
): Promise<FanOutResult<T>> {
  const settled = await Promise.all(
    addresses.map(async (address) => {
      try {
        const rows = await read(address);
        return { address, rows };
      } catch (caught) {
        // One member's failure must not take the feed down; the rest is still
        // true, and `missing` says the picture is partial.
        logger.warn("vaults.activity_member_failed", { error: caught, context: { address } });
        return { address, rows: null };
      }
    })
  );

  const rows: Sourced<T>[] = [];
  const missing: Hex[] = [];
  for (const entry of settled) {
    if (entry.rows === null) {
      missing.push(entry.address);
      continue;
    }
    for (const row of entry.rows) rows.push({ ...row, sourceAddress: entry.address });
  }

  // Newest first. A stable tiebreak on the source keeps two members' rows from
  // shuffling between renders when their timestamps collide — which they do,
  // because the strategies quote the same markets in the same millisecond.
  rows.sort((a, b) => {
    const delta = timeOf(b) - timeOf(a);
    return delta !== 0 ? delta : a.sourceAddress.localeCompare(b.sourceAddress);
  });

  logger.info("vaults.activity", {
    context: { rows: rows.length, missing: missing.length, members: addresses.length },
  });
  return { rows, missing };
}
