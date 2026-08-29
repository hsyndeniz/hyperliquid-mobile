import {
  FOLLOWER_PAGE_CAP,
  acceptsDeposits,
  fetchVaultDetails,
  parseFollowerRow,
  parseVaultDetails,
  readPortfolio,
} from "@/hyperliquid/vaults/details";
import { WeightBudget } from "@/hyperliquid/api/weightBudget";
import { HlError } from "@/hyperliquid/core/errors";

import live from "@/hyperliquid/vaults/__fixtures__/vault-details-mainnet.json";

const HLP = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
const NOT_A_VAULT = "0x5bf8287baeda8de01c88b3016d64f3875b0b4347";
const VAULT = "0x1111111111111111111111111111111111111111";
const LEADER = "0x2222222222222222222222222222222222222222";

const fixture = live as Record<string, unknown>;

function detail(overrides: Record<string, unknown> = {}) {
  return {
    name: "A vault",
    vaultAddress: VAULT,
    leader: LEADER,
    description: "a description",
    portfolio: [],
    apr: 0.05,
    followerState: null,
    leaderFraction: 0.5,
    leaderCommission: 0,
    followers: [],
    maxDistributable: 100,
    maxWithdrawable: 0,
    isClosed: false,
    relationship: { type: "normal" },
    allowDeposits: true,
    alwaysCloseOnWithdraw: false,
    ...overrides,
  };
}

describe("the recorded mainnet responses", () => {
  it("parses HLP", () => {
    const hlp = parseVaultDetails(fixture[HLP]);
    expect(hlp).not.toBeNull();
    expect(hlp!.name).toBe("Hyperliquidity Provider (HLP)");
    expect(hlp!.address).toBe(HLP);
  });

  it("returns null for the recorded NON-vault response", () => {
    // Live mainnet answers HTTP 200 with a two-byte `null` body for any address
    // that is not a vault. The SDK's declared return type has no `| null`, so
    // `data.name` throws on a mistyped address.
    expect(parseVaultDetails(fixture[NOT_A_VAULT])).toBeNull();
    expect(fixture[NOT_A_VAULT]).toBeNull();
  });

  it("flags HLP's follower page as truncated", () => {
    // Exactly 100 rows, and they sum to $138.1m against a maxDistributable of
    // $177.5m. Reading `rows.length` as a follower count understates it by an
    // unknown margin.
    const hlp = parseVaultDetails(fixture[HLP])!;
    expect(hlp.followers.rows).toHaveLength(FOLLOWER_PAGE_CAP);
    expect(hlp.followers.truncated).toBe(true);
  });

  it("finds no leader row on HLP", () => {
    // The `user` field's union allows the literal "Leader", but HLP has no such
    // row at all — a parser that assumes one exists finds nothing.
    const hlp = parseVaultDetails(fixture[HLP])!;
    expect(hlp.followers.rows.some((r) => r.isLeader)).toBe(false);
  });

  it("reads HLP as a parent with its children", () => {
    const hlp = parseVaultDetails(fixture[HLP])!;
    expect(hlp.relationship.kind).toBe("parent");
    if (hlp.relationship.kind === "parent") {
      expect(hlp.relationship.childAddresses.length).toBeGreaterThan(0);
      for (const child of hlp.relationship.childAddresses) {
        expect(child).toMatch(/^0x[0-9a-f]{40}$/);
      }
    }
  });

  it("reads a child, which carries NO link back to its parent", () => {
    // Measured on all three of HLP's children in the fixture: the wire sends a
    // bare {"type":"child"} with no data object. The only way to resolve a
    // parent is to scan every parent's child list.
    const child = Object.values(fixture)
      .map((raw) => parseVaultDetails(raw))
      .find((v) => v?.relationship.kind === "child");

    expect(child).toBeDefined();
    expect(child!.relationship).toEqual({ kind: "child" });
  });

  it("keeps every portfolio history value a string", () => {
    // Observed to 18 significant digits ("218435639.169077009"); a double loses
    // the tail and still renders as a number.
    const hlp = parseVaultDetails(fixture[HLP])!;
    expect(hlp.portfolio.length).toBeGreaterThan(0);
    for (const period of hlp.portfolio) {
      for (const [at, value] of period.accountValueHistory) {
        expect(typeof at).toBe("number");
        expect(typeof value).toBe("string");
      }
    }
  });

  it("exposes the eight periods the wire actually sends", () => {
    const hlp = parseVaultDetails(fixture[HLP])!;
    expect(hlp.portfolio.map((p) => p.period)).toEqual([
      "day",
      "week",
      "month",
      "allTime",
      "perpDay",
      "perpWeek",
      "perpMonth",
      "perpAllTime",
    ]);
  });
});

