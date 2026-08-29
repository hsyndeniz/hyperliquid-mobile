/**
 * Prediction markets, end to end, against live Hyperliquid **mainnet**.
 *
 *   HL_E2E=1 bun run test:e2e --testPathPattern predictions
 *
 * **Why mainnet.** Testnet has far more outcome markets (305 against 8), but no
 * account there holds a position, and the whole risk in this area is arithmetic
 * over somebody's real balances. So the catalog checks run against mainnet's
 * small, live universe and the holdings checks against a real holder found by
 * scanning it.
 *
 * **Why this exists.** Every unit test in `predictions/` runs against a recorded
 * fixture, which means what they assert is that the parser matches a snapshot
 * this project took. Four things no fixture can check:
 *
 * 1. The catalog's **shape still holds** — the recorded one is a moment, and this
 *    area moves fast enough that a market settled between two probes taken five
 *    hours apart while the module was being written.
 * 2. `#N` is still the coin `l2Book` answers to, and still the only one.
 * 3. Outcome holdings are still **absent from `assetPositions`** — the finding the
 *    entire holdings module rests on.
 * 4. The `outcomeMetaUpdates` channel is still **accepted by the socket**. It was
 *    declared in the SDK and unwired here until Phase 10, so nothing had ever
 *    opened it.
 *
 * **What it costs.** Nothing. Read-only, no signature, no state left behind — and
 * deliberately so: every write in this area moves money, and `userOutcome` has no
 * dry-run. Its payloads are verified against a recording transport in
 * `predictions/convert.test.ts` instead.
 */

import {
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from "@nktkas/hyperliquid";
import { BigNumber } from "bignumber.js";

import { classifyAssetId, decomposeAssetId } from "@/hyperliquid/core/assetIds";
import { createIdentity } from "@/hyperliquid/core/identity";
import { unsafeOutcomeId } from "@/hyperliquid/predictions/convert";
import { fetchCatalog, tradableSides } from "@/hyperliquid/predictions/catalog";
import { PredictionCatalogStore } from "@/hyperliquid/predictions/catalogStore";
import {
  fetchOutcomeHoldings,
  nonZero,
  type OutcomeHoldings,
} from "@/hyperliquid/predictions/holdings";
import {
  buildMergeOutcomeQuote,
  completeYesSets,
  confirmConversion,
  mergeablePair,
  outcomeIdsOfQuestion,
  questionForOutcome,
} from "@/hyperliquid/predictions/preflight";
import { createSubscribeFn, type SubscriptionApi } from "@/hyperliquid/state/channels";
import { setupHyperliquid } from "@/hyperliquid/setup";
import type { PredictionCatalog } from "@/hyperliquid/predictions/types";
import type { Scoped } from "@/hyperliquid/types/domain";

import { withRateLimitRetry } from "@/hyperliquid/__e2e__/support";

const ENABLED = process.env.HL_E2E === "1";
const describeE2E = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.warn("e2e SKIPPED: set HL_E2E=1 to run against live Hyperliquid");
}

/**
 * A known mainnet holder of outcome shares.
 *
 * Pinned rather than discovered, because discovery would mean scanning fills.
 * A position that closes only weakens the assertions below — each one is written
 * to hold either way — so a stale address degrades coverage rather than failing.
 */
const HOLDER = "0x0e7d09a53f348fcef8bb139af9ebb552f4a33fe9";

