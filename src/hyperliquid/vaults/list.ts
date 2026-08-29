/**
 * The vault directory.
 *
 * **`vaultSummaries` is not it.** That endpoint returns `[]` — a two-byte
 * response — on mainnet *and* testnet. It is a rolling "created in the last
 * couple of hours" feed, so it is empty essentially always, and a client that
 * builds its vault list from it shows the user nothing while 9,467 vaults exist.
 *
 * The only complete list is an **undocumented CDN blob** the SDK does not wrap:
 * `https://stats-data.hyperliquid.xyz/Mainnet/vaults`. Measured live:
 * **14,214,200 bytes, `content-encoding: none`, 9,467 entries, 317 ms** on
 * desktop broadband. That is the single most important number in this module —
 * on cellular it is a stall, and it must never be fetched during session start.
 *
 * Most of it is not worth showing. Of 9,467 vaults only **107 are open with TVL
 * above $50k**. So the filter is not a nicety; it is the difference between a
 * usable list and nine thousand dead rows.
 *
 * This module is the **only** place that URL appears.
 */

import { BigNumber } from "bignumber.js";

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import type { HlEnv, Hex } from "@/hyperliquid/types/domain";
import {
  approximate,
  type VaultAddress,
  type VaultRelationship,
  type VaultSummary,
} from "@/hyperliquid/vaults/types";

const logger = log.child("vaults.list");

/**
 * Measured at 14.2 MB uncompressed. Stated as a constant so a caller can decide
 * against fetching it on a metered connection without discovering the size the
 * hard way.
 */
export const VAULT_LIST_APPROX_BYTES = 14_200_000;

function listUrl(env: HlEnv): string {
  // The path segment is capitalised on the CDN, unlike everything else in the API.
  return `https://stats-data.hyperliquid.xyz/${env === "testnet" ? "Testnet" : "Mainnet"}/vaults`;
}

function lower(value: unknown): Hex | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value.toLowerCase() as Hex)
    : null;
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
  // A child carries no `data` at all — it cannot name its parent. Kept as a
  // distinct kind anyway, because "this vault's equity is a slice of a larger
  // pool" is worth showing even without a link to follow.
  if (record.type === "child") return { kind: "child" };
  return { kind: "normal" };
}

/**
 * The one `pnls` period this client keeps.
 *
 * The wire sends `[["day",[…]],["week",[…]],["month",[…]],["allTime",[…]]]` on
 * every entry. Reading one period rather than four is the difference between
 * ~113k and ~450k transient strings retained across a 14.2 MB parse — on a
 * phone, mid-parse, that headroom is the whole budget. Month is the pick
 * because day and week are too short to read as a shape and `allTime` compresses
 * a four-year vault and a four-day one onto the same axis.
 */
const PNL_PERIOD = "month";

/** Two points make a line. One is a dot pretending to be a trend. */
const MIN_PNL_POINTS = 2;

/** A finite decimal string, the same shape `approximate` accepts. */
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;

/**
 * One period's series out of an entry's `pnls` tuples, or `null`.
 *
 * Scans for the wanted tuple and materialises only that one — a `map` over all
 * four would allocate every period before discarding three.
 *
 * **A single malformed point rejects the whole series.** The points carry no
 * timestamps, so position IS the x-axis; dropping a bad point silently shifts
 * every later point left and draws a plausible line through the wrong shape.
 * A missing sparkline is a state the card already renders honestly.
 *
 * Values stay **strings** here. They are money, and the only `Number()` they
 * ever meet is the chart's display leaf.
 */
export function readPeriodPnl(raw: unknown, period: string): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  for (const tuple of raw) {
    if (!Array.isArray(tuple) || tuple[0] !== period) continue;
    const series: unknown = tuple[1];
    if (!Array.isArray(series) || series.length < MIN_PNL_POINTS) return null;
    for (const point of series) {
      if (typeof point !== "string" || !DECIMAL.test(point)) return null;
    }
    return series as readonly string[];
  }
  return null;
}

/** Parse one CDN entry, or `null` if it is unusable. */
export function parseVaultSummary(raw: unknown): VaultSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as { summary?: unknown; apr?: unknown; pnls?: unknown };

  // The list entry is NOT the summary — it wraps one, alongside `apr` and the
  // `pnls` sparklines. Reading the outer object as the summary yields undefined
  // for every field and a row that renders as blank.
  const summary =
    typeof entry.summary === "object" && entry.summary !== null
      ? (entry.summary as Record<string, unknown>)
      : null;
  if (!summary) return null;

  const address = lower(summary.vaultAddress);
  const leader = lower(summary.leader);
  if (!address || !leader) return null;

  return {
    address: address as VaultAddress,
    // Verbatim. Trimming here would make 29 pairs of vaults indistinguishable.
    name: typeof summary.name === "string" ? summary.name : "",
    leader,
    tvl: typeof summary.tvl === "string" ? summary.tvl : "0",
    isClosed: summary.isClosed === true,
    relationship: readRelationship(summary.relationship),
    createdAtMs: typeof summary.createTimeMillis === "number" ? summary.createTimeMillis : 0,
    apr: approximate(entry.apr) ?? ("0" as VaultSummary["apr"]),
    // `pnls` rides the OUTER entry beside `apr`, not inside `summary` — the
    // same trap the summary comment above describes, one field over.
    monthPnl: readPeriodPnl(entry.pnls, PNL_PERIOD),
  };
}

