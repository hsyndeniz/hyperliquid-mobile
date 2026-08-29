import {
  assertLedVault,
  distributeFromVault,
  distributeMaximumFromVault,
  fetchLeadingVaults,
  isLedVault,
  leadsVault,
  modifyVault,
  canonicalVaultDescription,
  canonicalVaultName,
  confirmVaultCreation,
  createVault,
  parseLeadingVaults,
  readCreatedVaultAddress,
  type VaultAdminClient,
} from "@/hyperliquid/vaults/manage";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import { VAULT_CREATION_FEE_USDC, VAULT_NAME_MAX } from "@/hyperliquid/vaults/types";
import { WeightBudget } from "@/hyperliquid/api/weightBudget";
import { HlError } from "@/hyperliquid/core/errors";
import type { MicroUsd } from "@/hyperliquid/transfers/types";
import type { Hex } from "@/hyperliquid/types/domain";
import type { VaultAddress } from "@/hyperliquid/vaults/types";

const VAULT = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303" as VaultAddress;
const OTHER = "0xabcdef0123456789abcdef0123456789abcdef01";
const LEADER = "0x5bf8287baeda8de01c88b3016d64f3875b0b4347";
const NOW = 1_770_000_000_000;

type ModifyCall = {
  vaultAddress: string;
  allowDeposits: boolean | null;
  alwaysCloseOnWithdraw: boolean | null;
};
type DistributeCall = { vaultAddress: string; usd: number };

function recorder(impl?: () => Promise<unknown>): {
  client: VaultAdminClient;
  modifies: ModifyCall[];
  distributes: DistributeCall[];
} {
  const modifies: ModifyCall[] = [];
  const distributes: DistributeCall[] = [];
  return {
    modifies,
    distributes,
    client: {
      vaultModify: async (params) => {
        modifies.push(params);
        return impl ? impl() : { status: "ok" };
      },
      vaultDistribute: async (params) => {
        distributes.push(params);
        return impl ? impl() : { status: "ok" };
      },
    },
  };
}

describe("leadingVaults is the only ownership check", () => {
  const led = parseLeadingVaults([{ address: VAULT, name: "My Vault" }]);

  it("parses address and name, lowercasing the address", () => {
    const [vault] = parseLeadingVaults([
      { address: VAULT.toUpperCase().replace("0X", "0x"), name: "  Padded  " },
    ]);
    expect(vault.address).toBe(VAULT);
    // Verbatim, like the directory: trimming merges genuinely distinct vaults.
    expect(vault.name).toBe("  Padded  ");
  });

  it("coalesces null to an empty list", () => {
    // `subAccounts2` one phase away uses null for "none", so a null here is
    // plausible and must not crash a leader screen on first load.
    expect(parseLeadingVaults(null)).toEqual([]);
    expect(parseLeadingVaults(undefined)).toEqual([]);
    expect(parseLeadingVaults([])).toEqual([]);
  });

  it("still rejects a shape that is neither array nor null", () => {
    expect(() => parseLeadingVaults({ nope: true })).toThrow(HlError);
  });

  it("drops a row with no usable address", () => {
    expect(parseLeadingVaults([{ name: "no address" }, null, 42])).toEqual([]);
  });

  it("recognises a led vault case-insensitively", () => {
    expect(isLedVault(led, VAULT.toUpperCase())).toBe(true);
    expect(isLedVault(led, OTHER)).toBe(false);
  });

  it("says 'open vaults', because leadingVaults omits closed ones", () => {
    // Telling a leader that a vault they closed is "not theirs" would be both
    // wrong and alarming — the address still exists and still reports
    // {"role":"vault"}.
    expect(() => assertLedVault(led, OTHER)).toThrow(/not one of your open vaults/);
    expect(() => assertLedVault(led, VAULT)).not.toThrow();
  });

  it("resolves leadership from vaultDetails too, which DOES cover closed vaults", () => {
    expect(leadsVault({ leader: LEADER as Hex }, LEADER.toUpperCase())).toBe(true);
    expect(leadsVault({ leader: LEADER as Hex }, OTHER)).toBe(false);
  });
});

describe("fetchLeadingVaults", () => {
  it("distinguishes LEADS-NONE from a refused read", async () => {
    const none = await fetchLeadingVaults({
      probe: { leadingVaults: async () => [] },
      user: LEADER,
    });
    expect(none).toEqual({ value: [], deferred: false });

    const refused = await fetchLeadingVaults({
      probe: { leadingVaults: async () => [{ address: VAULT, name: "x" }] },
      user: LEADER,
      budget: new WeightBudget(0),
    });
    expect(refused).toEqual({ value: null, deferred: true });
  });

  it("queries the leader's address", async () => {
    const calls: { user: string }[] = [];
    await fetchLeadingVaults({
      probe: {
        leadingVaults: async (params) => {
          calls.push(params);
          return [];
        },
      },
      user: LEADER,
    });
    expect(calls[0].user).toBe(LEADER);
  });
});

