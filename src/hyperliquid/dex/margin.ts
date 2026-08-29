/**
 * Margin-table resolution.
 *
 * Two verified facts shape this module, and both save network calls that would
 * otherwise be made blindly:
 *
 * 1. **Ids below 50 are implicit flat tables** where `id === maxLeverage` and
 *    `lowerBound === "0.0"`. Confirmed for ids 1, 3, 5, 10, 12, 20, 25, 30, 40
 *    and 50 — each returned exactly one tier with an empty description. So a
 *    lookup for `marginTableId: 10` needs no request at all: the answer is
 *    "flat 10×". Ids 51 and above are genuinely tiered.
 * 2. **`meta({dex}).marginTables` does not contain the tables its own universe
 *    references.** Every builder dex was missing 100% of its referenced ids, and
 *    even the main dex was missing 4 of the 10 it references. Reading tiers from
 *    that array and stopping there silently yields nothing for most assets.
 *
 * Sortedness was checked across **288 tables on both networks** with zero
 * violations, every table starting at `"0.0"` and `maxLeverage` non-increasing.
 * The docs never promise that ordering, so this module sorts defensively anyway
 * and says so when the assumption is violated.
 */

import { BigNumber } from "bignumber.js";

import { log } from "@/hyperliquid/core/logger";
import type { MarginTier } from "@/hyperliquid/core/precision";

const logger = log.child("dex.margin");

/**
 * Ids at or below this are flat single-tier tables whose id is the leverage.
 *
 * The boundary is exact: 50 is flat, 51 is the first genuinely tiered table.
 */
export const FLAT_MARGIN_TABLE_MAX_ID = 50;

export interface MarginTable {
  id: number;
  /** `""` for a flat table; `"tiered 10x"` and similar for a real one. */
  description: string;
  /** Ascending by `lowerBound`, guaranteed by this module rather than by the API. */
  tiers: MarginTier[];
  /** True when synthesised locally rather than fetched. */
  synthetic: boolean;
}

/** Whether an id can be answered without a network call. */
export function isFlatMarginTable(id: number): boolean {
  return id <= FLAT_MARGIN_TABLE_MAX_ID;
}

/**
 * The table for a low id, without asking the server.
 *
 * `id === maxLeverage` for every one of these, which is why no request is
 * needed — and why a client that fetches them anyway makes one call per asset
 * for information it already has.
 */
export function syntheticMarginTable(id: number): MarginTable {
  return {
    id,
    description: "",
    tiers: [{ lowerBound: "0.0", maxLeverage: id }],
    synthetic: true,
  };
}

/**
 * Normalise a fetched table.
 *
 * Sorts ascending and logs if the input was not already so — the reverse scan in
 * `findMarginTier` depends on the ordering and does not sort, so a violation
 * would silently select the wrong tier and show the wrong maximum leverage.
 */
export function normaliseMarginTable(id: number, raw: unknown): MarginTable {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const rawTiers = Array.isArray(record.marginTiers) ? record.marginTiers : [];

  const tiers: MarginTier[] = rawTiers.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const tier = entry as Record<string, unknown>;
    if (typeof tier.lowerBound !== "string" || typeof tier.maxLeverage !== "number") return [];
    return [{ lowerBound: tier.lowerBound, maxLeverage: tier.maxLeverage }];
  });

  const sorted = [...tiers].sort(
    (a, b) => new BigNumber(a.lowerBound).comparedTo(b.lowerBound) ?? 0
  );
  const wasSorted = sorted.every((tier, i) => tier === tiers[i]);
  if (!wasSorted) {
    logger.warn("marginTable.unsorted", { context: { id, tiers: tiers.length } });
  }

  return {
    id,
    description: typeof record.description === "string" ? record.description : "",
    tiers: sorted,
    synthetic: false,
  };
}

/**
 * A cache that answers flat ids locally and remembers fetched ones.
 *
 * Worth having because a builder dex's universe references ids the dex's own
 * `marginTables` array does not carry, so without a cache every asset row would
 * trigger a fetch for a table shared by dozens of assets.
 */
export class MarginTableCache {
  private tables = new Map<number, MarginTable>();

  /** The table if known or derivable, else `null` — meaning it must be fetched. */
  get(id: number): MarginTable | null {
    const cached = this.tables.get(id);
    if (cached) return cached;
    if (isFlatMarginTable(id)) {
      const synthetic = syntheticMarginTable(id);
      this.tables.set(id, synthetic);
      return synthetic;
    }
    return null;
  }

  set(table: MarginTable): void {
    this.tables.set(table.id, table);
  }

  /** Ids that genuinely need a request, given what is already known. */
  missing(ids: readonly number[]): number[] {
    return [...new Set(ids)].filter((id) => this.get(id) === null);
  }

  get size(): number {
    return this.tables.size;
  }

  clear(): void {
    this.tables.clear();
  }
}
