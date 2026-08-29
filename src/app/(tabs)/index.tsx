/**
 * Markets — the landing tab. Three sections over two REST reads.
 *
 * The list is a **LegendList** over a scroll window — one 10-row viewport at
 * first paint, a page more per end-reach — because spot alone is ~1,309 rows
 * and every row is live. Rows re-render individually through `useMid`'s string-primitive
 * selector; this screen re-renders only on segment/search/state changes.
 *
 * **Order is fixed per snapshot.** Rows are sorted by volume once per TTL in
 * the hook; the 15 s mids poll moves prices in place and never re-sorts the
 * list under the user's finger. Search filters the ACTIVE segment only and
 * never re-sorts either (`filterRows` returns the same reference for a blank
 * query). The sort row picks the ORDERING, and `orderRows` ranks on snapshot
 * fields for the same reason — a gainers list that reshuffled every poll would
 * move the row under a finger already travelling toward it.
 *
 * The states rules, restated from the portfolio screen and applied per
 * section — each section fails alone (a deferred perp read must not blank a
 * loaded spot list):
 *
 * - loading → skeleton rows, never an empty state;
 * - deferred → a neutral notice + Try again (the budget protecting the
 *   shared per-IP allowance is not an error);
 * - error → the same notice styled as danger;
 * - ready + empty → honest empty copy, search-aware;
 * - stale mids (> 15 s, re-asked every 5 s) → a warning chip in the header
 *   and suppressed price flashes, never silently frozen numbers.
 */

import type { JSX } from "react";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { LegendList } from "@legendapp/list/react-native";
import { Button, Chip, InputGroup, Skeleton, Tabs, Typography, useThemeColor } from "heroui-native";
import { Search, X } from "lucide-react-native";
import { LiquidGlassContainerView } from "@callstack/liquid-glass";

import { MarketHighlightCard } from "@/components/markets/MarketHighlightCard";
import { MarketListRow } from "@/components/markets/MarketListRow";
import { selectHighlights, summarizeMarkets } from "@/components/markets/marketsView";
import { describeFetched } from "@/components/portfolio/fetchedView";
import { Empty, LoadingRows } from "@/components/portfolio/primitives";
import { hlConfig } from "@/hyperliquid/config/env";
import { useMarketList, useMidsStale } from "@/hyperliquid/hooks/markets";
import { useSessionState } from "@/hyperliquid/hooks/session";
import {
  filterRows,
  orderRows,
  type MarketKind,
  type MarketRow,
  type MarketSortMode,
} from "@/hyperliquid/markets/rows";
import { useHyperliquid } from "@/providers/HyperliquidProvider";

/**
 * Clearance for the floating native tab bar, in points.
 *
 * Not derivable: `useSafeAreaInsets().bottom` reports the home indicator only,
 * and `NativeTabs` exposes no height hook.
 */
const TAB_BAR_CLEARANCE = 88;

/**
 * The scroll window: a fresh section mounts 10 rows — one viewport, since a
 * section switch is a keyed remount and a small first mount is what makes it
 * instant — and scrolling grows the window 10 at a time via `onEndReached`.
 * Small pages are not only about mount cost: every visible row may request a
 * sparkline after its dwell, so a page is also a spending unit against the
 * shared per-IP budget. Ten rows is at most 210 weight, and only for rows
 * someone stopped on; mounting 20 up front spent a second page's weight on
 * rows below the fold. The generous threshold matters too: growing one
 * viewport BEFORE the hard end keeps the append off the exact frame the
 * fling lands on.
 */
const INITIAL_ROWS = 10;
const PAGE_ROWS = 10;

const SEGMENTS: [MarketKind, string][] = [
  ["perp", "Perps"],
  ["spot", "Spot"],
  ["prediction", "Predictions"],
];

/**
 * The sort row. Open interest is **perps-only** — spot and prediction rows
 * carry `openInterest: null` because the concept does not exist there, and a
 * mode that can rank nothing is not a mode.
 *
 * Deliberately absent: a "Trending" mode (nothing in the wire distinguishes it
 * from volume — it would be volume wearing a different word) and category
 * chips (nothing in `meta`/`spotMeta` classifies BTC, ETH or SOL, so the
 * groupings would be this client's invention presented as the exchange's).
 */
const SORT_MODES: [MarketSortMode, string][] = [
  ["volume", "Volume"],
  ["gainers", "Gainers"],
  ["losers", "Losers"],
];
const PERP_SORT_MODES: [MarketSortMode, string][] = [...SORT_MODES, ["oi", "Open interest"]];

