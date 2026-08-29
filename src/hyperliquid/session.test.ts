/**
 * Lifecycle tests for the composition root.
 *
 * The SDK, the wallet and the agent gate are mocked so this can drive the real
 * `HyperliquidSession` and observe what it does to the transport — which is the
 * only way to catch the class of bug this file exists to prevent: a session that
 * looks alive while every feed is dead.
 */

// `mock`-prefixed: jest hoists `jest.mock` factories above these declarations
// and refuses any other out-of-scope reference.
const mockWsInstances: { closed: boolean }[] = [];
const mockSubscribeCalls: string[] = [];
const mockAgent: { kind: string; gate: Promise<void> | null } = {
  kind: "approval_required",
  gate: null,
};
const mockInfo: {
  subAccounts2: unknown;
  subAccountsThrows: boolean;
  rateLimit: unknown;
  rateLimitCalls: string[];
  leadingVaults: unknown;
  leadingVaultsThrows: boolean;
  leadingVaultsCalls: string[];
} = {
  subAccounts2: null,
  subAccountsThrows: false,
  rateLimit: null,
  rateLimitCalls: [],
  leadingVaults: [],
  leadingVaultsThrows: false,
  leadingVaultsCalls: [],
};

jest.mock("@nktkas/hyperliquid", () => {
  class WebSocketTransport {
    closed = false;
    constructor() {
      mockWsInstances.push(this);
    }
    close() {
      this.closed = true;
    }
    ready() {
      return Promise.resolve();
    }
  }
  class HttpTransport {}
  class InfoClient {
    userRole = async () => ({ role: "user" });
    extraAgents = async () => [];
    subAccounts2 = async () => {
      if (mockInfo.subAccountsThrows) throw new Error("info unreachable");
      return mockInfo.subAccounts2;
    };
    userRateLimit = async (params: { user: string }) => {
      mockInfo.rateLimitCalls.push(params.user);
      return mockInfo.rateLimit;
    };
    leadingVaults = async (params: { user: string }) => {
      mockInfo.leadingVaultsCalls.push(params.user);
      if (mockInfo.leadingVaultsThrows) throw new Error("info unreachable");
      return mockInfo.leadingVaults;
    };
  }
  class ExchangeClient {}
  class SubscriptionClient {
    private make(channel: string) {
      return async () => {
        mockSubscribeCalls.push(channel);
        return { unsubscribe: async () => undefined };
      };
    }
    clearinghouseState = this.make("clearinghouseState");
    openOrders = this.make("openOrders");
    spotState = this.make("spotState");
    userFills = this.make("userFills");
    userTwapSliceFills = this.make("userTwapSliceFills");
    orderUpdates = this.make("orderUpdates");
    notification = this.make("notification");
  }
  return { WebSocketTransport, HttpTransport, InfoClient, ExchangeClient, SubscriptionClient };
});

const SIGNER_ADDRESS = "0x5bf8287baeda8de01c88b3016d64f3875b0b4347";

const mockSigner = { fail: false };

jest.mock("@/hyperliquid/wallet/accounts", () => ({
  signerFor: async () => {
    if (mockSigner.fail) throw new Error("wallet locked");
    return {
      address: SIGNER_ADDRESS,
      kind: "silent",
      label: "Test",
      account: { address: SIGNER_ADDRESS, signTypedData: async () => "0x" },
    };
  },
}));

jest.mock("@/hyperliquid/auth/session", () => ({
  ensureAgentReady: async () => {
    // A hold point INSIDE the start, so a test can land a `stop()` mid-flight.
    if (mockAgent.gate) await mockAgent.gate;
    return {
      status: { kind: mockAgent.kind },
      activated: true,
      registeredAgents: [],
    };
  },
}));

jest.mock("@/hyperliquid/orders/startupReconcile", () => ({
  reconcilePendingSubmits: async () => ({
    landed: [],
    notLanded: [],
    unresolved: [],
    deferred: 0,
  }),
}));