describe("a never-sent failure is not `unknown`", () => {
  /**
   * `unknown` is this module family's reserved term for "it may have landed —
   * watch, never retry". `run()` here special-cased only `api_error`, so a
   * schema rejection and an airplane-mode failure — both of which provably
   * never left the device — told the user their vault write might be in flight
   * and withheld the retry that was the only cure.
   *
   * `transfers/transfer.ts` already had the `validation_error` half with the
   * reasoning spelled out; this file is a copy that drifted.
   */
  const failing = (error: unknown) => ({
    vaultModify: async () => {
      throw error;
    },
  });

  it("reports a schema rejection as rejected_locally", async () => {
    const outcome = await modifyVault({
      client: failing(Object.assign(new Error("bad shape"), { name: "ValidationError" })) as never,
      vault: VAULT,
      allowDeposits: true,
      now: () => NOW,
    });
    expect(outcome.kind).toBe("rejected_locally");
  });

  it("reports an offline failure as rejected_locally, not unknown", async () => {
    // Only reachable at all since `looksOffline` learned to walk the cause
    // chain: the SDK wraps every throw, so the bare TypeError never arrived.
    const wrapped = Object.assign(new Error("HTTP request failed"), {
      name: "HttpRequestError",
      cause: new TypeError("Network request failed"),
    });
    const outcome = await modifyVault({
      client: failing(wrapped) as never,
      vault: VAULT,
      allowDeposits: true,
      now: () => NOW,
    });
    expect(outcome.kind).toBe("rejected_locally");
  });

  it("still calls a genuine transport failure unknown", async () => {
    // The distinction the whole classification exists for: an aborted request
    // may have reached the exchange and had its reply lost.
    const outcome = await modifyVault({
      client: failing(Object.assign(new Error("timeout"), { name: "HttpRequestError" })) as never,
      vault: VAULT,
      allowDeposits: true,
      now: () => NOW,
    });
    expect(outcome.kind).toBe("unknown");
  });
});

describe("modifyVault", () => {
  it("sends null for an unspecified flag, NEVER false", async () => {
    // The decisive test. `null` means "leave unchanged" on the wire; `false`
    // switches deposits off for every follower. A call meaning to change one
    // setting would silently change both.
    const { client, modifies } = recorder();
    await modifyVault({ client, vault: VAULT, allowDeposits: true, now: () => NOW });

    expect(modifies[0]).toEqual({
      vaultAddress: VAULT,
      allowDeposits: true,
      alwaysCloseOnWithdraw: null,
    });
  });

  it("passes an explicit false through", async () => {
    // Distinct from omitting it: this really does mean "switch deposits off".
    const { client, modifies } = recorder();
    await modifyVault({ client, vault: VAULT, allowDeposits: false, now: () => NOW });
    expect(modifies[0].allowDeposits).toBe(false);
  });

  it("can change only the withdrawal policy", async () => {
    const { client, modifies } = recorder();
    await modifyVault({ client, vault: VAULT, alwaysCloseOnWithdraw: true, now: () => NOW });
    expect(modifies[0]).toEqual({
      vaultAddress: VAULT,
      allowDeposits: null,
      alwaysCloseOnWithdraw: true,
    });
  });

  it("refuses a call that names no change, without signing", async () => {
    // A no-op still costs a signature and, in a log, is indistinguishable from a
    // call that did something.
    const { client, modifies } = recorder();
    const outcome = await modifyVault({ client, vault: VAULT, now: () => NOW });

    expect(outcome.kind).toBe("rejected_locally");
    expect(modifies).toHaveLength(0);
  });
});

describe("vaultDistribute and its ambiguous zero", () => {
  it("refuses a zero amount rather than paying out everything", async () => {
    // `vaultDistribute.usd` allows 0 where `vaultTransfer.usd` requires 1, and 0
    // is not a no-op — it means "distribute the maximum". A caller that arrived
    // at zero by subtraction did not mean to empty the vault's free margin.
    const { client, distributes } = recorder();
    const outcome = await distributeFromVault({
      client,
      vault: VAULT,
      usd: 0 as MicroUsd,
      now: () => NOW,
    });

    expect(outcome.kind).toBe("rejected_locally");
    expect(distributes).toHaveLength(0);
    if (outcome.kind === "rejected_locally") {
      expect(outcome.error.context).toMatchObject({ reason: "ambiguous_zero" });
    }
  });

  it("sends a real amount through", async () => {
    const { client, distributes } = recorder();
    const outcome = await distributeFromVault({
      client,
      vault: VAULT,
      usd: 10_000_000 as MicroUsd,
      now: () => NOW,
    });

    expect(outcome).toEqual({ kind: "settled", nonce: NOW });
    expect(distributes[0]).toEqual({ vaultAddress: VAULT, usd: 10_000_000 });
  });

  it("reaches the maximum only through its own named function", async () => {
    // The wire spells "everything" as 0. Separating it means that value can never
    // be reached by arithmetic.
    const { client, distributes } = recorder();
    await distributeMaximumFromVault({ client, vault: VAULT, now: () => NOW });
    expect(distributes[0]).toEqual({ vaultAddress: VAULT, usd: 0 });
  });
});