describe("the five JSON-number fields", () => {
  it("wraps them as approximations, never as wire amounts", () => {
    // `leaderFraction` was observed as 0.0016483967568351689 — seventeen
    // significant digits, IEEE-754 admitting the exact value is already gone.
    // No BigNumber discipline downstream recovers it.
    const parsed = parseVaultDetails(
      detail({
        apr: 0.0039864237126079555,
        leaderFraction: 0.0016483967568351689,
        maxDistributable: 177451120.878129,
      })
    )!;

    expect(parsed.apr).toBe("0.0039864237126079555");
    expect(parsed.leaderFraction).toBe("0.0016483967568351689");
    expect(parsed.maxDistributable).toBe("177451120.878129");
  });

  it("reports an absent one as null rather than zero", () => {
    // Zero is a real value for `maxWithdrawable`; "not sent" is not the same
    // thing and must not render as "you can withdraw nothing".
    const parsed = parseVaultDetails(detail({ maxWithdrawable: undefined, apr: null }))!;
    expect(parsed.maxWithdrawable).toBeNull();
    expect(parsed.apr).toBeNull();
  });

  it("accepts a string, in case the API ever fixes the field", () => {
    expect(parseVaultDetails(detail({ apr: "0.05" }))!.apr).toBe("0.05");
  });
});

describe("followers", () => {
  function rows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      user: `0x${String(i).padStart(40, "0")}`,
      vaultEquity: "1",
      pnl: "0",
      allTimePnl: "0",
      daysFollowing: 1,
      vaultEntryTime: 1,
      lockupUntil: 2,
    }));
  }

  it("is not truncated below the cap", () => {
    const parsed = parseVaultDetails(detail({ followers: rows(99) }))!;
    expect(parsed.followers.truncated).toBe(false);
  });

  it("is truncated at the cap", () => {
    const parsed = parseVaultDetails(detail({ followers: rows(FOLLOWER_PAGE_CAP) }))!;
    expect(parsed.followers.truncated).toBe(true);
  });

  it("measures truncation against the RAW length, not the parsed one", () => {
    // Dropping an unusable row must not make a truncated page look complete —
    // that would turn a partial list into an authoritative-looking one.
    const withJunk = [...rows(FOLLOWER_PAGE_CAP - 1), { user: "not an address" }];
    const parsed = parseVaultDetails(detail({ followers: withJunk }))!;
    expect(parsed.followers.rows).toHaveLength(FOLLOWER_PAGE_CAP - 1);
    expect(parsed.followers.truncated).toBe(true);
  });

  it("separates the leader marker from a real address", () => {
    // The wire puts the literal string "Leader" in an address-typed field. A
    // caller comparing `user` to an address would silently never match it.
    const leaderRow = parseFollowerRow({ user: "Leader", vaultEquity: "5" })!;
    expect(leaderRow.isLeader).toBe(true);
    expect(leaderRow.user).toBeNull();

    const mixedCase = LEADER.toUpperCase().replace("0X", "0x");
    const follower = parseFollowerRow({ user: mixedCase, vaultEquity: "5" })!;
    expect(follower.isLeader).toBe(false);
    expect(follower.user).toBe(LEADER);
  });

  it("drops a row it cannot attribute", () => {
    expect(parseFollowerRow({ user: "0xnope" })).toBeNull();
    expect(parseFollowerRow(null)).toBeNull();
  });
});

describe("followerState", () => {
  it("is null when vaultDetails was asked without a user", () => {
    // Every recorded fixture was fetched without one, which is also why every
    // recorded maxWithdrawable is 0.
    expect(parseVaultDetails(fixture[HLP])!.followerState).toBeNull();
  });

  it("parses the caller's own row when present", () => {
    const parsed = parseVaultDetails(
      detail({
        followerState: {
          user: LEADER,
          vaultEquity: "1234.5",
          pnl: "1",
          allTimePnl: "2",
          daysFollowing: 3,
          vaultEntryTime: 4,
          lockupUntil: 5,
        },
      })
    )!;
    expect(parsed.followerState).toMatchObject({ user: LEADER, vaultEquity: "1234.5" });
  });
});

