import { ActionBudget } from "@/hyperliquid/api/rateLimit";
import { HlError } from "@/hyperliquid/core/errors";
import { createIdentity } from "@/hyperliquid/core/identity";
import type { AgentStatus } from "@/hyperliquid/auth/agentPolicy";
import type { OrderLeg } from "@/hyperliquid/orders/build";
import { clearPending, listPending } from "@/hyperliquid/orders/pending";
import { placeOrders } from "@/hyperliquid/orders/place";

const ADDRESS = "0xabcdef0123456789abcdef0123456789abcdef01";
const SUB = "0x1111111111111111111111111111111111111111";
const NOW = 1_800_000_000_000;

const identity = createIdentity({ env: "testnet", accountId: "acc", address: ADDRESS });
const ready: AgentStatus<{ address: string }> = {
  kind: "ready",
  account: { address: "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111" },
};

function leg(): OrderLeg {
  return { a: 0, b: true, p: "97000", s: "0.001", r: false, t: { limit: { tif: "Gtc" } } };
}

function okResponse(count: number) {
  return {
    status: "ok",
    response: {
      type: "order",
      data: { statuses: Array.from({ length: count }, (_, i) => ({ resting: { oid: i + 1 } })) },
    },
  };
}

function client(order: unknown) {
  return { order } as never;
}

describe("placeOrders", () => {
  beforeEach(() => {
    clearPending();
  });

  it("refuses to trade without an approved agent, before spending anything", async () => {
    const budget = new ActionBudget();
    await expect(
      placeOrders({
        client: client(async () => okResponse(1)),
        identity,
        agentStatus: { kind: "approval_required", reason: "no_local_key" },
        budget,
        orders: [leg()],
        now: () => NOW,
      })
    ).rejects.toThrow(HlError);

    expect(budget.snapshot(identity).used).toBe(0);
    expect(listPending()).toHaveLength(0);
  });

  it("still trades while the agent is merely due for rotation", async () => {
    const outcome = await placeOrders({
      client: client(async () => okResponse(1)),
      identity,
      agentStatus: { kind: "rotation_due", account: ready.account, validUntil: NOW + 1000 },
      budget: new ActionBudget(),
      orders: [leg()],
      now: () => NOW,
    });
    expect(outcome.kind).toBe("settled");
  });

  it("refuses when the action budget is exhausted, and says when to retry", async () => {
    const budget = new ActionBudget();
    budget.seed(identity, { limit: 1, used: 1 });

    await expect(
      placeOrders({
        client: client(async () => okResponse(1)),
        identity,
        agentStatus: ready,
        budget,
        orders: [leg()],
        now: () => NOW,
      })
    ).rejects.toThrow(/rate limit/i);
    expect(listPending()).toHaveLength(0);
  });

  it("checks the WHOLE batch against the budget, not one leg", async () => {
    const budget = new ActionBudget();
    budget.seed(identity, { limit: 2, used: 0 });

    await expect(
      placeOrders({
        client: client(async () => okResponse(3)),
        identity,
        agentStatus: ready,
        budget,
        orders: [leg(), leg(), leg()],
        now: () => NOW,
      })
    ).rejects.toThrow(/rate limit/i);
  });

  it("mints a cloid for every leg", async () => {
    let sent: { orders: OrderLeg[] } | undefined;
    await placeOrders({
      client: client(async (p: { orders: OrderLeg[] }) => {
        sent = p;
        return okResponse(2);
      }),
      identity,
      agentStatus: ready,
      budget: new ActionBudget(),
      orders: [leg(), leg()],
      now: () => NOW,
    });
    expect(sent!.orders.every((o) => typeof o.c === "string")).toBe(true);
    expect(new Set(sent!.orders.map((o) => o.c)).size).toBe(2);
  });

  it("journals the submit BEFORE sending, so an app kill cannot lose the handle", async () => {
    let pendingAtSendTime = 0;
    await placeOrders({
      client: client(async () => {
        // Observed from inside the request: the journal must already be written.
        pendingAtSendTime = listPending().length;
        return okResponse(1);
      }),
      identity,
      agentStatus: ready,
      budget: new ActionBudget(),
      orders: [leg()],
      now: () => NOW,
    });
    expect(pendingAtSendTime).toBe(1);
  });

  it("clears the journal once the outcome is known", async () => {
    await placeOrders({
      client: client(async () => okResponse(1)),
      identity,
      agentStatus: ready,
      budget: new ActionBudget(),
      orders: [leg()],
      now: () => NOW,
    });
    expect(listPending()).toHaveLength(0);
  });

  it("LEAVES the journal entry when the outcome is unknown", async () => {
    // This entry is what the startup reconciler picks up.
    const outcome = await placeOrders({
      client: client(async () => {
        throw Object.assign(new Error("timeout"), { name: "HttpRequestError" });
      }),
      identity,
      agentStatus: ready,
      budget: new ActionBudget(),
      orders: [leg()],
      now: () => NOW,
    });

    expect(outcome.kind).toBe("unknown");
    const pending = listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].expiresAt).toBeGreaterThan(NOW);
  });

  it("debits the budget by leg count", async () => {
    const budget = new ActionBudget();
    budget.seed(identity, { limit: 100, used: 0 });
    await placeOrders({
      client: client(async () => okResponse(3)),
      identity,
      agentStatus: ready,
      budget,
      orders: [leg(), leg(), leg()],
      now: () => NOW,
    });
    expect(budget.snapshot(identity).used).toBe(3);
  });

  it("routes a sub-account order through vaultAddress", async () => {
    const subIdentity = createIdentity({
      env: "testnet",
      accountId: "acc",
      address: ADDRESS,
      subAccount: SUB,
    });
    let opts: Record<string, unknown> | undefined;
    await placeOrders({
      client: client(async (_p: unknown, o: Record<string, unknown>) => {
        opts = o;
        return okResponse(1);
      }),
      identity: subIdentity,
      agentStatus: ready,
      budget: new ActionBudget(),
      orders: [leg()],
      now: () => NOW,
    });
    expect(opts?.vaultAddress).toBe(SUB);
  });

  it("journals under the sub-account's own scope", async () => {
    const subIdentity = createIdentity({
      env: "testnet",
      accountId: "acc",
      address: ADDRESS,
      subAccount: SUB,
    });
    await placeOrders({
      client: client(async () => {
        throw Object.assign(new Error("timeout"), { name: "HttpRequestError" });
      }),
      identity: subIdentity,
      agentStatus: ready,
      budget: new ActionBudget(),
      orders: [leg()],
      now: () => NOW,
    });
    expect(listPending()[0].address).toBe(SUB);
  });
});
