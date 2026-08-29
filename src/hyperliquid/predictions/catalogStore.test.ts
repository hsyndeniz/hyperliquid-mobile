import { parseCatalog } from "@/hyperliquid/predictions/catalog";
import {
  PredictionCatalogStore,
  questionsMentioning,
} from "@/hyperliquid/predictions/catalogStore";

import mainnet from "@/hyperliquid/predictions/__fixtures__/outcome-meta-mainnet.json";

const NOW = 1_700_000_000_000;

function seeded(): PredictionCatalogStore {
  const store = new PredictionCatalogStore();
  store.seed(parseCatalog(mainnet), NOW);
  return store;
}

describe("before it is seeded", () => {
  it("reports unknown rather than empty", () => {
    // "We have not looked" is not "there are no markets". A screen showing the
    // second when the first is true tells a holder their position does not exist.
    const store = new PredictionCatalogStore();
    expect(store.read()).toBeNull();
    expect(store.hasSeeded()).toBe(false);
    expect(store.readOrEmpty()).toEqual({ outcomes: [], questions: [], deployers: [] });
  });

  it("absorbs no deltas", () => {
    // Applying updates to nothing would build a catalog containing only what
    // changed since the socket opened, and present it as the whole market list.
    const store = new PredictionCatalogStore();
    const changed = store.apply(
      {
        updates: [
          { outcomeCreated: { outcome: 77, sideSpecs: [{ name: "Yes" }, { name: "No" }] } },
        ],
      },
      NOW
    );
    expect(changed).toBe(false);
    expect(store.read()).toBeNull();
  });
});

describe("absorbing the update feed", () => {
  it("adds a created outcome, fully decoded", () => {
    const store = seeded();
    const before = store.readOrEmpty().outcomes.length;
    expect(
      store.apply(
        {
          updates: [
            {
              outcomeCreated: {
                outcome: 77,
                name: "New",
                description: "d",
                quoteToken: "USDC",
                sideSpecs: [{ name: "Yes" }, { name: "No" }],
              },
            },
          ],
        },
        NOW
      )
    ).toBe(true);

    const added = store.readOrEmpty().outcomes.find((o) => o.outcomeId === 77)!;
    expect(store.readOrEmpty().outcomes).toHaveLength(before + 1);
    // Decoded through the same parser as the REST snapshot, so the wire coin the
    // book needs is present immediately.
    expect(added.sides.map((s) => s.wireCoin)).toEqual(["#770", "#771"]);
  });

  it("REMOVES a settled outcome, matching what a refetch would return", () => {
    // `outcomeMeta` lists only unsettled outcomes. Keeping a settled row would
    // make the live store disagree with its own refresh.
    const store = seeded();
    expect(store.readOrEmpty().outcomes.some((o) => o.outcomeId === 1022)).toBe(true);
    store.apply({ updates: [{ outcomeSettled: { outcome: 1022 } }] }, NOW);
    expect(store.readOrEmpty().outcomes.some((o) => o.outcomeId === 1022)).toBe(false);
  });

  it("reports the settlement, because a holder must not miss it", () => {
    // The moment shares stop being tradeable and become a claim.
    const store = seeded();
    store.apply({ updates: [{ outcomeSettled: { outcome: 1022 } }] }, NOW);
    expect(store.recentSettlements()).toEqual([{ kind: "outcome", id: 1022, at: NOW }]);
    store.acknowledgeSettlements();
    expect(store.recentSettlements()).toEqual([]);
  });

  it("reports a settlement for a market it never listed", () => {
    // A holder can own an outcome this snapshot never carried — 4 of 8 recorded
    // mainnet outcomes are in no question, and settled ones are dropped entirely.
    const store = seeded();
    store.apply({ updates: [{ outcomeSettled: { outcome: 999_999 } }] }, NOW);
    expect(store.recentSettlements()).toHaveLength(1);
  });

  it("replaces a question's outcome set rather than merging it", () => {
    const store = seeded();
    store.apply(
      {
        updates: [
          {
            questionUpdated: {
              question: 167,
              name: "Recurring",
              description: "d",
              fallbackOutcome: 2001,
              namedOutcomes: [2002, 2003],
              settledNamedOutcomes: [],
            },
          },
        ],
      },
      NOW
    );
    const question = store.readOrEmpty().questions.find((q) => q.questionId === 167)!;
    expect(store.readOrEmpty().questions).toHaveLength(1);
    expect(question.namedOutcomeIds).toEqual([2002, 2003]);
    expect(question.fallbackOutcomeId).toBe(2001);
  });

  it("removes a settled question", () => {
    const store = seeded();
    store.apply({ updates: [{ questionSettled: { question: 167 } }] }, NOW);
    expect(store.readOrEmpty().questions).toEqual([]);
    expect(store.recentSettlements()).toEqual([{ kind: "question", id: 167, at: NOW }]);
  });

  it("reads an id spelled as a string as well as a number", () => {
    const store = seeded();
    store.apply({ updates: [{ outcomeSettled: { outcome: "1022" } }] }, NOW);
    expect(store.readOrEmpty().outcomes.some((o) => o.outcomeId === 1022)).toBe(false);
  });

  it("survives a malformed frame without discarding the catalog", () => {
    const store = seeded();
    const before = store.readOrEmpty().outcomes.length;
    for (const junk of [null, 42, {}, { updates: null }, { updates: [null, 7, {}] }]) {
      expect(store.apply(junk, NOW)).toBe(false);
    }
    expect(store.readOrEmpty().outcomes).toHaveLength(before);
  });

  it("notifies subscribers only when something actually changed", () => {
    const store = seeded();
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.apply({ updates: [{ outcomeSettled: { outcome: 1022 } }] }, NOW);
    expect(notified).toBe(1);
    // Same outcome again: already gone, nothing changes, no re-render.
    store.apply({ updates: [{ outcomeSettled: { outcome: 1022 } }] }, NOW);
    expect(notified).toBe(1);
  });
});

describe("finding what a settlement touched", () => {
  it("matches an outcome in any of a question's three lists", () => {
    const catalog = parseCatalog(mainnet);
    // 1021 is the unnamed fallback; 1022 is named.
    expect(questionsMentioning(catalog, 1021).map((q) => q.questionId)).toEqual([167]);
    expect(questionsMentioning(catalog, 1022).map((q) => q.questionId)).toEqual([167]);
    expect(questionsMentioning(catalog, 1017)).toEqual([]);
  });
});