/** Parse the whole blob. Unusable entries are dropped, not fatal. */
export function parseVaultList(raw: unknown): VaultSummary[] {
  if (!Array.isArray(raw)) {
    throw new HlError("The vault list is not an array", { code: "validation_error" });
  }
  return raw.flatMap((entry) => {
    const parsed = parseVaultSummary(entry);
    return parsed ? [parsed] : [];
  });
}

export interface VaultListFilter {
  /** Drop closed vaults. Independent of TVL and of `allowDeposits`. */
  openOnly?: boolean;
  /** Minimum TVL as a decimal string. `"50000"` leaves ~107 of 9,467. */
  minTvl?: string;
  /** Cap the result after sorting by TVL, descending. */
  limit?: number;
}

/**
 * Narrow the directory to what is worth rendering.
 *
 * Applied **before** anything is handed to a UI, because the unfiltered list is
 * overwhelmingly dead: 45% of vaults hold exactly zero.
 */
export function filterVaults(
  vaults: readonly VaultSummary[],
  filter: VaultListFilter = {}
): VaultSummary[] {
  const floor = filter.minTvl === undefined ? null : new BigNumber(filter.minTvl);
  const kept = vaults.filter((vault) => {
    if (filter.openOnly && vault.isClosed) return false;
    if (floor && new BigNumber(vault.tvl).isLessThan(floor)) return false;
    return true;
  });
  kept.sort((a, b) => new BigNumber(b.tvl).comparedTo(a.tvl) ?? 0);
  return filter.limit === undefined ? kept : kept.slice(0, filter.limit);
}

/**
 * Vaults whose display names collide once whitespace is ignored.
 *
 * Not a curiosity. Hyperliquid enforces exact global uniqueness, so a name looks
 * like an identity — but 9,467 distinct names become 9,438 after trimming, and
 * an impersonator is already live: `"Hyperliquidity Provider(HLP)"` sits beside
 * the real `"Hyperliquidity Provider (HLP)"`, one space apart. A user who
 * recognises a vault by name can fund the wrong one, irreversibly and with a
 * 24-hour lockup.
 *
 * Returns the groups, keyed by the normalised name, so a list can mark every
 * member as ambiguous rather than silently picking one.
 */
export function findNameCollisions(vaults: readonly VaultSummary[]): Map<string, VaultSummary[]> {
  const byNormalised = new Map<string, VaultSummary[]>();
  for (const vault of vaults) {
    const key = normaliseVaultName(vault.name);
    const group = byNormalised.get(key);
    if (group) group.push(vault);
    else byNormalised.set(key, [vault]);
  }
  return new Map([...byNormalised].filter(([, group]) => group.length > 1));
}

/**
 * The key two names collide under.
 *
 * **All whitespace is removed, not collapsed.** Collapsing runs of spaces catches
 * `"Big  Vault"` against `"Big Vault"` but misses the attack that is actually live:
 * the real HLP is `"Hyperliquidity Provider (HLP)"` and the impersonator is
 * `"Hyperliquidity Provider(HLP)"` — a *missing* space, which no amount of
 * collapsing brings together. Removing whitespace entirely catches both shapes.
 *
 * This is a whitespace and case check only. It does **not** catch Unicode
 * homoglyphs (Cyrillic "о" for Latin "o"), which would need a confusables table;
 * that gap is why the deposit preflight echoes the **address**, and treats a name
 * match as a hint rather than as identity.
 */
export function normaliseVaultName(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

export interface FetchVaultListParams {
  env: HlEnv;
  filter?: VaultListFilter;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Fetch and parse the directory.
 *
 * Deliberately **not** routed through the weight budget: this is a CDN object,
 * not an info endpoint, so it neither consumes nor is limited by the exchange's
 * request budget. It is expensive in a different currency — bandwidth — which is
 * why it takes an `AbortSignal` and why `VAULT_LIST_APPROX_BYTES` is exported.
 */
export async function fetchVaultList(params: FetchVaultListParams): Promise<VaultSummary[]> {
  const url = listUrl(params.env);
  const startedAt = Date.now();
  const response = await (params.fetchImpl ?? fetch)(url, { signal: params.signal });

  if (!response.ok) {
    throw new HlError(`The vault list is unavailable (HTTP ${response.status})`, {
      code: "transport_error",
      context: { status: response.status },
    });
  }

  const parsed = parseVaultList(await response.json());
  logger.info("vaults.listed", {
    context: { total: parsed.length, env: params.env },
    durationMs: Date.now() - startedAt,
  });
  return params.filter ? filterVaults(parsed, params.filter) : parsed;
}
