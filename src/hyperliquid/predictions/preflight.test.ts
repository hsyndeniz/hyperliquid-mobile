import { HlError } from "@/hyperliquid/core/errors";
import { parseCatalog } from "@/hyperliquid/predictions/catalog";
import { unsafeOutcomeId, unsafeQuestionId } from "@/hyperliquid/predictions/convert";
import { parseOutcomeHoldings, type OutcomeHoldings } from "@/hyperliquid/predictions/holdings";
import {
  buildMergeOutcomeQuote,
  buildMergeQuestionQuote,
  buildNegateQuote,
  buildSplitQuote,
  completeYesSets,
  confirmConversion,
  isConfirmable,
  mergeablePair,
  outcomeIdsOfQuestion,
  questionForOutcome,
  type ConvertEcho,
  type ConvertQuote,
} from "@/hyperliquid/predictions/preflight";

import mainnet from "@/hyperliquid/predictions/__fixtures__/outcome-meta-mainnet.json";

const catalog = parseCatalog(mainnet);
const NOW = 1_700_000_000_000;
const now = () => NOW;

/** The recorded mainnet question: fallback 1021, named 1022-1024. */
const QUESTION = unsafeQuestionId(167);

/**
 * `hold` defaults to zero, but is now expressible — every row here hardcoded
 * "0.0", which is why the locked-share path shipped untested. The recorded
 * mainnet fixture has `{"coin":"+10171","total":"8548.0","hold":"93.0"}`.
 */
function holdings(rows: { coin: string; total: string; hold?: string }[]): OutcomeHoldings {
  return parseOutcomeHoldings(rows.map((r) => ({ ...r, hold: r.hold ?? "0.0", entryNtl: "0.0" })));
}

function confirm(quote: ConvertQuote, overrides: Partial<ConvertEcho> = {}) {
  return confirmConversion(
    quote,
    {
      token: quote.token,
      kindDisplayed: quote.kind,
      outcomeIdDisplayed: quote.subject.outcomeId,
      questionIdDisplayed: quote.subject.questionId,
      amountDisplayed: quote.amount,
      acknowledged: quote.warnings.map((w) => w.code),
      ...overrides,
    },
    NOW
  );
}

describe("the catalog joins", () => {
  it("includes the UNNAMED fallback in a question's outcome set", () => {
    // 1021 is `fallbackOutcome` — tradeable, no slug, skipped by the SDK's symbol
    // converter. A set built by enumerating named markets is short by one and
    // merges nothing.
    expect(outcomeIdsOfQuestion(catalog, 167)).toEqual([1021, 1022, 1023, 1024]);
  });

  it("answers null for an outcome in no listed question, which is COMMON", () => {
    // 4 of the 8 recorded mainnet outcomes are in no question, including 1017 —
    // the one the recorded live holder owns. Outcome rows carry no `question`
    // field, so there is no other direction to try.
    expect(questionForOutcome(catalog, 1022)).toBe(167);
    for (const orphan of [1017, 1018, 1019, 1020]) {
      expect([orphan, questionForOutcome(catalog, orphan)]).toEqual([orphan, null]);
    }
  });

  it("returns an empty set for an unknown question rather than throwing", () => {
    expect(outcomeIdsOfQuestion(catalog, 999)).toEqual([]);
  });
});

