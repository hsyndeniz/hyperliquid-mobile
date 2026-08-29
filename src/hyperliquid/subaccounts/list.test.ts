import {
  assertOwnedSubAccount,
  canCreateSubAccount,
  fetchSubAccounts,
  isInternalCounterparty,
  isOwnedSubAccount,
  parseSubAccount,
  parseSubAccounts,
} from "@/hyperliquid/subaccounts/list";
import { WeightBudget } from "@/hyperliquid/api/weightBudget";
import { HlError } from "@/hyperliquid/core/errors";

import live from "@/hyperliquid/subaccounts/__fixtures__/subaccounts2-mainnet.json";

const MASTER = "0x1111111111111111111111111111111111111111";
const SUB = "0x2222222222222222222222222222222222222222";

describe("parsing a recorded mainnet response", () => {
  it("parses every entry", () => {
    const parsed = parseSubAccounts(live);
    expect(parsed).toHaveLength(live.length);
    expect(parsed[0].address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(parsed[0].master).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("survives an EMPTY dexToClearinghouseState", () => {
    // The recorded account has zero dex entries. The SDK's "always includes the
    // main DEX" comment is false, and `find(e => e[0] === "")[1]` throws here —
    // it did so on 72% of sampled sub-accounts.
    const parsed = parseSubAccounts(live);
    expect(parsed[0].perpEquityByDex.size).toBe(0);
    expect(parsed[0].perpEquityTotal).toBe("0");
  });
});

describe("the null response", () => {
  it("coalesces null to an empty list", () => {
    // The MAJORITY case — 9 of 10 sampled mainnet addresses, and every new
    // user's first session. `.length` or `.map` on it crashes at launch.
    expect(parseSubAccounts(null)).toEqual([]);
    expect(parseSubAccounts(undefined)).toEqual([]);
  });

  it("still rejects a shape that is neither array nor null", () => {
    expect(() => parseSubAccounts({ nope: true })).toThrow(HlError);
  });
});

describe("equity is summed across every dex", () => {
  const onHip3 = [
    {
      name: "trading",
      subAccountUser: SUB,
      master: MASTER,
      // No main-dex entry at all, and the real money is on a builder dex.
      dexToClearinghouseState: [["xyz", { marginSummary: { accountValue: "50555968.0" } }]],
      spotState: { balances: [] },
    },
  ];

  it("does not report zero for an account funded on a builder dex", () => {
    // v1 displayed $0.009981 against $50,555,968 real. A user reads "empty" and
    // abandons the account.
    const [parsed] = parseSubAccounts(onHip3);
    expect(parsed.perpEquityTotal).toBe("50555968");
    expect(parsed.perpEquityByDex.get("xyz")).toBe("50555968.0");
  });

  it("keys the main dex as null, matching HlIdentity.dex", () => {
    const [parsed] = parseSubAccounts([
      {
        name: "a",
        subAccountUser: SUB,
        master: MASTER,
        dexToClearinghouseState: [
          ["", { marginSummary: { accountValue: "10.5" } }],
          ["xyz", { marginSummary: { accountValue: "20.25" } }],
        ],
        spotState: { balances: [] },
      },
    ]);

    expect(parsed.perpEquityByDex.get(null)).toBe("10.5");
    expect(parsed.perpEquityByDex.get("xyz")).toBe("20.25");
    expect(parsed.perpEquityTotal).toBe("30.75");
  });
});

describe("abstraction mode", () => {
  function withAbstraction(abstraction?: unknown) {
    return parseSubAccount({
      name: "a",
      subAccountUser: SUB,
      master: MASTER,
      dexToClearinghouseState: [],
      spotState: { balances: [] },
      ...(abstraction === undefined ? {} : { abstraction }),
    });
  }

  it("reports an ABSENT field as null, not disabled", () => {
    // 26 absent against 24 explicitly disabled across 67 sub-accounts.
    // Collapsing the two puts the wrong margin badge on a quarter of them.
    expect(withAbstraction()?.abstraction).toBeNull();
  });

  it("keeps an explicit disabled distinct", () => {
    expect(withAbstraction("disabled")?.abstraction).toBe("disabled");
  });

  it.each(["unifiedAccount", "portfolioMargin"])("passes %s through", (mode) => {
    expect(withAbstraction(mode)?.abstraction).toBe(mode);
  });

  it("ignores an unrecognised value rather than displaying it", () => {
    expect(withAbstraction("somethingNew")?.abstraction).toBeNull();
  });
});

describe("malformed entries", () => {
  it("drops an entry with no usable address", () => {
    expect(parseSubAccounts([{ name: "x" }, null, 42])).toEqual([]);
  });

  it("lowercases both addresses so comparisons are safe", () => {
    const parsed = parseSubAccount({
      name: "a",
      subAccountUser: SUB.toUpperCase().replace("0X", "0x"),
      master: MASTER.toUpperCase().replace("0X", "0x"),
      dexToClearinghouseState: [],
      spotState: { balances: [] },
    });
    expect(parsed?.address).toBe(SUB);
    expect(parsed?.master).toBe(MASTER);
  });
});

describe("ownership", () => {
  const owned = parseSubAccounts([
    {
      name: "a",
      subAccountUser: SUB,
      master: MASTER,
      dexToClearinghouseState: [],
      spotState: { balances: [] },
    },
  ]);

  it("recognises a real sub-account, case-insensitively", () => {
    expect(isOwnedSubAccount(owned, SUB.toUpperCase())).toBe(true);
  });

  it("refuses a foreign address", () => {
    // Without this a mistyped address passes createIdentity untouched, and the
    // store's echo guard compares against that SAME wrong address — so it
    // agrees, and the user gets a calm, well-formed, empty portfolio.
    expect(isOwnedSubAccount(owned, "0x9999999999999999999999999999999999999999")).toBe(false);
    expect(() =>
      assertOwnedSubAccount(owned, "0x9999999999999999999999999999999999999999")
    ).toThrow(/not one of this account/);
  });
});

describe("internal counterparties", () => {
  const owned = parseSubAccounts([
    {
      name: "a",
      subAccountUser: SUB,
      master: MASTER,
      dexToClearinghouseState: [],
      spotState: { balances: [] },
    },
  ]);

  it("recognises the master and a sibling sub-account", () => {
    // `subAccountSpotTransfer` produces NO ledger row of its own — zero across
    // ~9,300 entries — and surfaces as an ordinary `spotTransfer`. The
    // counterparty is the only way to tell it from a real send.
    expect(isInternalCounterparty(owned, MASTER, SUB)).toBe(true);
    expect(isInternalCounterparty(owned, MASTER, MASTER)).toBe(true);
  });

  it("treats a stranger as external", () => {
    expect(
      isInternalCounterparty(owned, MASTER, "0x9999999999999999999999999999999999999999")
    ).toBe(false);
    expect(isInternalCounterparty(owned, MASTER, null)).toBe(false);
  });
});

describe("nesting", () => {
  it("allows creation only from a master", () => {
    // Sub-accounts do not nest — `subAccounts2` on one returned null 21/21.
    // Gated on the identity, not on an empty list: `null` is overloaded for
    // "has none", "is a sub-account", and "that is not an account".
    expect(canCreateSubAccount(null)).toBe(true);
    expect(canCreateSubAccount(SUB)).toBe(false);
  });
});

describe("fetchSubAccounts", () => {
  const probe = { subAccounts2: async () => live };

  it("queries the master and returns parsed summaries", async () => {
    const calls: { user: string }[] = [];
    const { value, deferred } = await fetchSubAccounts({
      probe: {
        subAccounts2: async (params) => {
          calls.push(params);
          return live;
        },
      },
      master: MASTER,
    });

    expect(deferred).toBe(false);
    expect(value).toHaveLength(live.length);
    expect(calls[0].user).toBe(MASTER);
  });

  it("reports deferred when the weight budget refuses", async () => {
    const result = await fetchSubAccounts({
      probe,
      master: MASTER,
      budget: new WeightBudget(0),
    });
    expect(result).toEqual({ value: null, deferred: true });
  });

  it("returns an empty list for an account with none", async () => {
    const { value } = await fetchSubAccounts({
      probe: { subAccounts2: async () => null },
      master: MASTER,
    });
    expect(value).toEqual([]);
  });
});