describe("outcomes", () => {
  it("reports a server refusal as rejected", async () => {
    const error = new Error("Only the vault leader may do that");
    error.name = "ApiRequestError";
    const { client } = recorder(async () => {
      throw error;
    });

    const outcome = await modifyVault({
      client,
      vault: VAULT,
      allowDeposits: true,
      now: () => NOW,
    });
    expect(outcome).toEqual({
      kind: "rejected_by_server",
      reason: "Only the vault leader may do that",
    });
  });

  it("reports a transport failure as unknown, with a window", async () => {
    const error = new Error("socket hang up");
    error.name = "HttpRequestError";
    const { client } = recorder(async () => {
      throw error;
    });

    const outcome = await distributeMaximumFromVault({ client, vault: VAULT, now: () => NOW });
    expect(outcome.kind).toBe("unknown");
    if (outcome.kind === "unknown") {
      expect(outcome.window).toEqual({ fromMs: NOW, toMs: NOW + 900_000 });
    }
  });
});

describe("vault creation", () => {
  const NAME = canonicalVaultName("Probe Vault");
  const DESC = canonicalVaultDescription("A vault used for nothing in particular.");
  const PLAN = { name: NAME, description: DESC, initialUsdc: canonicalAmount("100") };

  function honestEcho() {
    return {
      nameDisplayed: NAME as string,
      descriptionDisplayed: DESC as string,
      initialUsdcDisplayed: "100",
      feeUsdcDisplayed: VAULT_CREATION_FEE_USDC,
    };
  }

  describe("the permanent text", () => {
    it("counts UTF-16 code units, so an emoji costs two", () => {
      // valibot measures .length. Two emoji is two characters to a user and four
      // units here, which clears the 3-unit floor a two-emoji name would fail.
      expect(() => canonicalVaultName("ab")).toThrow(/counts as 2/);
      expect(canonicalVaultName("\u{1F642}\u{1F642}")).toHaveLength(4);
    });

    it("matches the bounds the SDK enforces", () => {
      // Measured live: "Invalid length: Expected >=3 but received 2" for a name,
      // "Expected >=10 but received 9" for a description.
      expect(() => canonicalVaultName("a".repeat(VAULT_NAME_MAX + 1))).toThrow(/must be 3-50/);
      expect(() => canonicalVaultDescription("too short")).toThrow(/must be 10-250/);
      expect(canonicalVaultName("a".repeat(VAULT_NAME_MAX))).toHaveLength(VAULT_NAME_MAX);
    });

    it("rejects control characters", () => {
      expect(() => canonicalVaultName("main\nalt")).toThrow(/control characters/);
    });

    it("trims, and counts what it will send", () => {
      expect(canonicalVaultName("  Probe Vault  ")).toBe("Probe Vault");
    });
  });

  describe("the echo", () => {
    it("REFUSES when the fee was never displayed", () => {
      // The decisive guard. A caller that never showed the 10,000 USDC charge
      // cannot produce this field, so a user cannot meet it after the fact.
      expect(() =>
        confirmVaultCreation(PLAN, { ...honestEcho(), feeUsdcDisplayed: "0" }, NOW)
      ).toThrow(/creation fee was not shown/);
      expect(() =>
        confirmVaultCreation(PLAN, { ...honestEcho(), feeUsdcDisplayed: "100" }, NOW)
      ).toThrow(/creation fee was not shown/);
    });

    it("accepts the fee in any numeric formatting", () => {
      // The point is that the figure was shown, not how it was rendered.
      expect(() =>
        confirmVaultCreation(PLAN, { ...honestEcho(), feeUsdcDisplayed: "10000.00" }, NOW)
      ).not.toThrow();
    });

    it("requires the exact permanent strings, since they can never be changed", () => {
      expect(() =>
        confirmVaultCreation(PLAN, { ...honestEcho(), nameDisplayed: "Other Vault" }, NOW)
      ).toThrow(/displayed name/);
      expect(() =>
        confirmVaultCreation(PLAN, { ...honestEcho(), descriptionDisplayed: "something else" }, NOW)
      ).toThrow(/displayed description/);
    });

    it("compares the deposit numerically", () => {
      expect(() =>
        confirmVaultCreation(PLAN, { ...honestEcho(), initialUsdcDisplayed: "100.00" }, NOW)
      ).not.toThrow();
      expect(() =>
        confirmVaultCreation(PLAN, { ...honestEcho(), initialUsdcDisplayed: "99" }, NOW)
      ).toThrow(/initial deposit does not match/);
    });

    it("enforces the 100 USDC floor the SDK also enforces", () => {
      const small = { ...PLAN, initialUsdc: canonicalAmount("99") };
      expect(() =>
        confirmVaultCreation(small, { ...honestEcho(), initialUsdcDisplayed: "99" }, NOW)
      ).toThrow(/at least 100 USDC/);
    });

    it("converts the deposit to micro-USD exactly once", () => {
      expect(confirmVaultCreation(PLAN, honestEcho(), NOW).initialUsd).toBe(100_000_000);
    });
  });

  describe("createVault", () => {
    function client(impl?: () => Promise<unknown>) {
      const calls: { name: string; description: string; initialUsd: number }[] = [];
      return {
        calls,
        client: {
          createVault: async (p: { name: string; description: string; initialUsd: number }) => {
            calls.push(p);
            return impl ? impl() : { status: "ok", response: { type: "createVault", data: VAULT } };
          },
        },
      };
    }

    it("sends the ticket's fields and returns the new address", async () => {
      const { client: c, calls } = client();
      const outcome = await createVault({
        client: c,
        ticket: confirmVaultCreation(PLAN, honestEcho(), NOW),
        now: () => NOW,
      });

      expect(calls[0]).toEqual({
        name: "Probe Vault",
        description: "A vault used for nothing in particular.",
        initialUsd: 100_000_000,
      });
      expect(outcome).toEqual({
        kind: "created",
        value: { address: VAULT, name: "Probe Vault" },
        nonce: NOW,
      });
    });

    it("still reports created when the address cannot be parsed", async () => {
      // The vault exists and cost $10,000. Reporting failure because a field
      // moved is how someone pays the fee twice.
      const { client: c } = client(async () => ({ status: "ok", response: { type: "default" } }));
      const outcome = await createVault({
        client: c,
        ticket: confirmVaultCreation(PLAN, honestEcho(), NOW),
        now: () => NOW,
      });
      expect(outcome).toEqual({
        kind: "created",
        value: { address: null, name: "Probe Vault" },
        nonce: NOW,
      });
    });

    it("is SINGLE-USE, because a duplicate costs another 10,000 USDC", async () => {
      const { client: c, calls } = client();
      const ticket = confirmVaultCreation(PLAN, honestEcho(), NOW);

      await createVault({ client: c, ticket, now: () => NOW });
      await expect(createVault({ client: c, ticket, now: () => NOW })).rejects.toThrow(
        /already used/
      );
      expect(calls).toHaveLength(1);
    });

    it("refuses a ticket that was never confirmed", async () => {
      const { client: c, calls } = client();
      const forged = { name: NAME, description: DESC, initialUsd: 100_000_000, confirmedAt: 0 };
      await expect(
        // @ts-expect-error the brand is a module-private symbol
        createVault({ client: c, ticket: forged, now: () => NOW })
      ).rejects.toThrow(/never confirmed/);
      expect(calls).toHaveLength(0);
    });

    it("reports a server refusal, which means no vault and no fee", async () => {
      const error = new Error("Insufficient balance to create vault");
      error.name = "ApiRequestError";
      const { client: c } = client(async () => {
        throw error;
      });
      const outcome = await createVault({
        client: c,
        ticket: confirmVaultCreation(PLAN, honestEcho(), NOW),
        now: () => NOW,
      });
      expect(outcome).toEqual({
        kind: "rejected_by_server",
        reason: "Insufficient balance to create vault",
      });
    });

    it("reports a transport failure as unknown — re-list, never re-send", async () => {
      const error = new Error("socket hang up");
      error.name = "HttpRequestError";
      const { client: c } = client(async () => {
        throw error;
      });
      const outcome = await createVault({
        client: c,
        ticket: confirmVaultCreation(PLAN, honestEcho(), NOW),
        now: () => NOW,
      });
      expect(outcome.kind).toBe("unknown");
    });
  });

  describe("readCreatedVaultAddress", () => {
    it("extracts and lowercases", () => {
      expect(
        readCreatedVaultAddress({ response: { data: VAULT.toUpperCase().replace("0X", "0x") } })
      ).toBe(VAULT);
    });

    it("returns null for anything else", () => {
      expect(readCreatedVaultAddress({ response: { type: "default" } })).toBeNull();
      expect(readCreatedVaultAddress(null)).toBeNull();
    });
  });
});