describe("what can actually be converted", () => {
  it("a merge is limited by the SMALLER side, not by either balance", () => {
    // The recorded holder's real shape: thousands of one side, none of the other.
    const held = holdings([
      { coin: "+10170", total: "6923.0" },
      { coin: "+10171", total: "0.0" },
    ]);
    expect(mergeablePair(held, unsafeOutcomeId(1017))).toBe("0");

    const paired = holdings([
      { coin: "+10170", total: "6923.0" },
      { coin: "+10171", total: "8545.0" },
    ]);
    expect(mergeablePair(paired, unsafeOutcomeId(1017))).toBe("6923");
  });

  it("does not offer shares that are locked in resting orders", () => {
    // `shares` is the wire's `total`; `held` is the portion backing resting
    // orders and therefore not convertible. Counting the total offers a merge
    // the exchange will refuse — and refuse opaquely, since the convert
    // response is a bare `{status:"ok"}` with no echo of what went wrong.
    const partlyResting = holdings([
      { coin: "+10170", total: "100.0" },
      { coin: "+10171", total: "100.0", hold: "60.0" },
    ]);
    // 100 Yes against 40 free No, not 100.
    expect(mergeablePair(partlyResting, unsafeOutcomeId(1017))).toBe("40");
  });

  it("reports nothing mergeable when every share is spoken for", () => {
    const allResting = holdings([
      { coin: "+10170", total: "50.0", hold: "50.0" },
      { coin: "+10171", total: "50.0" },
    ]);
    expect(mergeablePair(allResting, unsafeOutcomeId(1017))).toBe("0");
  });

  it("a complete Yes set is the minimum across EVERY outcome of the question", () => {
    const full = holdings([
      { coin: "+10210", total: "10.0" },
      { coin: "+10220", total: "12.0" },
      { coin: "+10230", total: "11.0" },
      { coin: "+10240", total: "40.0" },
    ]);
    expect(completeYesSets(catalog, full, QUESTION)).toBe("10");

    // Drop the unnamed fallback (1021) and the set collapses — the exact failure
    // a name-based enumeration produces.
    const missingFallback = holdings([
      { coin: "+10220", total: "12.0" },
      { coin: "+10230", total: "11.0" },
      { coin: "+10240", total: "40.0" },
    ]);
    expect(completeYesSets(catalog, missingFallback, QUESTION)).toBe("0");
  });

  it("counts a complete set from FREE shares, not total ones", () => {
    // One outcome with shares tied up caps the whole set, exactly as one
    // outcome with a low balance does.
    const oneLocked = holdings([
      { coin: "+10210", total: "10.0" },
      { coin: "+10220", total: "12.0", hold: "9.0" },
      { coin: "+10230", total: "11.0" },
      { coin: "+10240", total: "40.0" },
    ]);
    expect(completeYesSets(catalog, oneLocked, QUESTION)).toBe("3");
  });

  it("reports zero sets for a question the catalog does not know", () => {
    // An empty minimum is not "unlimited". Returning Infinity here would offer a
    // merge on a question nothing is known about.
    expect(completeYesSets(catalog, holdings([]), unsafeQuestionId(999))).toBe("0");
  });

  it("counts side 0 as Yes by INDEX, never by name", () => {
    // Measured: `sideSpecs[0].name` is "Yes" on mainnet and "template:Yes" on
    // testnet. Keying on the string would silently score testnet as zero.
    for (const outcome of catalog.outcomes) {
      expect([outcome.outcomeId, outcome.sides[0].sideIndex]).toEqual([outcome.outcomeId, 0]);
    }
  });
});

describe("split", () => {
  it("blocks on a balance it can see, and says so when it cannot", () => {
    const short = buildSplitQuote({
      catalog,
      outcome: unsafeOutcomeId(1022),
      quoteTokens: "100",
      availableQuoteTokens: "40",
      now,
    });
    expect(short.blockers.map((b) => b.code)).toContain("insufficient_quote_tokens");

    const unchecked = buildSplitQuote({
      catalog,
      outcome: unsafeOutcomeId(1022),
      quoteTokens: "100",
      now,
    });
    expect(unchecked.blockers).toEqual([]);
    expect(unchecked.warnings.map((w) => w.code)).toContain("holdings_not_checked");
  });

  it("says out loud that it takes no view", () => {
    const quote = buildSplitQuote({
      catalog,
      outcome: unsafeOutcomeId(1022),
      quoteTokens: "100",
      availableQuoteTokens: "1000",
      now,
    });
    expect(quote.warnings.map((w) => w.code)).toContain("split_buys_both_sides");
    expect(quote.subject.name).toBe(catalog.outcomes.find((o) => o.outcomeId === 1022)!.name);
  });

  it("blocks a market that is not in the catalog", () => {
    // The catalog lists only UNSETTLED outcomes, so absence usually means it
    // already resolved — and converting a resolved market is meaningless.
    const quote = buildSplitQuote({
      catalog,
      outcome: unsafeOutcomeId(482),
      quoteTokens: "1",
      availableQuoteTokens: "1000",
      now,
    });
    expect(quote.blockers.map((b) => b.code)).toEqual(["outcome_not_listed"]);
  });
});

