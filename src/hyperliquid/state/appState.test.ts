import {
  AppStatePolicy,
  RESUBSCRIBE_AFTER_BACKGROUND_MS,
  decideOnResume,
} from "@/hyperliquid/state/appState";

describe("decideOnResume", () => {
  it("keeps a healthy connection after a brief absence", () => {
    // Tearing down a working socket because the user glanced at another app
    // costs a reconnect and a visible gap for no reason.
    const decision = decideOnResume({ awayMs: 2_000, connectionState: "open" });
    expect(decision.shouldResubscribe).toBe(false);
  });

  it("still marks data stale after even a brief absence", () => {
    // The stream had a gap; nothing on screen is provably current.
    expect(decideOnResume({ awayMs: 500, connectionState: "open" }).shouldMarkStale).toBe(true);
  });

  it("resubscribes after a long absence", () => {
    // Hyperliquid drops a connection silent for ~60s, so past the threshold the
    // socket has very likely gone regardless of what the client believes.
    const decision = decideOnResume({
      awayMs: RESUBSCRIBE_AFTER_BACKGROUND_MS + 1,
      connectionState: "open",
    });
    expect(decision.shouldResubscribe).toBe(true);
  });

  it("is inclusive at the threshold", () => {
    expect(
      decideOnResume({ awayMs: RESUBSCRIBE_AFTER_BACKGROUND_MS, connectionState: "open" })
        .shouldResubscribe
    ).toBe(true);
  });

  it("resubscribes immediately when the socket is terminated, however brief the absence", () => {
    const decision = decideOnResume({ awayMs: 10, connectionState: "terminated" });
    expect(decision.shouldResubscribe).toBe(true);
  });

  it("resubscribes when there is no transport at all", () => {
    expect(decideOnResume({ awayMs: 10, connectionState: "idle" }).shouldResubscribe).toBe(true);
  });

  it("does not rebuild mid-reconnect — the transport is already handling it", () => {
    expect(decideOnResume({ awayMs: 100, connectionState: "connecting" }).shouldResubscribe).toBe(
      false
    );
  });
});

describe("decideOnResume: WHICH rebuild, not just whether", () => {
  // The mode exists because releasing subscriptions is only safe when the
  // socket can carry the re-add. Get this wrong mid-reconnect and every account
  // channel dies with nothing left to re-drive it.
  it("does NOTHING while the transport is reconnecting", () => {
    // The SDK preserves its subscription map across a non-terminal close and
    // replays it on open, with the original listeners. Our release deletes from
    // that map, and the replacement frames cannot land on a socket that is not
    // open — so acting here destroys the recovery instead of performing it.
    const d = decideOnResume({ awayMs: 10 * 60_000, connectionState: "connecting" });
    expect(d.mode).toBe("none");
    expect(d.shouldResubscribe).toBe(false);
    // Still stale: a ten-minute gap is a gap whoever fixes it.
    expect(d.shouldMarkStale).toBe(true);
  });

  it("rebuilds the transport when it is terminated or absent", () => {
    // A terminated socket has already had every subscription failed by the SDK
    // and will not replay, so re-adding on it can never work.
    expect(decideOnResume({ awayMs: 0, connectionState: "terminated" }).mode).toBe("rebuild");
    expect(decideOnResume({ awayMs: 0, connectionState: "idle" }).mode).toBe("rebuild");
  });

  it("releases and re-adds only on an OPEN socket after a long absence", () => {
    expect(decideOnResume({ awayMs: 10 * 60_000, connectionState: "open" }).mode).toBe("live");
  });

  it("leaves a short absence on an open socket alone", () => {
    const d = decideOnResume({ awayMs: 1_000, connectionState: "open" });
    expect(d.mode).toBe("none");
    expect(d.shouldResubscribe).toBe(false);
  });
});

