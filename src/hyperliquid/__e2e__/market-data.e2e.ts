/**
 * Market data and precision, end to end, against live Hyperliquid **testnet and
 * mainnet**.
 *
 *   HL_E2E=1 bun run test:e2e --testPathPattern market-data
 *
 * **Why this exists.** `core/assetIds` is the highest-consequence module in the
 * codebase. A signed order carries `a: number`, so a wrong lookup does not fail —
 * it places an order on a *different market*. Every unit test for it runs against
 * a hand-written stub of `SymbolConverter`, which means the thing actually being
 * asserted is that our arithmetic matches our own fixture. Nothing checked it
 * against the exchange's live universes, where the ids are assigned.
 *
 * The same gap applies to precision. `formatPrice`/`formatSize` are checked
 * against invented `szDecimals`, and `getPriceTick` against invented prices. The
 * exchange, meanwhile, publishes an order book made entirely of prices it has
 * already accepted — the best available oracle for "is this on the tick grid",
 * and one no mock can stand in for.
 *
 * So this drives the real objects against both live networks:
 *
 *   live meta / spotMeta / perpDexs / outcomeMeta
 *     -> SymbolConverter -> our wrapper -> resolveAssetSpec
 *     -> all four id ranges checked against the formula the *server's own*
 *        indices imply
 *     -> formatPrice / formatSize / getPriceTick round-tripped against every
 *        level of a live l2 book
 *     -> a live websocket book and live candle history through the real stores
 *     -> min-notional and margin/leverage helpers against the live tables
 *
 * **What it costs.** Nothing. Every call here is read-only: no order, no
 * signature, no state left behind, and mainnet is touched with `InfoClient` and
 * a subscription socket only.
 *
 * **No key is imported and no agent is seeded**, unlike `session.e2e.ts`: this
 * dimension signs nothing, so requiring `HL_TESTNET_SIGNER_KEY` would make the
 * suite skip for a reason that does not apply to it. `setupHyperliquid()` still
 * runs, because without it the logger has no sink.
 *
 * Two live divergences are documented rather than fixed — see the `outcome`
 * blocks. They are asserted in the shape the exchange actually behaves, so this
 * file starts failing the day either is repaired.
 */

import {
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from "@nktkas/hyperliquid";
import { SymbolConverter } from "@nktkas/hyperliquid/utils";
import { BigNumber } from "bignumber.js";

import {
  fetchCandles,
  mergeCandles,
  previousPageEnd,
  type CandleProbe,
} from "@/hyperliquid/api/candles";
import { resolveAssetSpec, subscriptionCoin, symbolFromWireCoin } from "@/hyperliquid/assets";
import {
  classifyAssetId,
  decomposeAssetId,
  wrapSymbolConverter,
  type AssetIndex,
} from "@/hyperliquid/core/assetIds";
import { UnknownAssetError } from "@/hyperliquid/core/errors";
import { createIdentity, subscriptionKey } from "@/hyperliquid/core/identity";
import { addLogSink, createConsoleSink, setLogLevel } from "@/hyperliquid/core/logger";
import {
  findMarginTier,
  formatPrice,
  formatSize,
  getNextPrice,
  getPriceTick,
  snapPriceToGrid,
} from "@/hyperliquid/core/precision";
import { isFlatMarginTable, normaliseMarginTable } from "@/hyperliquid/dex/margin";
import { maxMarketOrderNotional, parseMaxMarketOrderNtls } from "@/hyperliquid/dex/limits";
import { MIN_ORDER_NOTIONAL_USDC, meetsMinNotional, notionalOf } from "@/hyperliquid/orders/build";
import { setupHyperliquid } from "@/hyperliquid/setup";
import {
  asksOf,
  bestAsk,
  bestBid,
  bidsOf,
  BookStore,
  BOOK_MAX_AGE_MS,
  type BookSnapshot,
} from "@/hyperliquid/state/book";
import { bucketStart, CandleStore, intervalMs, isClosed } from "@/hyperliquid/state/candles";
import { createSubscribeFn, type SubscriptionApi } from "@/hyperliquid/state/channels";
import { SubscriptionRegistry } from "@/hyperliquid/state/registry";
import type {
  Candle,
  HlEnv,
  MarketType,
  Scoped,
  SubscriptionTarget,
} from "@/hyperliquid/types/domain";

const ENABLED = process.env.HL_E2E === "1";

const describeE2E = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  // Loud: a silently skipped e2e suite reads exactly like a passing one.
  console.warn("e2e SKIPPED: set HL_E2E=1 to run against live testnet + mainnet");
}

/** A perp that exists on both networks and always has a two-sided book. */
const PERP_SYMBOL = "BTC";
/** A second perp, used only to prove one market's feed cannot enter another's store. */
const OTHER_PERP_SYMBOL = "ETH";

/**
 * The one spot pair whose wire id **is** its display name on both networks.
 *
 * `getSpotPairId` returns `"PURR/USDC"` rather than `"@0"`, and a client that
 * composed `"@" + universeIndex` would subscribe to a coin the exchange does not
 * know — a permanently empty book with no error anywhere.
 */
const PAIR_ID_EXCEPTION = "PURR/USDC";

/** Wire prices and sizes: plain decimals only. Exponential notation is rejected by the schema. */
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

/** Live fixtures, filled per network, read by the cross-network block declared last. */
const fixtures = new Map<HlEnv, MarketFixture>();

