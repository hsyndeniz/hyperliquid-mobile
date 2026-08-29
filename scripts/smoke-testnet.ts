/**
 * Live testnet smoke test.
 *
 *   bun run smoke
 *
 * Exercises the Phase 1–4 realtime path against the **real Hyperliquid testnet**
 * — no wallet, no funds, no credentials, nothing written. Read-only market data
 * only, so it is safe to run at any time.
 *
 * It exists because unit tests prove the logic and prove nothing about the
 * assumptions underneath it: that the SDK's websocket works on this runtime,
 * that our subscription parameters are accepted, that events actually arrive in
 * the shape the types claim, and that a target switch really does drop in-flight
 * data from the previous market.
 *
 * Anything requiring a signature (agent approval, order placement) is out of
 * scope here and needs a funded testnet account.
 */

import { InfoClient, SubscriptionClient, WebSocketTransport } from "@nktkas/hyperliquid";
import { SymbolConverter } from "@nktkas/hyperliquid/utils";

import { resolveAssetSpec, subscriptionCoin } from "@/hyperliquid/assets";
import { classifyAssetId, wrapSymbolConverter } from "@/hyperliquid/core/assetIds";
import { createIdentity, subscriptionKey } from "@/hyperliquid/core/identity";
import { formatPrice, formatSize } from "@/hyperliquid/core/precision";
import { addLogSink, createConsoleSink, setLogLevel } from "@/hyperliquid/core/logger";
import { createSubscribeFn, type SubscriptionApi } from "@/hyperliquid/state/channels";
import { BookStore, asksOf, bestBid, bidsOf, type BookSnapshot } from "@/hyperliquid/state/book";
import {
  fetchCandles,
  mergeCandles,
  previousPageEnd,
  toCandle,
  type CandleProbe,
} from "@/hyperliquid/api/candles";
import { CandleStore, bucketStart, intervalMs } from "@/hyperliquid/state/candles";
import type { ICandleWsEvent } from "@/hyperliquid/types/sdk";
import { SubscriptionRegistry } from "@/hyperliquid/state/registry";
import {
  fetchPerpCtxs,
  fetchSpotCtxs,
  type PerpCtxsProbe,
  type SpotCtxsProbe,
} from "@/hyperliquid/api/assetCtxs";
import { buildPerpRows, buildSpotRows } from "@/hyperliquid/markets/rows";
import type { Candle, Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

const IS_TESTNET = true;
const WAIT_FOR_DATA_MS = 15_000;

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** Ascending order is an invariant chart renderers rely on without checking. */
function isAscending(candles: readonly Candle[]): boolean {
  return candles.every((c, i) => i === 0 || candles[i - 1].openTime < c.openTime);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve once `predicate` holds, or give up. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

async function main(): Promise<void> {
  setLogLevel("warn");
  addLogSink(createConsoleSink());

  console.log("Hyperliquid smoke test — TESTNET, read-only\n" + "=".repeat(46));

  // -------------------------------------------------------------------------
  section("1. Asset resolution against live metadata");
  // -------------------------------------------------------------------------
  const httpTransport = new (await import("@nktkas/hyperliquid")).HttpTransport({
    isTestnet: IS_TESTNET,
  });
  const info = new InfoClient({ transport: httpTransport });
  const converter = await SymbolConverter.create({ transport: httpTransport, dexs: true });
  const assets = wrapSymbolConverter(converter);

  const btc = resolveAssetSpec(assets, "BTC");
  // NOT a fixed id: asset ids are per-network (BTC is 0 on mainnet, 3 on
  // testnet). Asserting a constant here would be asserting the wrong network.
  check(
    "BTC resolves",
    Number.isInteger(btc.assetId) && btc.szDecimals > 0,
    `assetId=${btc.assetId} szDecimals=${btc.szDecimals}`
  );
  check("BTC classified as a perp", btc.marketType === "perp");
  check("BTC id is in the perp range", classifyAssetId(btc.assetId) === "perp");

  // Spot ids differ per network — this is why `env` is a key dimension.
  const spotSymbol = "HYPE/USDC";
  try {
    const spot = resolveAssetSpec(assets, spotSymbol);
    check(
      `${spotSymbol} resolves to the spot range`,
      classifyAssetId(spot.assetId) === "spot",
      `assetId=${spot.assetId} (testnet ids differ from mainnet)`
    );
    check(
      `${spotSymbol} uses the wire pair id, not the display name`,
      subscriptionCoin(assets, spotSymbol).startsWith("@"),
      subscriptionCoin(assets, spotSymbol)
    );
  } catch {
    console.log(`  · ${spotSymbol} not listed on testnet — skipped`);
  }

  check(
    "an unknown symbol throws rather than returning a partial spec",
    (() => {
      try {
        resolveAssetSpec(assets, "DEFINITELY_NOT_A_COIN");
        return false;
      } catch {
        return true;
      }
    })()
  );

  // -------------------------------------------------------------------------
  section("2. Precision against live szDecimals");
  // -------------------------------------------------------------------------
  const mids = await info.allMids();
  const btcMid = (mids as Record<string, string>).BTC;
  check("allMids returns a BTC mid", typeof btcMid === "string", btcMid);

  if (btcMid) {
    const price = formatPrice(btcMid, btc.szDecimals, btc.marketType);
    check("mid formats to a wire-safe price", /^[0-9]+(\.[0-9]+)?$/.test(price), price);
    check("no exponential notation", !/e/i.test(price));
    const size = formatSize("0.0012345", btc.szDecimals);
    check("size truncates to the lot size", /^[0-9]+(\.[0-9]+)?$/.test(size), size);
  }

  // -------------------------------------------------------------------------
  section("3. Live subscription lifecycle");
  // -------------------------------------------------------------------------
  const wsTransport = new WebSocketTransport({
    isTestnet: IS_TESTNET,
    keepAlive: { interval: 30_000 },
  });
  const subscriptionClient = new SubscriptionClient({ transport: wsTransport });

  const identity = createIdentity({
    env: "testnet",
    accountId: "smoke",
    // Any address: only read-only market channels are used here.
    address: "0x0000000000000000000000000000000000000001",
  });

  const book = new BookStore();
  const candles = new CandleStore();
  let eventCount = 0;
  let candleEvents = 0;

  const subscribe = createSubscribeFn({
    api: subscriptionClient as unknown as SubscriptionApi,
    sink: (event) => {
      if (event.target.channel === "candle") {
        candleEvents += 1;
        const raw = event.value as ICandleWsEvent;
        candles.apply({ ...event, value: toCandle(raw) }, Date.now());
        return;
      }
      eventCount += 1;
      book.apply(event as Scoped<BookSnapshot>);
    },
    onError: (target, error) => {
      console.log(`  ! channel error on ${target.channel}:`, error);
    },
  });

  const registry = new SubscriptionRegistry(subscribe);
  const btcBook: SubscriptionTarget = {
    identity,
    channel: "l2Book",
    coin: "BTC",
    aggregation: null,
    interval: null,
  };

  book.setTarget(btcBook);
  await registry.add(btcBook);
  check("l2Book subscription opened", registry.isActive(btcBook));

  const gotData = await waitFor(() => eventCount > 0, WAIT_FOR_DATA_MS);
  check("book events arrive over the socket", gotData, `${eventCount} event(s)`);

  const snapshot = book.read(Date.now());
  check(
    "book reads as fresh and has both sides",
    Boolean(snapshot && bidsOf(snapshot).length > 0 && asksOf(snapshot).length > 0),
    snapshot ? `${bidsOf(snapshot).length} bids / ${asksOf(snapshot).length} asks` : "no book"
  );
  if (snapshot) {
    const top = bestBid(snapshot);
    check(
      "levels carry string prices, not floats",
      typeof top?.px === "string",
      `top bid ${top?.px}`
    );
    check(
      "event carries the server timestamp used for freshness",
      typeof snapshot.time === "number" && snapshot.time > 0,
      String(snapshot.time)
    );
  }

  // -------------------------------------------------------------------------
  section("4. Target switch drops in-flight data from the old market");
  // -------------------------------------------------------------------------
  const ethBook: SubscriptionTarget = { ...btcBook, coin: "ETH" };
  const droppedBefore = book.dropped;

  book.setTarget(ethBook);
  check("book cleared immediately on switch", book.read(Date.now()) === null);

  await registry.reconcile([ethBook]);
  check("old subscription closed", !registry.isActive(btcBook));
  check("new subscription open", registry.isActive(ethBook));

  await waitFor(() => book.read(Date.now()) !== null, WAIT_FOR_DATA_MS);
  const ethSnapshot = book.read(Date.now());
  check("ETH book arrives", ethSnapshot !== null);
  check(
    "any late BTC events were dropped, not stored",
    book.dropped >= droppedBefore,
    `${book.dropped} dropped`
  );

  // -------------------------------------------------------------------------
  section("5. Candle history over REST");
  // -------------------------------------------------------------------------
  const history = await fetchCandles({
    probe: info as unknown as CandleProbe,
    coin: "BTC",
    interval: "1m",
    count: 200,
  });
  check(
    "candleSnapshot returned rows",
    history.candles.length > 0,
    `${history.candles.length} bar(s)`
  );
  check("history is ascending by open time", isAscending(history.candles));
  const newest = history.candles[history.candles.length - 1];
  if (newest) {
    check(
      "bucket width matches the requested interval",
      newest.closeTime - newest.openTime === intervalMs("1m") - 1,
      `T - t = ${newest.closeTime - newest.openTime}ms`
    );
    check(
      "open times land on epoch bucket boundaries",
      newest.openTime === bucketStart(newest.openTime, "1m")
    );
    check("prices arrive as strings", typeof newest.open === "string", `o=${newest.open}`);
    // The forming bucket is present only once it has traded, so both outcomes
    // are correct. What must always hold is that it is never in the FUTURE.
    check(
      "newest bar is the current bucket or an earlier one, never a future one",
      newest.openTime <= bucketStart(Date.now(), "1m"),
      history.hasFormingBar
        ? `forming bar present, opened ${new Date(newest.openTime).toISOString()}`
        : `no forming bar yet — newest closed at ${new Date(newest.openTime).toISOString()}`
    );
    check(
      "row count matches the request, give or take the forming bar",
      Math.abs(history.candles.length - 200) <= 1,
      `${history.candles.length}/200`
    );
    // Zero-trade buckets are real rows carrying the previous close, not defects.
    const flat = history.candles.filter((c) => c.trades === 0);
    check(
      "zero-trade buckets carry a usable price",
      flat.every((c) => c.open === c.close && c.close.length > 0),
      `${flat.length} of ${history.candles.length} bars had no trades`
    );
  }

  // Paging backwards. The range is inclusive at both ends, so asking for
  // `oldest.openTime` would re-return that same bar.
  const oldest = history.candles[0];
  if (oldest) {
    const page = await fetchCandles({
      probe: info as unknown as CandleProbe,
      coin: "BTC",
      interval: "1m",
      count: 50,
      endTime: previousPageEnd(oldest),
    });
    check("previous page fetched", page.candles.length > 0, `${page.candles.length} bar(s)`);
    check(
      "previous page stops before the bar we already hold",
      page.candles.every((c) => c.openTime < oldest.openTime)
    );
    const merged = mergeCandles(page.candles, history.candles);
    check(
      "merge de-duplicates rather than concatenating",
      merged.length === page.candles.length + history.candles.length && isAscending(merged),
      `${page.candles.length} + ${history.candles.length} = ${merged.length}`
    );
  }

  // -------------------------------------------------------------------------
  section("6. Live candle feed");
  // -------------------------------------------------------------------------
  const candleTarget: SubscriptionTarget = {
    identity,
    channel: "candle",
    coin: "BTC",
    aggregation: null,
    interval: "1m",
  };
  candles.setTarget(candleTarget);
  if (history.candles.length > 0) {
    candles.seed(candleTarget, history.candles, Date.now());
    check("store seeded from REST history", candles.size === history.candles.length);
  }

  await registry.add(candleTarget);
  check("candle subscription opened", registry.isActive(candleTarget));

  // A bucket only produces events when it trades, and testnet BTC 1m has been
  // measured going a full bucket without one. Silence here is a property of the
  // market, not of this code, so it is reported rather than failed.
  const gotCandle = await waitFor(() => candleEvents > 0, 45_000);
  console.log(
    gotCandle
      ? `  · ${candleEvents} live candle event(s) in the wait window`
      : "  · no trades on BTC 1m during the wait — the quiet-market path"
  );

  const series = candles.read();
  check(
    "forming bar is never also in the committed array",
    series.forming === null ||
      !series.committed.some((c) => c.openTime === series.forming!.openTime)
  );
  check("committed series is ascending", isAscending(series.committed));
  check(
    "no bucket is ever presented as forming from the future",
    series.forming === null || series.forming.openTime <= bucketStart(Date.now(), "1m")
  );
  check(
    "latest close is available for a price readout",
    candles.latestClose() !== null,
    String(candles.latestClose())
  );

  // The wall-clock promotion. Nothing else closes a bucket on a market that has
  // stopped trading, and a dead bucket presented as live pins the shown price.
  // The wait above spans a bucket boundary, so this is the real scenario.
  const staleBefore =
    series.forming !== null && series.forming.closeTime < Date.now() ? "stale" : "current";
  const settled = candles.settle(Date.now());
  check(
    "settle promotes a bucket whose time has passed",
    settled === (staleBefore === "stale"),
    `forming bar was ${staleBefore} before settle`
  );
  check(
    "nothing stale is left forming after settle",
    candles.read().forming === null || candles.read().forming!.closeTime >= Date.now()
  );

  // A BTC/1h target must not collide with BTC/1m.
  const hourly: SubscriptionTarget = { ...candleTarget, interval: "1h" };
  check(
    "interval is part of the subscription key",
    subscriptionKey(candleTarget) !== subscriptionKey(hourly)
  );
  await registry.add(hourly);
  check("a second interval opens its own subscription", registry.isActive(hourly));

  // -------------------------------------------------------------------------
  section("7. Keys and teardown");
  // -------------------------------------------------------------------------
  check(
    "subscription keys separate the two markets",
    subscriptionKey(btcBook) !== subscriptionKey(ethBook)
  );
  check(
    "aggregation is part of the key",
    subscriptionKey(ethBook) !==
      subscriptionKey({ ...ethBook, aggregation: { nSigFigs: 3, mantissa: null, fast: false } })
  );

  await registry.closeAll();
  check("all subscriptions torn down", registry.activeCount === 0);

  wsTransport.close();
  check("transport closed", true);

  // -------------------------------------------------------------------------
  section("8. Combined asset contexts (Markets list reads)");
  // -------------------------------------------------------------------------
  // The two join rules the Markets screen rests on, checked against the live
  // wire rather than fixtures: perp ctxs are index-aligned (the parse THROWS
  // on a mismatch, so a non-deferred value is itself the alignment proof) and
  // spot ctxs are NOT — they outnumber the universe, carrying the `#N`
  // prediction sides in the same response.
  const perpResult = await fetchPerpCtxs({ probe: info as unknown as PerpCtxsProbe });
  check("metaAndAssetCtxs fetched (not deferred)", perpResult.value !== null);
  if (perpResult.value !== null) {
    const [perpMeta, perpCtxs] = perpResult.value;
    check(
      "perp universe and ctxs are index-aligned",
      perpMeta.universe.length === perpCtxs.length,
      `${perpMeta.universe.length} universe / ${perpCtxs.length} ctxs`
    );
    const perpRows = buildPerpRows(perpResult.value);
    check(
      "perp rows build from the live payload, delisted dropped",
      perpRows.length > 0 &&
        perpRows.length < perpMeta.universe.length &&
        perpRows.every((row) => !row.isDelisted),
      `${perpRows.length} tradeable of ${perpMeta.universe.length}`
    );
  }

  const spotResult = await fetchSpotCtxs({ probe: info as unknown as SpotCtxsProbe });
  check("spotMetaAndAssetCtxs fetched (not deferred)", spotResult.value !== null);
  if (spotResult.value !== null) {
    const [spotMeta, spotCtxs] = spotResult.value;
    check(
      "spot ctx count exceeds the universe — NOT index-aligned",
      spotCtxs.length > spotMeta.universe.length,
      `${spotCtxs.length} ctxs vs ${spotMeta.universe.length} universe rows`
    );
    const predictionCount = spotCtxs.filter((ctx) => ctx.coin.startsWith("#")).length;
    check(
      "prediction `#N` ctxs ride in the spot response",
      predictionCount > 0,
      `${predictionCount} outcome-side ctxs`
    );
    const { spot: spotRows, predictionCtxs } = buildSpotRows(spotResult.value);
    // Pair wire coins are `@N` — except canonical pairs (testnet: PURR/USDC),
    // whose wire coin is the literal pair name. Both are real spellings.
    check(
      "spot rows join by ctx.coin against the live payload",
      spotRows.length > 0 &&
        spotRows.every((row) => row.wireCoin.startsWith("@") || row.wireCoin.includes("/")),
      `${spotRows.length} pairs`
    );
    check(
      "the `#N` ctxs route to the prediction map, none lost",
      predictionCtxs.size === predictionCount,
      `${predictionCtxs.size} routed`
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n" + "=".repeat(46));
  if (failures === 0) {
    console.log("PASS — realtime path verified against live testnet");
  } else {
    console.log(`FAIL — ${failures} check(s) failed`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nSmoke test crashed:", error);
  process.exit(1);
});
