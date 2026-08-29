/**
 * Market detail — the repo's first dynamic route. `coin` is the WIRE spelling
 * (`BTC`, `@107`, `#102170`, `PURR/USDC` — canonical pairs use the literal
 * pair name, measured); `symbol` and `kind` ride along so the header renders
 * without a lookup, with `kindOfWireCoin` as the deep-link fallback.
 *
 * ## Where each number comes from
 *
 * - **Perp**: `usePerpAssetCtx` (live `activeAssetCtx` websocket) feeds the
 *   hero and the six tiles; `maxLeverage` comes from the cached list row.
 *   Stale ctx (> 10 s) dims last-known values under a warning chip instead of
 *   blanking them.
 * - **Spot**: no live ctx feed exists by design (`activeSpotAssetCtx` is
 *   deliberately unwired), so the hero tracks the candle feed's forming close
 *   and the tiles are the cached snapshot — a screen-level cached re-read of
 *   `spotMetaAndAssetCtxs`, because the list cache holds BUILT rows and a
 *   `MarketRow` deliberately carries no token attributes.
 * - **Prediction**: the same raw read supplies both sides' marks (`#N` ctxs
 *   ride in the spot response), the catalog names them, and
 *   `predictionSideRows` keeps the two probabilities visibly summing to 100%.
 *
 * The candle seed is the only mandatory extra weight on this screen (35);
 * within the list's 60 s TTL everything else is cache-warm.
 */

import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";

import { BookOpen } from "lucide-react-native";

import { DetailSections } from "@/components/markets/DetailSections";
import { MarketDetailHeader } from "@/components/markets/MarketDetailHeader";
import { OrderBookPanel } from "@/components/trade/OrderBookPanel";
import { statIcon } from "@/components/markets/statIcon";
import { FundingClock } from "@/components/markets/FundingClock";
import { MarketAccountSection } from "@/components/trade/MarketAccountSection";
import { Button, Card, Chip, Skeleton, Typography } from "heroui-native";

import { GlassCta } from "@/components/common/glass";
import { CandleChartCard } from "@/components/markets/CandleChartCard";
import {
  aboutRows,
  outcomeByWireCoin,
  perpStatTiles,
  predictionSideRows,
  predictionStatTiles,
  spotDetailFor,
  spotStatTiles,
  type StatTile as StatTileData,
} from "@/components/markets/detailView";
import {
  changeTrend,
  formatChangePct,
  formatProbabilityChangePts,
  kindOfWireCoin,
} from "@/components/markets/marketsView";
import { StatTileGrid } from "@/components/markets/StatTile";
import { fetchSpotCtxs, type SpotCtxsProbe } from "@/hyperliquid/api/assetCtxs";
import { getInfoClient } from "@/hyperliquid/api/clients";
import {
  readThrough,
  restCache,
  restCacheKey,
  REST_CACHE_TTL_MS,
} from "@/hyperliquid/api/restCache";
import { hlConfig } from "@/hyperliquid/config/env";
import {
  useCandleSeries,
  useMarketList,
  useMid,
  useMidsStale,
  usePerpAssetCtx,
} from "@/hyperliquid/hooks/markets";
import { usePredictionCatalog } from "@/hyperliquid/hooks/predictions";
import { useSessionState } from "@/hyperliquid/hooks/session";
import { change24hPct, type MarketRow } from "@/hyperliquid/markets/rows";
import type { CandleInterval, HlEnv } from "@/hyperliquid/types/domain";
import type { ISpotMetaAndAssetCtxsResponse } from "@/hyperliquid/types/sdk";
import { useHyperliquid } from "@/providers/HyperliquidProvider";

// ---------------------------------------------------------------------------
// The raw spot read (spot + prediction kinds only)
// ---------------------------------------------------------------------------

type RawSpotState =
  | { kind: "loading" }
  | { kind: "deferred" }
  | { kind: "error"; message: string }
  | { kind: "ready"; value: ISpotMetaAndAssetCtxsResponse };

/**
 * `spotMetaAndAssetCtxs`, cached raw for this screen under its own env-scoped
 * key (the `PortfolioChart` pattern: the screen owns the read the hooks do
 * not export). 20 weight on a cold detail, free within the TTL; a deferral
 * renders as a notice with a retry, never as an empty About card.
 */