describe("portfolio", () => {
  it("reads an array of PAIRS, not an object map", () => {
    // The same shape trap that produced garbage in Phase 6 when
    // `tokenToAvailableAfterMaintenance` was read with Object.entries.
    const parsed = readPortfolio([
      ["day", { accountValueHistory: [[1, "2"]], pnlHistory: [[1, "3"]], vlm: "9" }],
    ]);
    expect(parsed).toEqual([
      { period: "day", accountValueHistory: [[1, "2"]], pnlHistory: [[1, "3"]], vlm: "9" },
    ]);
  });

  it("drops a malformed pair rather than throwing", () => {
    expect(readPortfolio([["day"], null, "nope", 42])).toEqual([]);
  });

  it("drops a history entry whose value is a number", () => {
    // A number here would be a wire change that silently costs precision.
    const [period] = readPortfolio([
      [
        "day",
        {
          accountValueHistory: [
            [1, 2],
            [3, "4"],
          ],
          pnlHistory: [],
          vlm: "0",
        },
      ],
    ]);
    expect(period.accountValueHistory).toEqual([[3, "4"]]);
  });
});

describe("malformed payloads", () => {
  it("throws for an object with no vault address", () => {
    expect(() => parseVaultDetails({ name: "x" })).toThrow(HlError);
  });

  it("throws for a scalar", () => {
    expect(() => parseVaultDetails(42)).toThrow(HlError);
  });

  it("treats undefined like null", () => {
    expect(parseVaultDetails(undefined)).toBeNull();
  });
});

describe("acceptsDeposits", () => {
  it("requires BOTH flags", () => {
    // `allowDeposits` stays true on the large majority of closed vaults, so it
    // is not a gate on its own.
    expect(acceptsDeposits(parseVaultDetails(detail())!)).toBe(true);
    expect(
      acceptsDeposits(parseVaultDetails(detail({ isClosed: true, allowDeposits: true }))!)
    ).toBe(false);
    expect(acceptsDeposits(parseVaultDetails(detail({ allowDeposits: false }))!)).toBe(false);
  });
});

describe("fetchVaultDetails", () => {
  it("passes the user through so followerState and maxWithdrawable mean something", async () => {
    const calls: { vaultAddress: string; user?: string }[] = [];
    await fetchVaultDetails({
      probe: {
        vaultDetails: async (params) => {
          calls.push(params);
          return detail();
        },
      },
      vaultAddress: VAULT,
      user: LEADER,
    });
    expect(calls[0]).toEqual({ vaultAddress: VAULT, user: LEADER });
  });

  it("omits `user` entirely rather than sending undefined", async () => {
    const calls: Record<string, unknown>[] = [];
    await fetchVaultDetails({
      probe: {
        vaultDetails: async (params) => {
          calls.push(params);
          return detail();
        },
      },
      vaultAddress: VAULT,
    });
    expect("user" in calls[0]).toBe(false);
  });

  it("distinguishes NOT-A-VAULT from a refused read", async () => {
    // Both are `null`, and collapsing them is how a rate-limited app tells the
    // user their vault does not exist.
    const notAVault = await fetchVaultDetails({
      probe: { vaultDetails: async () => null },
      vaultAddress: VAULT,
    });
    expect(notAVault).toEqual({ value: null, deferred: false });

    const refused = await fetchVaultDetails({
      probe: { vaultDetails: async () => detail() },
      vaultAddress: VAULT,
      budget: new WeightBudget(0),
    });
    expect(refused).toEqual({ value: null, deferred: true });
  });

  it("does not call the endpoint when the budget refuses", async () => {
    // The endpoint throttles at roughly one call per second and retrying inside
    // the penalty prolongs it, so the local budget has to bite first.
    let called = false;
    await fetchVaultDetails({
      probe: {
        vaultDetails: async () => {
          called = true;
          return detail();
        },
      },
      vaultAddress: VAULT,
      budget: new WeightBudget(0),
    });
    expect(called).toBe(false);
  });
});