describe("merge outcome", () => {
  const outcome = unsafeOutcomeId(1022);

  it("blocks a one-sided holding with the reason, not just the number", () => {
    const quote = buildMergeOutcomeQuote({
      catalog,
      outcome,
      shares: "50",
      holdings: holdings([
        { coin: "+10220", total: "6923.0" },
        { coin: "+10221", total: "0.0" },
      ]),
      now,
    });
    expect(quote.blockers.map((b) => b.code)).toContain("insufficient_pair");
    expect(quote.blockers[0].detail).toContain("one of each side");
    expect(quote.available).toBe("0");
  });

  it("allows a merge covered by both sides", () => {
    const quote = buildMergeOutcomeQuote({
      catalog,
      outcome,
      shares: "50",
      holdings: holdings([
        { coin: "+10220", total: "60.0" },
        { coin: "+10221", total: "55.0" },
      ]),
      now,
    });
    expect(quote.blockers).toEqual([]);
    expect(quote.available).toBe("55");
  });

  it("warns that a maximum has no figure to show", () => {
    const quote = buildMergeOutcomeQuote({
      catalog,
      outcome,
      shares: null,
      holdings: holdings([
        { coin: "+10220", total: "60.0" },
        { coin: "+10221", total: "55.0" },
      ]),
      now,
    });
    expect(quote.amount).toBeNull();
    expect(quote.warnings.map((w) => w.code)).toContain("amount_decided_by_exchange");
    // The exchange decides, but the account's own figure is still worth showing.
    expect(quote.available).toBe("55");
  });

  it("warns that merging is charged and splitting is not", () => {
    const quote = buildMergeOutcomeQuote({ catalog, outcome, shares: "1", now });
    expect(quote.warnings.map((w) => w.code)).toContain("burn_is_charged");
  });
});

describe("merge question", () => {
  it("names the unnamed outcome as part of the set", () => {
    const quote = buildMergeQuestionQuote({ catalog, question: QUESTION, shares: "5", now });
    expect(quote.warnings.map((w) => w.code)).toContain("question_includes_unnamed_outcome");
  });

  it("counts how many outcomes are short when nothing can be merged", () => {
    const quote = buildMergeQuestionQuote({
      catalog,
      question: QUESTION,
      shares: "5",
      holdings: holdings([
        { coin: "+10220", total: "12.0" },
        { coin: "+10230", total: "11.0" },
      ]),
      now,
    });
    expect(quote.blockers.map((b) => b.code)).toEqual(["incomplete_yes_set"]);
    // 1021 and 1024 are missing entirely — 2 of the 4.
    expect(quote.blockers[0].detail).toContain("all 4 outcomes");
    expect(quote.blockers[0].detail).toContain("2 are short");
  });

  it("blocks a question the catalog does not list", () => {
    const quote = buildMergeQuestionQuote({
      catalog,
      question: unsafeQuestionId(999),
      shares: "5",
      now,
    });
    expect(quote.blockers.map((b) => b.code)).toContain("question_not_listed");
  });
});