// eslint-disable-next-line import/first -- must load AFTER the jest.mock calls above.
import { HyperliquidSession } from "@/hyperliquid/session";
// eslint-disable-next-line import/first
import { ACCOUNT_CHANNELS } from "@/hyperliquid/state/accountSession";
// eslint-disable-next-line import/first
import { actionBudget } from "@/hyperliquid/api/rateLimit";
// eslint-disable-next-line import/first
import { weightBudget } from "@/hyperliquid/api/weightBudget";
// eslint-disable-next-line import/first
import { createIdentity } from "@/hyperliquid/core/identity";

const SUB = "0x2222222222222222222222222222222222222222";

function anyIdentity(subAccount: string | null) {
  return createIdentity({
    env: "testnet",
    accountId: SIGNER_ADDRESS,
    address: SIGNER_ADDRESS,
    subAccount,
  });
}

/** One `subAccounts2` row, in the wire's shape. */
function subAccountRow(address: string) {
  return {
    name: "trading",
    subAccountUser: address,
    master: SIGNER_ADDRESS,
    dexToClearinghouseState: [],
    spotState: { balances: [] },
  };
}

function liveSockets(): number {
  return mockWsInstances.filter((ws) => !ws.closed).length;
}

beforeEach(() => {
  mockWsInstances.length = 0;
  mockSubscribeCalls.length = 0;
  mockAgent.kind = "approval_required";
  mockAgent.gate = null;
  mockSigner.fail = false;
  mockInfo.subAccounts2 = null;
  mockInfo.subAccountsThrows = false;
  mockInfo.rateLimit = null;
  mockInfo.rateLimitCalls.length = 0;
  mockInfo.leadingVaults = [];
  mockInfo.leadingVaultsThrows = false;
  mockInfo.leadingVaultsCalls.length = 0;
  // A module global with a one-minute rolling window. A `start()` spends 42 of
  // the 1200/min allowance — subAccounts2 (20) + leadingVaults (20) +
  // userRateLimit (2) — which is ~28 starts per minute and fine in practice.
  // This suite does 28 of them in under a second, so the window never drains and
  // the later tests would be refused before reaching their probes.
  weightBudget.clear();
  actionBudget.forget(anyIdentity(SUB));
  actionBudget.forget(anyIdentity(null));
});

describe("starting a session", () => {
  it("subscribes every account channel on a fresh start", async () => {
    // Counted against ACCOUNT_CHANNELS rather than a literal. A literal passed
    // at 6 for a while after `notification` became the 7th: the mock had no
    // such method, its subscribe threw, and `Promise.allSettled` swallowed it —
    // the test asserting "every channel" was green with one missing.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    expect(mockSubscribeCalls).toHaveLength(ACCOUNT_CHANNELS.length);
    expect([...mockSubscribeCalls].sort()).toEqual([...ACCOUNT_CHANNELS].sort());
    expect(liveSockets()).toBe(1);
    await session.stop();
  });

  it("points each store at its OWN channel", async () => {
    // A store targeted at another channel rejects every event it is handed,
    // silently — open orders and spot balances simply never appear.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    expect(session.stores.account.currentTarget()?.channel).toBe("clearinghouseState");
    expect(session.stores.openOrders.currentTarget()?.channel).toBe("openOrders");
    expect(session.stores.fills.currentTarget()?.channel).toBe("userFills");
    expect(session.stores.spot.currentTarget()?.channel).toBe("spotState");
    await session.stop();
  });
});

describe("restarting for the SAME identity", () => {
  it("leaves the websocket open and the subscriptions live", async () => {
    // The flow this class invites: start read-only at launch, then start again
    // with `approveAgent` when the user opts into trading. `configureClients`
    // closes the socket, and `switchTo` correctly does nothing for an unchanged
    // identity — so an unguarded reconfigure killed every feed with nothing
    // left to re-open it, and the registry's `active` entries made it
    // unrecoverable without a full stop.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });
    const socketsAfterFirst = liveSockets();
    const subscribesAfterFirst = mockSubscribeCalls.length;

    mockAgent.kind = "ready";
    await session.start({ env: "testnet", approveAgent: true });

    expect(liveSockets()).toBe(socketsAfterFirst);
    expect(liveSockets()).toBe(1);
    // No churn either: a healthy socket is not torn down and re-subscribed.
    expect(mockSubscribeCalls).toHaveLength(subscribesAfterFirst);
    await session.stop();
  });

  it("still reflects the newly approved agent", async () => {
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });
    expect(session.canTrade()).toBe(false);

    mockAgent.kind = "ready";
    await session.start({ env: "testnet", approveAgent: true });

    expect(session.canTrade()).toBe(true);
    await session.stop();
  });
});