function useRawSpotCtxs(env: HlEnv, enabled: boolean): { state: RawSpotState; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [entry, setEntry] = useState<{ env: HlEnv | null; state: RawSpotState }>(() => {
    const hit = restCache.read<ISpotMetaAndAssetCtxsResponse>(
      restCacheKey("spotCtxsRaw", env),
      Date.now(),
      REST_CACHE_TTL_MS
    );
    return hit === undefined
      ? { env: null, state: { kind: "loading" } }
      : { env, state: { kind: "ready", value: hit } };
  });
  // Derived, not effect-reset: an env switch reads `loading` on the very
  // first render and a late response for the old env cannot overwrite it.
  const state: RawSpotState = entry.env === env ? entry.state : { kind: "loading" };

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // Deferred a tick so nothing writes state synchronously from the effect.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { value } = await readThrough<ISpotMetaAndAssetCtxsResponse>({
            key: restCacheKey("spotCtxsRaw", env),
            ttlMs: REST_CACHE_TTL_MS,
            now: Date.now(),
            fetch: async () => {
              const result = await fetchSpotCtxs({
                probe: getInfoClient() as unknown as SpotCtxsProbe,
              });
              // `null` is the budget declining; `readThrough` skips caching it.
              return result.value;
            },
          });
          if (!live) return;
          setEntry({
            env,
            state: value === null ? { kind: "deferred" } : { kind: "ready", value },
          });
        } catch (error) {
          if (!live) return;
          setEntry({
            env,
            state: { kind: "error", message: error instanceof Error ? error.message : "failed" },
          });
        }
      })();
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [env, enabled, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}

function rowFor(
  list: { kind: string; value?: readonly MarketRow[] },
  wireCoin: string
): MarketRow | null {
  return list.kind === "ready" && list.value
    ? (list.value.find((row) => row.wireCoin === wireCoin) ?? null)
    : null;
}

function first(param: string | string[] | undefined): string | null {
  if (param === undefined) return null;
  return Array.isArray(param) ? (param[0] ?? null) : param;
}

/**
 * Both sides' raw ctxs, keyed by wire coin — `predictionSideRows`' input.
 * Falls back to the route coin alone while the catalog has not named the
 * outcome, so the hero still has a mark to stand on.
 */
