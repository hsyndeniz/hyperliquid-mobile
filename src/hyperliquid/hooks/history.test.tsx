/**
 * Real mount/commit cycles for the one-shot history reads.
 *
 * The two failures worth catching here are both invisible to a selector test:
 *
 * - **Account A's transfers under account B's header.** It comes from React
 *   retaining state across a prop change, so it only shows in a real re-render.
 * - **A response landing after a switch.** Same cause, opposite direction — the
 *   fetch for A resolves while B is on screen.
 *
 * The weight budget is real, not mocked: `tryRun` spends synchronously before
 * awaiting, and stubbing it would hide the `null`-is-deferred contract that the
 * `deferred` state depends on.
 */

import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { restCache } from "@/hyperliquid/api/restCache";
import { weightBudget } from "@/hyperliquid/api/weightBudget";
import { useLedger, type Fetched, type LedgerView } from "@/hyperliquid/hooks/history";
import type { Hex } from "@/hyperliquid/types/domain";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;

/**
 * Rows in the real wire shape, tagged with their user so a mix-up is visible.
 *
 * `type` lives INSIDE `delta` on the wire — `parseLedger` lifts it out. A
 * fixture with `type` at the top level parses to zero rows, which is exactly
 * what a "ready but empty" bug looks like.
 */
function rowsFor(user: Hex) {
  return [{ time: 1, hash: `0x${user.slice(2, 6)}`, delta: { type: "deposit", usdc: "10" } }];
}

let mockResolvers: Map<string, (rows: unknown) => void>;

jest.mock("@/hyperliquid/api/clients", () => ({
  getInfoClient: () => ({
    userNonFundingLedgerUpdates: ({ user }: { user: Hex }) =>
      new Promise((resolve) => {
        mockResolvers.set(user.toLowerCase(), resolve);
      }),
  }),
}));

/**
 * A probe and its capture, built per test.
 *
 * `react-hooks/globals` rejects a component writing to any binding declared
 * outside it, so the capture has to be a local the probe closes over — which is
 * also what keeps one test's last-seen state from leaking into the next.
 */
function makeProbe(): {
  Probe: (props: { user: Hex | null }) => null;
  seen: () => Fetched<LedgerView>;
  refresh: () => void;
} {
  const states: Fetched<LedgerView>[] = [];
  const refreshers: (() => void)[] = [];
  function Probe({ user }: { user: Hex | null }): null {
    const result = useLedger(user);
    states.push(result.state);
    refreshers.push(result.refresh);
    return null;
  }
  return {
    Probe,
    seen: () => states[states.length - 1] ?? { kind: "idle" },
    refresh: () => refreshers[refreshers.length - 1]?.(),
  };
}

/** Let the deferred-a-tick effect fire and any resolved promise flush. */
async function settle(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(1);
    await Promise.resolve();
  });
}