describe("switching to a DIFFERENT identity", () => {
  it("rebuilds the transport and resubscribes", async () => {
    // The per-identity transport rule: `orderUpdates` frames carry no user
    // field, so two accounts on one socket cannot be told apart downstream.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet", accountId: "A" });
    await session.start({ env: "testnet", accountId: "B" });

    expect(mockWsInstances.length).toBeGreaterThanOrEqual(2);
    expect(liveSockets()).toBe(1);
    expect(mockSubscribeCalls).toHaveLength(ACCOUNT_CHANNELS.length * 2);
    await session.stop();
  });
});

describe("overlapping starts", () => {
  it("serialises rather than putting two identities on one transport", async () => {
    // Without a guard the two runs interleave teardown and setup, and both
    // identities can end up subscribed on the same socket.
    const session = new HyperliquidSession();

    await Promise.all([
      session.start({ env: "testnet", accountId: "A" }),
      session.start({ env: "testnet", accountId: "B" }),
    ]);

    expect(liveSockets()).toBe(1);
    // Exactly one identity is current, and every store agrees with it.
    const identity = session.state()?.identity;
    expect(identity).toBeDefined();
    for (const store of Object.values(session.stores)) {
      expect(store.currentTarget()?.identity.accountId).toBe(identity?.accountId);
    }
    await session.stop();
  });
});

describe("stopping", () => {
  it("closes the socket and clears every store", async () => {
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });
    await session.stop();

    expect(liveSockets()).toBe(0);
    expect(session.state()).toBeNull();
    expect(session.stores.account.read()).toBeNull();
    expect(session.stores.spot.read()).toBeNull();
  });

  it("can start again afterwards", async () => {
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });
    await session.stop();

    mockSubscribeCalls.length = 0;
    await session.start({ env: "testnet" });

    expect(mockSubscribeCalls).toHaveLength(ACCOUNT_CHANNELS.length);
    expect(liveSockets()).toBe(1);
    await session.stop();
  });
});

describe("the trading gate", () => {
  it("refuses an exchange client until the agent is ready", async () => {
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    expect(session.canTrade()).toBe(false);
    expect(() => session.exchangeClient()).toThrow(/not approved/);
    // The master client is always available — transfers need it and it does not
    // depend on the agent at all.
    expect(() => session.masterClient()).not.toThrow();
    await session.stop();
  });

  it("refuses both before any session exists", () => {
    const session = new HyperliquidSession();
    expect(() => session.exchangeClient()).toThrow(/No session/);
    expect(() => session.masterClient()).toThrow(/No session/);
  });

  it("still allows trading while the agent is due for rotation", async () => {
    // `rotation_due` means "rotate this soon", not "stop trading" — the agent is
    // still valid, and `ensureAgentReady` returns it as-is precisely to avoid
    // prompting mid-trade. Gating on `ready` alone locked the user out for the
    // agent's final 24 hours, inverting what the threshold is for.
    mockAgent.kind = "rotation_due";
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    expect(session.canTrade()).toBe(true);
    expect(session.needsAgentRotation()).toBe(true);
    await session.stop();
  });

  it("does not flag rotation for a healthy agent", async () => {
    mockAgent.kind = "ready";
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    expect(session.canTrade()).toBe(true);
    expect(session.needsAgentRotation()).toBe(false);
    await session.stop();
  });
});

