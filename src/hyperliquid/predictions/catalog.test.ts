import {
  fetchCatalog,
  parseCatalog,
  parseOutcome,
  parseOutcomeAttributes,
  parseSettledOutcome,
  payoutForSide,
  sideByWireCoin,
  tradableSides,
  unlistedOutcomeIds,
} from "@/hyperliquid/predictions/catalog";
import { WeightBudget } from "@/hyperliquid/api/weightBudget";
import { HlError } from "@/hyperliquid/core/errors";

import mainnet from "@/hyperliquid/predictions/__fixtures__/outcome-meta-mainnet.json";
import testnetSlice from "@/hyperliquid/predictions/__fixtures__/outcome-meta-testnet-slice.json";
import settledFixture from "@/hyperliquid/predictions/__fixtures__/settled-outcome-mainnet.json";

const settled = settledFixture as Record<string, unknown>;

describe("the recorded mainnet catalog", () => {
  const catalog = parseCatalog(mainnet);

  it("parses every outcome and question", () => {
    expect(catalog.outcomes.length).toBeGreaterThan(0);
    expect(catalog.questions.length).toBeGreaterThan(0);
    for (const outcome of catalog.outcomes) {
      expect(outcome.outcomeId).toBeGreaterThan(0);
      expect(outcome.quoteToken).toBe("USDC");
    }
  });

  it("gives every outcome exactly two sides", () => {
    // MEASURED 309/309 across both networks. The encoding reserves ten slots, so
    // the parser accepts N — but two is what the exchange actually ships, and a
    // market that suddenly had one side would be a wire change worth noticing.
    for (const outcome of catalog.outcomes) {
      expect([outcome.name, outcome.sides.length]).toEqual([outcome.name, 2]);
    }
  });

  it("derives the wire coin and the balance coin, which are DIFFERENT strings", () => {
    // `#N` is what l2Book accepts; `+N` is how the same holding appears as a spot
    // balance. Using one where the other belongs fails silently at both ends.
    const [{ outcome, side }] = tradableSides(catalog);
    expect(side.wireCoin).toBe(`#${outcome.outcomeId * 10 + side.sideIndex}`);
    expect(side.balanceCoin).toBe(`+${outcome.outcomeId * 10 + side.sideIndex}`);
    expect(side.assetId).toBe(100_000_000 + outcome.outcomeId * 10 + side.sideIndex);
  });

  it("finds a side by the wire coin the feeds echo", () => {
    const [{ side }] = tradableSides(catalog);
    expect(sideByWireCoin(catalog, side.wireCoin)?.side.assetId).toBe(side.assetId);
    expect(sideByWireCoin(catalog, "#999999")).toBeNull();
  });

  it("reports the outcomes a question names but the catalog cannot", () => {
    // The fallback outcome is tradeable and has NO slug — `SymbolConverter` skips
    // it by design — and a settled outcome has been deleted from `outcomes`
    // outright. Both would otherwise render as a question missing a row.
    const unlisted = unlistedOutcomeIds(catalog);
    const fallbacks = catalog.questions.flatMap((q) =>
      q.fallbackOutcomeId === null ? [] : [q.fallbackOutcomeId]
    );
    expect(fallbacks.length).toBeGreaterThan(0);
    // Every referenced-but-absent id is reported, sorted and deduplicated.
    expect(unlisted).toEqual([...unlisted].sort((a, b) => a - b));
    expect(new Set(unlisted).size).toBe(unlisted.length);
  });
});

describe("the recorded testnet slice", () => {
  const catalog = parseCatalog(testnetSlice);

  it("reads `venue`, which the SDK does not declare", () => {
    // Present on 185 of 309 outcomes and absent from the SDK's type entirely.
    // Deployer attribution is only reachable through it.
    expect(catalog.outcomes.some((o) => o.venue !== null)).toBe(true);
  });

  it("reports an absent venue as null rather than empty string", () => {
    for (const outcome of catalog.outcomes) {
      expect(outcome.venue === null || outcome.venue.length > 0).toBe(true);
    }
  });
});

describe("description attributes", () => {
  it("parses the pipe-delimited recurring form", () => {
    expect(
      parseOutcomeAttributes(
        "class:priceBucket|underlying:BTC|expiry:20260807-0600|priceThresholds:63571,66166|period:1d"
      )
    ).toEqual({
      class: "priceBucket",
      underlying: "BTC",
      expiry: "20260807-0600",
      priceThresholds: "63571,66166",
      period: "1d",
    });
  });

  it("returns null for prose, NOT an empty object", () => {
    // "Not this format" and "this format, and it said nothing" are different
    // answers, and only one of them should render as a parameter table.
    expect(
      parseOutcomeAttributes("This outcome resolves to Yes if Argentina wins the Game.")
    ).toBeNull();
    expect(parseOutcomeAttributes("")).toBeNull();
  });

  it("does not mistake one stray colon in prose for structure", () => {
    expect(parseOutcomeAttributes("Note: this resolves at noon | see rules")).toBeNull();
  });
});

