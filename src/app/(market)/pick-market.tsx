/**
 * The market picker — a NATIVE modal route, not a bottom sheet.
 *
 * A picker is a destination, not a surface hovering over the current one: it
 * owns the whole screen, has its own scroll and search field, and gets the
 * platform's sheet presentation, dismiss gesture and back affordance for
 * free. Registered with `presentation: "modal"` in the root layout.
 *
 * ## Returning the choice
 *
 * `router.dismissTo("/order")` with the coin as a param. When the `/order`
 * modal is beneath in the stack (it is — `openPicker` is the only way here),
 * POP_TO keeps that mounted screen and swaps its params; `useTradeScreen`
 * adopts the fresh coin during render, and the modal's own render-phase
 * ticket reset makes the new market a NEW ticket. No callback plumbing
 * across a route boundary and no shared mutable handoff.
 *
 * NOTE (2026-08-22): no live surface calls `openPicker` right now — the
 * `/order` modal is deliberately per-market. The route stays registered
 * because the hook still exposes the affordance and the screen is proven.
 *
 * ## The list
 *
 * Search on top, then a Favorites | All | Perps | Spot strip, then ONE
 * LegendList whose data switches with the tab — the list is keyed on the tab
 * so recycling state resets with the swap. Every tab is volume-descending
 * (BigNumber over the wire strings, the order each section already carries);
 * All is both sections merged and re-sorted, Favorites is that merged list
 * filtered by the pinned set. `?kind=` preselects Perps or Spot so the trade
 * screen's own switch still lands the user on the right list. Predictions
 * stay out — the trade screen cannot submit an outcome order.
 *
 * Row anatomy: [star] [badge] [symbol + leverage chip] [spacer]
 * [volume / OI] [price / 24h%]. The star is its own pressable and PINS the
 * market instead of choosing it — pinning is why the row grew a second
 * target; everything else on the row chooses.
 */

import type { JSX } from "react";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { LegendList } from "@legendapp/list/react-native";
import { Search, Star } from "lucide-react-native";
import { Chip, InputGroup, Tabs, Typography, useThemeColor } from "heroui-native";

import { favoritesStore } from "@/components/markets/favorites";
import { changeTrend, formatChangePct, formatCompactUsd } from "@/components/markets/marketsView";
import { CoinBadge } from "@/components/portfolio/primitives";
import { hlConfig } from "@/hyperliquid/config/env";
import type { Fetched } from "@/hyperliquid/hooks/history";
import { useMarketList } from "@/hyperliquid/hooks/markets";
import { useSessionState } from "@/hyperliquid/hooks/session";
import { useStoreValue } from "@/hyperliquid/hooks/useStore";
import { change24hPct, sortRows, type MarketRow } from "@/hyperliquid/markets/rows";
import { useHyperliquid } from "@/providers/HyperliquidProvider";

type PickerTab = "favorites" | "all" | "perp" | "spot";

const TABS: [PickerTab, string][] = [
  ["favorites", "Favorites"],
  ["all", "All"],
  ["perp", "Perps"],
  ["spot", "Spot"],
];

/**
 * The Markets tab's windowed-mount pattern, retuned: picker rows are ~56 pt
 * against that screen's 70, so one viewport is fourteen rows, and none of
 * them request sparklines — the window here is purely mount cost, not a
 * spending unit against the request budget.
 */
const INITIAL_ROWS = 14;
const PAGE_ROWS = 14;

type SectionState =
  | { kind: "ready"; rows: readonly MarketRow[] }
  | { kind: "loading" }
  | { kind: "deferred" }
  | { kind: "error" };

/** `idle` folds into `loading`: the picker cannot retry, only report. */
function sectionOf(fetched: Fetched<readonly MarketRow[]>): SectionState {
  switch (fetched.kind) {
    case "ready":
      return { kind: "ready", rows: fetched.value };
    case "error":
      return { kind: "error" };
    case "deferred":
      return { kind: "deferred" };
    default:
      return { kind: "loading" };
  }
}

/** The four-prop inert wrapper — chips inside pressables must not eat taps. */
function InertChip({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <View
      className="pointer-events-none"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {children}
    </View>
  );
}