describe("a start() that fails must not leave a lie behind", () => {
  it("reports no session when an env switch fails partway", async () => {
    // `configureClients` closes every client and rebinds the module-global
    // config BEFORE the fallible awaits, so a failure after it would otherwise
    // leave the old session published against clients that no longer exist —
    // accessors reporting a live session on a network nothing is bound to.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });
    expect(session.state()).not.toBeNull();

    mockSigner.fail = true;
    await expect(session.start({ env: "mainnet" })).rejects.toThrow(/wallet locked/);

    expect(session.state()).toBeNull();
    expect(liveSockets()).toBe(0);
    expect(() => session.exchangeClient()).toThrow(/No session/);
  });

  it("leaves a healthy same-env session untouched when a restart fails", async () => {
    // Nothing was reconfigured, so there is nothing to unwind — the previous
    // session genuinely is still live and must keep working.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });
    const before = session.state();

    mockSigner.fail = true;
    await expect(session.start({ env: "testnet" })).rejects.toThrow(/wallet locked/);

    expect(session.state()).toBe(before);
    expect(liveSockets()).toBe(1);
    await session.stop();
  });

  it("can start again cleanly after a failed switch", async () => {
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });
    mockSigner.fail = true;
    await expect(session.start({ env: "mainnet" })).rejects.toThrow();

    mockSigner.fail = false;
    mockSubscribeCalls.length = 0;
    await session.start({ env: "mainnet" });

    expect(mockSubscribeCalls).toHaveLength(ACCOUNT_CHANNELS.length);
    expect(liveSockets()).toBe(1);
    await session.stop();
  });
});

describe("selecting a sub-account", () => {
  it("refuses an address that is not one of the master's", async () => {
    // The decisive guard. A foreign or mistyped address passes `createIdentity`
    // untouched, and the stores' echo guard compares against that SAME wrong
    // address — so it agrees, and the user gets a calm, well-formed, entirely
    // empty portfolio belonging to a stranger.
    mockInfo.subAccounts2 = [subAccountRow(SUB)];
    const session = new HyperliquidSession();

    await expect(
      session.start({ env: "testnet", subAccount: "0x9999999999999999999999999999999999999999" })
    ).rejects.toThrow(/not one of this account/);
    expect(session.state()).toBeNull();
  });

  it("accepts a real one, case-insensitively", async () => {
    mockInfo.subAccounts2 = [subAccountRow(SUB)];
    const session = new HyperliquidSession();

    const state = await session.start({
      env: "testnet",
      subAccount: SUB.toUpperCase().replace("0X", "0x"),
    });

    expect(state.identity.subAccount).toBe(SUB);
    expect(state.subAccounts).toHaveLength(1);
    await session.stop();
  });

  it("refuses when the list could not be read at all", async () => {
    // Unverifiable is not the same as fine. Selecting a sub-account is an
    // explicit act, and proceeding on an unchecked address is the one outcome
    // with no visible symptom.
    mockInfo.subAccountsThrows = true;
    const session = new HyperliquidSession();

    await expect(session.start({ env: "testnet", subAccount: SUB })).rejects.toThrow(
      /Cannot verify/
    );
  });

  it("still starts on the master when the list is unreadable", async () => {
    // A failure to READ is not a failure to start. `null` is carried through,
    // deliberately distinct from `[]` — "we do not know" must not render as
    // "you have none".
    mockInfo.subAccountsThrows = true;
    const session = new HyperliquidSession();

    const state = await session.start({ env: "testnet" });

    expect(state.subAccounts).toBeNull();
    await session.stop();
  });

  it("reports an empty list as [], not null", async () => {
    // The majority case: `subAccounts2` answers `null` for "has none", and
    // collapsing that into our own "unknown" would make every ordinary account
    // look like a failed read.
    mockInfo.subAccounts2 = null;
    const session = new HyperliquidSession();

    const state = await session.start({ env: "testnet" });

    expect(state.subAccounts).toEqual([]);
    await session.stop();
  });
});