describeE2E("market data and precision against live metadata", () => {
  beforeAll(() => {
    setLogLevel("warn");
    addLogSink(createConsoleSink());
    // The module bootstrap, exactly as `src/app/_layout.tsx` calls it. Without
    // it the logger silently discards every event, including the channel-error
    // warnings this file relies on to notice a dead feed.
    setupHyperliquid();
  });

  describeNetwork("testnet");
  describeNetwork("mainnet");

  // -------------------------------------------------------------------------
  // Declared last so both fixtures above are populated by the time it runs.
  describe("across the two networks", () => {
    it("gives the two networks different universes, which is why `env` is a key dimension", () => {
      const testnet = fixtures.get("testnet")!;
      const mainnet = fixtures.get("mainnet")!;

      const mainnetIndex = new Map(mainnet.perpUniverse.map((asset, i) => [asset.name, i]));
      const shared = testnet.perpUniverse
        .map((asset, i) => ({ name: asset.name, testnetIndex: i }))
        .filter((entry) => mainnetIndex.has(entry.name));
      // Guard: with no overlap the divergence count below would be trivially
      // zero and the assertion vacuous.
      expect(shared.length).toBeGreaterThan(20);

      // Deliberately NOT "BTC is 0 on mainnet and 3 on testnet". That is true
      // today (measured), but it is a fact about a listing order Hyperliquid can
      // change, and a suite that asserts it fails for no defect. What must hold
      // is only that the orderings differ SOMEWHERE — one divergence among ~200
      // shared symbols is enough for an env-less cache to hand a testnet id to a
      // mainnet order, which is a different market rather than an error.
      const divergent = shared.filter(
        (entry) => mainnetIndex.get(entry.name) !== entry.testnetIndex
      );
      expect(divergent.length).toBeGreaterThan(0);

      // Both still classify as perps: the ranges are per-protocol, the indices
      // are per-network.
      expect(classifyAssetId(testnet.perp.assetId)).toBe("perp");
      expect(classifyAssetId(mainnet.perp.assetId)).toBe("perp");
    });

    it("carries `env` into the subscription key, so one coin cannot span both", () => {
      // The structural half of the claim above, and the one that cannot drift:
      // two targets identical in EVERY field but `env` must not collide. If they
      // did, a mainnet book would be delivered into a store the user opened on
      // testnet — `isForTarget` compares exactly this string. Built here rather
      // than taken from the fixtures, whose accountIds differ too and would make
      // the keys differ even with `env` dropped from the key entirely.
      const base = {
        accountId: "same-account",
        address: "0x0000000000000000000000000000000000000001",
      };
      const asTarget = (env: HlEnv): SubscriptionTarget => ({
        identity: createIdentity({ ...base, env }),
        channel: "l2Book",
        coin: PERP_SYMBOL,
        aggregation: null,
        interval: null,
      });
      expect(subscriptionKey(asTarget("testnet"))).not.toBe(subscriptionKey(asTarget("mainnet")));
    });

    it("keeps every range disjoint and correctly ordered on both networks", () => {
      // Without this the loop below iterates zero times and the test passes in
      // 0 ms having asserted nothing — the exact shape of vacuity this suite
      // exists to eliminate, and reachable for real if a `beforeAll` throws.
      expect(fixtures.size).toBe(2);
      for (const fixture of fixtures.values()) {
        const { perp, spot, builder, outcome } = fixture;
        // The whole point of the four bands: an id alone answers "which kind of
        // market is this", so a lookup can never resolve into the wrong universe.
        expect(perp.assetId).toBeLessThan(10_000);
        expect(spot.assetId).toBeGreaterThanOrEqual(10_000);
        expect(spot.assetId).toBeLessThan(100_000);
        expect(builder.assetId).toBeGreaterThanOrEqual(100_000);
        expect(builder.assetId).toBeLessThan(100_000_000);
        // Only when one is quoted; prediction markets are intermittent and the
        // other three bands are the load-bearing part of this assertion.
        if (outcome) expect(outcome.assetId).toBeGreaterThanOrEqual(100_000_000);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// One network's worth of tests
// ---------------------------------------------------------------------------

function describeNetwork(env: HlEnv): void {
  const isTestnet = env === "testnet";

  describe(`${env}`, () => {
    let fx: MarketFixture;

    beforeAll(async () => {
      fx = await buildFixture(env);
      fixtures.set(env, fx);
    }, 120_000);

    afterAll(async () => {
      await fx?.teardown();
    }, 60_000);

    // -----------------------------------------------------------------------
    describe("1. the four asset-id ranges resolve against live metadata", () => {
      it("resolves a perp to its own index in the live universe", () => {
        const spec = resolveAssetSpec(fx.assets, PERP_SYMBOL);

        // Checked against the position the SERVER put it at in `meta().universe`,
        // fetched separately from the converter. Asserting a constant would be
        // asserting a network (BTC is 0 on mainnet, 3 on testnet).
        expect(spec.assetId).toBe(fx.perp.index);
        expect(classifyAssetId(spec.assetId)).toBe("perp");
        expect(decomposeAssetId(spec.assetId)).toEqual({ kind: "perp", index: fx.perp.index });
        expect(spec.szDecimals).toBe(fx.perp.szDecimals);
        expect(spec.marketType).toBe<MarketType>("perp");
      });

      it("maps the WHOLE live perp universe positionally, not just the sampled one", () => {
        // One symbol cannot distinguish a positional map from a lookup that
        // happens to agree at one point. Measured: 210 perps on testnet, 232 on
        // mainnet — and a perp resolved to its neighbour's index is an order
        // filled on the neighbour's market at the neighbour's price.
        expect(fx.perpUniverse.length).toBeGreaterThan(100);
        fx.perpUniverse.forEach((asset, index) => {
          expect(fx.assets.getAssetId(asset.name)).toBe(index);
          // szDecimals travels with the id and decides the price ceiling; a
          // right id carrying the wrong one still mis-prices the order.
          expect(fx.assets.getSzDecimals(asset.name)).toBe(asset.szDecimals);
        });
      });

      it("resolves EVERY live spot pair to 10000 + its universe index", () => {
        // Live universes, not one sample: the exception pair the block below
        // covers sits at index 0, where `10000 + index` is indistinguishable
        // from a constant. Measured: 1,309 pairs on testnet, 322 on mainnet.
        expect(fx.spotRows.length).toBeGreaterThan(100);
        for (const row of fx.spotRows) {
          expect(fx.assets.getAssetId(row.symbol)).toBe(10_000 + row.index);
          // The pair id is the wire coin the server itself published for that
          // row — the read side matches echoed frames on exactly this string.
          expect(fx.assets.getSpotPairId(row.symbol)).toBe(row.wireCoin);
        }
      });

      it("gives an ORDINARY pair a wire coin that is not its display name", () => {
        const { symbol, wireCoin, index } = fx.normalSpot;
        const spec = resolveAssetSpec(fx.assets, symbol);

        expect(spec.assetId).toBe(10_000 + index);
        expect(classifyAssetId(spec.assetId)).toBe("spot");
        expect(decomposeAssetId(spec.assetId)).toEqual({ kind: "spot", index });
        // Spot alone gets the 8-decimal ceiling; see block 2 for why that is not
        // cosmetic.
        expect(spec.marketType).toBe<MarketType>("spot");

        // The point of the whole spot branch, and what the exception pair
        // cannot show: the display name is NOT a wire coin. `l2Book`/`trades`
        // take `@N`, so a subscription made with "BASE/QUOTE" matches nothing
        // and the book stays empty forever with no error. A `subscriptionCoin`
        // that returned its argument unchanged passes every assertion in the
        // exception block below and fails here. Measured: testnet @3
        // (BREAD/USDC), mainnet @1 (HFUN/USDC).
        expect(wireCoin).toBe(`@${index}`);
        expect(wireCoin).not.toBe(symbol);
        expect(subscriptionCoin(fx.assets, symbol)).toBe(wireCoin);
        // And back again, which is the direction the read side uses to decide
        // whether an arriving frame belongs to the screen that is open.
        expect(symbolFromWireCoin(fx.assets, wireCoin)).toBe(symbol);
      });

      it("returns the exception pair's own name as its wire coin, not @index", () => {
        // PURR/USDC is universe index 0 on both networks, so a client that built
        // `"@" + index` would subscribe to "@0" — which the exchange does not
        // know. Live-checked because the exception list is metadata, not a rule.
        expect(fx.assets.getSpotPairId(PAIR_ID_EXCEPTION)).toBe(PAIR_ID_EXCEPTION);
        expect(subscriptionCoin(fx.assets, PAIR_ID_EXCEPTION)).toBe(PAIR_ID_EXCEPTION);
        // And the inverse map agrees, which is what the read side uses to match
        // an echoed wire coin back onto a displayed symbol.
        expect(fx.assets.getSymbolBySpotPairId(PAIR_ID_EXCEPTION)).toBe(PAIR_ID_EXCEPTION);
      });

      it("resolves a HIP-3 builder-dex perp to 100000 + dexIndex*10000 + index", () => {
        const spec = resolveAssetSpec(fx.assets, fx.builder.symbol);

        // `dexIndex` is the asset's position in the live `perpDexs()` array and
        // `index` its position in that dex's own universe — both read from the
        // server, not assumed.
        expect(spec.assetId).toBe(100_000 + fx.builder.dexIndex * 10_000 + fx.builder.index);
        expect(classifyAssetId(spec.assetId)).toBe("builderDex");
        expect(decomposeAssetId(spec.assetId)).toEqual({
          kind: "builderDex",
          dexIndex: fx.builder.dexIndex,
          index: fx.builder.index,
        });
        expect(spec.szDecimals).toBe(fx.builder.szDecimals);

        // Every asset the dex lists, in the order the server listed them. The
        // sampled asset sits at index 0, where the low term of the formula
        // vanishes and a resolver that ignored `index` entirely — mapping the
        // whole dex onto one id — would still pass. Measured: 105 assets on
        // mainnet `xyz`, 1 on testnet `test`.
        expect(fx.builderUniverse.length).toBeGreaterThan(0);
        fx.builderUniverse.forEach((asset, index) => {
          expect(fx.assets.getAssetId(asset.name)).toBe(
            100_000 + fx.builder.dexIndex * 10_000 + index
          );
          expect(fx.assets.getSzDecimals(asset.name)).toBe(asset.szDecimals);
        });

        // The regression that matters. A builder-dex id is >= 100000, so any
        // `assetId >= 10000 ? "spot" : "perp"` shortcut calls it spot and prices
        // it on the 8-decimal ceiling instead of 6 — see block 2 for the price
        // that produces.
        expect(spec.marketType).toBe<MarketType>("perp");
      });

      it("resolves an outcome market to 100000000 + outcomeId*10 + sideIndex", () => {
        // Prediction markets are thin and intermittent. When none is quoted with a
        // resting book this assertion has nothing to check — skip it rather than
        // failing the whole file, which is what a hard requirement in `beforeAll` did.
        if (!fx.outcome) return;
        const spec = resolveAssetSpec(fx.assets, fx.outcome.slug);

        expect(spec.assetId).toBe(100_000_000 + fx.outcome.outcomeId * 10 + fx.outcome.sideIndex);
        expect(classifyAssetId(spec.assetId)).toBe("outcome");
        expect(decomposeAssetId(spec.assetId)).toEqual({
          kind: "outcome",
          outcomeId: fx.outcome.outcomeId,
          sideIndex: fx.outcome.sideIndex,
        });
        // Not spot, despite an id nine digits long.
        expect(spec.marketType).toBe<MarketType>("perp");

        // BOTH sides. The sampled one is `sideIndex` 0, where the `+ sideIndex`
        // term vanishes — a formula that dropped it would map Yes and No onto
        // the same id, and an order meant for "No" would be a bet on the
        // opposite outcome, placed at a perfectly valid price.
        expect(fx.outcomeSides.length).toBeGreaterThan(1);
        for (const side of fx.outcomeSides) {
          expect(fx.assets.getAssetId(side.slug)).toBe(
            100_000_000 + fx.outcome.outcomeId * 10 + side.sideIndex
          );
        }
        const sideIds = fx.outcomeSides.map((side) => fx.assets.getAssetId(side.slug));
        expect(new Set(sideIds).size).toBe(sideIds.length);
        expect(sideIds[1] - sideIds[0]).toBe(1);

        // Independent confirmation from the exchange that this id is a market it
        // actually runs: `allMids` keys outcome markets `#<outcomeId*10+side>`,
        // which is the id's low bits. Two unrelated endpoints agreeing rules out
        // the slug having resolved to a stale or invented entry.
        //
        // Bounds are INCLUSIVE deliberately. These markets expire daily
        // (measured today: 0.03–0.97 across 16 mainnet / 404 testnet sides), and
        // a side that has effectively resolved prints 0 or 1 — asserting a
        // strict interval would fail on a market behaving correctly. The content
        // is the upper bound: a probability, not a $64k perp price, which is
        // what proves the id landed in the outcome universe.
        expect(fx.outcome.liveMid).toMatch(DECIMAL);
        expect(new BigNumber(fx.outcome.liveMid).isGreaterThanOrEqualTo(0)).toBe(true);
        expect(new BigNumber(fx.outcome.liveMid).isLessThanOrEqualTo(1)).toBe(true);
      });

      it("throws on an unknown symbol rather than yielding undefined", () => {
        // The adaptation `wrapSymbolConverter` exists for: the SDK returns
        // `undefined`, which would be spread into a signed action as `a:
        // undefined` and rejected — or worse, coerced — far from the typo.
        expect(() => resolveAssetSpec(fx.assets, "DEFINITELY_NOT_A_COIN")).toThrow(
          UnknownAssetError
        );
        expect(fx.assets.tryGetAssetId("DEFINITELY_NOT_A_COIN")).toBeUndefined();
      });
    });

    // -----------------------------------------------------------------------
    describe("2. precision round-trips against live szDecimals", () => {
      it("accepts every level of a live perp book unchanged", () => {
        const levels = fx.perpBook;
        // A thin book would make this vacuous; BTC is two-sided on both networks.
        expect(levels.length).toBeGreaterThan(10);

        for (const level of levels) {
          // Every resting price is a price the exchange ACCEPTED, so a formatter
          // that alters one would have rejected — or silently moved — a real
          // order. Compared numerically because the wire sends "64204.0" and the
          // formatter emits "64204": same price, different spelling.
          expectSamePrice(
            formatPrice(level.px, fx.perp.szDecimals, "perp"),
            level.px,
            `perp px ${level.px}`
          );
          expectSamePrice(
            formatSize(level.sz, fx.perp.szDecimals),
            level.sz,
            `perp sz ${level.sz}`
          );
        }
      });

      it("puts every live level exactly on the tick grid our helpers compute", () => {
        for (const level of fx.perpBook) {
          const tick = getPriceTick(level.px, fx.perp.szDecimals, "perp");
          expect(tick).not.toBeNull();
          // If a resting price is not a whole number of ticks, the order form's
          // +/- stepper walks the user off the grid and every order it builds is
          // rejected at submit time.
          expect(new BigNumber(level.px).modulo(tick!).isZero()).toBe(true);
          expectSamePrice(
            snapPriceToGrid(level.px, "nearest", fx.perp.szDecimals, "perp")!.toFixed(),
            level.px,
            `snap ${level.px}`
          );
        }
      });

      it("steps one tick up from the live best bid onto another valid price", () => {
        const best = bestBid(fx.perpSnapshot)!.px;
        const next = getNextPrice(best, "up", fx.perp.szDecimals, "perp");
        expect(next).not.toBeNull();

        // Must actually move — the reason `getNextPrice` re-derives the tick at
        // the probe price instead of adding a fixed step is that a stepper which
        // returns the same price looks frozen to the user.
        expect(next!.isGreaterThan(best)).toBe(true);
        // And must land somewhere the exchange would take.
        expectSamePrice(
          formatPrice(next!.toFixed(), fx.perp.szDecimals, "perp"),
          next!.toFixed(),
          "stepped price"
        );
      });

      it("needs the SPOT ceiling for a live spot book the perp ceiling would destroy", () => {
        const levels = fx.finePriceBook.levels;
        expect(levels.length).toBeGreaterThan(0);

        const szDecimals = fx.finePriceBook.szDecimals;
        for (const level of levels) {
          expectSamePrice(
            formatPrice(level.px, szDecimals, "spot"),
            level.px,
            `spot px ${level.px}`
          );
        }

        // The other half, and the reason `marketType` may never be inferred from
        // the id.
        //
        // The book was CHOSEN by counting decimals on the exchange's own price
        // strings — arithmetic on wire data, touching none of the code under
        // test — precisely so this next assertion is a consequence rather than
        // the selection rule. Selecting with `formatPrice` itself would make a
        // perp ceiling that had stopped applying unfalsifiable here.
        const perpCeiling = Math.max(6 - szDecimals, 0);
        const finer = levels.filter((level) => decimalPlaces(level.px) > perpCeiling);
        expect(finer.length).toBeGreaterThan(0);

        // Measured on testnet @391 (BAAAH/USDC, szDecimals 0, 39 of 40 levels)
        // and mainnet @33 (BID/USDC, 33 of 33): every one of those live,
        // exchange-accepted prices either truncates to a DIFFERENT price under
        // the perp ceiling or, once it truncates to zero, throws outright. Both
        // are the same defect — a price the user typed exactly, changed.
        for (const level of finer) {
          expect(perpCeilingBreaks(level.px, szDecimals)).toBe(true);
        }
      });

      it("prices a builder-dex perp on the 6-decimal ceiling, not the spot 8", () => {
        const { szDecimals } = fx.builder;
        const spec = resolveAssetSpec(fx.assets, fx.builder.symbol);

        // Precondition, stated rather than assumed: at szDecimals >= 6 a perp
        // has no decimal places at all, the probe below truncates to zero and
        // `formatPrice` throws — the test would ERROR instead of asserting.
        // Measured maximum on a live builder dex: 5.
        expect(szDecimals).toBeLessThan(6);

        // A probe small enough that the DECIMAL ceiling is what binds. The
        // 5-significant-figure cap applies too and the stricter of the two wins,
        // so a value in [0.1, 1) is capped at five decimals whichever market type
        // is used and the two ceilings look identical — which is precisely why a
        // builder-dex asset priced like an equity can be mis-typed for months
        // without anything going visibly wrong. Leading zeros push the
        // significant figures far enough right that the ceiling shows through.
        const spotMax = 8 - szDecimals;
        const leadingZeros = Math.max(0, spotMax - 5);
        const probe = `0.${"0".repeat(leadingZeros)}${"1".repeat(spotMax - leadingZeros)}`;
        const asPerp = formatPrice(probe, szDecimals, spec.marketType);
        const asSpot = formatPrice(probe, szDecimals, "spot");

        // If these were equal the assertions below would prove nothing.
        expect(asPerp).not.toBe(asSpot);
        expect(decimalPlaces(asPerp)).toBe(6 - szDecimals);
        expect(decimalPlaces(asSpot)).toBe(spotMax);

        // And the live book agrees with the ceiling we chose. Guarded because a
        // builder dex can list an asset nobody quotes: an empty book makes the
        // loop below assert nothing at all, which is the failure mode this
        // whole suite exists to eliminate. Measured: 1 level on testnet
        // `test:ABC`, 40 on mainnet `xyz:XYZ100`.
        expect(fx.builderBook.length).toBeGreaterThan(0);
        for (const level of fx.builderBook) {
          expectSamePrice(
            formatPrice(level.px, szDecimals, spec.marketType),
            level.px,
            `builder px ${level.px}`
          );
          expectSamePrice(formatSize(level.sz, szDecimals), level.sz, `builder sz ${level.sz}`);
        }
      });

      it("DOCUMENTS A BUG: an outcome market's resolved szDecimals cannot price its own book", () => {
        // Prediction markets are thin and intermittent. When none is quoted with a
        // resting book this assertion has nothing to check — skip it rather than
        // failing the whole file, which is what a hard requirement in `beforeAll` did.
        if (!fx.outcome) return;
        const spec = resolveAssetSpec(fx.assets, fx.outcome.slug);
        const levels = fx.outcomeBook;
        expect(levels.length).toBeGreaterThan(0);

        // What our stack resolves. `SymbolConverter` hard-codes 5 for every
        // outcome market ("absent from szDecimals metadata; they are all 5") and
        // `resolveAssetSpec` passes it straight through, so the 6-decimal perp
        // ceiling leaves exactly ONE decimal place for a probability.
        expect(spec.szDecimals).toBe(5);
        expect(spec.marketType).toBe<MarketType>("perp");
        const allowedDecimals = 6 - spec.szDecimals;
        expect(allowedDecimals).toBe(1);

        // What the exchange actually publishes: prices finer than that — measured
        // up to 5 decimals on mainnet (0.85325) and 2 on testnet — with at most 5
        // significant figures, and sizes that are whole numbers. Both are the
        // signature of szDecimals 0, not 5.
        expect(Math.max(...levels.map((level) => decimalPlaces(level.px)))).toBeGreaterThan(
          allowedDecimals
        );
        for (const level of levels) {
          expect(new BigNumber(level.sz).isInteger()).toBe(true);
          expectSamePrice(formatPrice(level.px, 0, "perp"), level.px, `outcome@0 ${level.px}`);
        }

        // The consequence, asserted as it actually behaves so this test fails the
        // day it is fixed: a live 0.85325 probability formats to 0.8. On a buy
        // that is an order 6% below where the user aimed; on a sell it crosses
        // the book and fills 6% cheap. Not a rejection — a valid order at the
        // wrong price.
        const broken = levels.filter(
          (level) =>
            !new BigNumber(formatPrice(level.px, spec.szDecimals, spec.marketType)).isEqualTo(
              level.px
            )
        );
        expect(broken.length).toBeGreaterThan(0);
        expect(decimalPlaces(formatPrice(broken[0].px, spec.szDecimals, spec.marketType))).toBe(1);
      });

      it("DOCUMENTS A BUG: an outcome market's subscription coin is the slug, not the wire id", async () => {
        // Prediction markets are thin and intermittent. When none is quoted with a
        // resting book this assertion has nothing to check — skip it rather than
        // failing the whole file, which is what a hard requirement in `beforeAll` did.
        if (!fx.outcome) return;
        // `subscriptionCoin` special-cases spot and returns the symbol unchanged
        // for everything else. That is right for perps and builder-dex assets —
        // proven live below — and wrong for outcome markets, whose wire coin is
        // `#<outcomeId*10+side>`.
        expect(subscriptionCoin(fx.assets, PERP_SYMBOL)).toBe(PERP_SYMBOL);
        expect(subscriptionCoin(fx.assets, fx.builder.symbol)).toBe(fx.builder.symbol);
        expect(subscriptionCoin(fx.assets, fx.outcome.slug)).toBe(fx.outcome.slug);

        // The wire id returns a real book...
        const byWireId = await fx.book(fx.outcome.wireCoin);
        expect(byWireId.coin).toBe(fx.outcome.wireCoin);
        expect(bidsOf(byWireId).length + asksOf(byWireId).length).toBeGreaterThan(0);

        // ...and the slug the resolver accepts returns literal `null`, HTTP 200 —
        // the same "well-formed nothing" the exchange answers a wrong dex with.
        // A chart opened on an outcome market therefore renders empty forever,
        // and the caller that dereferences the response crashes on `.levels`.
        const bySlug = (await fx.info.l2Book({ coin: fx.outcome.slug })) as unknown;
        expect(bySlug).toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    describe("3. the live l2 book over the websocket", () => {
      let snapshot: BookSnapshot;

      beforeAll(async () => {
        snapshot = await fx.liveBook();
      }, 90_000);

      it("delivers both sides with prices and sizes as STRINGS", () => {
        const bids = bidsOf(snapshot);
        const asks = asksOf(snapshot);
        expect(bids.length).toBeGreaterThan(0);
        expect(asks.length).toBeGreaterThan(0);

        for (const level of [...bids, ...asks]) {
          // A parsed double loses the tail of an 18-significant-digit size and
          // re-serialises in exponential notation, which the action schema
          // rejects outright. The types claim strings; only the live feed proves
          // the claim.
          expect(typeof level.px).toBe("string");
          expect(typeof level.sz).toBe("string");
          expect(level.px).toMatch(DECIMAL);
          expect(level.sz).toMatch(DECIMAL);
        }
      });

      it("orders bids descending and asks ascending, with a positive spread", () => {
        const bids = bidsOf(snapshot);
        const asks = asksOf(snapshot);

        // Renderers and the "best price" readout both take index 0 without
        // checking. A reversed side puts the worst quote on the top row and makes
        // every market-order slippage estimate point the wrong way.
        for (let i = 1; i < bids.length; i += 1) {
          expect(new BigNumber(bids[i].px).isLessThan(bids[i - 1].px)).toBe(true);
        }
        for (let i = 1; i < asks.length; i += 1) {
          expect(new BigNumber(asks[i].px).isGreaterThan(asks[i - 1].px)).toBe(true);
        }
        expect(new BigNumber(bestAsk(snapshot)!.px).isGreaterThan(bestBid(snapshot)!.px)).toBe(
          true
        );
      });

      it("stamps the SERVER's clock on the envelope, not the device's", () => {
        // The failure this exists for is in `readServerTime`: if the l2Book arm
        // stopped finding `data.time`, `Scoped.serverTime` would be null and
        // freshness would silently fall back to `receivedAt` — the device clock.
        // A feed that died server-side while the socket stayed open would then
        // read as permanently fresh and no stale state would ever render.
        const scoped = fx.liveScoped();
        expect(scoped.serverTime).not.toBeNull();
        expect(scoped.serverTime).toBe(snapshot.time);
        // And it is genuinely a clock, not a sequence number or a bucket bound.
        expect(snapshot.time).toBeGreaterThan(1_700_000_000_000);
        // Within the window the store itself enforces, measured at the instant
        // the snapshot was accepted. Wider than that and every book in the app
        // renders stale; narrower is impossible, since `read` already refused
        // anything older.
        expect(Math.abs(fx.liveAcceptedAt - snapshot.time)).toBeLessThanOrEqual(BOOK_MAX_AGE_MS);
      });

      it("refuses another market's live events into this market's store", () => {
        // The decisive cross-feed check, and the reason `subscriptionKey` carries
        // the coin: two live subscriptions ran into ONE store targeted at BTC.
        // A shared key would have let ETH's book render under BTC's name.
        //
        // `arrived` is counted at the SINK, before the store sees anything, so
        // this proves the ETH feed was genuinely delivering. Without it the whole
        // test passes against a dead ETH subscription: `heldCoins` would still be
        // BTC-only and `dropped` can be nudged above zero by an out-of-order BTC
        // frame alone. Measured cadence is ~4 frames per 15 s per coin on both
        // networks, first frame ~1 s in.
        expect(fx.crossFeed.arrived[OTHER_PERP_SYMBOL]).toBeGreaterThan(0);
        expect(fx.crossFeed.arrived[PERP_SYMBOL]).toBeGreaterThan(0);
        // Every ETH frame was refused: the store dropped at least as many events
        // as ETH delivered.
        expect(fx.crossFeed.dropped).toBeGreaterThanOrEqual(
          fx.crossFeed.arrived[OTHER_PERP_SYMBOL]
        );
        // ...and none of them was ever held.
        expect(fx.crossFeed.heldCoins).toEqual([subscriptionCoin(fx.assets, PERP_SYMBOL)]);
        expect(
          subscriptionKey(fx.crossFeed.btcTarget) !== subscriptionKey(fx.crossFeed.ethTarget)
        ).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    describe("4. candle history over REST", () => {
      let minutes: Candle[];
      let hours: Candle[];

      beforeAll(async () => {
        minutes = fx.minuteCandles;
        hours = fx.hourCandles;
      });

      it("returns strictly ascending open times", () => {
        expect(minutes.length).toBeGreaterThan(100);
        for (let i = 1; i < minutes.length; i += 1) {
          // Chart renderers binary-search the array without validating it, so an
          // out-of-order row does not error — it draws a different window.
          expect(minutes[i].openTime).toBeGreaterThan(minutes[i - 1].openTime);
        }
      });

      it("gives every bucket the width of the interval it was asked for", () => {
        for (const candle of minutes) {
          // `T` is inclusive, so the width is one ms short of the interval. A row
          // that disagreed would be a different timeframe's data under the label
          // the user picked.
          expect(candle.closeTime - candle.openTime).toBe(intervalMs("1m") - 1);
          expect(candle.openTime).toBe(bucketStart(candle.openTime, "1m"));
          expect(candle.interval).toBe("1m");
        }
        for (const candle of hours) {
          expect(candle.closeTime - candle.openTime).toBe(intervalMs("1h") - 1);
          expect(candle.openTime).toBe(bucketStart(candle.openTime, "1h"));
          expect(candle.interval).toBe("1h");
        }
        // The two are genuinely different widths — otherwise the check above is
        // asserting the same thing twice.
        expect(intervalMs("1h")).toBe(intervalMs("1m") * 60);
      });

      it("never presents a future bucket, and flags the forming one honestly", () => {
        const newest = minutes[minutes.length - 1];
        // A bucket that has not started yet would render as a live bar pinned to
        // a price that has never traded.
        expect(newest.openTime).toBeLessThanOrEqual(bucketStart(Date.now(), "1m"));
        expect(fx.minuteHistory.deferred).toBe(false);

        // Deliberately NOT `hasFormingBar === (newest.closeTime >= fetchedAt)`:
        // that is `fetchCandles`'s own line, re-run over its own output, and
        // would hold whatever the module did. This checks the SAME question
        // through `isClosed` in `state/candles`, the predicate `CandleStore.seed`
        // uses — the two modules must agree on where a bucket ends. If they
        // drift, the seeded chart either draws the live bucket in `committed`
        // AND `forming` (a visibly doubled bar) or loses the live bar entirely.
        expect(fx.minuteHistory.hasFormingBar).toBe(!isClosed(newest, fx.minuteHistory.fetchedAt));
        // No row other than the newest may be open — an earlier one still
        // counted as forming means the tail is out of order.
        for (const candle of minutes.slice(0, -1)) {
          expect(isClosed(candle, fx.minuteHistory.fetchedAt)).toBe(true);
        }
      });

      it("carries prices as strings, including on zero-trade buckets", () => {
        for (const candle of minutes) {
          expect(typeof candle.close).toBe("string");
          expect(candle.open).toMatch(DECIMAL);
          expect(candle.close).toMatch(DECIMAL);
          expect(candle.volume).toMatch(DECIMAL);
        }

        const quiet = minutes.filter((candle) => candle.trades === 0);
        if (isTestnet) {
          // Measured on testnet BTC 1m: 9 of 201 buckets had no trades. A quiet
          // bucket is real data, not a gap — treating it as one leaves a hole in
          // the chart and an undefined price under the crosshair.
          expect(quiet.length).toBeGreaterThan(0);
        }
        for (const candle of quiet) {
          expect(candle.open).toBe(candle.close);
          expect(candle.high).toBe(candle.close);
          expect(candle.low).toBe(candle.close);
          expect(new BigNumber(candle.close).isGreaterThan(0)).toBe(true);
          expect(new BigNumber(candle.volume).isZero()).toBe(true);
        }
      });

      it("pages backwards without re-fetching the bar it already holds", async () => {
        const oldest = minutes[0];
        const page = await fetchCandles({
          probe: fx.info as unknown as CandleProbe,
          coin: PERP_SYMBOL,
          interval: "1m",
          count: 50,
          endTime: previousPageEnd(oldest),
        });

        expect(page.candles.length).toBeGreaterThan(0);
        // The lower bound is inclusive by containment: passing `openTime` itself
        // returns that same bar, so a naive pager either loops on one bar or
        // duplicates it into the series.
        for (const candle of page.candles) {
          expect(candle.openTime).toBeLessThan(oldest.openTime);
        }

        const merged = mergeCandles(page.candles, minutes);
        expect(merged.length).toBe(page.candles.length + minutes.length);
        for (let i = 1; i < merged.length; i += 1) {
          expect(merged[i].openTime).toBeGreaterThan(merged[i - 1].openTime);
        }
      });

      it("seeds the store without ever drawing the forming bar twice", () => {
        const target = fx.candleTarget("1m");
        const store = new CandleStore();
        store.setTarget(target);
        // Seeded at the instant the history was FETCHED, not at `Date.now()`:
        // seeding with a later clock silently reclassifies the live bucket as
        // closed whenever a minute boundary passed between fetch and test, and
        // the assertion below would then be nondeterministic rather than wrong.
        store.seed(target, minutes, fx.minuteHistory.fetchedAt);

        const series = store.read();
        expect(store.size).toBe(minutes.length);
        // The store's verdict must match the fetch's flag. A disagreement is the
        // doubled-bar / missing-live-bar failure, reached from the other side.
        expect(series.forming !== null).toBe(fx.minuteHistory.hasFormingBar);
        // Chart libraries draw `forming` IN ADDITION to `committed`, so a bucket
        // present in both is rendered twice — visibly, as a doubled bar.
        if (series.forming) {
          expect(series.committed.some((c) => c.openTime === series.forming!.openTime)).toBe(false);
          expect(series.forming.openTime).toBeLessThanOrEqual(bucketStart(Date.now(), "1m"));
        }
        for (let i = 1; i < series.committed.length; i += 1) {
          expect(series.committed[i].openTime).toBeGreaterThan(series.committed[i - 1].openTime);
        }
        // A price readout reads this; `null` would render as an empty ticker on a
        // chart that visibly has bars.
        expect(store.latestClose()).toMatch(DECIMAL);
      });

      it("promotes the forming bucket once its wall clock has passed", () => {
        // Seeded at the newest bucket's OPEN time rather than at `fetchedAt`.
        // Whether live history happens to contain a forming bar is a property
        // of how the market traded in the last minute — measured absent on
        // testnet BTC often enough to matter — so a settle() check hung off the
        // test above asserts nothing at all whenever it does not. Seeded here,
        // exactly one bucket is open BY CONSTRUCTION: the newest closes at
        // `openTime + 59999`, every earlier one at or before `openTime - 1`.
        const newest = minutes[minutes.length - 1];
        const target = fx.candleTarget("1m");
        const store = new CandleStore();
        store.setTarget(target);
        store.seed(target, minutes, newest.openTime);

        const before = store.read();
        expect(before.forming?.openTime).toBe(newest.openTime);
        expect(before.committed.length).toBe(minutes.length - 1);
        expect(before.committed.some((c) => c.openTime === newest.openTime)).toBe(false);

        // `T` is inclusive, so the bucket is still open AT its close time. One
        // ms either side of that boundary is where an off-by-one lives, and an
        // early promotion freezes the live bar a whole interval before it ends.
        expect(store.settle(newest.closeTime)).toBe(false);
        expect(store.settle(newest.closeTime + 1)).toBe(true);

        const after = store.read();
        expect(after.forming).toBeNull();
        // Promoted, not discarded. Nothing else closes a bucket on a market that
        // has stopped trading; if settle dropped it instead, the chart would
        // lose its most recent candle at every interval boundary on a quiet
        // market — and the price readout would jump back a minute.
        expect(after.committed.length).toBe(minutes.length);
        expect(after.committed[after.committed.length - 1].openTime).toBe(newest.openTime);
        expect(after.committed[after.committed.length - 1].close).toBe(newest.close);
      });
    });

    // -----------------------------------------------------------------------
    describe("5. subscription keys separate markets and intervals", () => {
      it("gives two markets and two intervals four distinct keys", () => {
        const btc1m = fx.candleTarget("1m");
        const btc1h = fx.candleTarget("1h");
        const eth1m = { ...btc1m, coin: OTHER_PERP_SYMBOL };
        const eth1h = { ...btc1h, coin: OTHER_PERP_SYMBOL };

        const keys = new Set([btc1m, btc1h, eth1m, eth1h].map(subscriptionKey));
        // A key that dropped `interval` would collapse 1m and 1h into one
        // subscription: the second subscribe is skipped as a duplicate and the
        // chart silently shows the wrong timeframe.
        expect(keys.size).toBe(4);
      });

      it("keeps two intervals of the same market open as separate live subscriptions", async () => {
        const btc1m = fx.candleTarget("1m");
        const btc1h = fx.candleTarget("1h");

        await fx.registry.add(btc1m);
        await fx.registry.add(btc1h);
        try {
          // Both active at once is the live proof that the exchange treats them as
          // two subscriptions and that our key does too.
          expect(fx.registry.isActive(btc1m)).toBe(true);
          expect(fx.registry.isActive(btc1h)).toBe(true);
        } finally {
          await fx.registry.remove(btc1m);
          await fx.registry.remove(btc1h);
        }
        expect(fx.registry.isActive(btc1m)).toBe(false);
        expect(fx.registry.isActive(btc1h)).toBe(false);
      }, 90_000);
    });

    // -----------------------------------------------------------------------
    describe("6. order-size bounds agree with the live tables", () => {
      it("puts the $10 minimum below the smallest tabulated market-order maximum", () => {
        const table = parseMaxMarketOrderNtls(fx.maxMarketOrderNtls);
        // Measured on testnet: [[25,"30000000.0"],[20,"5000000.0"],[10,"2000000.0"],[1,"500000.0"]].
        expect(table.length).toBeGreaterThan(0);
        for (const [leverage, notional] of table) {
          expect(Number.isInteger(leverage)).toBe(true);
          expect(notional).toMatch(DECIMAL);
        }

        const smallest = table.reduce(
          (min, [, notional]) => BigNumber.minimum(min, notional),
          new BigNumber(table[0][1])
        );
        // If the floor ever crossed the ceiling there would be assets with no
        // legal order size at all, and the order form would reject every input
        // the user could type.
        expect(smallest.isGreaterThan(MIN_ORDER_NOTIONAL_USDC)).toBe(true);
      });

      it("bounds every live perp's leverage, falling back conservatively", () => {
        const table = parseMaxMarketOrderNtls(fx.maxMarketOrderNtls);
        const exactLeverages = new Set(table.map(([leverage]) => leverage));

        const byLeverage = new Map(table);
        for (const asset of fx.perpUniverse) {
          const bound = maxMarketOrderNotional(table, asset.maxLeverage);
          // `null` would be read by a caller as "no limit", and the exchange
          // would then reject the order it built. Every live asset must map to
          // some bound.
          expect(bound).not.toBeNull();
          expect(bound!.notional).toMatch(DECIMAL);
          expect(bound!.exact).toBe(exactLeverages.has(asset.maxLeverage));
          // And an exact hit must return that row's NOTIONAL. Without this the
          // flag is checked but the value never is, so returning the wrong
          // column — or a neighbouring row — passes.
          if (bound!.exact) {
            expect(bound!.notional).toBe(byLeverage.get(asset.maxLeverage));
          }
        }

        // The fallback direction. Builder-dex assets carry leverage values (up
        // to 50) with no row of their own; the leverage used here is derived
        // from the live table rather than named, because a table that gained a
        // 50x row would make a hard-coded 50 assert the opposite branch and fail
        // for no defect.
        const highestTabulated = Math.max(...exactLeverages);
        const untabulated = highestTabulated + 1;
        const fallback = maxMarketOrderNotional(table, untabulated)!;
        expect(fallback.exact).toBe(false);
        // The conservative reading: fall back to the tightest tabulated tier at
        // or below, never invent a larger cap than any row grants. Treating an
        // unknown leverage as unlimited is what puts an order on the wire that
        // the exchange then rejects — and a rejection still costs an action from
        // the rate-limit budget.
        expect(fallback.notional).toBe(byLeverage.get(highestTabulated));

        // What makes "next lower tier" conservative in the first place, checked
        // against the live table rather than assumed: notional rises with
        // leverage. If the exchange ever inverted that, stepping DOWN a tier
        // would step UP the allowed size and the fallback would be the
        // permissive answer, not the safe one.
        const ascending = [...table].sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < ascending.length; i += 1) {
          expect(new BigNumber(ascending[i][1]).isGreaterThanOrEqualTo(ascending[i - 1][1])).toBe(
            true
          );
        }
      });

      it("derives a minimum order size from a live price that clears the minimum", () => {
        const price = bestBid(fx.perpSnapshot)!.px;
        const lot = new BigNumber(10).pow(-fx.perp.szDecimals);

        // The order form's real computation: the smallest whole lot whose
        // notional reaches $10 at the live price.
        const lots = new BigNumber(MIN_ORDER_NOTIONAL_USDC)
          .dividedBy(price)
          .dividedBy(lot)
          .integerValue(BigNumber.ROUND_CEIL);
        // Precondition, stated rather than assumed: at one lot there is no
        // "one lot less" to test, `formatSize("0", ...)` throws, and the test
        // below would ERROR instead of asserting. Measured ~17 lots for BTC at
        // szDecimals 5 on both networks.
        expect(lots.isGreaterThan(1)).toBe(true);
        const size = formatSize(lots.multipliedBy(lot).toFixed(), fx.perp.szDecimals);

        expect(meetsMinNotional(price, size)).toBe(true);
        // One lot less must fail, or the "minimum" is not the minimum and the
        // exchange rejects the order — which still costs an action from the
        // rate-limit budget.
        const oneLotLess = formatSize(
          lots.minus(1).multipliedBy(lot).toFixed(),
          fx.perp.szDecimals
        );
        expect(meetsMinNotional(price, oneLotLess)).toBe(false);
        expect(notionalOf(price, size).isGreaterThanOrEqualTo(MIN_ORDER_NOTIONAL_USDC)).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    describe("7. margin tables against the live universe", () => {
      it("confirms every flat table id IS the asset's max leverage", () => {
        const flat = fx.perpUniverse.filter((asset) => isFlatMarginTable(asset.marginTableId));
        // Measured: 187 of 210 testnet and 196 of 232 mainnet perps.
        expect(flat.length).toBeGreaterThan(50);

        for (const asset of flat) {
          // The fact that lets `MarginTableCache` answer these ids with no
          // network call at all. If it stopped holding, every asset row would
          // show a leverage the exchange does not offer.
          expect(asset.marginTableId).toBe(asset.maxLeverage);
        }
      });

      it("normalises a live tiered table into an ascending, non-increasing ladder", () => {
        const table = normaliseMarginTable(fx.tieredTable.id, fx.tieredTable.raw);
        // A single-tier answer here would make every assertion below vacuous and
        // would mean the fixture picked a flat table by mistake.
        expect(table.tiers.length).toBeGreaterThan(1);

        // Both invariants `findMarginTier` relies on without re-checking: it
        // scans in REVERSE and returns the first tier the value clears, so an
        // unsorted ladder silently selects the wrong maximum leverage.
        expect(table.tiers[0].lowerBound).toBe("0.0");
        for (let i = 1; i < table.tiers.length; i += 1) {
          expect(
            new BigNumber(table.tiers[i].lowerBound).isGreaterThan(table.tiers[i - 1].lowerBound)
          ).toBe(true);
          expect(table.tiers[i].maxLeverage).toBeLessThanOrEqual(table.tiers[i - 1].maxLeverage);
        }

        // A tiny position sits in the first tier; a notional past the last bound
        // sits in the last. Both read off the live ladder, not an invented one.
        expect(findMarginTier("1", table.tiers)).toEqual(table.tiers[0]);
        const top = table.tiers[table.tiers.length - 1];
        expect(
          findMarginTier(new BigNumber(top.lowerBound).plus(1).toFixed(), table.tiers)
        ).toEqual(top);

        // The cross-check the shape assertions above cannot make: the ladder's
        // FIRST tier is what the order form offers as maximum leverage, and it
        // must equal what the universe says the asset allows. Measured: zero
        // mismatches across every tiered table on both networks (testnet 55 =>
        // 10x for 10 assets, mainnet 56 => 40x for BTC). A table that disagreed
        // would let the user select a leverage the exchange refuses, and the
        // rejection arrives only at submit time.
        const users = fx.perpUniverse.filter((asset) => asset.marginTableId === table.id);
        expect(users.length).toBeGreaterThan(0);
        for (const asset of users) {
          expect(table.tiers[0].maxLeverage).toBe(asset.maxLeverage);
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface BookLevelLike {
  px: string;
  sz: string;
}

interface MarketFixture {
  env: HlEnv;
  info: InfoClient;
  assets: AssetIndex;
  registry: SubscriptionRegistry;

  perp: { assetId: number; index: number; szDecimals: number };
  /** The one pair whose wire id IS its display name. */
  spot: { symbol: string; wireCoin: string; index: number; assetId: number };
  /** An ordinary pair, whose wire id is `@N` and is NOT its display name. */
  normalSpot: { symbol: string; wireCoin: string; index: number };
  /** Every live pair whose display symbol is unambiguous — see `buildFixture`. */
  spotRows: { symbol: string; wireCoin: string; index: number }[];
  builder: {
    symbol: string;
    dexName: string;
    dexIndex: number;
    index: number;
    szDecimals: number;
    assetId: number;
  };
  /** The chosen dex's whole universe, in the order the server listed it. */
  builderUniverse: { name: string; szDecimals: number }[];
  /**
   * `null` when no live outcome market has a resting book right now.
   *
   * Prediction markets are thin and intermittent, and hard-requiring one made
   * the WHOLE file fail whenever none happened to be quoted — 62 tests reporting
   * a code defect because a third party stopped making a market. The outcome
   * assertions skip themselves instead; everything else still runs.
   */
  outcome: null | {
    slug: string;
    outcomeId: number;
    sideIndex: number;
    wireCoin: string;
    liveMid: string;
    assetId: number;
  };
  /** Every tradable side of the chosen outcome market — Yes and No. */
  outcomeSides: OutcomeSide[];

  perpUniverse: { name: string; maxLeverage: number; marginTableId: number; szDecimals: number }[];
  perpBook: BookLevelLike[];
  perpSnapshot: BookSnapshot;
  builderBook: BookLevelLike[];
  outcomeBook: BookLevelLike[];
  finePriceBook: { symbol: string; szDecimals: number; levels: BookLevelLike[] };

  minuteCandles: Candle[];
  hourCandles: Candle[];
  minuteHistory: { hasFormingBar: boolean; deferred: boolean; fetchedAt: number };

  maxMarketOrderNtls: unknown;
  tieredTable: { id: number; raw: unknown };

  crossFeed: {
    dropped: number;
    /** Frames seen at the SINK, per wire coin — before the store's guard runs. */
    arrived: Record<string, number>;
    heldCoins: string[];
    btcTarget: SubscriptionTarget;
    ethTarget: SubscriptionTarget;
  };

  book(coin: string): Promise<BookSnapshot>;
  liveBook(): Promise<BookSnapshot>;
  liveScoped(): Scoped<BookSnapshot>;
  /** `Date.now()` at the instant the live snapshot was accepted by the store. */
  liveAcceptedAt: number;
  candleTarget(interval: "1m" | "1h"): SubscriptionTarget;
  teardown(): Promise<void>;
}

/**
 * Build everything one network's tests read.
 *
 * Deliberately fetches `meta`, `perpDexs` and `outcomeMeta` itself even though
 * `SymbolConverter.create` fetches the same three internally: those raw
 * responses are the **independent** source the converter's answers are checked
 * against. Reading the ids back out of the converter and comparing them to
 * themselves is the shape of test this whole exercise exists to eliminate.
 */
async function buildFixture(env: HlEnv): Promise<MarketFixture> {
  const isTestnet = env === "testnet";
  const transport = new HttpTransport({ isTestnet, timeout: 20_000 });
  const info = new InfoClient({ transport });

  const perpMeta = await withRetry(() => info.meta());
  const perpIndex = perpMeta.universe.findIndex((asset) => asset.name === PERP_SYMBOL);
  if (perpIndex < 0) throw new Error(`${PERP_SYMBOL} is not listed on ${env}`);

  // --- a builder dex with at least one listed asset -------------------------
  const dexs = await withRetry(() => info.perpDexs());
  const candidates = dexs
    .map((dex, index) => ({ dex, index }))
    .filter((entry) => entry.index > 0 && entry.dex !== null && entry.dex.name.length > 0);
  let builder: MarketFixture["builder"] | null = null;
  let builderUniverse: MarketFixture["builderUniverse"] = [];
  // Empty universes are common — a dex can be registered before it lists
  // anything — so this walks until it finds one that actually trades.
  for (const entry of candidates.slice(0, 6)) {
    const dexName = entry.dex!.name;
    const dexMeta = await withRetry(() => info.meta({ dex: dexName }));
    if (dexMeta.universe.length === 0) continue;
    const asset = dexMeta.universe[0];
    builderUniverse = dexMeta.universe.map((entryAsset) => ({
      name: entryAsset.name,
      szDecimals: entryAsset.szDecimals,
    }));
    builder = {
      symbol: asset.name,
      dexName,
      dexIndex: entry.index,
      index: 0,
      szDecimals: asset.szDecimals,
      assetId: 100_000 + entry.index * 10_000,
    };
    break;
  }
  if (!builder) throw new Error(`no builder dex on ${env} lists an asset`);

  // --- the converter, over exactly the one dex we verified ------------------
  // `dexs: true` would fetch `meta` for all 244 testnet dexs in parallel, which
  // is a rate-limit event on a shared IP rather than a test.
  const converter = await withRetry(() =>
    SymbolConverter.create({ transport, dexs: [builder!.dexName] })
  );
  const assets = wrapSymbolConverter(converter);

  // --- spot ------------------------------------------------------------------
  const [spotMeta, spotCtxs] = await withRetry(() => info.spotMetaAndAssetCtxs());
  const tokens = new Map(spotMeta.tokens.map((token) => [token.index, token]));
  const spotRows = spotMeta.universe.map((market, position) => {
    const base = tokens.get(market.tokens[0]);
    const quote = tokens.get(market.tokens[1]);
    return {
      symbol: `${base?.name}/${quote?.name}`,
      wireCoin: market.name,
      index: market.index,
      szDecimals: base?.szDecimals ?? 0,
      midPx: spotCtxs[position]?.midPx ?? null,
      // A pair whose base or quote token is missing from `tokens` has no display
      // symbol at all, and the SDK skips it rather than indexing `undefined/USDC`.
      named: base !== undefined && quote !== undefined,
    };
  });

  // Two rows sharing a display symbol would shadow each other in any
  // symbol-keyed map, so "which id does this symbol resolve to" has no single
  // right answer for them. Excluded so the whole-universe check stays
  // arithmetic on wire data rather than a claim about which duplicate won.
  // Measured: zero duplicates on either network today.
  const symbolCounts = new Map<string, number>();
  for (const row of spotRows) symbolCounts.set(row.symbol, (symbolCounts.get(row.symbol) ?? 0) + 1);
  const namedSpotRows = spotRows
    .filter((row) => row.named && symbolCounts.get(row.symbol) === 1)
    .map((row) => ({ symbol: row.symbol, wireCoin: row.wireCoin, index: row.index }));

  const exception = spotRows.find((row) => row.symbol === PAIR_ID_EXCEPTION);
  if (!exception) throw new Error(`${PAIR_ID_EXCEPTION} is not listed on ${env}`);
  const spot = {
    symbol: exception.symbol,
    wireCoin: exception.wireCoin,
    index: exception.index,
    assetId: 10_000 + exception.index,
  };

  // The lowest-indexed ordinary pair: the oldest listing, so the least likely
  // to be delisted between runs. Measured: testnet @3 (BREAD/USDC), mainnet @1
  // (HFUN/USDC). Chosen by its WIRE name starting with `@`, which is the
  // exchange's own statement that it is not an exception pair.
  const normalSpot = namedSpotRows
    .filter((row) => row.wireCoin.startsWith("@") && row.index > 0)
    .sort((a, b) => a.index - b.index)[0];
  if (!normalSpot) throw new Error(`no ordinary @N spot pair listed on ${env}`);

  // A pair quoted finely enough that the 6-decimal perp ceiling could not carry
  // its prices — see `findFinePriceBook` for why it is discovered, not named.
  const finePriceBook = await findFinePriceBook(info, spotRows);

  // --- live books ------------------------------------------------------------
  const book = async (coin: string): Promise<BookSnapshot> =>
    (await withRetry(() => info.l2Book({ coin }))) as unknown as BookSnapshot;

  const perpSnapshot = await book(PERP_SYMBOL);
  const builderBook = await book(builder.symbol);

  // --- outcome market --------------------------------------------------------
  // Walked rather than taken first: measured on testnet, only 1 of the 3 newest
  // recurring markets had any resting orders at all, so a single pick makes the
  // whole outcome dimension fail on a market that is simply untraded.
  const outcomeMeta = await withRetry(() => info.outcomeMeta());
  const mids = (await withRetry(() => info.allMids())) as Record<string, string>;
  const outcomeCandidates = outcomeMarketCandidates(outcomeMeta, mids);
  // Not fatal: see `MarketFixture.outcome`.
  if (outcomeCandidates.length === 0) {
    console.warn(`e2e: no live outcome market on ${env}; outcome assertions will skip`);
  }

  let outcomeSides: OutcomeSide[] | null = null;
  let outcomeBook: BookLevelLike[] = [];
  for (const candidate of outcomeCandidates.slice(0, 8)) {
    const raw = await book(candidate[0].wireCoin);
    const levels = [...bidsOf(raw), ...asksOf(raw)];
    if (levels.length === 0) continue;
    // Prefer a witness whose book actually carries a price finer than one
    // decimal, counted on the exchange's own price STRINGS and never through
    // `formatPrice` — the same rule `findFinePriceBook` follows, so the test
    // that shows the resolved szDecimals cannot carry these prices is not
    // selecting them with the function it is checking. The FALLBACK is the
    // first market with any book at all: if the exchange ever stopped quoting
    // outcome markets finer than one decimal, the assertion stays in place and
    // fails, which is correct — the divergence would have gone away.
    const fine = levels.some((level) => decimalPlaces(level.px) > 1);
    if (outcomeSides === null || fine) {
      outcomeSides = candidate;
      outcomeBook = levels;
    }
    if (fine) break;
  }
  const chosenSide = outcomeSides?.[0];
  const outcome: MarketFixture["outcome"] = !chosenSide
    ? null
    : {
        slug: chosenSide.slug,
        outcomeId: chosenSide.outcomeId,
        sideIndex: chosenSide.sideIndex,
        wireCoin: chosenSide.wireCoin,
        liveMid: chosenSide.liveMid,
        assetId: 100_000_000 + chosenSide.outcomeId * 10 + chosenSide.sideIndex,
      };

  // --- candles ---------------------------------------------------------------
  const probe = info as unknown as CandleProbe;
  const minuteFetchedAt = Date.now();
  // 500 on testnet: zero-trade buckets are the point of that assertion and a
  // wider window makes finding one near-certain on a quiet network.
  const minuteHistory = await withRetry(() =>
    fetchCandles({
      probe,
      coin: PERP_SYMBOL,
      interval: "1m",
      count: isTestnet ? 500 : 200,
      now: () => minuteFetchedAt,
    })
  );
  const hourHistory = await withRetry(() =>
    fetchCandles({ probe, coin: PERP_SYMBOL, interval: "1h", count: 200 })
  );

  // --- limits and margin -----------------------------------------------------
  const maxMarketOrderNtls = await withRetry(() => info.maxMarketOrderNtls());
  const tieredId = perpMeta.universe
    .map((asset) => asset.marginTableId)
    .find((id) => !isFlatMarginTable(id));
  if (tieredId === undefined) throw new Error(`no tiered margin table referenced on ${env}`);
  const tieredRaw = await withRetry(() => info.marginTable({ id: tieredId }));

  // --- one live websocket, shared by the book and cross-feed checks ----------
  const wsTransport = new WebSocketTransport({
    isTestnet,
    timeout: 20_000,
    keepAlive: { interval: 30_000 },
  });
  const subscriptionClient = new SubscriptionClient({ transport: wsTransport });

  const identity = createIdentity({
    env,
    accountId: `market-data-${env}`,
    // Any address: only read-only market channels are opened, and none of them
    // takes a user.
    address: "0x0000000000000000000000000000000000000001",
  });
  const btcTarget: SubscriptionTarget = {
    identity,
    channel: "l2Book",
    coin: PERP_SYMBOL,
    aggregation: null,
    interval: null,
  };
  const ethTarget: SubscriptionTarget = { ...btcTarget, coin: OTHER_PERP_SYMBOL };

  const store = new BookStore();
  store.setTarget(btcTarget);
  const heldCoins = new Set<string>();
  /** Counted BEFORE `store.apply`, so a dead feed is distinguishable from a refused one. */
  const arrived: Record<string, number> = {};
  const subscribe = createSubscribeFn({
    api: subscriptionClient as unknown as SubscriptionApi,
    sink: (event) => {
      const coin = (event.value as Partial<BookSnapshot> | undefined)?.coin;
      // Block 5 later routes candle events through this same sink; they carry no
      // `coin`, so they are counted by neither side.
      if (typeof coin === "string") arrived[coin] = (arrived[coin] ?? 0) + 1;
      store.apply(event as Scoped<BookSnapshot>);
      const held = store.readScoped();
      if (held) heldCoins.add(held.value.coin);
    },
    onError: (target, error) => {
      // Surfaced rather than swallowed: a silently dead feed is indistinguishable
      // from a quiet market, and every wait below would then time out for the
      // wrong reason.
      console.warn(`${env} channel error on ${target.channel}`, error);
    },
  });
  const registry = new SubscriptionRegistry(subscribe);

  // Both markets live, both writing into the ONE store targeted at BTC.
  await registry.add(btcTarget);
  await registry.add(ethTarget);

  const snapshot = await waitFor(() => store.read(Date.now()), 60_000);
  const acceptedAt = Date.now();
  const scoped = store.readScoped()!;
  // Wait for the OTHER market's feed specifically, not merely for the drop
  // counter to move: `dropped` also counts out-of-order frames of our own coin,
  // so a dead ETH subscription could satisfy it. Measured cadence is ~4 l2Book
  // frames per 15 s per coin with the first ~1 s in — not tick rate.
  await waitFor(() => arrived[OTHER_PERP_SYMBOL], 30_000);
  await registry.remove(ethTarget);

  return {
    env,
    info,
    assets,
    registry,
    perp: {
      assetId: perpIndex,
      index: perpIndex,
      szDecimals: perpMeta.universe[perpIndex].szDecimals,
    },
    spot,
    normalSpot,
    spotRows: namedSpotRows,
    builder,
    builderUniverse,
    outcome,
    outcomeSides: outcomeSides ?? [],
    perpUniverse: perpMeta.universe.map((asset) => ({
      name: asset.name,
      maxLeverage: asset.maxLeverage,
      marginTableId: asset.marginTableId,
      szDecimals: asset.szDecimals,
    })),
    perpBook: [...bidsOf(perpSnapshot), ...asksOf(perpSnapshot)],
    perpSnapshot,
    builderBook: [...bidsOf(builderBook), ...asksOf(builderBook)],
    outcomeBook,
    finePriceBook,
    minuteCandles: minuteHistory.candles,
    hourCandles: hourHistory.candles,
    minuteHistory: {
      hasFormingBar: minuteHistory.hasFormingBar,
      deferred: minuteHistory.deferred,
      fetchedAt: minuteFetchedAt,
    },
    maxMarketOrderNtls,
    tieredTable: { id: tieredId, raw: tieredRaw },
    crossFeed: {
      dropped: store.dropped,
      arrived: { ...arrived },
      heldCoins: [...heldCoins],
      btcTarget,
      ethTarget,
    },
    book,
    liveBook: async () => snapshot,
    liveScoped: () => scoped,
    liveAcceptedAt: acceptedAt,
    candleTarget: (interval) => ({
      identity,
      channel: "candle",
      coin: PERP_SYMBOL,
      aggregation: null,
      interval,
    }),
    teardown: async () => {
      await registry.closeAll().catch(() => undefined);
      wsTransport.close();
    },
  };
}

/**
 * A live spot book with at least one price the perp ceiling could not carry.
 *
 * Discovered rather than hard-coded: testnet lists 1,309 pairs, mainnet 900-odd,
 * and which of them are quoted finely enough churns. Candidates are the
 * lowest-priced pairs, because that is exactly where the decimal ceiling binds —
 * above ~1 the 5-significant-figure cap dominates and the perp and spot ceilings
 * become indistinguishable.
 *
 * The mid only nominates a candidate; the **book** confirms it, because a mid is
 * the average of two sides and can carry decimals neither side has. Measured: 1
 * candidate needed on testnet, 3 on mainnet.
 */
async function findFinePriceBook(
  info: InfoClient,
  rows: {
    symbol: string;
    wireCoin: string;
    szDecimals: number;
    midPx: string | null;
  }[]
): Promise<{ symbol: string; szDecimals: number; levels: BookLevelLike[] }> {
  const candidates = rows
    .filter((row) => row.midPx !== null && new BigNumber(row.midPx).isGreaterThan(0))
    .sort((a, b) => new BigNumber(a.midPx!).comparedTo(b.midPx!) ?? 0)
    .slice(0, 12);

  for (const candidate of candidates) {
    const raw = (await withRetry(() =>
      info.l2Book({ coin: candidate.wireCoin })
    )) as unknown as BookSnapshot;
    const levels = [...bidsOf(raw), ...asksOf(raw)];
    // The predicate is pure arithmetic on the exchange's own price STRINGS —
    // `formatPrice` is deliberately not called here, so the test that asserts
    // the perp ceiling breaks these prices is not selecting them with the very
    // function it is checking.
    const perpCeiling = Math.max(6 - candidate.szDecimals, 0);
    if (levels.some((level) => decimalPlaces(level.px) > perpCeiling)) {
      return { symbol: candidate.symbol, szDecimals: candidate.szDecimals, levels };
    }
  }
  throw new Error("no live spot book carried a price finer than the perp ceiling");
}

/**
 * Whether the perp ceiling would change (or reject) a price the exchange accepted.
 *
 * Two failure modes, one meaning: `formatPrice` truncates the extra decimals
 * away, or — once the whole value truncates to zero — throws `PrecisionError`.
 * Both mean the price the user typed is not the price that would be sent.
 */
function perpCeilingBreaks(price: string, szDecimals: number): boolean {
  try {
    return !new BigNumber(formatPrice(price, szDecimals, "perp")).isEqualTo(price);
  } catch {
    return true;
  }
}

interface OutcomeSide {
  slug: string;
  outcomeId: number;
  sideIndex: number;
  wireCoin: string;
  liveMid: string;
}

/**
 * Every live outcome market, as the slugs our resolver takes — **all sides**.
 *
 * Outcome markets are the one range with no endpoint that returns the symbol:
 * `outcomeMeta` gives numeric ids and a pipe-delimited spec, and `allMids` keys
 * them `#<outcomeId*10+side>`. The slug is derived from that spec — rebuilt here
 * from live fields rather than hard-coded, because the recurring price markets
 * are replaced every 24 h.
 *
 * Both sides are returned deliberately. At `sideIndex` 0 the `+ sideIndex` term
 * of the id formula vanishes, so a single Yes-side sample cannot tell the real
 * formula from one that dropped the term — and an order meant for "No" placed
 * on "Yes" is a bet on the opposite outcome, filled at a valid price.
 *
 * @see https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications
 */
function outcomeMarketCandidates(
  meta: {
    outcomes: { outcome: number; description: string; sideSpecs: { name: string }[] }[];
    questions: { fallbackOutcome: number }[];
  },
  mids: Record<string, string>
): OutcomeSide[][] {
  // A question's fallback outcome is not tradable on its own and is given no
  // public slug, so the converter never indexes it. Picking one would fail the
  // whole network's fixture with `UnknownAssetError` from a resolver doing
  // exactly the right thing. None currently carries `class:priceBinary` on
  // either network, so this is insurance rather than a live filter.
  const fallbacks = new Set(meta.questions.map((question) => question.fallbackOutcome));
  const months = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];

  const candidates: OutcomeSide[][] = [];
  for (const outcome of meta.outcomes) {
    if (fallbacks.has(outcome.outcome)) continue;
    if (!outcome.description.includes("class:priceBinary")) continue;
    const fields = Object.fromEntries(
      outcome.description.split("|").map((part) => {
        const [key, ...rest] = part.split(":");
        return [key, rest.join(":")];
      })
    ) as Record<string, string>;
    const { underlying, expiry, targetPrice } = fields;
    if (!underlying || !expiry || !targetPrice) continue;

    // Expiry "YYYYMMDD-HHMM" becomes the slug date "mon-dd-HHMM".
    const date = `${months[Number(expiry.slice(4, 6)) - 1]}-${expiry.slice(6, 8)}-${expiry.slice(9, 13)}`;
    const sides: OutcomeSide[] = [];
    for (const [sideIndex, side] of outcome.sideSpecs.entries()) {
      const slug = `${underlying}-above-${targetPrice}-${side.name}-${date}`.toLowerCase();
      const wireCoin = `#${outcome.outcome * 10 + sideIndex}`;
      const liveMid = mids[wireCoin];
      if (liveMid === undefined) continue;
      sides.push({ slug, outcomeId: outcome.outcome, sideIndex, wireCoin, liveMid });
    }
    // Both sides or neither: a market quoting only one side would make the
    // adjacency check below untestable, and there is no shortage of candidates.
    if (sides.length === outcome.sideSpecs.length && sides.length > 1) candidates.push(sides);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compare two decimal strings by value, reporting both when they differ.
 *
 * Not `toBe`: the wire spells a price "64204.0" and the formatter emits "64204".
 * Those are the same price, and failing on the spelling would bury the one thing
 * this file is looking for — a formatter that changed a price the exchange had
 * already accepted.
 */
function expectSamePrice(actual: string, expected: string, label: string): void {
  expect(`${label}: ${new BigNumber(actual).toFixed()}`).toBe(
    `${label}: ${new BigNumber(expected).toFixed()}`
  );
}

/** Significant decimal places, ignoring trailing zeros the wire adds. */
function decimalPlaces(value: string): number {
  return (value.split(".")[1] ?? "").replace(/0+$/, "").length;
}

/**
 * Poll until `read` returns something truthy, or fail with a useful message.
 *
 * Live frames arrive on the exchange's schedule, so every assertion about
 * arriving state has to wait rather than sample once.
 */
async function waitFor<T>(
  read: () => T | null | undefined,
  timeoutMs: number
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for live state`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Run a live read once, and once more after a pause if the exchange rate-limits.
 *
 * Info requests share a per-IP weight budget with everyone behind the same NAT,
 * and this suite is not the only thing pointed at these two networks. A 429 is a
 * neighbour's traffic, not a defect in the code under test — but retrying
 * forever would hide a real outage, so it retries exactly once.
 */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!/429|too many requests|rate limit/i.test(String(error))) throw error;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return run();
  }
}
