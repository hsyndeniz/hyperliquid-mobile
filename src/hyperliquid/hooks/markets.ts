/**
 * Market-data hooks — the composition edge for the Markets screens.
 *
 * All budget and cache decisions live HERE, not in the modules they compose:
 * `api/assetCtxs.ts` and `api/candles.ts` are budget-injected fetchers,
 * `markets/rows.ts` is a pure join, and the stores hold state. The budget is a
 * property of *this app making this call on this device*, so it belongs at the
 * edge — the same rule `hooks/history.ts` states.
 *
 * ## The list is polled, never subscribed
 *
 * `useMarketList` opens **no websocket**. `allMids` is a 2-weight REST poll
 * every {@link MIDS_POLL_INTERVAL_MS} while the screen is focused; the pushed
 * channel delivers a ~45 KB map (2,700 keys, measured) per tick, which is a
 * Hermes JSON parse per push for a screen that needs 15 s freshness. The
 * arithmetic that fixed the design: cold mount 62 weight (perps 20 + spot 20 +
 * catalog 20 + one mids poll 2), steady state 8/min, pull-to-refresh 42.
 *
 * ## Three sections, three independent states
 *
 * Perps, spot and predictions are separate `Fetched` values on purpose: the
 * perp read being deferred by the budget must not blank a spot list that
 * loaded fine. Predictions DERIVE from the spot response (the `#N` ctxs ride
 * in it — no extra read) joined against the outcome catalog, so their state is
 * the spot state until the catalog resolves.
 *
 * ## Env scoping
 *
 * Every cache key and subscription target carries an env. It defaults to the
 * build-time `hlConfig.env`; a caller running against a session that switched
 * network passes that session's env instead. `marketMids` is one process-wide
 * map — on an env switch the next poll replaces it wholesale, and the age
 * keeps the stale chip honest through the gap.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useFocusEffect } from "expo-router";

import { getInfoClient } from "@/hyperliquid/api/clients";
import {
  fetchPerpCtxs,
  fetchSpotCtxs,
  type PerpCtxsProbe,
  type SpotCtxsProbe,
} from "@/hyperliquid/api/assetCtxs";
import {
  fetchCandles,
  previousPageEnd,
  toCandle,
  type CandleProbe,
} from "@/hyperliquid/api/candles";
import {
  readThrough,
  restCache,
  restCacheKey,
  REST_CACHE_TTL_MS,
} from "@/hyperliquid/api/restCache";
import { weightBudget } from "@/hyperliquid/api/weightBudget";
import { hlConfig } from "@/hyperliquid/config/env";
import { scope } from "@/hyperliquid/core/freshness";
import { subscriptionKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import type { Fetched } from "@/hyperliquid/hooks/history";
import { usePredictionCatalog } from "@/hyperliquid/hooks/predictions";
import { useStoreValue } from "@/hyperliquid/hooks/useStore";
import {
  buildPerpRows,
  buildPredictionRows,
  buildSpotRows,
  sortRows,
  type MarketRow,
  type SpotCtxInput,
} from "@/hyperliquid/markets/rows";
import { AssetCtxStore, type AssetCtxView } from "@/hyperliquid/state/assetCtx";
import { BookStore, type BookSnapshot } from "@/hyperliquid/state/book";
import { CandleStore, intervalMs, type CandleSeries } from "@/hyperliquid/state/candles";
import { marketFeed, marketTarget } from "@/hyperliquid/state/marketFeed";
import { TradesStore, type TradeRow, type TradeTick } from "@/hyperliquid/state/trades";
import { MidsStore } from "@/hyperliquid/state/mids";
import { sparklines, type SparkCloses } from "@/hyperliquid/state/sparklines";
import type { ResumeDecision } from "@/hyperliquid/state/appState";
import type { CandleInterval, HlEnv, L2Aggregation, Scoped } from "@/hyperliquid/types/domain";
import type { IActiveAssetCtxEvent, ICandleWsEvent } from "@/hyperliquid/types/sdk";

const logger = log.child("hooks.markets");

/**
 * `useFocusEffect` comes straight from React Navigation rather than from
 * the router.
 *
 * This is a headless-module file; the router is the UI layer's navigator,
 * and a hook that only asks "is my screen focused?" does not need it. It used
 * to be a lazy `require` because expo-router dragged in `standard-navigation`,
 * whose untranspiled ESM Jest could not load — `@react-navigation/*` is
 * allowlisted in `transformIgnorePatterns`, so a plain import is fine now.
 */