function MarketPickRow({
  row,
  favorited,
  onChoose,
}: {
  row: MarketRow;
  favorited: boolean;
  onChoose: (row: MarketRow) => void;
}): JSX.Element {
  const accentColor = useThemeColor("accent");
  const mutedColor = useThemeColor("muted");
  const trend = changeTrend(row.px, row.prevDayPx);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Trade ${row.symbol}`}
      onPress={() => onChoose(row)}
      className="flex-row items-center gap-3 py-2.5"
    >
      {/* Its own pressable: the star PINS, it must never choose the row. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${favorited ? "Unpin" : "Pin"} ${row.symbol}`}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        onPress={() => favoritesStore.toggle(row.wireCoin)}
      >
        <Star
          size={16}
          color={favorited ? accentColor : mutedColor}
          fill={favorited ? accentColor : "none"}
        />
      </Pressable>
      <CoinBadge coin={row.symbol} />
      <View className="flex-row items-center gap-2">
        <Typography.Paragraph className="font-semibold">{row.symbol}</Typography.Paragraph>
        {row.maxLeverage === null ? null : (
          <InertChip>
            <Chip size="sm" variant="soft">
              <Chip.Label className="font-medium">{`${row.maxLeverage}x`}</Chip.Label>
            </Chip>
          </InertChip>
        )}
      </View>
      <View className="flex-1" />
      <View className="items-end">
        <Typography.Paragraph className="text-xs tabular-nums font-medium">
          {formatCompactUsd(row.dayNtlVlm)}
        </Typography.Paragraph>
        {row.openInterest !== null ? (
          <Typography.Paragraph className="text-[10px] text-muted tabular-nums font-normal">
            {`OI ${formatCompactUsd(row.openInterest)}`}
          </Typography.Paragraph>
        ) : null}
      </View>
      <View className="items-end">
        <Typography.Paragraph className="tabular-nums font-medium">{row.px}</Typography.Paragraph>
        <Typography.Paragraph
          className={`text-xs tabular-nums font-normal ${
            trend === "up" ? "text-success" : trend === "down" ? "text-danger" : "text-muted"
          }`}
        >
          {formatChangePct(change24hPct(row.px, row.prevDayPx))}
        </Typography.Paragraph>
      </View>
    </Pressable>
  );
}

