import { HlError } from "@/hyperliquid/core/errors";
import {
  isWholeShares,
  mergeAllOfOutcome,
  mergeAllOfQuestion,
  mergeOutcome,
  mergeQuestion,
  negateOutcome,
  outcomeIdOf,
  questionIdOf,
  quoteTokens,
  shares,
  splitOutcome,
  unsafeOutcomeId,
  unsafeQuestionId,
  type OutcomeConvertClient,
} from "@/hyperliquid/predictions/convert";
import { parseOutcomeHoldings } from "@/hyperliquid/predictions/holdings";
import { parseCatalog } from "@/hyperliquid/predictions/catalog";

import mainnet from "@/hyperliquid/predictions/__fixtures__/outcome-meta-mainnet.json";

interface Sent {
  action: unknown;
  opts: { expiresAfter?: number } | undefined;
}

function recorder(behaviour: "ok" | Error = "ok"): {
  client: OutcomeConvertClient;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  return {
    sent,
    client: {
      userOutcome: async (action, opts) => {
        sent.push({ action, opts });
        if (behaviour !== "ok") throw behaviour;
        return { status: "ok", response: { type: "default" } };
      },
    },
  };
}

const AGENT = { signer: "agent" } as const;
const NOW = () => 1_700_000_000_000;

describe("the identifier", () => {
  it("comes from a parsed object, never from arithmetic at the call site", () => {
    const { unsettled } = parseOutcomeHoldings([
      { coin: "+10170", total: "6923.0", hold: "0.0", entryNtl: "3535.56" },
    ]);
    // The holding knows all three numbers. Only one of them is the identifier
    // these actions take.
    expect(unsettled[0].assetId).toBe(100_010_170);
    expect(unsettled[0].balanceCoin).toBe("+10170");
    expect(outcomeIdOf(unsettled[0])).toBe(1017);
  });

  it("reads a catalog outcome and a catalog question", () => {
    const catalog = parseCatalog(mainnet);
    expect(outcomeIdOf(catalog.outcomes[0])).toBe(catalog.outcomes[0].outcomeId);
    expect(questionIdOf(catalog.questions[0])).toBe(catalog.questions[0].questionId);
  });

  it("refuses a non-integer or negative id", () => {
    expect(() => unsafeOutcomeId(1017.5)).toThrow(HlError);
    expect(() => unsafeOutcomeId(-1)).toThrow(HlError);
    expect(() => unsafeQuestionId(Number.NaN)).toThrow(HlError);
    // 0 is a legitimate outcome id — the SDK's own example uses it.
    expect(unsafeOutcomeId(0)).toBe(0);
  });

  it("cannot tell an encoding from an id, which is why it says so", () => {
    // `10170` is outcome 1017 side 0 as an encoding AND a perfectly valid
    // outcome id. No check distinguishes them; the name is the warning.
    expect(unsafeOutcomeId(10_170)).toBe(10_170);
  });
});

describe("the amount", () => {
  it("names the unit in its error, not 'transfer amount'", () => {
    expect(() => quoteTokens("0")).toThrow(/quote token amount is zero/);
    expect(() => shares("0")).toThrow(/share amount is zero/);
  });

  it("rejects everything a float could produce", () => {
    expect(() => shares("1e21")).toThrow(HlError);
    expect(() => shares("-1")).toThrow(HlError);
    expect(() => shares("0.30000000000000004")).toThrow(HlError);
    expect(() => quoteTokens("0.1234567")).toThrow(HlError);
  });

  it("trims surrounding whitespace rather than refusing it", () => {
    // A pasted amount carries spaces. The producer trims before validating, so
    // this is accepted — worth pinning, because the alternative reading is that
    // the regex rejects it.
    expect(shares(" 1.5 ")).toBe("1.5");
  });

  it("normalises to the string that will actually be signed", () => {
    expect(quoteTokens("25.00")).toBe("25");
    expect(shares("0100.500")).toBe("100.5");
  });

  it("reports whole shares without gating on them", () => {
    // Every observed quantity is an integer, but nothing says a fraction is
    // refused and this client has not tried one — so it is a warning, not a
    // rejection.
    expect(isWholeShares(shares("6923.0"))).toBe(true);
    expect(isWholeShares(shares("6923"))).toBe(true);
    expect(isWholeShares(shares("0.5"))).toBe(false);
    expect(shares("0.5")).toBe("0.5");
  });
});