/** Poll cadence while the list is focused. 2 weight per poll ≈ 8/min. */
export const MIDS_POLL_INTERVAL_MS = 15_000;

/** Age past which the header shows the stale chip — one missed poll. */
export const MIDS_STALE_AFTER_MS = 15_000;

/** Chart seed depth. 300 bars = 20 + 15 paging weight = 35 per seed. */
export const CANDLE_SEED_COUNT = 300;

/**
 * Sparkline closes: 24 hourly candles per coin, cached hard.
 *
 * **The cost is the whole design.** One coin is 21 weight (20 + 24/20 pages)
 * against a 1,200/minute allowance shared by the entire app, so a naive
 * per-row fetch is not a heavier version of the highlight strip — it is a
 * different order of problem: 30 visible rows would be 630, and one scroll
 * page another 630, while the mids poll and every trade action draw from the
 * same window. What makes rows affordable is not a smaller page; it is
 * fetching only what someone actually LOOKED at:
 *
 * - **Dwell.** A row must hold its coin for {@link SPARKLINE_DWELL_MS} before
 *   it asks. Cells recycle, so the effect's cleanup fires the moment a row is
 *   reused for another coin — a fling therefore requests nothing at all.
 * - **Reserve.** No sparkline is fetched while the budget is under
 *   {@link SPARKLINE_WEIGHT_RESERVE}. Decoration must never be the reason a
 *   price poll or an order is declined; the reserve is what makes that a rule
 *   rather than a hope.
 * - **Concurrency + a LIFO queue.** At most
 *   {@link SPARKLINE_MAX_INFLIGHT} requests are open, and the newest request
 *   wins: by the time a queue drains, the coin someone was looking at eight
 *   seconds ago is off screen and worthless.
 *
 * A declined or failed read caches NOTHING and renders NOTHING — no notice,
 * no placeholder line. The price and the 24h change are the information; the
 * line is garnish, and garnish that is sometimes absent is honest where a
 * fabricated flat line would not be.
 */
export const SPARKLINE_CANDLES = 24;
export const SPARKLINE_TTL_MS = 5 * 60_000;

/** How long a row must hold one coin before it asks. A fling never asks. */
export const SPARKLINE_DWELL_MS = 400;

/** Weight kept back for the price poll and anything the user initiates. */
export const SPARKLINE_WEIGHT_RESERVE = 300;

/** Open sparkline requests allowed at once. */
export const SPARKLINE_MAX_INFLIGHT = 4;

/** Coins that may wait for a slot. Older intent is stale intent. */
const SPARKLINE_QUEUE_CAP = 8;

/** Newest-first: the row on screen now outranks the one that scrolled away. */
const sparkQueue: { key: string; coin: string }[] = [];
const sparkPending = new Set<string>();
let sparkInFlight = 0;

function sparkKey(env: HlEnv, wireCoin: string): string {
  return `${env}:${wireCoin}`;
}

async function readSparkline(key: string, wireCoin: string): Promise<void> {
  const { value } = await readThrough<SparkCloses>({
    key: restCacheKey("sparkline", key),
    ttlMs: SPARKLINE_TTL_MS,
    now: Date.now(),
    fetch: async () => {
      const history = await fetchCandles({
        probe: getInfoClient() as unknown as CandleProbe,
        coin: wireCoin,
        interval: "1h",
        count: SPARKLINE_CANDLES,
      });
      // Budget declined: cache nothing, render nothing, and let the next
      // dwell on this coin ask again.
      if (history.deferred) return null;
      return history.candles.map((candle) => [candle.openTime, candle.close] as const);
    },
  });
  if (value !== null) sparklines.set(key, value);
}

/** Drain the queue while a slot, the budget and the queue all allow it. */
function pumpSparklines(): void {
  while (sparkInFlight < SPARKLINE_MAX_INFLIGHT && sparkQueue.length > 0) {
    // Re-checked per request, not once per drain: the budget moves under us.
    if (weightBudget.remaining(Date.now()) < SPARKLINE_WEIGHT_RESERVE) return;
    const next = sparkQueue.pop();
    if (next === undefined) return;
    sparkPending.delete(next.key);
    if (sparklines.has(next.key)) continue;

    sparkInFlight += 1;
    void readSparkline(next.key, next.coin)
      .catch((error: unknown) => {
        logger.warn("markets.sparkline_failed", { context: { coin: next.coin }, error });
      })
      .finally(() => {
        sparkInFlight -= 1;
        pumpSparklines();
      });
  }
}

