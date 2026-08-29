import { AGENT_ROTATION_THRESHOLD_MS } from "@/hyperliquid/config/constants";
import type { AgentIdentifiable, RegisteredAgent } from "@/hyperliquid/auth/agentPolicy";
import {
  agentName,
  isExpired,
  isRotationDue,
  resolveAgentStatus,
} from "@/hyperliquid/auth/agentPolicy";

const NOW = 1_800_000_000_000;
const AGENT_ADDRESS = "0xaaaabbbbccccddddeeeeffff0000111122223333";

function account(address = AGENT_ADDRESS): AgentIdentifiable {
  return { address };
}

function registered(overrides: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
    address: AGENT_ADDRESS as `0x${string}`,
    name: "hl",
    validUntil: NOW + 30 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe("isRotationDue / isExpired", () => {
  it("treats a null validUntil as never expiring", () => {
    // The reference compares `validUntil <= threshold` directly; null coerces to
    // 0, so a never-expiring agent reads as expiring and gets rejected.
    expect(isRotationDue(null, NOW)).toBe(false);
    expect(isExpired(null, NOW)).toBe(false);
  });

  it("flags an agent inside the rotation window", () => {
    expect(isRotationDue(NOW + AGENT_ROTATION_THRESHOLD_MS - 1, NOW)).toBe(true);
  });

  it("leaves an agent outside the window alone", () => {
    expect(isRotationDue(NOW + AGENT_ROTATION_THRESHOLD_MS + 1, NOW)).toBe(false);
  });

  it("is inclusive at the rotation boundary", () => {
    expect(isRotationDue(NOW + AGENT_ROTATION_THRESHOLD_MS, NOW)).toBe(true);
  });

  it("separates expired from merely due for rotation", () => {
    const soon = NOW + 1000;
    expect(isExpired(soon, NOW)).toBe(false);
    expect(isRotationDue(soon, NOW)).toBe(true);

    const past = NOW - 1;
    expect(isExpired(past, NOW)).toBe(true);
  });
});

describe("resolveAgentStatus", () => {
  it("requires approval when no agent is registered on chain", () => {
    expect(resolveAgentStatus({ registeredAgents: [], localAccount: account(), now: NOW })).toEqual(
      { kind: "approval_required", reason: "no_agents_registered" }
    );
  });

  it("requires approval when we hold no key", () => {
    expect(
      resolveAgentStatus({ registeredAgents: [registered()], localAccount: null, now: NOW })
    ).toEqual({ kind: "approval_required", reason: "no_local_key" });
  });

  it("is ready when a valid agent matches our key", () => {
    const status = resolveAgentStatus({
      registeredAgents: [registered()],
      localAccount: account(),
      now: NOW,
    });
    expect(status.kind).toBe("ready");
  });

  it("matches addresses case-insensitively", () => {
    // viem returns checksummed addresses; Hyperliquid returns lowercase.
    const status = resolveAgentStatus({
      registeredAgents: [registered({ address: AGENT_ADDRESS.toUpperCase() as `0x${string}` })],
      localAccount: account(AGENT_ADDRESS),
      now: NOW,
    });
    expect(status.kind).toBe("ready");
  });

  it("requires approval when our key is not the registered agent", () => {
    const status = resolveAgentStatus({
      registeredAgents: [registered({ address: "0x9999999999999999999999999999999999999999" })],
      localAccount: account(),
      now: NOW,
    });
    expect(status).toEqual({ kind: "approval_required", reason: "key_address_mismatch" });
  });

  it("requires approval once the agent has expired", () => {
    const status = resolveAgentStatus({
      registeredAgents: [registered({ validUntil: NOW - 1 })],
      localAccount: account(),
      now: NOW,
    });
    expect(status).toEqual({ kind: "approval_required", reason: "expired" });
  });

  it("stays usable while rotation is due, rather than blocking a trade", () => {
    const validUntil = NOW + 1000;
    const localAccount = account();
    const status = resolveAgentStatus({
      registeredAgents: [registered({ validUntil })],
      localAccount,
      now: NOW,
    });
    expect(status).toMatchObject({ kind: "rotation_due", validUntil });
    // Still returns a usable signer — rotation happens in the background.
    expect(status.kind === "rotation_due" && status.account).toBe(localAccount);
  });

  it("is ready for a never-expiring agent", () => {
    const status = resolveAgentStatus({
      registeredAgents: [registered({ validUntil: null })],
      localAccount: account(),
      now: NOW,
    });
    expect(status.kind).toBe("ready");
  });

  it("picks our agent out of several registered ones", () => {
    const status = resolveAgentStatus({
      registeredAgents: [
        registered({ address: "0x1111111111111111111111111111111111111111" }),
        registered(),
        registered({ address: "0x2222222222222222222222222222222222222222" }),
      ],
      localAccount: account(),
      now: NOW,
    });
    expect(status.kind).toBe("ready");
  });
});

describe("agentName", () => {
  it("caps at Hyperliquid's 16-character limit", () => {
    expect(agentName("a-very-long-agent-name-indeed")).toHaveLength(16);
  });

  it("leaves a short name intact", () => {
    expect(agentName("hl-mobile")).toBe("hl-mobile");
  });
});