describe("action budget seeding", () => {
  it("seeds against the SUB-ACCOUNT, which HL rate-limits separately", async () => {
    mockInfo.subAccounts2 = [subAccountRow(SUB)];
    mockInfo.rateLimit = { cumVlm: "0", nRequestsUsed: 5, nRequestsCap: 900, nRequestsSurplus: 0 };
    const session = new HyperliquidSession();

    await session.start({ env: "testnet", subAccount: SUB });

    expect(mockInfo.rateLimitCalls).toContain(SUB);
    expect(actionBudget.snapshot(anyIdentity(SUB))).toMatchObject({ limit: 900, used: 5 });
    await session.stop();
  });

  it("seeds AFTER the switch, which forgets the previous budget", async () => {
    // `switchTo` calls `budget.forget` on the outgoing identity. Seeding before
    // it would be erased, and an unseeded identity is assumed new — throttled to
    // the floor rather than left unlimited, so the symptom is a user who cannot
    // trade rather than one who over-sends.
    mockInfo.rateLimit = {
      cumVlm: "0",
      nRequestsUsed: 0,
      nRequestsCap: 1_234,
      nRequestsSurplus: 0,
    };
    const session = new HyperliquidSession();

    await session.start({ env: "testnet" });

    expect(actionBudget.snapshot(anyIdentity(null))).toMatchObject({ limit: 1_234, used: 0 });
    await session.stop();
  });

  it("starts anyway when the budget cannot be read", async () => {
    mockInfo.rateLimit = null;
    const session = new HyperliquidSession();
    await expect(session.start({ env: "testnet" })).resolves.toBeDefined();
    await session.stop();
  });
});

describe("vaults the wallet leads", () => {
  const VAULT = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";

  it("reads them from leadingVaults, keyed on the WALLET address", async () => {
    // A vault never appears in its leader's `subAccounts2`, and `userRole` on a
    // vault gives no pointer back to its leader — so this is the only ownership
    // source, and it resolves in one direction only.
    mockInfo.leadingVaults = [{ address: VAULT, name: "My Vault" }];
    const session = new HyperliquidSession();

    const state = await session.start({ env: "testnet" });

    expect(state.ledVaults).toEqual([{ address: VAULT, name: "My Vault" }]);
    expect(mockInfo.leadingVaultsCalls).toContain(SIGNER_ADDRESS);
    await session.stop();
  });

  it("asks about the WALLET even when a sub-account is selected", async () => {
    // A sub-account leads nothing, so querying `effectiveAddress` here would
    // always answer empty and quietly hide the user's own vaults.
    mockInfo.subAccounts2 = [subAccountRow(SUB)];
    mockInfo.leadingVaults = [{ address: VAULT, name: "My Vault" }];
    const session = new HyperliquidSession();

    await session.start({ env: "testnet", subAccount: SUB });

    expect(mockInfo.leadingVaultsCalls).toContain(SIGNER_ADDRESS);
    expect(mockInfo.leadingVaultsCalls).not.toContain(SUB);
    await session.stop();
  });

  it("carries null through when the list is unreadable, not []", async () => {
    // "We do not know" must not render as "you lead no vaults" — the leader
    // screen would look identical and be wrong.
    mockInfo.leadingVaultsThrows = true;
    const session = new HyperliquidSession();

    const state = await session.start({ env: "testnet" });

    expect(state.ledVaults).toBeNull();
    await session.stop();
  });

  it("still starts the session when it cannot be read", async () => {
    // Unlike a selected sub-account, a vault is not something these parameters
    // can switch the session to, so an unreadable list costs a screen rather
    // than correctness.
    mockInfo.leadingVaultsThrows = true;
    const session = new HyperliquidSession();
    await expect(session.start({ env: "testnet" })).resolves.toBeDefined();
    await session.stop();
  });

  it("reports leading none as [], distinct from unreadable", async () => {
    mockInfo.leadingVaults = [];
    const session = new HyperliquidSession();
    const state = await session.start({ env: "testnet" });
    expect(state.ledVaults).toEqual([]);
    await session.stop();
  });
});

