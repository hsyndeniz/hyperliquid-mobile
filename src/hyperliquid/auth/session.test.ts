import { HlError } from "@/hyperliquid/core/errors";
import { createIdentity } from "@/hyperliquid/core/identity";
import {
  ensureAgentReady,
  inspectAgent,
  isAccountActivated,
  parseRegisteredAgents,
} from "@/hyperliquid/auth/session";
import * as agentModule from "@/hyperliquid/auth/agent";
import * as keychainModule from "@/hyperliquid/auth/keychain";

const ADDRESS = "0xabcdef0123456789abcdef0123456789abcdef01";
const AGENT = "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const NOW = 1_800_000_000_000;
const identity = createIdentity({ env: "testnet", accountId: "acc", address: ADDRESS });

function info(overrides: { agents?: unknown; role?: unknown; agentsThrow?: boolean } = {}) {
  return {
    extraAgents: async () => {
      // A failed read is not an empty list. `agentsRead` exists to keep the two
      // apart, and the tests below turn on that difference.
      if (overrides.agentsThrow) throw new Error("info unreachable");
      return overrides.agents ?? [];
    },
    userRole: async () => overrides.role ?? { role: "user" },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("parseRegisteredAgents", () => {
  it("preserves a null validUntil as 'never expires'", () => {
    // Coercing null to 0 is the reference's bug: a permanent agent then reads
    // as expired on every check and is re-approved forever.
    const parsed = parseRegisteredAgents([{ address: AGENT, name: "hl", validUntil: null }]);
    expect(parsed[0].validUntil).toBeNull();
  });

  it("keeps a numeric expiry", () => {
    expect(
      parseRegisteredAgents([{ address: AGENT, name: "hl", validUntil: 123 }])[0].validUntil
    ).toBe(123);
  });

  it("treats a missing validUntil as never-expiring rather than expired", () => {
    expect(parseRegisteredAgents([{ address: AGENT, name: "hl" }])[0].validUntil).toBeNull();
  });

  it("skips malformed entries instead of throwing", () => {
    expect(
      parseRegisteredAgents([null, 42, { name: "no address" }, { address: AGENT }])
    ).toHaveLength(1);
  });

  it("returns empty for a non-array response", () => {
    expect(parseRegisteredAgents({ unexpected: true })).toEqual([]);
  });
});

describe("isAccountActivated", () => {
  it("treats 'missing' as unfunded", () => {
    expect(isAccountActivated({ role: "missing" })).toBe(false);
  });

  it("treats any other role as activated", () => {
    expect(isAccountActivated({ role: "user" })).toBe(true);
    expect(isAccountActivated({ role: "agent", data: {} })).toBe(true);
  });

  it("is conservative about an unreadable response", () => {
    expect(isAccountActivated(null)).toBe(false);
  });
});

describe("inspectAgent", () => {
  it("reports approval_required when no key is held", async () => {
    jest.spyOn(agentModule, "loadAgentAccount").mockResolvedValue(null);
    const result = await inspectAgent({
      identity,
      info: info({ agents: [{ address: AGENT, name: "hl", validUntil: null }] }),
      now: () => NOW,
    });
    expect(result.status.kind).toBe("approval_required");
    expect(result.activated).toBe(true);
  });

  it("reports ready when the held key matches a live agent", async () => {
    jest
      .spyOn(agentModule, "loadAgentAccount")
      .mockResolvedValue({ address: AGENT as `0x${string}`, signTypedData: async () => "0x" });
    const result = await inspectAgent({
      identity,
      info: info({ agents: [{ address: AGENT, name: "hl", validUntil: null }] }),
      now: () => NOW,
    });
    expect(result.status.kind).toBe("ready");
  });

  it("survives one probe failing without failing the whole inspection", async () => {
    jest.spyOn(agentModule, "loadAgentAccount").mockResolvedValue(null);
    const result = await inspectAgent({
      identity,
      info: {
        extraAgents: async () => {
          throw new Error("network");
        },
        userRole: async () => ({ role: "user" }),
      },
      now: () => NOW,
    });
    expect(result.registeredAgents).toEqual([]);
    expect(result.activated).toBe(true);
  });

  it("changes nothing — it is read-only", async () => {
    const create = jest.spyOn(agentModule, "createAndStoreAgent");
    jest.spyOn(agentModule, "loadAgentAccount").mockResolvedValue(null);
    await inspectAgent({ identity, info: info(), now: () => NOW });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("ensureAgentReady", () => {
  it("refuses on an unfunded account, which cannot approve anything", async () => {
    jest.spyOn(agentModule, "loadAgentAccount").mockResolvedValue(null);
    await expect(
      ensureAgentReady({
        identity,
        info: info({ role: { role: "missing" } }),
        approver: { approveAgent: async () => ({}) },
        now: () => NOW,
      })
    ).rejects.toThrow(/not activated/i);
  });

  it("does not prompt the wallet when no approver is supplied", async () => {
    jest.spyOn(agentModule, "loadAgentAccount").mockResolvedValue(null);
    const create = jest.spyOn(agentModule, "createAndStoreAgent");
    const result = await ensureAgentReady({ identity, info: info(), now: () => NOW });
    expect(result.status.kind).toBe("approval_required");
    expect(create).not.toHaveBeenCalled();
  });

  it("INSPECTS an unfunded account instead of refusing it", async () => {
    // The first-run deadlock, found on the first device run. A freshly created
    // wallet is unfunded, so a read-only `session.start()` threw "deposit before
    // trading" and produced no session at all — while the deposit screen that
    // would fix it is itself behind a session.
    //
    // Note what the sibling test above is called: "refuses on an unfunded
    // account, WHICH CANNOT APPROVE ANYTHING". That reason is a condition on
    // approving. It was being applied to looking.
    jest.spyOn(agentModule, "loadAgentAccount").mockResolvedValue(null);
    const create = jest.spyOn(agentModule, "createAndStoreAgent");

    const result = await ensureAgentReady({
      identity,
      info: info({ role: { role: "missing" } }),
      now: () => NOW,
    });

    expect(result.status.kind).toBe("approval_required");
    expect(result.activated).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("INSPECTS an account whose status could not be read", async () => {
    // Same rule. `agentsRead: false` is the caller's signal that the list is
    // unknown rather than empty — the distinction this module treats as
    // cardinal — so a read-only surface can render honestly instead of being
    // denied a session because one HTTP request failed.
    jest.spyOn(agentModule, "loadAgentAccount").mockResolvedValue(null);

    const result = await ensureAgentReady({
      identity,
      info: info({ agentsThrow: true }),
      now: () => NOW,
    });

    expect(result.status.kind).toBe("approval_required");
    expect(result.agentsRead).toBe(false);
  });

  it("STILL refuses to approve when the agent list was never read", async () => {
    // The dangerous half, and it must survive the reordering. A failed read
    // yields an empty list, which resolves to `approval_required` — so
    // proceeding would mint and approve a brand new agent on chain because one
    // request failed, burning one of the master's three slots.
    jest.spyOn(agentModule, "loadAgentAccount").mockResolvedValue(null);
    const create = jest.spyOn(agentModule, "createAndStoreAgent");

    await expect(
      ensureAgentReady({
        identity,
        info: info({ agentsThrow: true }),
        approver: { approveAgent: async () => ({}) },
        now: () => NOW,
      })
    ).rejects.toThrow(/could not read/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("generates, stores and approves an agent when one is needed", async () => {
    const account = { address: AGENT as `0x${string}`, signTypedData: async () => "0x" as const };
    jest.spyOn(agentModule, "loadAgentAccount").mockResolvedValue(null);
    jest
      .spyOn(agentModule, "createAndStoreAgent")
      .mockResolvedValue({ account, agentAddress: AGENT as `0x${string}` });
    const approveAgent = jest.fn().mockResolvedValue({});

    const result = await ensureAgentReady({
      identity,
      info: info(),
      approver: { approveAgent },
      label: "hl-mobile",
      now: () => NOW,
    });

    expect(result.status.kind).toBe("ready");
    expect(approveAgent).toHaveBeenCalledWith({ agentAddress: AGENT, agentName: "hl-mobile" });
  });

  it("caps the agent name at Hyperliquid's 16-character limit", async () => {
    jest.spyOn(agentModule, "loadAgentAccount").mockResolvedValue(null);
    jest.spyOn(agentModule, "createAndStoreAgent").mockResolvedValue({
      account: { address: AGENT as `0x${string}`, signTypedData: async () => "0x" },
      agentAddress: AGENT as `0x${string}`,
    });
    const approveAgent = jest.fn().mockResolvedValue({});
    await ensureAgentReady({
      identity,
      info: info(),
      approver: { approveAgent },
      label: "a-very-long-label-indeed",
      now: () => NOW,
    });
    expect(approveAgent.mock.calls[0][0].agentName).toHaveLength(16);
  });

  it("discards the stored key when the SERVER refuses the approval", async () => {
    // An articulated refusal is a fact: the chain did not accept the agent, so
    // the key is dead weight and would read as key_address_mismatch forever.
    jest.spyOn(agentModule, "loadAgentAccount").mockResolvedValue(null);
    jest.spyOn(agentModule, "createAndStoreAgent").mockResolvedValue({
      account: { address: AGENT as `0x${string}`, signTypedData: async () => "0x" },
      agentAddress: AGENT as `0x${string}`,
    });
    const remove = jest.spyOn(keychainModule, "deleteAgentKey").mockResolvedValue();

    await expect(
      ensureAgentReady({
        identity,
        info: info(),
        approver: {
          approveAgent: async () => {
            throw new HlError("Agent approval rejected", { code: "api_error" });
          },
        },
        now: () => NOW,
      })
    ).rejects.toThrow(HlError);

    expect(remove).toHaveBeenCalled();
  });

  it("KEEPS the key when the approval merely times out", async () => {
    // `approveAgent` is an HTTP POST, so a timeout or aborted fetch may well
    // have landed on-chain. Deleting the local key there destroys the only
    // thing that can turn that approval into a usable session — the agent would
    // be registered to an address whose private key no longer exists anywhere,
    // and the user would have to approve a second one to recover.
    jest.spyOn(agentModule, "loadAgentAccount").mockResolvedValue(null);
    jest.spyOn(agentModule, "createAndStoreAgent").mockResolvedValue({
      account: { address: AGENT as `0x${string}`, signTypedData: async () => "0x" },
      agentAddress: AGENT as `0x${string}`,
    });
    const remove = jest.spyOn(keychainModule, "deleteAgentKey").mockResolvedValue();

    await expect(
      ensureAgentReady({
        identity,
        info: info(),
        approver: {
          approveAgent: async () => {
            throw new HlError("socket hang up", { code: "transport_error" });
          },
        },
        now: () => NOW,
      })
    ).rejects.toThrow(HlError);

    expect(remove).not.toHaveBeenCalled();
  });

  it("leaves a rotation-due agent alone rather than prompting mid-trade", async () => {
    jest
      .spyOn(agentModule, "loadAgentAccount")
      .mockResolvedValue({ address: AGENT as `0x${string}`, signTypedData: async () => "0x" });
    const create = jest.spyOn(agentModule, "createAndStoreAgent");

    const result = await ensureAgentReady({
      identity,
      info: info({ agents: [{ address: AGENT, name: "hl", validUntil: NOW + 1000 }] }),
      approver: { approveAgent: async () => ({}) },
      now: () => NOW,
    });

    expect(result.status.kind).toBe("rotation_due");
    expect(create).not.toHaveBeenCalled();
  });
});