function sideCtxsFor(
  state: RawSpotState | null,
  outcome: { sides: readonly { wireCoin: string }[] } | null,
  wireCoin: string
): Map<string, { markPx: string; prevDayPx: string }> {
  const map = new Map<string, { markPx: string; prevDayPx: string }>();
  if (state === null || state.kind !== "ready") return map;
  const wanted = new Set(outcome ? outcome.sides.map((side) => side.wireCoin) : [wireCoin]);
  for (const ctx of state.value[1]) {
    if (wanted.has(ctx.coin)) map.set(ctx.coin, ctx);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/**
 * How much room the book gets when its row is expanded.
 *
 * A fixed height, not `flex-1`: this sits inside a scroll view, so there is no
 * "remaining space" to take, and the panel measures its own row count from the
 * height it is given. Eight rows a side plus the spread reads as a book rather
 * than a peek.
 */
const BOOK_PANEL_HEIGHT = 320;

export default function MarketDetail(): JSX.Element {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ coin: string; symbol?: string; kind?: string }>();
  const wireCoin = first(params.coin) ?? "";
  const kindParam = first(params.kind);
  const kind: MarketRow["kind"] =
    kindParam === "perp" || kindParam === "spot" || kindParam === "prediction"
      ? kindParam
      : kindOfWireCoin(wireCoin);

  const { session, lastResume } = useHyperliquid();
  const sessionState = useSessionState(session);
  const env = sessionState?.config.env ?? hlConfig.env;

  // Cache-warm within the list's TTL; also keeps the mids poll running while
  // this screen is focused, which is what ticks the hero between trades.
  const { perps, spot, predictions } = useMarketList(env);
  const row = rowFor(kind === "perp" ? perps : kind === "spot" ? spot : predictions, wireCoin);

  const [interval, setChartInterval] = useState<CandleInterval>("1h");
  const candles = useCandleSeries(wireCoin, interval, { env, lastResume });
  const perpFeed = usePerpAssetCtx(wireCoin, kind, env);
  const mid = useMid(wireCoin);
  const midsStale = useMidsStale();

  const raw = useRawSpotCtxs(env, kind !== "perp");
  const catalog = usePredictionCatalog();

  const outcome =
    kind === "prediction" ? outcomeByWireCoin(catalog?.outcomes ?? null, wireCoin) : null;

  // Plain derivations, no manual useMemo: React Compiler memoises them on its
  // own, and a hand-rolled memo here is exactly what makes it skip the
  // component (`preserve-manual-memoization`).
  const spotView =
    kind === "spot" && raw.state.kind === "ready"
      ? spotDetailFor(raw.state.value[0], raw.state.value[1], wireCoin)
      : null;

  const sideCtxs = sideCtxsFor(kind === "prediction" ? raw.state : null, outcome, wireCoin);

  // ------------------------------------------------------------------ hero
  const latestCloseWire =
    candles.series.forming?.close ?? candles.series.committed.at(-1)?.close ?? null;

  const heroPx =
    kind === "perp"
      ? (perpFeed.ctx?.markPx ?? mid ?? row?.px ?? null)
      : kind === "prediction"
        ? // The MARK is the probability. A candle close on an illiquid
          // prediction book can be days old and absurd — a 0.0% hero on a
          // 50/50 market was observed live — so it is the LAST resort here,
          // not the first.
          (sideCtxs.get(wireCoin)?.markPx ?? mid ?? row?.px ?? latestCloseWire ?? null)
        : (latestCloseWire ?? mid ?? row?.px ?? spotView?.markPx ?? null);

  const prevDayPx =
    kind === "perp"
      ? (perpFeed.ctx?.prevDayPx ?? row?.prevDayPx ?? null)
      : (row?.prevDayPx ??
        (kind === "spot" ? spotView?.prevDayPx : sideCtxs.get(wireCoin)?.prevDayPx) ??
        null);

  // Perp staleness comes from the live channel's own 10 s gate; the polled
  // kinds go stale with the mids heartbeat.
  const heroStale = kind === "perp" ? perpFeed.isStale : midsStale;

  const trend = changeTrend(heroPx, prevDayPx);
  const pct = change24hPct(heroPx, prevDayPx);
  const changeLabel =
    kind === "prediction"
      ? trend === null
        ? null
        : formatProbabilityChangePts(heroPx, prevDayPx)
      : pct === null
        ? null
        : formatChangePct(pct);

  const title = first(params.symbol) ?? row?.symbol ?? outcome?.name ?? wireCoin;

  // ------------------------------------------------------------------ tiles
  const perpTiles: StatTileData[] | null =
    kind === "perp"
      ? perpStatTiles(
          perpFeed.ctx,
          row && row.maxLeverage !== null ? { maxLeverage: row.maxLeverage } : null
        )
      : null;

  const spotTiles: StatTileData[] | null =
    kind === "spot" ? spotStatTiles(spotView?.token ?? null, spotView?.ctx ?? null) : null;

  const about = kind === "spot" ? aboutRows(spotView?.about ?? null) : [];

  const predictionTiles: StatTileData[] | null =
    kind === "prediction"
      ? predictionStatTiles({
          dayNtlVlm: row?.dayNtlVlm ?? null,
          quoteToken: outcome?.quoteToken ?? null,
          venue: outcome?.venue ?? null,
        })
      : null;

  const sides = outcome ? predictionSideRows(outcome, sideCtxs) : [];

  // Which disclosure rows are open. The fact rows are always visible now, so
  // nothing starts open — the book stays CLOSED because it is a live
  // subscription and a feed nobody expanded should not run. `DetailSections`
  // makes the open set the mount gate.
  const [openSections, setOpenSections] = useState<string[]>([]);

  return (
    // The sheet's FIRST page: no back affordance, because there is nothing
    // behind it inside the sheet, and no top inset, because the sheet's own
    // edge already sits below the status bar. The `pt-4` is the breathing
    // room the old card's top pad provided — without it the coin badge butts
    // against the sheet's rounded corner.
    <View className="flex-1 bg-background pt-4">
      {/* Identity and price on ONE line — see `MarketDetailHeader`. It replaces
          both the title bar and the old stacked hero: this is the sheet's first
          page, its height is finite, and two rows of chrome above the chart come
          straight out of what is readable beneath it. */}
      <View className="px-4 pb-1">
        <MarketDetailHeader
          wireCoin={wireCoin}
          symbol={title}
          kind={kind}
          price={heroPx}
          isStale={heroStale}
          changeLabel={changeLabel}
          trend={trend}
        />
      </View>
      {/* A plain ScrollView. The sheet's dismiss gesture is UIKit's own now
          and negotiates with scrolled content natively — drag at scroll-top
          dismisses, anywhere else scrolls — so the transition-aware wrapper
          went with the library. Styles are the resolved Tailwind steps. */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 8,
          gap: 16,
          paddingBottom: insets.bottom + 24,
        }}
      >
        {/* ------------------------------------------------------------ chart */}
        <CandleChartCard
          coin={wireCoin}
          feed={candles}
          interval={interval}
          onIntervalChange={setChartInterval}
          asProbability={kind === "prediction"}
        />

        {/* ------------------------------------------------------------ stats */}
        {perpTiles !== null ? (
          <View className="gap-2">
            <View className="flex-row items-center justify-between px-1">
              <Typography.Paragraph className="text-sm text-muted font-normal">
                Info
              </Typography.Paragraph>
              {perpFeed.isStale ? (
                <Chip size="sm" color="warning" variant="soft">
                  <Chip.Label className="font-medium">stale</Chip.Label>
                </Chip>
              ) : null}
            </View>
            {/* One grouped list: the book as a disclosure row on top, the
                fact rows in plain sight beneath — facts should not hide
                behind a tap. The book stays a LIVE SUBSCRIPTION that only
                runs while open; the open set is the mount gate. */}
            <DetailSections
              stale={perpFeed.isStale}
              open={openSections}
              onOpenChange={setOpenSections}
              disclosures={[
                {
                  value: "book",
                  icon: BookOpen,
                  label: "Order book",
                  content: (
                    <View className="px-4 pb-3" style={{ height: BOOK_PANEL_HEIGHT }}>
                      <OrderBookPanel
                        wireCoin={wireCoin}
                        symbol={title}
                        szDecimals={row?.szDecimals ?? null}
                        marketType="perp"
                        anchorPx={heroPx}
                        env={env}
                      />
                    </View>
                  ),
                },
              ]}
              rows={perpTiles.map((tile) => ({
                icon: statIcon(tile.label),
                label: tile.label,
                value: tile.value,
                tone: tile.tone,
                // Funding is the one fact whose "when" matters as much as its
                // size — it is paid on the hour, and the rate alone cannot
                // say how soon.
                suffix: tile.label === "Funding / hr" ? <FundingClock /> : undefined,
              }))}
            />
          </View>
        ) : null}

        {spotTiles !== null ? (
          <Card className="gap-3">
            <Typography.Paragraph className="text-xs text-muted font-normal">
              Spot stats
            </Typography.Paragraph>
            {raw.state.kind === "loading" ? (
              // Loading is NOT "--": dashes mean "this source has no value",
              // and the first visit was showing them for a read still in
              // flight — a skeleton is the honest in-between.
              <Skeleton className="h-20 w-full rounded-xl" />
            ) : (
              <StatTileGrid tiles={spotTiles} />
            )}
            <RawReadNotice state={raw.state} retry={raw.retry} />
          </Card>
        ) : null}

        {kind === "spot" ? (
          <DetailSections
            open={openSections}
            onOpenChange={setOpenSections}
            disclosures={[
              {
                value: "book",
                icon: BookOpen,
                label: "Order book",
                content: (
                  <View className="px-4 pb-3" style={{ height: BOOK_PANEL_HEIGHT }}>
                    <OrderBookPanel
                      wireCoin={wireCoin}
                      symbol={title}
                      szDecimals={row?.szDecimals ?? null}
                      marketType="spot"
                      anchorPx={heroPx}
                      env={env}
                    />
                  </View>
                ),
              },
            ]}
            rows={about.map((entry) => ({ label: entry.label, value: entry.value }))}
          />
        ) : null}

        {kind === "prediction" ? (
          <>
            {outcome !== null && outcome.description !== "" ? (
              // A disclosure row instead of the old More/Less button —
              // expansion is what the row is for, and it is a bigger target
              // than a tertiary button under four clipped lines.
              <DetailSections
                open={openSections}
                onOpenChange={setOpenSections}
                disclosures={[
                  {
                    value: "question",
                    icon: BookOpen,
                    label: "Question",
                    content: (
                      <View className="px-4 pb-3">
                        <Typography.Paragraph className="font-normal">
                          {outcome.description}
                        </Typography.Paragraph>
                      </View>
                    ),
                  },
                ]}
              />
            ) : null}

            {sides.length > 0 ? (
              <Card className="gap-3">
                <Typography.Paragraph className="text-xs text-muted font-normal">
                  Sides
                </Typography.Paragraph>
                {sides.map((side) => (
                  <View key={side.wireCoin} className="flex-row items-center justify-between">
                    <Typography.Paragraph className="font-medium" numberOfLines={1}>
                      {side.name}
                    </Typography.Paragraph>
                    <Typography.Paragraph className="font-semibold tabular-nums">
                      {side.probability ?? "--"}
                    </Typography.Paragraph>
                  </View>
                ))}
                {/* The chart plots the route's side; the sides card names both. */}
                <Typography.Paragraph className="text-xs text-muted font-normal">
                  Chart shows{" "}
                  {outcome?.sides.find((side) => side.wireCoin === wireCoin)?.name ?? wireCoin}
                </Typography.Paragraph>
              </Card>
            ) : null}

            {predictionTiles !== null ? (
              <Card className="gap-3">
                <Typography.Paragraph className="text-xs text-muted font-normal">
                  Market
                </Typography.Paragraph>
                <StatTileGrid tiles={predictionTiles} />
                <RawReadNotice state={raw.state} retry={raw.retry} />
              </Card>
            ) : null}
          </>
        ) : null}

        {/* ------------------------------------------------------ account */}
        {/* Your position, orders and balance on THIS market — contextual
            sections, not the full account tabs (Portfolio is the full view).
            Predictions are excluded: `TradableKind` is perp-or-spot, and an
            outcome market has no position or order shape these items read. */}
        {kind === "prediction" ? null : <MarketAccountSection kind={kind} coin={wireCoin} />}
        {/* The wire coin rides along so the trade screen lands on THIS market —
          without it it opens on whatever was last traded. NOT rendered for a
          prediction: the trade screen cannot submit an outcome order, and the
          pushed "#N" coin would even persist as the last market, so a fresh
          open would restore a broken screen. */}
        {kind === "prediction" ? null : (
          <GlassCta
            label="Trade"
            onPress={() => router.push({ pathname: "/order", params: { coin: wireCoin } })}
          />
        )}
      </ScrollView>
    </View>
  );
}

/**
 * Why a stats card is dashed: the raw read was deferred or failed. Renders
 * nothing while loading or ready — the tiles' own nulls cover loading.
 */
function RawReadNotice({
  state,
  retry,
}: {
  state: RawSpotState;
  retry: () => void;
}): JSX.Element | null {
  if (state.kind === "loading" || state.kind === "ready") return null;
  return (
    <View className="items-start gap-2">
      <Chip
        size="sm"
        variant="soft"
        {...(state.kind === "error" ? { color: "danger" as const } : {})}
      >
        <Chip.Label className="font-medium">
          {state.kind === "deferred" ? "paused to stay inside the rate limit" : "could not load"}
        </Chip.Label>
      </Chip>
      <Typography.Paragraph className="text-xs text-muted font-normal">
        {state.kind === "deferred"
          ? "This read shares a per-IP allowance with the rest of the screen."
          : state.message}
      </Typography.Paragraph>
      <Button size="sm" variant="secondary" onPress={retry}>
        <Button.Label className="font-medium">Try again</Button.Label>
      </Button>
    </View>
  );
}