describe("negate", () => {
  it("blocks when no listed question contains the outcome", () => {
    // Not a lookup failure — 1017 genuinely belongs to no listed question, and
    // `negateOutcome` needs a question id. Guessing one would negate into a
    // different market's outcomes.
    const quote = buildNegateQuote({ catalog, outcome: unsafeOutcomeId(1017), noShares: "5", now });
    expect(quote.blockers.map((b) => b.code)).toContain("question_unknown_for_outcome");
    expect(quote.subject.questionId).toBeNull();
  });

  it("accepts a question the caller supplies when the catalog has none", () => {
    const quote = buildNegateQuote({
      catalog,
      outcome: unsafeOutcomeId(1022),
      question: QUESTION,
      noShares: "5",
      holdings: holdings([{ coin: "+10221", total: "10.0" }]),
      now,
    });
    expect(quote.blockers).toEqual([]);
    expect(quote.available).toBe("10");
  });

  it("blocks when there is no OTHER outcome to negate into", () => {
    // Nothing on the wire prevents this call; the shares would be consumed for
    // nothing.
    const lonely = parseCatalog({
      outcomes: [{ outcome: 5, sideSpecs: [{ name: "Yes" }, { name: "No" }] }],
      questions: [{ question: 9, name: "solo", namedOutcomes: [5] }],
    });
    const quote = buildNegateQuote({
      catalog: lonely,
      outcome: unsafeOutcomeId(5),
      question: unsafeQuestionId(9),
      noShares: "5",
      now,
    });
    expect(quote.blockers.map((b) => b.code)).toContain("nothing_to_negate_into");
  });

  it("reads the NO side, not the Yes side", () => {
    // Negating consumes side 1. Reading side 0 would report a healthy balance for
    // an account that holds no No shares at all.
    const quote = buildNegateQuote({
      catalog,
      outcome: unsafeOutcomeId(1022),
      question: QUESTION,
      noShares: "5",
      holdings: holdings([{ coin: "+10220", total: "999.0" }]),
      now,
    });
    expect(quote.available).toBe("0");
    expect(quote.blockers.map((b) => b.code)).toContain("insufficient_no_shares");
  });
});

describe("the ticket", () => {
  const good = () =>
    buildSplitQuote({
      catalog,
      outcome: unsafeOutcomeId(1022),
      quoteTokens: "100",
      availableQuoteTokens: "1000",
      now,
    });

  it("is issued when the echo matches and every warning was acknowledged", () => {
    const quote = good();
    expect(isConfirmable(quote, NOW)).toBe(true);
    expect(confirm(quote).confirmedAt).toBe(NOW);
  });

  it("refuses a mislabelled direction", () => {
    // Split and merge are exact opposites; a UI that rendered the wrong verb must
    // not be able to sign.
    expect(() => confirm(good(), { kindDisplayed: "merge_outcome" })).toThrow(HlError);
  });

  it("refuses a market the caller did not display", () => {
    expect(() => confirm(good(), { outcomeIdDisplayed: 1023 })).toThrow(HlError);
    // The encoding and the asset id are the two confusable neighbours.
    expect(() => confirm(good(), { outcomeIdDisplayed: 10_220 })).toThrow(HlError);
    expect(() => confirm(good(), { outcomeIdDisplayed: 100_010_220 })).toThrow(HlError);
  });

  it("refuses an unacknowledged warning", () => {
    expect(() => confirm(good(), { acknowledged: [] })).toThrow(/unacknowledged/);
  });

  it("refuses a stale quote", () => {
    const quote = good();
    expect(isConfirmable(quote, quote.expiresAt + 1)).toBe(false);
    expect(() => confirmConversion(quote, { ...bareEcho(quote) }, quote.expiresAt + 1)).toThrow(
      /expired/
    );
  });

  it("refuses a blocked quote before checking anything else", () => {
    const blocked = buildSplitQuote({
      catalog,
      outcome: unsafeOutcomeId(1022),
      quoteTokens: "100",
      availableQuoteTokens: "1",
      now,
    });
    expect(() => confirm(blocked)).toThrow(HlError);
  });

  it("changes token when any quoted fact changes", () => {
    const a = good();
    const b = buildSplitQuote({
      catalog,
      outcome: unsafeOutcomeId(1022),
      quoteTokens: "101",
      availableQuoteTokens: "1000",
      now,
    });
    expect(a.token).not.toBe(b.token);
    expect(() => confirm(a, { token: b.token })).toThrow(HlError);
  });
});

function bareEcho(quote: ConvertQuote): ConvertEcho {
  return {
    token: quote.token,
    kindDisplayed: quote.kind,
    outcomeIdDisplayed: quote.subject.outcomeId,
    questionIdDisplayed: quote.subject.questionId,
    amountDisplayed: quote.amount,
    acknowledged: quote.warnings.map((w) => w.code),
  };
}