describe("malformed input", () => {
  it("drops an outcome with no usable id", () => {
    expect(parseOutcome({ name: "x" })).toBeNull();
    expect(parseOutcome(null)).toBeNull();
    expect(parseCatalog({ outcomes: [{ name: "x" }, null, 42] }).outcomes).toEqual([]);
  });

  it("coalesces a null response to an empty catalog", () => {
    expect(parseCatalog(null)).toEqual({ outcomes: [], questions: [], deployers: [] });
  });

  it("tolerates a bare array, since this shape has already moved three times", () => {
    const parsed = parseCatalog([{ outcome: 5, sideSpecs: [{ name: "Yes" }, { name: "No" }] }]);
    expect(parsed.outcomes).toHaveLength(1);
    expect(parsed.outcomes[0].sides).toHaveLength(2);
  });

  it("still rejects a scalar", () => {
    expect(() => parseCatalog(42)).toThrow(HlError);
  });

  it("refuses to encode an eleventh side, which would collide with the next outcome", () => {
    // Side index 10 would produce `outcomeId*10 + 10` — that is the NEXT
    // outcome's side 0, a silent cross-market mix-up rather than a visible error.
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `s${i}` }));
    const parsed = parseOutcome({ outcome: 5, sideSpecs: many })!;
    expect(parsed.sides).toHaveLength(10);
    expect(parsed.sides.at(-1)!.assetId).toBe(100_000_000 + 5 * 10 + 9);
  });
});

describe("settled outcomes — the second, disjoint source", () => {
  it("parses a real settled market", () => {
    // Outcome 482 returns full data here and is ABSENT from `outcomeMeta`.
    const parsed = parseSettledOutcome(settled["482"])!;
    expect(parsed.outcome.outcomeId).toBe(482);
    expect(parsed.outcome.name).toBe("Argentina");
    expect(parsed.settleFraction).toBe("1.0");
    expect(parsed.details).toContain("Argentina");
    expect(parsed.questionName).toContain("World Cup");
  });

  it("pays side 0 the fraction and every other side the remainder", () => {
    // Getting this backwards reports a total loss as a full win.
    const won = parseSettledOutcome(settled["482"])!;
    expect(payoutForSide(won, 0)).toBe("1");
    expect(payoutForSide(won, 1)).toBe("0");
  });

  it("computes the remainder with BigNumber, not floats", () => {
    const partial = parseSettledOutcome({
      spec: { outcome: 1, sideSpecs: [{ name: "Yes" }, { name: "No" }] },
      settleFraction: "0.7",
    })!;
    // 1 - 0.7 is 0.30000000000000004 as a double.
    expect(payoutForSide(partial, 1)).toBe("0.3");
  });

  it("returns null for a market that is not settled", () => {
    expect(parseSettledOutcome(null)).toBeNull();
    expect(parseSettledOutcome({ settleFraction: "1.0" })).toBeNull();
  });

  it("reads the question id out of its SETTLED nesting", () => {
    // A live row carries `question: 167`; a settled response nests it as
    // `question: {settled: 87}`. Both are the id, and only one shape appears at
    // a time.
    const parsed = parseCatalog({
      outcomes: [],
      questions: [{ question: { settled: 87 }, name: "World Cup" }],
    });
    expect(parsed.questions[0].questionId).toBe(87);
  });
});

describe("fetchCatalog", () => {
  it("distinguishes an empty catalog from a refused read", async () => {
    const empty = await fetchCatalog({
      probe: { outcomeMeta: async () => ({ outcomes: [], questions: [] }) },
    });
    expect(empty.value).toEqual({ outcomes: [], questions: [], deployers: [] });
    expect(empty.deferred).toBe(false);

    const refused = await fetchCatalog({
      probe: { outcomeMeta: async () => mainnet },
      budget: new WeightBudget(0),
    });
    expect(refused).toEqual({ value: null, deferred: true });
  });

  it("does not call the endpoint when the budget refuses", async () => {
    let called = false;
    await fetchCatalog({
      probe: {
        outcomeMeta: async () => {
          called = true;
          return mainnet;
        },
      },
      budget: new WeightBudget(0),
    });
    expect(called).toBe(false);
  });
});