describe("AppStatePolicy", () => {
  function policy(overrides: Partial<Parameters<typeof buildOptions>[0]> = {}) {
    return buildOptions(overrides);
  }

  function buildOptions(o: {
    connectionState?: "idle" | "connecting" | "open" | "terminated";
    clock?: { value: number };
  }) {
    const clock = o.clock ?? { value: 1_800_000_000_000 };
    const calls = { resubscribe: 0, markStale: 0 };
    const instance = new AppStatePolicy({
      resubscribe: async () => {
        calls.resubscribe += 1;
      },
      markStale: () => {
        calls.markStale += 1;
      },
      connectionState: () => o.connectionState ?? "open",
      now: () => clock.value,
    });
    return { instance, calls, clock };
  }

  it("does not close the transport on background — closing is permanent", async () => {
    const { instance, calls } = policy();
    await instance.onPhaseChange("background");
    expect(calls.resubscribe).toBe(0);
    expect(calls.markStale).toBe(0);
    expect(instance.currentPhase).toBe("background");
  });

  it("marks stale but keeps the connection on a short absence", async () => {
    const { instance, calls, clock } = policy();
    await instance.onPhaseChange("background");
    clock.value += 3_000;
    await instance.onPhaseChange("active");

    expect(calls.markStale).toBe(1);
    expect(calls.resubscribe).toBe(0);
  });

  it("rebuilds subscriptions after a long absence", async () => {
    const { instance, calls, clock } = policy();
    await instance.onPhaseChange("background");
    clock.value += RESUBSCRIBE_AFTER_BACKGROUND_MS + 1_000;
    await instance.onPhaseChange("active");

    expect(calls.resubscribe).toBe(1);
    expect(calls.markStale).toBe(1);
  });

  it("marks stale BEFORE resubscribing, so nothing renders as live meanwhile", async () => {
    const order: string[] = [];
    const clock = { value: 0 };
    const instance = new AppStatePolicy({
      resubscribe: async () => {
        order.push("resubscribe");
      },
      markStale: () => order.push("markStale"),
      connectionState: () => "terminated",
      now: () => clock.value,
    });

    await instance.onPhaseChange("background");
    clock.value += 1_000;
    await instance.onPhaseChange("active");

    expect(order).toEqual(["markStale", "resubscribe"]);
  });

  it("leaves surfaces stale when the rebuild fails, which is the safe state", async () => {
    const clock = { value: 0 };
    let marked = 0;
    const instance = new AppStatePolicy({
      resubscribe: async () => {
        throw new Error("still offline");
      },
      markStale: () => {
        marked += 1;
      },
      connectionState: () => "terminated",
      now: () => clock.value,
    });

    await instance.onPhaseChange("background");
    clock.value += 1_000;
    await expect(instance.onPhaseChange("active")).resolves.toBeDefined();
    expect(marked).toBe(1);
  });

  it("ignores repeated transitions to the same phase", async () => {
    const { instance, calls } = policy();
    await instance.onPhaseChange("background");
    expect(await instance.onPhaseChange("background")).toBeNull();
    await instance.onPhaseChange("active");
    expect(await instance.onPhaseChange("active")).toBeNull();
    expect(calls.markStale).toBe(1);
  });

  it("handles a resume with no recorded background — a cold start", async () => {
    const { instance } = policy();
    const decision = await instance.onPhaseChange("active");
    expect(decision).toBeNull(); // already active
  });
});

describe("secrets do not stay in the heap while suspended", () => {
  it("locks the vault on backgrounding", async () => {
    // `lockVault` shipped with the docstring "for lock-on-background" and no
    // caller at all, so the AES key that decrypts the recovery phrase lived in
    // the JS heap for the whole time the app was suspended — the one window
    // where a memory capture is plausible.
    let locked = 0;
    const policy = new AppStatePolicy({
      resubscribe: async () => undefined,
      markStale: () => undefined,
      connectionState: () => "open",
      lockSecrets: () => {
        locked += 1;
      },
    });

    await policy.onPhaseChange("background");
    expect(locked).toBe(1);
  });

  it("does not lock on the way back in — that would be a re-read per resume", async () => {
    let locked = 0;
    const policy = new AppStatePolicy({
      resubscribe: async () => undefined,
      markStale: () => undefined,
      connectionState: () => "open",
      lockSecrets: () => {
        locked += 1;
      },
    });

    await policy.onPhaseChange("background");
    await policy.onPhaseChange("active");
    expect(locked).toBe(1);
  });
});