describe("background and foreground", () => {
  it("marks every store stale on resume, before any rebuild lands", async () => {
    // The mobile failure this exists for: an app returning after ten minutes
    // renders a book that stopped updating, with nothing saying so. iOS
    // suspends the JS thread and drops the socket without telling anyone.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    await session.onAppStateChange("background");
    const decision = await session.onAppStateChange("active");

    expect(decision?.shouldMarkStale).toBe(true);
    expect(session.stores.account.isStale(Date.now(), 60_000)).toBe(true);
    await session.stop();
  });

  it("ignores a repeat transition to the same phase", async () => {
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    await session.onAppStateChange("background");
    expect(await session.onAppStateChange("background")).toBeNull();
    await session.stop();
  });

  it("REBUILDS when the connection is not open, however brief the absence", async () => {
    // The elapsed-time threshold is only consulted for a connection that is
    // still open; an idle or terminated one is rebuilt regardless, because the
    // time test exists to guess whether a socket survived and here we already
    // know it did not.
    //
    // This is also what proves the wiring: `resubscribe` had no counterpart on
    // the session until now, so the policy could never do anything.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });
    mockSubscribeCalls.length = 0;

    await session.onAppStateChange("background");
    const decision = await session.onAppStateChange("active");

    expect(decision?.shouldResubscribe).toBe(true);
    expect(mockSubscribeCalls).toHaveLength(ACCOUNT_CHANNELS.length);
    await session.stop();
  });
});

describe("rejected events are readable", () => {
  it("exposes the per-channel tally the dispatcher keeps", async () => {
    // It accumulated into a Map with no accessor, and `record()` logs only the
    // FIRST rejection per channel — so a wire-shape change logged once and then
    // went silent with the count unreachable.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    expect(session.rejectedEvents()).toBeDefined();
    expect(session.rejectedEvents().size).toBe(0);
    await session.stop();
  });
});

describe("the session is observable", () => {
  it("notifies subscribers when a session starts", async () => {
    // Without this the session was readable but not watchable: `state()` was a
    // plain getter, so a screen could not re-render when the agent gate passed
    // and "you can trade now" was reachable only by polling.
    const session = new HyperliquidSession();
    const seen: (string | null)[] = [];
    session.subscribe(() => seen.push(session.state()?.identity.address ?? null));

    await session.start({ env: "testnet" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
    await session.stop();
  });

  it("notifies on stop, with the session ALREADY cleared", async () => {
    // Ordering matters as much as the notification. A listener that fires
    // before `current` is nulled reads the dead session and renders a logged-in
    // shell around nothing.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    const seen: (unknown | null)[] = [];
    session.subscribe(() => seen.push(session.state()));
    await session.stop();

    expect(seen).toEqual([null]);
  });

  it("notifies on an identity switch", async () => {
    mockInfo.subAccounts2 = [subAccountRow(SUB)];
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });
    await session.start({ env: "testnet", subAccount: SUB });

    expect(notifications).toBe(1);
    expect(session.state()?.identity.subAccount).toBe(SUB);
    await session.stop();
  });

  it("notifies when a failed env switch clears the session", async () => {
    // The unwind path sets `current = null` from inside a catch. An assignment
    // there that skipped the notification would leave every subscriber showing
    // a session that the accessors already refuse to serve.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    const seen: (unknown | null)[] = [];
    session.subscribe(() => seen.push(session.state()));

    mockSigner.fail = true;
    await expect(session.start({ env: "mainnet" })).rejects.toThrow(/wallet locked/);

    expect(seen).toEqual([null]);
  });

  it("does NOT notify when a same-env restart fails and the session survives", async () => {
    // Nothing changed, so nothing may be published. A spurious notification
    // here repaints a healthy screen for no reason on every transient error.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });

    mockSigner.fail = true;
    await expect(session.start({ env: "testnet" })).rejects.toThrow(/wallet locked/);

    expect(notifications).toBe(0);
    mockSigner.fail = false;
    await session.stop();
  });

  it("returns the SAME state object between changes", async () => {
    // The `getSnapshot` contract. React compares successive snapshots with
    // `Object.is`; a `state()` that rebuilt its object per call would re-render
    // forever, which is the failure `useStore.ts` is written around.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    expect(session.state()).toBe(session.state());
    await session.stop();
  });

  it("stops notifying after unsubscribe", async () => {
    const session = new HyperliquidSession();
    let notifications = 0;
    const unsubscribe = session.subscribe(() => {
      notifications += 1;
    });

    await session.start({ env: "testnet" });
    expect(notifications).toBe(1);

    unsubscribe();
    await session.stop();
    expect(notifications).toBe(1);
  });

  it("keeps notifying the others when one listener throws", async () => {
    // A screen that crashes in its own render must not stop the rest of the app
    // from learning that the account changed — nor fail the start that
    // triggered it.
    const session = new HyperliquidSession();
    let reached = false;
    session.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    session.subscribe(() => {
      reached = true;
    });

    await expect(session.start({ env: "testnet" })).resolves.toBeDefined();
    expect(reached).toBe(true);
    await session.stop();
  });
});