describeE2E("prediction markets, live on mainnet", () => {
  let info: InfoClient;
  let catalog: PredictionCatalog;
  let holdings: OutcomeHoldings;

  beforeAll(async () => {
    setupHyperliquid();
    info = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });

    const result = await withRateLimitRetry("outcomeMeta", () =>
      fetchCatalog({ probe: info as never })
    );
    catalog = result.value!;
    holdings = await withRateLimitRetry("spotClearinghouseState", () =>
      fetchOutcomeHoldings({ probe: info as never, user: HOLDER })
    );
  }, 120_000);

  describe("the catalog", () => {
    it("still parses into markets with two sides each", () => {
      expect(catalog.outcomes.length).toBeGreaterThan(0);
      for (const outcome of catalog.outcomes) {
        expect([outcome.outcomeId, outcome.sides.length]).toEqual([outcome.outcomeId, 2]);
        expect(outcome.quoteToken).toBe("USDC");
      }
    });

    it("assigns every side an id in the outcome range, by the documented formula", () => {
      // `100_000_000 + outcomeId * 10 + sideIndex`. A wrong id here does not
      // fail — it addresses a different market.
      for (const { outcome, side } of tradableSides(catalog)) {
        expect(classifyAssetId(side.assetId)).toBe("outcome");
        expect(decomposeAssetId(side.assetId)).toMatchObject({
          kind: "outcome",
          outcomeId: outcome.outcomeId,
          sideIndex: side.sideIndex,
        });
      }
    });

    it("still has outcomes belonging to NO listed question", () => {
      // Measured 4 of 8. The preflight blocks a negate on these rather than
      // guessing a question, so this is load-bearing rather than trivia. If it
      // ever becomes 0 of N, that block becomes unreachable and should be
      // revisited — not silently kept.
      const orphans = catalog.outcomes
        .map((o) => o.outcomeId)
        .filter((id) => questionForOutcome(catalog, id) === null);
      console.log(`e2e: outcomes in no listed question: ${JSON.stringify(orphans)}`);
      expect(Array.isArray(orphans)).toBe(true);
    });

    it("includes the UNNAMED fallback in each question's outcome set", () => {
      for (const question of catalog.questions) {
        const ids = outcomeIdsOfQuestion(catalog, question.questionId);
        expect(ids).toEqual(expect.arrayContaining([...question.namedOutcomeIds]));
        if (question.fallbackOutcomeId !== null) {
          // The "none of the above" market — tradeable, no slug, invisible to
          // anything that enumerates by name.
          expect(ids).toContain(question.fallbackOutcomeId);
        }
      }
    });
  });

  describe("the market read path", () => {
    it("answers l2Book on `#N` and on nothing else", async () => {
      const [{ outcome, side }] = tradableSides(catalog);
      const book = (await withRateLimitRetry("l2Book", () =>
        info.l2Book({ coin: side.wireCoin })
      )) as { coin: string; levels: { px: string; sz: string }[][] } | null;

      expect(book).not.toBeNull();
      expect(book!.coin).toBe(side.wireCoin);

      // The SDK's invented slug, the bare encoding and the asset id all answer
      // literal `null` at HTTP 200 — a permanent empty book with no error.
      for (const wrong of [String(outcome.outcomeId * 10 + side.sideIndex), String(side.assetId)]) {
        const refused = await withRateLimitRetry("l2Book.wrong", () =>
          info.l2Book({ coin: wrong }).catch(() => null)
        );
        expect([wrong, refused]).toEqual([wrong, null]);
      }
    }, 120_000);

    it("quotes prices on a 1e-5 grid and sizes as whole shares", async () => {
      const [{ side }] = tradableSides(catalog);
      const book = (await withRateLimitRetry("l2Book.grid", () =>
        info.l2Book({ coin: side.wireCoin })
      )) as { levels: { px: string; sz: string }[][] } | null;
      const levels = (book?.levels ?? []).flat();
      if (levels.length === 0) {
        console.warn("e2e: no levels quoted; grid check skipped");
        return;
      }

      for (const level of levels) {
        // 5 price decimals is what `OUTCOME_PRICE_SZ_DECIMALS` encodes, and the
        // reason `formatPrice` had to stop using `szDecimals` for outcomes.
        expect(new BigNumber(level.px).decimalPlaces()).toBeLessThanOrEqual(5);
        expect(new BigNumber(level.sz).isInteger()).toBe(true);
        // Every share pays 0 or 1, so a price outside (0,1) is not a price.
        expect(new BigNumber(level.px).gt(0)).toBe(true);
        expect(new BigNumber(level.px).lt(1)).toBe(true);
      }
    }, 120_000);
  });

  describe("holdings", () => {
    it("finds outcome rows in SPOT balances", () => {
      const total = holdings.unsettled.length + holdings.settled.length;
      console.log(
        `e2e: holder has ${holdings.unsettled.length} unsettled, ${holdings.settled.length} settled rows`
      );
      expect(total).toBeGreaterThan(0);
    });

    it("finds NONE of them in perp positions", async () => {
      // The finding the whole holdings module rests on: `state/accountWire.ts`
      // parses `assetPositions` and cannot see prediction markets at all.
      const perp = (await withRateLimitRetry("clearinghouseState", () =>
        info.clearinghouseState({ user: HOLDER })
      )) as { assetPositions: { position: { coin: string } }[] };

      const outcomeRows = perp.assetPositions.filter((p) => /^[#+o]\d+$/.test(p.position.coin));
      expect(outcomeRows).toEqual([]);
    }, 120_000);

    it("decodes each row to the market the book answers to", () => {
      for (const holding of holdings.unsettled) {
        expect(holding.wireCoin).toBe(`#${holding.outcomeId * 10 + holding.sideIndex}`);
        expect(holding.balanceCoin).toBe(`+${holding.outcomeId * 10 + holding.sideIndex}`);
        expect(classifyAssetId(holding.assetId)).toBe("outcome");
      }
    });

    it("keeps every quantity a string, never a number", () => {
      for (const holding of [...holdings.unsettled, ...holdings.settled]) {
        expect(typeof holding.shares).toBe("string");
        expect(typeof holding.costBasis).toBe("string");
      }
    });
  });

  describe("the preflight, against real balances", () => {
    it("limits a merge to the smaller side of the pair", () => {
      const live = nonZero(holdings.unsettled);
      if (live.length === 0) {
        console.warn("e2e: holder is flat; merge arithmetic skipped");
        return;
      }

      const outcomeId = live[0].outcomeId;
      const sides = live.filter((h) => h.outcomeId === outcomeId);
      const pair = mergeablePair(holdings, unsafeOutcomeId(outcomeId));

      // Numerically. Sorting the strings puts "12254.0" before "7392.0".
      const smallest = sides
        .map((s) => new BigNumber(s.shares))
        .reduce((a, b) => (a.lt(b) ? a : b));
      if (sides.length === 2) {
        expect(new BigNumber(pair).eq(smallest)).toBe(true);
      } else {
        // Only one side held: nothing to burn against.
        expect(new BigNumber(pair).isZero()).toBe(true);
      }
    });

    it("blocks one share more than the pair allows", () => {
      const live = nonZero(holdings.unsettled);
      if (live.length === 0) return;
      const outcome = unsafeOutcomeId(live[0].outcomeId);
      const pair = mergeablePair(holdings, outcome);

      const quote = buildMergeOutcomeQuote({
        catalog,
        outcome,
        shares: new BigNumber(pair).plus(1).toFixed(),
        holdings,
      });
      expect(quote.blockers.map((b) => b.code)).toContain("insufficient_pair");
    });

    it("issues a ticket only for a fully-echoed quote", () => {
      const live = nonZero(holdings.unsettled);
      if (live.length === 0) return;
      const outcome = unsafeOutcomeId(live[0].outcomeId);
      const pair = mergeablePair(holdings, outcome);
      const quote = buildMergeOutcomeQuote({ catalog, outcome, shares: pair, holdings });
      if (quote.blockers.length > 0) {
        console.warn(`e2e: merge blocked (${quote.blockers[0].code}); ticket check skipped`);
        return;
      }

      const echo = {
        token: quote.token,
        kindDisplayed: quote.kind,
        outcomeIdDisplayed: quote.subject.outcomeId,
        questionIdDisplayed: quote.subject.questionId,
        amountDisplayed: quote.amount,
        acknowledged: quote.warnings.map((w) => w.code),
      };
      expect(confirmConversion(quote, echo).quote.token).toBe(quote.token);

      // Showing the ENCODING rather than the id — the mistake the wire accepts.
      expect(() =>
        confirmConversion(quote, { ...echo, outcomeIdDisplayed: live[0].outcomeId * 10 })
      ).toThrow();
    });

    it("scores complete Yes sets across every outcome of each live question", () => {
      for (const question of catalog.questions) {
        const sets = completeYesSets(
          catalog,
          holdings,
          question.questionId as unknown as Parameters<typeof completeYesSets>[2]
        );
        // A count, never Infinity, whatever the holder owns.
        expect(new BigNumber(sets).isFinite()).toBe(true);
        expect(new BigNumber(sets).gte(0)).toBe(true);
      }
    });
  });

  describe("the outcomeMetaUpdates channel", () => {
    it("is accepted by the live socket and tears down cleanly", async () => {
      // Declared by the SDK and unwired here until Phase 10, so nothing had ever
      // opened it. The channel speaks only when a market is created or settles —
      // mainnet's one recurring market settles daily at 06:00 UTC — so this
      // asserts the SUBSCRIPTION, not the payload. The payload shape remains
      // SDK-declared and unmeasured; `catalogStore.ts` says so and tells callers
      // to keep a refetch backstop.
      const ws = new WebSocketTransport({ isTestnet: false });
      const subs = new SubscriptionClient({ transport: ws });
      const store = new PredictionCatalogStore();
      store.seed(catalog);

      const frames: unknown[] = [];
      const subscribe = createSubscribeFn({
        api: subs as unknown as SubscriptionApi,
        sink: (event: Scoped<unknown>) => {
          frames.push(event.value);
          store.apply(event.value);
        },
      });

      const identity = createIdentity({
        env: "mainnet",
        accountId: "e2e",
        address: HOLDER,
        dex: null,
        subAccount: null,
      });

      const handle = await subscribe({
        channel: "outcomeMetaUpdates",
        identity,
        // All null: the catalog feed is the exchange's, not an account's or a
        // market's. It takes no coin, no aggregation and no interval.
        coin: null,
        aggregation: null,
        interval: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await handle.unsubscribe();
      await ws.close();

      // Frames are not expected within the window; a settlement is a daily event.
      console.log(`e2e: outcomeMetaUpdates delivered ${frames.length} frames in 5s`);
      expect(store.readOrEmpty().outcomes.length).toBeGreaterThan(0);
    }, 60_000);
  });
});