describe("useLedger", () => {
  let tree: ReactTestRenderer;

  beforeEach(() => {
    jest.useFakeTimers();
    mockResolvers = new Map();
    // Both singletons are process-wide — one IP, one cache — so each carries
    // between tests. A stale hit here would silently answer the deferred case
    // with a cached "ready", which is exactly what it did before this line.
    restCache.invalidate();
    // The budget is a process-wide singleton — one IP, one allowance — so it
    // carries spends between tests. Advancing past the sliding window ages them
    // out, which is the same mechanism production relies on.
    jest.advanceTimersByTime(120_000);
  });

  afterEach(() => {
    act(() => tree?.unmount());
    jest.useRealTimers();
  });

  it("is idle — not empty — when there is no session", async () => {
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe user={null} />);
    });
    // "idle" is what renders "start a session"; "ready" with no rows would
    // render "you have no transfers", which is a claim about the account.
    expect(probe.seen().kind).toBe("idle");
  });

  it("is loading — not empty — before the first response", async () => {
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe user={A} />);
    });
    await settle();
    expect(probe.seen().kind).toBe("loading");
  });

  it("reads ready once the response lands", async () => {
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe user={A} />);
    });
    await settle();
    await act(async () => {
      mockResolvers.get(A)?.(rowsFor(A));
      await Promise.resolve();
    });
    const state = probe.seen();
    expect(state.kind).toBe("ready");
    expect(state.kind === "ready" && state.value.rows.length).toBe(1);
  });

  it("does NOT show the previous account's rows after a switch", async () => {
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe user={A} />);
    });
    await settle();
    await act(async () => {
      mockResolvers.get(A)?.(rowsFor(A));
      await Promise.resolve();
    });
    expect(probe.seen().kind).toBe("ready");

    // The switch itself, before B's request can possibly have returned.
    await act(async () => {
      tree.update(<probe.Probe user={B} />);
    });
    // Anything but `loading` here is account A's data under account B.
    expect(probe.seen().kind).toBe("loading");
  });

  it("drops a response that arrives after a switch", async () => {
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe user={A} />);
    });
    await settle();
    await act(async () => {
      tree.update(<probe.Probe user={B} />);
    });
    await settle();

    // A's fetch resolves late, while B is on screen.
    await act(async () => {
      mockResolvers.get(A)?.(rowsFor(A));
      await Promise.resolve();
    });
    expect(probe.seen().kind).toBe("loading");
  });

  it("returns to idle when the session ends", async () => {
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe user={A} />);
    });
    await settle();
    await act(async () => {
      mockResolvers.get(A)?.(rowsFor(A));
      await Promise.resolve();
    });
    expect(probe.seen().kind).toBe("ready");

    await act(async () => {
      tree.update(<probe.Probe user={null} />);
    });
    // Not "ready" with stale rows: signing out must not leave the last
    // account's transfers readable.
    expect(probe.seen().kind).toBe("idle");
  });

  it("spends NOTHING on a remount inside the TTL", async () => {
    // The regression this guards: the Portfolio screen refetched every history
    // section on every mount, taking one mount from 20 weight to 104 and
    // dropping the mounts that fit in a minute from 58 to 11. Past that the
    // budget declines calls, and the account-value chart was the visible
    // casualty — it rendered "History deferred" instead of a chart.
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe user={A} />);
    });
    await settle();
    await act(async () => {
      mockResolvers.get(A)?.(rowsFor(A));
      await Promise.resolve();
    });
    expect(probe.seen().kind).toBe("ready");

    const spentAfterFirstMount = weightBudget.used(Date.now());
    mockResolvers.clear();

    // Unmount and mount again, exactly as a tab switch does.
    await act(async () => tree.unmount());
    const second = makeProbe();
    await act(async () => {
      tree = create(<second.Probe user={A} />);
    });
    await settle();

    // Ready on the FIRST frame — no skeleton, no request, no weight.
    expect(second.seen().kind).toBe("ready");
    expect(mockResolvers.size).toBe(0);
    expect(weightBudget.used(Date.now())).toBe(spentAfterFirstMount);
  });

  it("refresh() reaches the exchange even with a warm cache", async () => {
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe user={A} />);
    });
    await settle();
    await act(async () => {
      mockResolvers.get(A)?.(rowsFor(A));
      await Promise.resolve();
    });
    mockResolvers.clear();

    // "I just made a transfer and want to see it" must not be answered from a
    // cache, however fresh.
    await act(async () => {
      probe.refresh();
      await Promise.resolve();
    });
    expect(mockResolvers.has(A)).toBe(true);
  });

  it("reports deferred — not empty, not error — when the budget declines", async () => {
    const probe = makeProbe();
    // Drain the window so `tryRun` refuses without calling the transport.
    for (let i = 0; i < 200; i++) weightBudget.spend(20, Date.now());

    await act(async () => {
      tree = create(<probe.Probe user={A} />);
    });
    await settle();
    await act(async () => {
      await Promise.resolve();
    });

    expect(probe.seen().kind).toBe("deferred");
    // And it never reached the transport, so there is nothing to resolve.
    expect(mockResolvers.has(A)).toBe(false);
  });
});