/**
 * Why a sort left the list empty — every row it was handed went to `unranked`.
 *
 * The `volume` entry is unreachable by construction (that mode ranks nothing
 * and rejects nothing) and exists so the map stays total: a partial record
 * would need a fallback string, which is a second copy of this sentence
 * waiting to drift.
 */
const UNRANKED_COPY: Record<MarketSortMode, string> = {
  volume: "These markets cannot be ordered right now.",
  gainers: "None of these markets reported a 24h change to rank by.",
  losers: "None of these markets reported a 24h change to rank by.",
  oi: "None of these markets reported open interest to rank by.",
};

const EMPTY_COPY: Record<MarketKind, { title: string; description: string }> = {
  perp: { title: "No perp markets", description: "The exchange listed nothing tradeable." },
  spot: { title: "No spot markets", description: "The exchange listed nothing tradeable." },
  prediction: {
    title: "No prediction markets",
    description: "No named outcome markets are live on this network.",
  },
};

function MarketsTab(): JSX.Element {
  // NativeTabs renders no header, so content starts under the status bar
  // without this.
  const insets = useSafeAreaInsets();
  const mutedColor = useThemeColor("muted");
  const { session } = useHyperliquid();
  const sessionState = useSessionState(session);
  // Exchange-wide data follows the NETWORK, not the account — a session that
  // switched env must not render mainnet rows under a testnet header.
  const env = sessionState?.config.env ?? hlConfig.env;

  const { perps, spot, predictions, refresh } = useMarketList(env);
  const [segment, setSegment] = useState<MarketKind>("perp");
  const [query, setQuery] = useState("");

  // Staleness is time-based, so something must re-ask; 5 s against the 15 s
  // threshold is the hook's default tick.
  const isStale = useMidsStale();

  const [sortMode, setSortMode] = useState<MarketSortMode>("volume");
  // Adjusted DURING render, the derived-state pattern: leaving open interest
  // selected while switching to a section whose rows all carry
  // `openInterest: null` would order the list by a metric no row has, and
  // `orderRows` would honestly return zero ranked rows.
  if (sortMode === "oi" && segment !== "perp") setSortMode("volume");

  const active = segment === "perp" ? perps : segment === "spot" ? spot : predictions;
  const view = describeFetched(active, {
    isEmpty: (rows) => rows.length === 0,
    emptyTitle: EMPTY_COPY[segment].title,
    emptyDescription: EMPTY_COPY[segment].description,
  });
  // Search narrows, then the sort orders what is left. Both preserve the input
  // array's identity on the common path (blank query, volume sort), so the
  // steady-state list hands `LegendList` the very array the hook built.
  const allRows = active.kind === "ready" ? active.value : [];
  const { rows, unranked } = orderRows(filterRows(allRows, query), sortMode);
  const summary = summarizeMarkets({
    all: allRows,
    shown: rows.length,
    unranked: unranked.length,
    query,
  });

  // The window resets whenever the list becomes a DIFFERENT list (section,
  // sort or search change), adjusted during render — the derived-state
  // pattern — so the small slice applies before the new list paints.
  const windowKey = `${segment}:${sortMode}:${query.trim()}`;
  const [window, setWindow] = useState({ key: windowKey, count: INITIAL_ROWS });
  if (window.key !== windowKey) setWindow({ key: windowKey, count: INITIAL_ROWS });
  const visibleRows = rows.length > window.count ? rows.slice(0, window.count) : rows;

  // Plain function: React Compiler memoises it, and a hand-written dep list
  // here previously made it skip the whole component.
  const onEndReached = (): void => {
    setWindow((held) =>
      held.count >= rows.length ? held : { ...held, count: held.count + PAGE_ROWS }
    );
  };

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refresh();
    // The reads settle independently and none reports back here, so the
    // spinner is time-boxed rather than tied to a promise it cannot see.
    setTimeout(() => setRefreshing(false), 900);
  }, [refresh]);

  const onSelectSegment = useCallback((value: string) => {
    // A section is a different list, and it REMOUNTS as one: the list's key
    // is `${segment}:${sortMode}`. Handing one recycler a wholesale identity
    // swap (1,309 spot rows in place of 210 perps) while preserving its
    // scroll state left phantom blank regions and rows from the previous
    // section on screen (observed live under fast switching, on FlashList).
    // The fresh mount starts from the small window slice, which is what
    // makes it fast.
    setSegment(value as MarketKind);
  }, []);

  // Plain function, like `onEndReached`: the compiler memoises it, and this
  // file's one measured regression came from a hand-written dep list.
  const onSelectSort = (value: string): void => {
    setSortMode(value as MarketSortMode);
  };

  // The strip's headliners come from PERPS regardless of the active section —
  // it is the home page's pulse, not a section filter.
  const highlights = perps.kind === "ready" ? selectHighlights(perps.value) : [];

  const openDetail = useCallback((row: MarketRow) => {
    router.push({
      pathname: "/market/[coin]",
      // `coin` is the WIRE spelling (`BTC`, `@107`, `#102170`, `PURR/USDC`);
      // symbol and kind ride along so the detail header renders without a
      // lookup.
      params: { coin: row.wireCoin, symbol: row.symbol, kind: row.kind },
    });
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: MarketRow }) => (
      <MarketListRow
        row={item}
        sortMode={sortMode}
        suppressFlash={isStale}
        onPress={() => openDetail(item)}
      />
    ),
    [isStale, openDetail, sortMode]
  );

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top + 8 }}>
      {/* Fixed header: on a 1,309-row list, search and section controls must
          not scroll away with the rows. */}
      <View className="gap-3 px-4 pb-3">
        <View className="gap-1">
          <View className="flex-row items-center justify-between">
            <Typography.Heading className="font-bold">Markets</Typography.Heading>
            {isStale ? (
              <Chip size="sm" color="warning" variant="soft">
                <Chip.Label className="font-medium">stale</Chip.Label>
              </Chip>
            ) : null}
          </View>
          {/* What is on screen, in one line. A skeleton while the read is in
              flight — "0 markets" during a cold mount is a claim about the
              exchange rather than about the read — and NOTHING on a deferral
              or an error, where the list body's notice already owns the
              explanation and a second line would say it twice. */}
          {view.kind === "loading" ? (
            <Skeleton className="h-3.5 w-48 rounded" />
          ) : view.kind === "notice" || summary === null ? null : (
            <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
              {summary}
            </Typography.Paragraph>
          )}
        </View>

        {/* Search first — reaching for a market is the tab's primary act.
            InputGroup, not SearchField — the plan's named fallback, applied:
            the beta SearchField committed keystrokes to `onChange` up to a
            minute late (typed "Sol", list filtered ~90 s later, observed
            live), which reads as a broken search. A plain controlled Input
            delivers onChangeText per keystroke. */}
        <InputGroup>
          <InputGroup.Prefix isDecorative>
            <Search size={16} color={mutedColor} />
          </InputGroup.Prefix>
          <InputGroup.Input
            value={query}
            onChangeText={setQuery}
            placeholder="Search markets"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            className="font-normal"
          />
          {/* Only while there is something to clear: `InputGroup` measures its
              suffix and pads the input by that width, so an always-mounted
              button would reserve a gutter the empty field does not need. Not
              `isDecorative` — that prop exists to pass touches through to the
              input, which is the opposite of what this one is for. */}
          {query !== "" ? (
            <InputGroup.Suffix>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                className="p-1"
                onPress={() => setQuery("")}
              >
                <X size={16} color={mutedColor} />
              </Pressable>
            </InputGroup.Suffix>
          ) : null}
        </InputGroup>

        {/* The pulse strip: volume leader, top gainer, top loser as sparkline
            cards. Perps-sourced regardless of the active section. Bleeds to
            the screen edge (-mx equivalent via horizontal padding inside the
            scroller, not margins). Skeleton cards while the snapshot loads —
            an empty strip would read as "no markets". */}
        {highlights.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {/* One glass container for the whole strip — Apple's structure for
                adjacent glass elements: effects render as a single pass, so
                per-view backdrop artifacts never stack across the gaps (with
                effect="regular" the standalone cards' dimming fringes overlapped
                and painted the 12pt gaps darker than the page, 229 vs 245; the
                container unioned that to one fringe, and effect="clear" — see
                MarketHighlightCard — removed the rest). `spacing` stays 0:
                merge-on-proximity is the container's other feature and the
                cards must not melt together. Off iOS 26 it is a plain View, so
                the fallback path is unchanged. */}
            <LiquidGlassContainerView style={{ flexDirection: "row", gap: 12 }}>
              {highlights.map((highlight) => (
                <MarketHighlightCard
                  key={highlight.row.wireCoin}
                  row={highlight.row}
                  role={highlight.role}
                  onPress={() => openDetail(highlight.row)}
                />
              ))}
            </LiquidGlassContainerView>
          </ScrollView>
        ) : perps.kind === "loading" ? (
          <View className="flex-row gap-3">
            <Skeleton className="h-36 w-44 rounded-2xl" />
            <Skeleton className="h-36 w-44 rounded-2xl" />
          </View>
        ) : null}

        {/* Core Tabs, third switcher iteration by request: the Pro Segment's
            indicator drifted after keyboard layout shifts, TagGroup read as
            filter pills — Tabs is the proven portfolio pattern and says
            "sections" plainly.

            `primary` is the filled pill on a recessed track, the section
            switcher shape the reference apps use. `secondary` is an underline,
            which reads as a sub-level — and the sort row below IS that
            sub-level, so giving both rows one variant would flatten a
            hierarchy the screen actually has. */}
        <Tabs variant="primary" value={segment} onValueChange={onSelectSegment}>
          {/* The ScrollView wrapper is load-bearing even for three items: the
              plain-List variant's indicator ignored a controlled value change
              (underlined Perps while Spot rendered, observed live); this is
              the portfolio's proven anatomy, whose indicator tracks. */}
          <Tabs.List>
            <Tabs.ScrollView>
              <Tabs.Indicator />
              {SEGMENTS.map(([value, label]) => (
                <Tabs.Trigger key={value} value={value}>
                  <Tabs.Label className="font-medium">{label}</Tabs.Label>
                </Tabs.Trigger>
              ))}
            </Tabs.ScrollView>
          </Tabs.List>
        </Tabs>

        {/* Keyed by segment: the TRIGGER SET changes across sections (open
            interest is perps-only), and the indicator sizes itself from the
            triggers it measured at mount — swapping the set under a live
            indicator leaves it laid out for the row that is gone. A remount
            per section costs four triggers. */}
        <Tabs key={segment} variant="secondary" value={sortMode} onValueChange={onSelectSort}>
          <Tabs.List>
            <Tabs.ScrollView>
              <Tabs.Indicator />
              {(segment === "perp" ? PERP_SORT_MODES : SORT_MODES).map(([value, label]) => (
                <Tabs.Trigger key={value} value={value}>
                  <Tabs.Label className="font-medium">{label}</Tabs.Label>
                </Tabs.Trigger>
              ))}
            </Tabs.ScrollView>
          </Tabs.List>
        </Tabs>
      </View>

      {/* LegendList (migrated from FlashList by request): same windowed
          contract — small keyed mount per section AND per sort, grow a page
          per end-reach. A sort change is as wholesale an identity swap as a
          section change (every row moves), so it earns the same fresh mount
          and the same 10-row first paint, scrolled back to the top.
          `recycleItems` keeps scroll cheap; the per-coin key on FlashPrice
          inside the row is what keeps recycling honest. */}
      <LegendList
        key={`${segment}:${sortMode}`}
        data={visibleRows}
        renderItem={renderItem}
        keyExtractor={(item) => item.wireCoin}
        recycleItems
        estimatedItemSize={70}
        onEndReached={onEndReached}
        // A full viewport of headroom: the window grows a page BEFORE the
        // scroll reaches the loaded edge, so the append never lands on the
        // frame a fling is settling into.
        onEndReachedThreshold={1}
        drawDistance={250}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingHorizontal: 16,
          // `insets.bottom` is the home indicator, NOT the tab bar. The
          // NativeTabs bar floats over content on iOS 26 and reports no
          // height; the constant is measured against the rendered bar.
          paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
        }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          view.kind === "loading" ? (
            <LoadingRows count={8} />
          ) : view.kind === "notice" ? (
            <View className="items-start gap-2 py-6">
              <Chip
                size="sm"
                variant="soft"
                {...(view.tone === "danger" ? { color: "danger" as const } : {})}
              >
                <Chip.Label className="font-medium">{view.label}</Chip.Label>
              </Chip>
              <Typography.Paragraph className="text-xs text-muted font-normal">
                {view.detail}
              </Typography.Paragraph>
              <Button size="sm" variant="secondary" onPress={refresh}>
                <Button.Label className="font-medium">Try again</Button.Label>
              </Button>
            </View>
          ) : view.kind === "rows" && unranked.length > 0 ? (
            // Ready with rows, nothing rendered, and the SORT is why: every
            // surviving row went to `unranked`. A non-empty `unranked` can
            // only mean this — a search that matched nothing leaves the sort
            // nothing to reject — so blaming the search here would be a lie.
            <Empty title="Nothing to rank" description={UNRANKED_COPY[sortMode]} />
          ) : view.kind === "rows" ? (
            // Ready with rows, yet nothing rendered: the SEARCH emptied it.
            <Empty
              title="No matches"
              description={`Nothing in ${
                SEGMENTS.find(([value]) => value === segment)?.[1] ?? segment
              } matches "${query.trim()}".`}
            />
          ) : (
            <Empty
              title={EMPTY_COPY[segment].title}
              description={EMPTY_COPY[segment].description}
            />
          )
        }
      />
    </View>
  );
}

export default MarketsTab;