/** Ask for one coin's closes. Idempotent, and free when already held. */
function requestSparkline(env: HlEnv, wireCoin: string): void {
  const key = sparkKey(env, wireCoin);
  if (sparklines.has(key) || sparkPending.has(key)) return;

  const cached = restCache.read<SparkCloses>(
    restCacheKey("sparkline", key),
    Date.now(),
    SPARKLINE_TTL_MS
  );
  if (cached !== undefined) {
    sparklines.set(key, cached);
    return;
  }

  sparkPending.add(key);
  sparkQueue.push({ key, coin: wireCoin });
  // Oldest intent falls off the FRONT — `pop()` takes the newest.
  while (sparkQueue.length > SPARKLINE_QUEUE_CAP) {
    const dropped = sparkQueue.shift();
    if (dropped !== undefined) sparkPending.delete(dropped.key);
  }
  pumpSparklines();
}

/**
 * Hourly closes for one coin, requested only after this row has held it for
 * {@link SPARKLINE_DWELL_MS}.
 *
 * `null` while unavailable — unread, still queued, declined by the reserve, or
 * failed. Every one of those renders no chart.
 */
export function useSparkline(
  wireCoin: string | null,
  env: HlEnv = hlConfig.env
): SparkCloses | null {
  const key = wireCoin === null ? null : sparkKey(env, wireCoin);

  // `useSyncExternalStore` requires a subscribe that is stable per key, or it
  // resubscribes every render — the same contract `useStoreValue` documents.
  const subscribe = useCallback(
    (listener: () => void) => sparklines.subscribe(key, listener),
    [key]
  );
  const getSnapshot = useCallback(() => sparklines.read(key), [key]);

  useEffect(() => {
    if (wireCoin === null) return;
    // The dwell. Cells recycle rather than unmount, so this cleanup is what
    // a fling trips: the coin changes, the timer dies, nothing is requested.
    const timer = setTimeout(() => requestSparkline(env, wireCoin), SPARKLINE_DWELL_MS);
    return () => clearTimeout(timer);
  }, [wireCoin, env]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Settle-timer clamp. The candle feed only ticks on trades, so a quiet
 * market's forming bar is promoted by wall clock at `closeTime + 1` — clamped
 * so a bar already past its close still settles (min) and a long interval
 * re-checks cheaply instead of sleeping an hour on a suspendable JS timer (max).
 */
export const SETTLE_MIN_DELAY_MS = 250;
export const SETTLE_MAX_DELAY_MS = 60_000;

/** How often a mounted detail surface re-checks ctx staleness (gate is 10 s). */
const CTX_STALE_CHECK_MS = 2_500;

/**
 * The polled mids, process-wide. Mids are the exchange's, not a screen's: the
 * list polls into this store, and every row/detail reads through {@link useMid}
 * so a poll re-renders only the rows whose mid string actually changed.
 */
export const marketMids = new MidsStore();

// ---------------------------------------------------------------------------
// Internal: env-scoped one-shot read with the useFetch state discipline
// ---------------------------------------------------------------------------

/**
 * `hooks/history.ts`'s `useFetch`, re-shaped for exchange-wide reads: the
 * scope dimension is the **env**, not a user. Same rules, same reasons —
 * lazy cache seed (a remount inside the TTL costs nothing), state stored WITH
 * the env it belongs to (an env switch derives `loading` with no effect-reset
 * and drops late responses by the same check), deferred-a-tick mount effect,
 * and `null` from the read meaning "budget declined", never "empty".
 */
function useEnvFetch<T>(
  env: HlEnv,
  request: string,
  read: () => Promise<T | null>
): { state: Fetched<T>; refresh: () => void } {
  const key = restCacheKey(request, env);
  const [entry, setEntry] = useState<{ env: HlEnv | null; state: Fetched<T> }>(() => {
    const hit = restCache.read<T>(key, Date.now(), REST_CACHE_TTL_MS);
    return hit === undefined
      ? { env: null, state: { kind: "loading" } }
      : { env, state: { kind: "ready", value: hit } };
  });

  const state: Fetched<T> = entry.env === env ? entry.state : { kind: "loading" };

  const run = useCallback(
    async (force: boolean) => {
      try {
        const { value } = await readThrough<T>({
          key: restCacheKey(request, env),
          ttlMs: force ? 0 : REST_CACHE_TTL_MS,
          now: Date.now(),
          fetch: read,
        });
        setEntry({
          env,
          state: value === null ? { kind: "deferred" } : { kind: "ready", value },
        });
      } catch (error) {
        logger.warn("markets.read_failed", { context: { request }, error });
        setEntry({
          env,
          state: { kind: "error", message: error instanceof Error ? error.message : "failed" },
        });
      }
    },
    // `read` is intentionally not a dependency: callers pass an inline arrow,
    // and depending on it would refetch in a loop. `env` + `request` identify
    // the read — the same reasoning as useFetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [env, request]
  );

  useEffect(() => {
    // Deferred a tick so nothing writes state synchronously from the effect;
    // `run` consults the cache first, so a remount inside the TTL is free.
    const timer = setTimeout(() => void run(false), 0);
    return () => clearTimeout(timer);
  }, [run]);

  const refresh = useCallback(() => {
    void run(true);
  }, [run]);

  return { state, refresh };
}

// ---------------------------------------------------------------------------
// The market list
// ---------------------------------------------------------------------------

/** The spot read's cached shape: built rows plus the `#N` ctxs for predictions. */
interface SpotSection {
  spot: readonly MarketRow[];
  predictionCtxs: ReadonlyMap<string, SpotCtxInput>;
}

export interface MarketList {
  perps: Fetched<readonly MarketRow[]>;
  spot: Fetched<readonly MarketRow[]>;
  predictions: Fetched<readonly MarketRow[]>;
  /** Forced refetch of perps + spot + one mids poll (42 weight). Catalog stays. */
  refresh: () => void;
}

/**
 * The three market sections, sorted by volume at build time.
 *
 * Order is fixed per snapshot — a mids poll moves prices in place via
 * {@link useMid}, it never re-sorts the list under the user's finger. Rows are
 * built and sorted ONCE per TTL and cached built (the spot payload is ~866 KB;
 * re-parsing per mount was the failure the cache exists to prevent).
 *
 * Predictions stay `loading` while the catalog is unresolved even if the spot
 * read is ready: a null catalog is "not known yet", and passing it as empty
 * would honestly build zero rows — the wrong honesty.
 */
export function useMarketList(env: HlEnv = hlConfig.env): MarketList {
  const catalog = usePredictionCatalog();

  const { state: perps, refresh: refreshPerps } = useEnvFetch<readonly MarketRow[]>(
    env,
    "marketRows:perps",
    async () => {
      const result = await fetchPerpCtxs({ probe: getInfoClient() as unknown as PerpCtxsProbe });
      if (result.value === null) return null;
      return sortRows(buildPerpRows(result.value));
    }
  );

  const { state: spotSection, refresh: refreshSpot } = useEnvFetch<SpotSection>(
    env,
    "marketRows:spot",
    async () => {
      const result = await fetchSpotCtxs({ probe: getInfoClient() as unknown as SpotCtxsProbe });
      if (result.value === null) return null;
      const { spot, predictionCtxs } = buildSpotRows(result.value);
      return { spot: sortRows(spot), predictionCtxs };
    }
  );

  const spot: Fetched<readonly MarketRow[]> = useMemo(
    () =>
      spotSection.kind === "ready" ? { kind: "ready", value: spotSection.value.spot } : spotSection,
    [spotSection]
  );

  const predictions: Fetched<readonly MarketRow[]> = useMemo(() => {
    if (spotSection.kind !== "ready") return spotSection;
    if (catalog === null) return { kind: "loading" };
    return {
      kind: "ready",
      value: sortRows(buildPredictionRows(spotSection.value.predictionCtxs, catalog)),
    };
  }, [spotSection, catalog]);

  const pollMids = useCallback(async () => {
    try {
      const mids = await weightBudget.tryRun("allMids", () => getInfoClient().allMids());
      // `null` is the budget declining — skip the write so the age keeps
      // growing and the stale chip appears instead of a silently frozen price.
      if (mids !== null) marketMids.set(mids as Record<string, string>, Date.now());
    } catch (error) {
      logger.warn("markets.mids_poll_failed", { error });
    }
  }, []);

  // Poll only while this screen is focused: a backgrounded tab must not spend
  // 8 weight/min forever. `useFocusEffect` re-runs on focus, so returning to
  // the tab polls immediately rather than waiting out the interval.
  useFocusEffect(
    useCallback(() => {
      void pollMids();
      const timer = setInterval(() => void pollMids(), MIDS_POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    }, [pollMids])
  );

  const refresh = useCallback(() => {
    refreshPerps();
    refreshSpot();
    void pollMids();
  }, [refreshPerps, refreshSpot, pollMids]);

  return { perps, spot, predictions, refresh };
}

/**
 * One row's mid, or `null` while unknown — the row falls back to its snapshot
 * `markPx`, never to 0. A string primitive, so `Object.is` bails unchanged
 * rows out of a changed poll and only moved prices re-render.
 */
export function useMid(coin: string): string | null {
  return useStoreValue(
    marketMids,
    useCallback((store: MidsStore) => store.mid(coin), [coin])
  );
}

/**
 * Whether the mids heartbeat has gone quiet, as a BOOLEAN that re-renders its
 * consumer only when the answer CHANGES.
 *
 * `useMidsAge` hands back a fresh number on every 5 s tick and every poll
 * frame, so a screen that only wants "stale or not" re-rendered on each —
 * measured on the Markets tab as a 13–77 ms whole-screen render every ≤5 s,
 * multiplied by the market detail and the order form, which derived the same
 * boolean the same way. Here the tick still runs, but `setStale(same)` takes
 * React's state bail-out and no render happens until the poll actually stalls
 * or recovers.
 */
export function useMidsStale(thresholdMs = MIDS_STALE_AFTER_MS, tickMs = 5_000): boolean {
  const [stale, setStale] = useState<boolean>(() => {
    const age = marketMids.ageMs(Date.now());
    return age !== null && age > thresholdMs;
  });
  useEffect(() => {
    const update = () => {
      const age = marketMids.ageMs(Date.now());
      setStale(age !== null && age > thresholdMs);
    };
    const unsubscribe = marketMids.subscribe(update);
    const timer = setInterval(update, tickMs);
    update();
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [thresholdMs, tickMs]);
  return stale;
}

/**
 * Milliseconds since the last successful poll, `null` before the first.
 *
 * A hook rather than `marketMids.ageMs(Date.now())` in a component: React
 * Compiler memoises plain method calls on stable objects (the measured
 * `session.address()` trap), so the read must go through a subscription.
 */
export function useMidsAge(tickMs = 5_000): number | null {
  const [age, setAge] = useState<number | null>(() => marketMids.ageMs(Date.now()));
  useEffect(() => {
    const update = () => setAge(marketMids.ageMs(Date.now()));
    const unsubscribe = marketMids.subscribe(update);
    const timer = setInterval(update, tickMs);
    update();
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [tickMs]);
  return age;
}

// ---------------------------------------------------------------------------
// Candle series
// ---------------------------------------------------------------------------

export type CandleSeedPhase = "loading" | "ready" | "deferred" | "error";

export interface CandleSeriesFeed {
  /** Committed + forming, referentially stable between mutations. */
  series: CandleSeries;
  /**
   * The REST seed's lifecycle. The live feed ticks regardless — `deferred` or
   * `error` mean "history missing, retry available", never an empty chart
   * presented as a market with no trades.
   */
  seed: CandleSeedPhase;
  /** Re-ask for the seed after a deferral or failure. */
  retry: () => void;
  /** Page history back one seed-width from the oldest held bar. */
  loadOlder: () => void;
  isLoadingOlder: boolean;
}

/**
 * A live candle series for one (coin, interval).
 *
 * **Live-first, then seed**: the websocket target opens before the REST seed
 * is requested, so a bar that trades during the fetch is upserted rather than
 * lost — overlap is safe because both paths key buckets by open time. An
 * interval switch is a retarget: the store clears (a BTC/1m series is not
 * BTC/1h data) and the old feed closes with its ref-count.
 *
 * The **settle timer is mandatory, not an optimisation**: the feed only emits
 * on trades, so on a quiet market nothing else ever closes the forming bar,
 * and a "current price" read from it pins to a dead close (measured: testnet
 * BTC 1m went a full bucket with no event).
 *
 * `lastResume` (from `useHyperliquid()`) triggers a REST backfill when the
 * app returns from background with the feed presumed dead or the series
 * stale — the socket may auto-heal, but the gap it left does not.
 */
export function useCandleSeries(
  wireCoin: string,
  interval: CandleInterval,
  options: { env?: HlEnv; lastResume?: ResumeDecision | null } = {}
): CandleSeriesFeed {
  const env = options.env ?? hlConfig.env;
  const lastResume = options.lastResume ?? null;
  const [store] = useState(() => new CandleStore());
  const [attempt, setAttempt] = useState(0);

  const target = useMemo(
    () => marketTarget({ env, channel: "candle", coin: wireCoin, interval }),
    [env, wireCoin, interval]
  );
  const targetKey = subscriptionKey(target);
  // Seed state is stored WITH the run it belongs to and derived, so a
  // retarget or retry reads `loading` on the very first render and a late
  // response for a previous target cannot overwrite the current one.
  const seedKey = `${targetKey}#${attempt}`;
  const [seedEntry, setSeedEntry] = useState<{ key: string; phase: CandleSeedPhase }>({
    key: seedKey,
    phase: "loading",
  });
  const seed: CandleSeedPhase = seedEntry.key === seedKey ? seedEntry.phase : "loading";

  // The live subscription. Opened before the seed fetch below by effect order.
  useEffect(() => {
    store.setTarget(target);
    return marketFeed.open(target, (event) => {
      store.apply({ ...event, value: toCandle(event.value as ICandleWsEvent) }, Date.now());
    });
  }, [store, target]);

  // The REST seed — re-run per retarget and per retry.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const history = await fetchCandles({
            probe: getInfoClient() as unknown as CandleProbe,
            coin: wireCoin,
            interval,
            count: CANDLE_SEED_COUNT,
          });
          if (!live) return;
          if (history.deferred) {
            setSeedEntry({ key: seedKey, phase: "deferred" });
            return;
          }
          store.seed(target, history.candles, Date.now());
          setSeedEntry({ key: seedKey, phase: "ready" });
        } catch (error) {
          logger.warn("markets.candle_seed_failed", {
            context: { coin: wireCoin, interval },
            error,
          });
          if (live) setSeedEntry({ key: seedKey, phase: "error" });
        }
      })();
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `target` and `seedKey` are both functions of (env, coin, interval,
    // attempt) — the listed deps are the identity of this seed run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, targetKey, attempt]);

  // The wall-clock settle. Re-armed on every store mutation: a trade advances
  // the forming bar (new close time), a settle clears it, a retarget resets.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const forming = store.read().forming;
      if (forming === null) return;
      const delay = Math.min(
        Math.max(forming.closeTime + 1 - Date.now(), SETTLE_MIN_DELAY_MS),
        SETTLE_MAX_DELAY_MS
      );
      timer = setTimeout(() => {
        store.settle(Date.now());
        // `settle` emits only when it promotes; a bar still open re-arms here.
        arm();
      }, delay);
    };
    const unsubscribe = store.subscribe(arm);
    arm();
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [store]);

  // Resume backfill. Keyed on the DECISION OBJECT: the provider mints a new
  // one per foreground return, so each resume is considered exactly once.
  useEffect(() => {
    if (lastResume === null) return;
    if (!lastResume.shouldResubscribe && !store.isStale(Date.now(), 2 * intervalMs(interval))) {
      return;
    }
    let live = true;
    void (async () => {
      try {
        const history = await fetchCandles({
          probe: getInfoClient() as unknown as CandleProbe,
          coin: wireCoin,
          interval,
          count: CANDLE_SEED_COUNT,
        });
        // A deferred backfill keeps the held bars; the store's own staleness
        // is what a chip reads — nothing here pretends the gap closed.
        if (!live || history.deferred) return;
        store.seed(target, history.candles, Date.now());
      } catch (error) {
        logger.warn("markets.candle_backfill_failed", {
          context: { coin: wireCoin, interval },
          error,
        });
      }
    })();
    return () => {
      live = false;
    };
    // Deliberately ONLY the decision: target/interval changes already re-seed
    // via the effect above, and re-running a backfill for them would double-buy
    // the same 35 weight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastResume]);

  const olderBusy = useRef(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const loadOlder = useCallback(() => {
    if (olderBusy.current) return;
    const oldest = store.read().committed[0];
    if (oldest === undefined) return;
    olderBusy.current = true;
    setIsLoadingOlder(true);
    void (async () => {
      try {
        const page = await fetchCandles({
          probe: getInfoClient() as unknown as CandleProbe,
          coin: wireCoin,
          interval,
          count: CANDLE_SEED_COUNT,
          endTime: previousPageEnd(oldest),
        });
        if (page.deferred) return;
        // `seed` upserts (and the store drops it if the target moved on), but
        // it also re-derives the forming pointer from THIS page — all closed
        // bars — so the live forming bar is captured first and re-applied.
        const forming = store.read().forming;
        store.seed(target, page.candles, Date.now());
        if (forming !== null) store.apply(scope(target, forming), Date.now());
      } catch (error) {
        logger.warn("markets.candle_page_failed", { context: { coin: wireCoin, interval }, error });
      } finally {
        olderBusy.current = false;
        setIsLoadingOlder(false);
      }
    })();
  }, [store, target, wireCoin, interval]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const series = useStoreValue(
    store,
    useCallback((s: CandleStore) => s.read(), [])
  );

  return { series, seed, retry, loadOlder, isLoadingOlder };
}

// ---------------------------------------------------------------------------
// Per-market live context (perps only)
// ---------------------------------------------------------------------------

export interface PerpAssetCtxFeed {
  /**
   * The latest ctx view — the SAME object between events, `null` before the
   * first event or after a retarget. Held through staleness so a surface can
   * dim last-known values instead of flashing empty; check `isStale`.
   */
  ctx: AssetCtxView | null;
  /** True when the held ctx is older than the 10 s freshness gate. */
  isStale: boolean;
}

/**
 * Live mark/oracle/funding/OI for one PERP market via `activeAssetCtx`.
 *
 * Perps only, structurally: for `kind !== "perp"` no subscription opens and
 * the result stays `{ctx: null, isStale: false}` — `activeSpotAssetCtx` is
 * deliberately unwired (spot detail reads the cached snapshot + candle feed),
 * and `fastAssetCtxs` is Hermes-banned (see `state/channels.ts`).
 */
export function usePerpAssetCtx(
  wireCoin: string,
  kind: MarketRow["kind"],
  env: HlEnv = hlConfig.env
): PerpAssetCtxFeed {
  const [store] = useState(() => new AssetCtxStore());
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (kind !== "perp") {
      store.setTarget(null);
      return;
    }
    const target = marketTarget({ env, channel: "activeAssetCtx", coin: wireCoin });
    store.setTarget(target);
    return marketFeed.open(target, (event) => {
      store.apply(event as Scoped<IActiveAssetCtxEvent>);
    });
  }, [env, kind, store, wireCoin]);

  // Staleness needs a clock, not just events — a dead feed emits nothing. The
  // store subscription clears the flag the instant a fresh event lands; the
  // interval trips it when nothing does. Same-value sets bail out of React.
  useEffect(() => {
    if (kind !== "perp") return;
    const check = () => setStale(store.isStale(Date.now()));
    const unsubscribe = store.subscribe(check);
    const timer = setInterval(check, CTX_STALE_CHECK_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [kind, store]);

  const scoped = useStoreValue(
    store,
    useCallback((s: AssetCtxStore) => s.readScoped(), [])
  );

  // Derived, not reset in an effect: a kind change must read correctly on the
  // very first render, and a leftover `stale` from a previous perp target
  // must not label a channel that is deliberately closed.
  return { ctx: scoped?.value ?? null, isStale: kind === "perp" && stale };
}

// ---------------------------------------------------------------------------
// Live order book + trades tape (the Trade screen)
// ---------------------------------------------------------------------------

export interface OrderBookFeed {
  /**
   * The freshness-gated book: `null` before the first frame, after a
   * retarget, and once the feed goes quiet past {@link BOOK_MAX_AGE_MS}.
   * The authority for anything that ACTS on a price — row taps fill the
   * order form from here and nowhere else.
   */
  book: BookSnapshot | null;
  /**
   * The last held snapshot regardless of age — the display path once `book`
   * goes null, rendered greyed with taps disabled so the screen degrades to
   * "old numbers, clearly labelled" instead of blanking mid-glance. Null only
   * before the first frame or after a retarget (a switch must never show the
   * previous market's book).
   */
  held: BookSnapshot | null;
  /** True when `held` is being shown past the freshness gate. */
  isStale: boolean;
}

/**
 * One market's live L2 book via `l2Book`, grouped per `aggregation`.
 *
 * A grouping change is a RETARGET, exactly like a coin change: aggregation is
 * part of the subscription key, so nSigFigs 4 and nSigFigs 2 are different
 * server subscriptions, and the store clears the instant the target moves —
 * the previous grouping's rows never render under the new menu label.
 *
 * `fast: true` delivers 5 levels per side every ~0.5 s; `fast: false` delivers
 * 20 every ~5 s (both measured on the wire). Pushes cost zero request weight
 * either way, so a surface that needs more than 5 levels AND a live touch runs
 * two of these — see `mergeBookSide`.
 *
 * `enabled: false` holds no subscription and reports an empty feed. It exists
 * for exactly that second call: a ladder with room for only 5 rows has nothing
 * to do with the deep feed, and an open channel nobody reads is a per-frame
 * Hermes parse for nothing.
 */
export function useOrderBook(
  wireCoin: string,
  aggregation: L2Aggregation | null,
  env: HlEnv = hlConfig.env,
  { enabled = true }: { enabled?: boolean } = {}
): OrderBookFeed {
  const [store] = useState(() => new BookStore());
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!enabled) {
      // Clears, not just unsubscribes: a disabled feed must not keep serving
      // the levels it happened to hold when it was switched off.
      store.setTarget(null);
      return;
    }
    const target = marketTarget({ env, channel: "l2Book", coin: wireCoin, aggregation });
    store.setTarget(target);
    return marketFeed.open(target, (event) => {
      store.apply(event as Scoped<BookSnapshot>);
    });
  }, [aggregation, enabled, env, store, wireCoin]);

  // The staleness clock, mirrored from `usePerpAssetCtx`: a dead feed emits
  // nothing, so events alone cannot trip the flag — the interval does, and
  // the store subscription clears it the instant a fresh frame lands.
  useEffect(() => {
    const check = () => setStale(store.isStale(Date.now()));
    const unsubscribe = store.subscribe(check);
    const timer = setInterval(check, CTX_STALE_CHECK_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [store]);

  // `readScoped`/`readHeld` are referentially stable between events, which is
  // what `useSyncExternalStore` requires of a snapshot; `read(Date.now())`
  // would flip to null between emissions and tear. Freshness rides the
  // interval-driven flag instead.
  const scoped = useStoreValue(
    store,
    useCallback((s: BookStore) => s.readScoped(), [])
  );
  const held = scoped?.value ?? null;

  return { book: stale ? null : held, held, isStale: stale && held !== null };
}

export interface TradesTapeFeed {
  /** Newest first, capped at {@link TAPE_CAP}. Empty before the first print. */
  trades: readonly TradeTick[];
  /** True when the feed has gone quiet past the gate while holding prints. */
  isStale: boolean;
}

/**
 * One market's recent prints via `trades`, for the tape toggle in the book
 * column. `enabled` gates the subscription entirely — the tape is behind a
 * toggle, and an invisible tape holding a live channel open would be spend
 * without a reader (free in weight, but a per-frame Hermes parse).
 */
export function useTradesTape(
  wireCoin: string,
  enabled: boolean,
  env: HlEnv = hlConfig.env
): TradesTapeFeed {
  const [store] = useState(() => new TradesStore());
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!enabled) {
      store.setTarget(null);
      return;
    }
    const target = marketTarget({ env, channel: "trades", coin: wireCoin });
    store.setTarget(target);
    return marketFeed.open(target, (event) => {
      store.apply(event as Scoped<readonly TradeRow[]>);
    });
  }, [enabled, env, store, wireCoin]);

  useEffect(() => {
    if (!enabled) return;
    const check = () => setStale(store.isStale(Date.now()));
    const unsubscribe = store.subscribe(check);
    const timer = setInterval(check, CTX_STALE_CHECK_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [enabled, store]);

  const trades = useStoreValue(
    store,
    useCallback((s: TradesStore) => s.read(), [])
  );

  return { trades, isStale: enabled && stale && trades.length > 0 };
}