describe("the wire shape of each action", () => {
  const outcome = unsafeOutcomeId(1017);
  const question = unsafeQuestionId(87);

  it("splits quote tokens", async () => {
    const { client, sent } = recorder();
    await splitOutcome({ ...AGENT, client, now: NOW, outcome, quoteTokens: quoteTokens("100") });
    expect(sent[0].action).toEqual({ splitOutcome: { outcome: 1017, amount: "100" } });
  });

  it("merges a stated number of shares", async () => {
    const { client, sent } = recorder();
    await mergeOutcome({ ...AGENT, client, now: NOW, outcome, shares: shares("50") });
    expect(sent[0].action).toEqual({ mergeOutcome: { outcome: 1017, amount: "50" } });
  });

  it("sends null ONLY from the explicitly-named maximum", async () => {
    // The whole reason the maximum is its own function: `null` means "all of it",
    // and an accidental one liquidates the position.
    const { client, sent } = recorder();
    await mergeAllOfOutcome({ ...AGENT, client, now: NOW, outcome });
    await mergeAllOfQuestion({ ...AGENT, client, now: NOW, question });
    expect(sent[0].action).toEqual({ mergeOutcome: { outcome: 1017, amount: null } });
    expect(sent[1].action).toEqual({ mergeQuestion: { question: 87, amount: null } });
  });

  it("merges a question by question id", async () => {
    const { client, sent } = recorder();
    await mergeQuestion({ ...AGENT, client, now: NOW, question, shares: shares("5") });
    expect(sent[0].action).toEqual({ mergeQuestion: { question: 87, amount: "5" } });
  });

  it("negates with BOTH ids — the question and the outcome inside it", async () => {
    // Sending only the outcome would be a different action entirely; the wire
    // requires the question because the Yes shares land on its other outcomes.
    const { client, sent } = recorder();
    await negateOutcome({
      ...AGENT,
      client,
      now: NOW,
      question,
      outcome,
      noShares: shares("12"),
    });
    expect(sent[0].action).toEqual({
      negateOutcome: { question: 87, outcome: 1017, amount: "12" },
    });
  });

  it("stamps expiresAfter on every action", async () => {
    // These do not rest, so this is not about a resting order — it is about a
    // request that stalls and lands against balances the user has since changed.
    const { client, sent } = recorder();
    const outcomeId = outcome;
    await splitOutcome({
      ...AGENT,
      client,
      now: NOW,
      outcome: outcomeId,
      quoteTokens: quoteTokens("1"),
    });
    await mergeAllOfOutcome({ ...AGENT, client, now: NOW, outcome: outcomeId });
    await negateOutcome({
      ...AGENT,
      client,
      now: NOW,
      question,
      outcome: outcomeId,
      noShares: shares("1"),
    });
    for (const call of sent) {
      expect(call.opts?.expiresAfter).toBe(NOW() + 30_000);
    }
  });

  it("passes no vaultAddress, because the action has no such field", async () => {
    // Every action in `orders/exchange.ts` can be routed to a sub-account. This
    // one offers no way to, and an agent signature resolves to the master — so a
    // client that thinks it is converting a sub-account's shares converts the
    // master's. Note this only holds because no `defaultVaultAddress` is set on
    // the client; `executeL1Action` would forward one into the signature with no
    // typed seam at all. `accountGuards.test.ts` pins that.
    const { client, sent } = recorder();
    await splitOutcome({ ...AGENT, client, now: NOW, outcome, quoteTokens: quoteTokens("1") });
    expect(Object.keys(sent[0].opts ?? {})).toEqual(["expiresAfter"]);
  });
});

describe("outcomes of a failed conversion", () => {
  const outcome = unsafeOutcomeId(1017);

  it("reports a server refusal as a fact — nothing converted", async () => {
    const refusal = Object.assign(new Error("Insufficient balance"), {
      name: "ApiRequestError",
      response: { status: "err", response: "Insufficient balance" },
    });
    const { client } = recorder(refusal);
    const result = await mergeOutcome({
      ...AGENT,
      client,
      now: NOW,
      outcome,
      shares: shares("50"),
    });
    expect(result.kind).toBe("rejected_by_server");
  });

  it("separates a schema rejection from an unknown outcome", async () => {
    // The SDK validates before signing, so a rejection there means the action
    // never left the device. Collapsing it into `unknown` would send a caller
    // re-reading balances for something that was never sent, and would present a
    // fixable input error as unresolvable.
    const rejection = Object.assign(new Error("Invalid type"), { name: "ValidationError" });
    const { client } = recorder(rejection);
    const result = await mergeOutcome({
      ...AGENT,
      client,
      now: NOW,
      outcome,
      shares: shares("50"),
    });
    expect(result.kind).toBe("rejected_locally");
  });

  it("reports a transport failure as UNKNOWN, with a window to watch", async () => {
    // There is no id in the response even on success, so nothing can be polled.
    // A retry is a second conversion, not a retry.
    const { client } = recorder(new Error("network down"));
    const result = await mergeOutcome({
      ...AGENT,
      client,
      now: NOW,
      outcome,
      shares: shares("50"),
    });
    expect(result).toMatchObject({
      kind: "unknown",
      nonce: NOW(),
      window: { fromMs: NOW(), toMs: NOW() + 30_000 },
    });
  });

  it("never exposes a retry helper", () => {
    // Same rule as the withdrawal path: a blind retry does not re-attempt the
    // conversion, it performs a second one.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require("@/hyperliquid/predictions/convert");
    expect(Object.keys(module).filter((name) => /retry|resend/i.test(name))).toEqual([]);
  });
});