describe("a stop that lands during an in-flight start", () => {
  it("abandons the start rather than resurrecting the torn-down session", async () => {
    // The real sequence: the app auto-starts at launch, the user opens the
    // wallet screen and replaces the wallet, and that handler awaits `stop()`
    // first. `inFlight` chains start-to-start only, so nothing reached the
    // running start: it completed afterwards, re-subscribed every channel and
    // re-published a session holding the signer resolved BEFORE the teardown.
    // The app then signed withdrawals with the old key while the screen
    // confirmed the new wallet.
    const session = new HyperliquidSession();
    let release!: () => void;
    mockAgent.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const starting = session.start({ env: "testnet", accountId: "A" });
    await session.stop();

    release();
    await expect(starting).rejects.toMatchObject({ code: "superseded" });

    // Nothing came back: no session, no socket, no subscriptions.
    expect(session.state()).toBeNull();
    expect(liveSockets()).toBe(0);
    for (const store of Object.values(session.stores)) {
      expect(store.currentTarget()).toBeNull();
    }
  });

  it("still lets a start requested AFTER the stop succeed", async () => {
    // The epoch must cancel what preceded it, not poison the session for good.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });
    await session.stop();

    const state = await session.start({ env: "testnet" });
    expect(state.identity).toBeDefined();
    expect(session.state()).not.toBeNull();
    await session.stop();
  });
});

describe("reconciling on resume", () => {
  it("sweeps the journals when the app becomes active, not only at start", async () => {
    // `reconcile()` had ONE production caller — session start — so within a
    // single app session a completed withdrawal was never settled. The
    // withdrawal preflight reads an unsettled journal entry as the
    // `withdrawal_in_flight` blocker, so a withdrawal that actually landed in
    // four minutes still refused the next one for the full fifteen-minute
    // settlement floor, and its row stayed "in progress" until the app was
    // restarted.
    //
    // Spied on the session's own `reconcile` rather than on the journal: the
    // claim is that the RESUME reaches the sweep at all, and the sweep's own
    // behaviour has its own suite.
    const session = new HyperliquidSession();
    await session.start({ env: "testnet" });

    const swept = jest.spyOn(session, "reconcile").mockResolvedValue(undefined);
    try {
      await session.onAppStateChange("active");
      expect(swept).toHaveBeenCalledTimes(1);

      // Backgrounding must NOT sweep: it spends weight for an answer nobody is
      // waiting for, and the resume is where the useful reading happens.
      swept.mockClear();
      await session.onAppStateChange("background");
      expect(swept).not.toHaveBeenCalled();
    } finally {
      swept.mockRestore();
      await session.stop();
    }
  });

  it("does not sweep when there is no session to sweep for", async () => {
    // A resume with no live session has no identity to scope the journal read
    // to, and an unscoped sweep would judge every account's entries against
    // whichever ledger answered.
    const session = new HyperliquidSession();
    const swept = jest.spyOn(session, "reconcile").mockResolvedValue(undefined);
    try {
      await session.onAppStateChange("active");
      expect(swept).not.toHaveBeenCalled();
    } finally {
      swept.mockRestore();
    }
  });
});
