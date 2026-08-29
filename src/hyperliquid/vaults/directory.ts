/**
 * The directory, shaped for screens — and for a phone's memory.
 *
 * The raw list is 9,467 summaries (14.2 MB of JSON; ~5 MB retained as Hermes
 * objects). A tab does not need that. It needs three much smaller things, all
 * derived here in one pass so the raw array can be garbage the moment parsing
 * ends:
 *
 * - **`top`** — the rows worth rendering: open vaults, TVL descending, capped.
 *   No TVL floor, deliberately: a $50k floor fits mainnet (~107 rows) but
 *   would nearly empty the testnet list (64 open vaults above $1k), and the
 *   sort + cap cut the same dead tail on both networks.
 * - **`index`** — address → {name, isClosed} over EVERY vault, open or not.
 *   The position-name join reads this: a held vault can be closed (equities,
 *   not the directory, is the source of positions) and can be missing
 *   entirely — testnet HLP is measured absent from the testnet directory.
 * - **`collisions`** — only the groups whose names collide once whitespace is
 *   ignored. The deposit preflight's `known` check must be honest over the
 *   FULL set (the live HLP impersonator is exactly what a TVL filter drops);
 *   keeping just the colliding groups preserves the exact answer at ~2% of
 *   the memory.
 */

import type { HlEnv, Hex } from "@/hyperliquid/types/domain";
import { filterVaults, findNameCollisions, normaliseVaultName } from "@/hyperliquid/vaults/list";
import { lockupState, type LockupState } from "@/hyperliquid/vaults/lockup";
import type { VaultPosition, VaultSummary } from "@/hyperliquid/vaults/types";

/** Rows the default directory view renders. See the header for why no minTvl. */
export const VAULT_TOP_LIMIT = 200;

export interface VaultIndexEntry {
  name: string;
  isClosed: boolean;
}

export interface VaultDirectory {
  env: HlEnv;
  fetchedAtMs: number;
  /** Open vaults, TVL descending, first {@link VAULT_TOP_LIMIT}. Full summaries. */
  top: readonly VaultSummary[];
  /** EVERY vault — the name join and closed badges. The deliberate memory spend. */
  index: ReadonlyMap<Hex, VaultIndexEntry>;
  /** Only colliding groups, keyed by {@link normaliseVaultName}. */
  collisions: ReadonlyMap<string, readonly VaultSummary[]>;
}

/** Derive everything a screen reads, then let the raw array go. */
export function buildVaultDirectory(
  env: HlEnv,
  all: readonly VaultSummary[],
  fetchedAtMs: number
): VaultDirectory {
  const index = new Map<Hex, VaultIndexEntry>();
  for (const vault of all) {
    index.set(vault.address, { name: vault.name, isClosed: vault.isClosed });
  }
  return {
    env,
    fetchedAtMs,
    top: filterVaults(all, { openOnly: true, limit: VAULT_TOP_LIMIT }),
    index,
    collisions: findNameCollisions(all),
  };
}

/**
 * A held position with what the directory knows about it.
 *
 * `name: null` means "not in the directory" — a measured state (testnet HLP),
 * not an error — and the caller renders the address. It must never become a
 * fallback string: "Unknown vault" reads as a defect where an address reads
 * as a fact.
 */
export interface NamedVaultPosition extends VaultPosition {
  name: string | null;
  isClosed: boolean | null;
  lockup: LockupState;
}

/**
 * Join positions to directory names. Order-independent: positions never wait
 * on the directory — equities ready + directory absent renders address rows,
 * and names appear when the directory lands.
 */
export function joinPositionNames(
  positions: readonly VaultPosition[],
  index: ReadonlyMap<Hex, VaultIndexEntry> | null,
  now: number = Date.now()
): NamedVaultPosition[] {
  return positions.map((position) => {
    const entry = index?.get(position.vault.toLowerCase() as Hex) ?? null;
    return {
      ...position,
      name: entry?.name ?? null,
      isClosed: entry?.isClosed ?? null,
      lockup: lockupState(position.lockedUntilMs, now),
    };
  });
}

/** One search hit — a full row when it is in `top`, an index entry otherwise. */
export interface VaultSearchHit {
  address: Hex;
  name: string;
  isClosed: boolean;
  /** Present only for rows in the rendered top set. */
  summary: VaultSummary | null;
}

/**
 * Find vaults by name, beyond the rendered cut.
 *
 * `top` is searched first (those hits carry full summaries), then the whole
 * index — a name-containment scan over ≤9,467 entries is sub-millisecond, and
 * it is what makes a small vault findable without retaining 5 MB of
 * summaries. Matching uses {@link normaliseVaultName} so the query survives
 * the whitespace games the collision defence exists for.
 */
export function searchDirectory(
  directory: VaultDirectory,
  query: string,
  limit: number = 50
): VaultSearchHit[] {
  const needle = normaliseVaultName(query);
  if (needle.length === 0) return [];

  const hits: VaultSearchHit[] = [];
  const seen = new Set<Hex>();

  for (const vault of directory.top) {
    if (hits.length >= limit) return hits;
    if (normaliseVaultName(vault.name).includes(needle)) {
      hits.push({
        address: vault.address,
        name: vault.name,
        isClosed: vault.isClosed,
        summary: vault,
      });
      seen.add(vault.address);
    }
  }
  for (const [address, entry] of directory.index) {
    if (hits.length >= limit) return hits;
    if (seen.has(address)) continue;
    if (normaliseVaultName(entry.name).includes(needle)) {
      hits.push({ address, name: entry.name, isClosed: entry.isClosed, summary: null });
    }
  }
  return hits;
}