export default function PickMarketScreen(): JSX.Element {
  const params = useLocalSearchParams<{ kind?: string }>();
  const { session } = useHyperliquid();
  const sessionState = useSessionState(session);
  const env = sessionState?.config.env ?? hlConfig.env;

  // `?kind=` preserves the deep-link contract: the trade screen's Spot|Perps
  // switch sends the user straight to the matching list.
  const [tab, setTab] = useState<PickerTab>(params.kind === "spot" ? "spot" : "perp");
  const [query, setQuery] = useState("");
  const mutedColor = useThemeColor("muted");

  // The same cached read the Markets tab uses — opening the picker costs no
  // extra request weight.
  const markets = useMarketList(env);
  const favorites = useStoreValue(favoritesStore, (store) => store.read());

  // All = both sections concatenated and RE-sorted: each arrives in its own
  // volume order, and interleaving two sorted lists is exactly what a plain
  // concat would fail at. `sortRows` is the same BigNumber-descending order.
  const perpRows = markets.perps.kind === "ready" ? markets.perps.value : null;
  const spotRows = markets.spot.kind === "ready" ? markets.spot.value : null;
  const mergedRows =
    perpRows !== null && spotRows !== null ? sortRows([...perpRows, ...spotRows]) : null;

  let active: SectionState;
  if (tab === "perp") {
    active = sectionOf(markets.perps);
  } else if (tab === "spot") {
    active = sectionOf(markets.spot);
  } else if (mergedRows === null) {
    // A merged tab needs BOTH sections; the worse state wins the report.
    active =
      markets.perps.kind === "error" || markets.spot.kind === "error"
        ? { kind: "error" }
        : markets.perps.kind === "deferred" || markets.spot.kind === "deferred"
          ? { kind: "deferred" }
          : { kind: "loading" };
  } else if (tab === "all") {
    active = { kind: "ready", rows: mergedRows };
  } else {
    active = { kind: "ready", rows: mergedRows.filter((row) => favorites.has(row.wireCoin)) };
  }

  const q = query.trim().toLowerCase();
  const baseRows = active.kind === "ready" ? active.rows : [];
  const rows = q === "" ? baseRows : baseRows.filter((row) => row.symbol.toLowerCase().includes(q));

  // The Markets tab's window pattern: reset to one viewport whenever the list
  // becomes a DIFFERENT list, adjusted during render so the small slice
  // applies before the new list paints.
  const windowKey = `${tab}:${q}`;
  const [window, setWindow] = useState({ key: windowKey, count: INITIAL_ROWS });
  if (window.key !== windowKey) setWindow({ key: windowKey, count: INITIAL_ROWS });
  const visibleRows = rows.length > window.count ? rows.slice(0, window.count) : rows;

  const onEndReached = (): void => {
    setWindow((held) =>
      held.count >= rows.length ? held : { ...held, count: held.count + PAGE_ROWS }
    );
  };

  const choose = (row: MarketRow): void => {
    router.dismissTo({ pathname: "/order", params: { coin: row.wireCoin } });
  };

  const renderItem = ({ item }: { item: MarketRow }): JSX.Element => (
    <MarketPickRow row={item} favorited={favorites.has(item.wireCoin)} onChoose={choose} />
  );

  return (
    <View className="flex-1 gap-3 bg-background px-5 pt-4">
      <InputGroup>
        <InputGroup.Prefix className="pr-2">
          <Search size={16} color={mutedColor} />
        </InputGroup.Prefix>
        {/* NOT autofocused. A picker is opened to BROWSE — measured on device,
            the keyboard covered 40% of the screen and left 5½ of 1,309 spot
            rows reachable, and the first tap on a row went to dismissing the
            keyboard rather than choosing the market. Typing is one tap away. */}
        <InputGroup.Input
          placeholder="Search markets"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          className="flex-1 px-4"
        />
      </InputGroup>

      <Tabs variant="secondary" value={tab} onValueChange={(value) => setTab(value as PickerTab)}>
        {/* The ScrollView wrapper is load-bearing: the plain-List variant's
            indicator ignores a controlled value change (observed live on the
            Markets tab); this is the proven anatomy whose indicator tracks. */}
        <Tabs.List>
          <Tabs.ScrollView>
            <Tabs.Indicator />
            {TABS.map(([value, label]) => (
              <Tabs.Trigger key={value} value={value}>
                <Tabs.Label className="font-medium">{label}</Tabs.Label>
              </Tabs.Trigger>
            ))}
          </Tabs.ScrollView>
        </Tabs.List>
      </Tabs>

      {active.kind === "ready" ? (
        // keyboardShouldPersistTaps "always", not "handled": with the keyboard
        // up after a search, a tap on a row must CHOOSE it, not spend itself
        // closing the keyboard. Keyed on the tab so a data swap resets the
        // recycler instead of handing it a wholesale identity change.
        <LegendList
          key={tab}
          data={visibleRows}
          renderItem={renderItem}
          keyExtractor={(item) => item.wireCoin}
          recycleItems
          estimatedItemSize={56}
          onEndReached={onEndReached}
          onEndReachedThreshold={1}
          drawDistance={250}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingBottom: 32 }}
          ListEmptyComponent={
            tab === "favorites" && q === "" ? (
              <Typography.Paragraph className="py-8 text-center text-muted font-normal">
                Tap a star to pin markets here.
              </Typography.Paragraph>
            ) : (
              <Typography.Paragraph className="py-8 text-center text-muted font-normal">
                No markets match “{query.trim()}”
              </Typography.Paragraph>
            )
          }
        />
      ) : (
        <View className="flex-1 items-center justify-center">
          <Typography.Paragraph className="text-muted font-normal">
            {active.kind === "deferred"
              ? "Market list deferred — try again shortly."
              : active.kind === "error"
                ? "Could not load markets."
                : "Loading markets…"}
          </Typography.Paragraph>
        </View>
      )}
    </View>
  );
}
