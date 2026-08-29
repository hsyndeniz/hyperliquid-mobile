/**
 * The vault feed filters, matching the official page's dropdowns exactly.
 *
 * These replace the adaptive flag filter on the four tabs that have a REAL
 * taxonomy. The adaptive one is still right for feeds whose categories are
 * whatever the wire happened to send (ledger types, order statuses), but it
 * cannot express `Spot / Perps`: that is a property of the coin's *encoding*,
 * not a label on the row, so no amount of reading the data surfaces it.
 *
 * Per tab, from the official app:
 *
 * - **Balances** — Asset: All · Active
 * - **Positions** — Side: All · Long · Short, and Market (searchable)
 * - **Open Orders** — Type: All · Spot · Perps, Side: All · Long/Buy ·
 *   Short/Sell, and Market
 * - **TWAP** — Active · History · Fill History as sub-tabs
 */

/** Which venue a wire coin trades on. */
export type MarketKind = "spot" | "perp";

/**
 * Classify a wire coin.
 *
 * The wire has no `isSpot` field — the encoding IS the answer, which is why
 * this cannot be derived by reading row labels:
 *
 * - `@107` — the spot universe's index form, the common case.
 * - `PURR/USDC` — the one named spot pair; it predates the index form.
 * - `#N` / `+N` / `oN` — prediction outcomes. **Spot-shaped**, as the module
 *   rule states: an outcome holding lives in `spotClearinghouseState.balances`
 *   and never in `assetPositions`, so grouping it with perps would file it
 *   under the one place it can never appear.
 * - `xyz:BTC` — a builder-deployed PERP, despite the prefix. The colon names
 *   the dex, not a different venue.
 * - anything else — a perp.
 */
export function marketKindOf(coin: string): MarketKind {
  if (coin.startsWith("@") || coin.includes("/")) return "spot";
  if (/^[#+o]\d+$/.test(coin)) return "spot";
  return "perp";
}

export interface FilterOption {
  id: string;
  label: string;
}

/** Balances → Asset. "Active" means the member holds something. */
export const ASSET_FILTERS: readonly FilterOption[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
];

/** Positions → Side. A fixed set, unlike the adaptive flags. */
export const POSITION_SIDE_FILTERS: readonly FilterOption[] = [
  { id: "all", label: "All" },
  { id: "long", label: "Long" },
  { id: "short", label: "Short" },
];

/** Open Orders → Side. The official app's own wording, buy/sell included. */
export const ORDER_SIDE_FILTERS: readonly FilterOption[] = [
  { id: "all", label: "All" },
  { id: "buy", label: "Long/Buy" },
  { id: "sell", label: "Short/Sell" },
];

/** Open Orders → Type. */
export const MARKET_TYPE_FILTERS: readonly FilterOption[] = [
  { id: "all", label: "All" },
  { id: "spot", label: "Spot" },
  { id: "perp", label: "Perps" },
];

/**
 * Trade History → Role.
 *
 * Derived from the fill's `crossed` flag: an order that crossed the spread
 * took liquidity, so `crossed: true` is the TAKER and `false` is the maker.
 * There is no `role` field on the wire.
 */
export const ROLE_FILTERS: readonly FilterOption[] = [
  { id: "all", label: "All" },
  { id: "maker", label: "Maker" },
  { id: "taker", label: "Taker" },
];

/**
 * Funding History → Side.
 *
 * Long/Short rather than the orders tab's Long/Buy — funding is charged on a
 * POSITION, which has a direction but no buy/sell. Read from the row's signed
 * size, since the funding ledger has no side field either.
 */
export const FUNDING_SIDE_FILTERS: readonly FilterOption[] = [
  { id: "all", label: "All" },
  { id: "long", label: "Long" },
  { id: "short", label: "Short" },
];

/** `crossed` → who paid the spread. */
export function roleOf(crossed: boolean): "taker" | "maker" {
  return crossed ? "taker" : "maker";
}

/** TWAP → the three sub-tabs. */
export type TwapView = "active" | "history" | "fills";

export const TWAP_VIEWS: [TwapView, string][] = [
  ["active", "Active"],
  ["history", "History"],
  ["fills", "Fill History"],
];

/**
 * The Market dropdown's options, built from the rows on screen.
 *
 * The official app lists every market the venue has; this lists only those
 * PRESENT, for the same reason the adaptive flag filter does — an option that
 * matches nothing is a dead end, and on a phone a 200-entry menu of mostly
 * empty choices is worse than a short honest one. Sorted alphabetically, which
 * is how the official menu reads once past its pinned first entry.
 */
export function marketOptions(coins: readonly string[]): readonly FilterOption[] {
  const distinct = [...new Set(coins)].sort((a, b) => a.localeCompare(b));
  return [{ id: "all", label: "All" }, ...distinct.map((coin) => ({ id: coin, label: coin }))];
}

/**
 * Narrow the market options by a search string.
 *
 * Case-insensitive substring, and "All" always survives so the menu can never
 * strand someone with no way back to the unfiltered list.
 */
export function searchMarkets(
  options: readonly FilterOption[],
  query: string
): readonly FilterOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return options;
  return options.filter(
    (option) => option.id === "all" || option.label.toLowerCase().includes(needle)
  );
}

/** What a row must expose for the fixed filters to judge it. */
export interface FilterableRow {
  /** Wire coin, when the row belongs to a market. */
  coin: string | null;
  /** Long/short for a position, buy/sell for an order. */
  sideId: "long" | "short" | "buy" | "sell" | null;
  /** Balances only: does this member hold anything? */
  isActive: boolean;
  /** Trade History only: which side of the spread this fill was on. */
  roleId?: "maker" | "taker" | null;
}

/** Selected option per filter id; a missing id means "all". */
export type FilterState = Readonly<Record<string, string>>;

/**
 * Apply the fixed filters.
 *
 * Every unknown or `"all"` selection passes everything through, so a filter
 * this row cannot answer never silently removes it — a Side selection must not
 * empty the Balances tab just because a balance has no side.
 */
export function matchesFilters(row: FilterableRow, filters: FilterState): boolean {
  const asset = filters.asset ?? "all";
  if (asset === "active" && !row.isActive) return false;

  const side = filters.side ?? "all";
  if (side !== "all" && row.sideId !== side) return false;

  const type = filters.type ?? "all";
  if (type !== "all" && (row.coin === null || marketKindOf(row.coin) !== type)) return false;

  const market = filters.market ?? "all";
  if (market !== "all" && row.coin !== market) return false;

  const role = filters.role ?? "all";
  if (role !== "all" && (row.roleId ?? null) !== role) return false;

  return true;
}
