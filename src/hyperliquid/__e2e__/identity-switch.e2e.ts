/**
 * Identity switching, end to end, against live Hyperliquid testnet.
 *
 *   HL_E2E=1 bun run test:e2e --testPathPattern identity-switch
 *
 * **Why this exists.** `session.e2e.ts` proves the composition root works for
 * *one* identity. This proves it survives **changing** identity, which is where
 * the conditional wiring is and where the last two composition bugs lived: the
 * Phase 8 `vaultAddress` routing hole, and an earlier one where `agentScopeKey`
 * still carried `dex`, so every HIP-3 dex switch minted a fresh agent and
 * re-prompted the user's real wallet — three prompts and the testnet master's
 * agent allowance is exhausted.
 *
 * Five things have to hold on a switch, and each fails silently:
 *
 * 1. The stores are **cleared**, not merely guarded. A guard drops incoming
 *    events; it does not remove what is already held, so a guard-only store
 *    keeps the previous account's balance under the new account's header.
 * 2. The old identity's subscriptions go away and the transport is rebuilt.
 *    `orderUpdates` and `userEvents` frames carry no user field, so two
 *    identities on one socket is a leak nothing downstream can filter.
 * 3. The **agent is reused** across a dex switch — `agentScopeKey` drops `dex`.
 * 4. The action budget is forgotten for the old identity and re-seeded for the
 *    new one from the server's own accounting.
 * 5. A sub-account the master does not own is refused **before** anything
 *    subscribes, and leaves no session behind.
 *
 * **What it costs.** Nothing. No order, no transfer, no signature that moves
 * funds, and — deliberately — **no `approveAgent` call anywhere**: the existing
 * approved agent is seeded into the (in-memory) keychain exactly as
 * `session.e2e.ts` does it. It spends a handful of info-request weight.
 *
 * Skips itself unless `HL_E2E=1`.
 */

import { BigNumber } from "bignumber.js";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";

import { HyperliquidSession } from "@/hyperliquid/session";
import { importPrivateKey } from "@/hyperliquid/wallet/accounts";
import { storeAgentKey } from "@/hyperliquid/auth/keychain";
import { parseRegisteredAgents } from "@/hyperliquid/auth/session";
import { createIdentity, agentScopeKey, identityKey } from "@/hyperliquid/core/identity";
import { actionBudget } from "@/hyperliquid/api/rateLimit";
import { getConnectionState, getSubscriptionClient } from "@/hyperliquid/api/clients";
import { parsePerpDexs, type DexInfo } from "@/hyperliquid/dex/catalog";
import { isHlError } from "@/hyperliquid/core/errors";
import { addLogSink, createConsoleSink, setLogLevel } from "@/hyperliquid/core/logger";
import { setupHyperliquid } from "@/hyperliquid/setup";
import type { Hex, HlIdentity } from "@/hyperliquid/types/domain";
import { withRateLimitRetry } from "@/hyperliquid/__e2e__/support";

const KEY = process.env.HL_TESTNET_SIGNER_KEY;
const ENABLED = process.env.HL_E2E === "1" && Boolean(KEY);

/**
 * A real testnet address that is emphatically **not** one of our sub-accounts —
 * the deployer of the `test` builder dex, read out of `perpDexs()`.
 *
 * A random-looking hex string would test the same code path, but this one makes
 * the failure mode concrete: it is a live, funded account belonging to someone
 * else, and without the ownership check the session would subscribe to it and
 * render its portfolio as the user's own.
 */
const STRANGER = "0x5e89b26d8d66da9888c835c9bfcc2aa51813e152";

const describeE2E = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.warn(
    process.env.HL_E2E === "1"
      ? "e2e SKIPPED: HL_TESTNET_SIGNER_KEY is not set (is .env present?)"
      : "e2e SKIPPED: set HL_E2E=1 to run against live testnet"
  );
}

describeE2E("identity switching through the real session, on live testnet", () => {
  let session: HyperliquidSession;
  let masterAddress: Hex;
  const info = new InfoClient({ transport: new HttpTransport({ isTestnet: true }) });

  beforeAll(async () => {
    setLogLevel("warn");
    addLogSink(createConsoleSink());

    // The module bootstrap, as `src/app/_layout.tsx` calls it. Without it the
    // vault has no AES-GCM backend and `importPrivateKey` refuses to run.
    setupHyperliquid();

    const derived = await importPrivateKey(KEY as string);
    masterAddress = derived.address;

    // Seed the ALREADY-APPROVED agent under the master's scope. The testnet
    // master's allowance is three agents and all three are used, so approving is
    // not merely wasteful here — it is unavailable. Everything below therefore
    // runs with `approveAgent` omitted, which also makes the reuse assertions
    // sharp: if `agentScopeKey` regained `dex`, the keychain lookup after a dex
    // switch would miss and the gate would report `approval_required` rather
    // than silently minting a replacement.
    const identity = createIdentity({
      env: "testnet",
      accountId: masterAddress,
      address: masterAddress,
    });
    await storeAgentKey(identity, deriveApprovedAgentKey(masterAddress));

    session = new HyperliquidSession();
  }, 60_000);

  afterAll(async () => {
    await session?.stop().catch(() => undefined);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Deliberately FIRST, while `session.state()` is still null. The guard's
  // promise is "nothing was subscribed", and that is only observable before a
  // healthy session exists to fall back on.
  describe("1. a sub-account the master does not own", () => {
    it("is refused before anything subscribes, and leaves no session", async () => {
      const error = await session
        .start({ env: "testnet", subAccount: STRANGER })
        .then(() => null)
        .catch((thrown: unknown) => thrown);

      // Not a generic throw: the specific refusal, so a network blip cannot be
      // mistaken for the guard firing.
      expect(isHlError(error)).toBe(true);
      if (!isHlError(error)) throw new Error("unreachable");
      expect(error.code).toBe("not_authorized");
      // `not_owned` rather than `subaccounts_unreadable` — the list WAS read
      // (this account has none) and the address was judged against it. The other
      // reason would mean the check never ran.
      expect(error.context?.reason).toBe("not_owned");

      // The whole point. A published session here would mean the stores are
      // pointed at a stranger's address, and the stores' echo guard compares
      // against that *same* wrong address — so it agrees, and the user gets a
      // calm, well-formed, entirely empty portfolio belonging to someone else.
      expect(session.state()).toBeNull();
      expect(session.canTrade()).toBe(false);

      // Nothing was pointed anywhere, and nothing is holding data.
      for (const store of [
        session.stores.account,
        session.stores.openOrders,
        session.stores.fills,
        session.stores.spot,
      ]) {
        expect(store.currentTarget()).toBeNull();
      }
      expect(session.stores.account.read()).toBeNull();

      // No socket was opened, and none was left dangling. An orphaned
      // `WebSocketTransport` reconnects forever by default, so a failed switch
      // that leaks one costs a live connection per attempt.
      expect(getConnectionState()).toBe("idle");
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe("2. the master's own identity starts", () => {
    it("starts on the main dex with the SEEDED agent and a server-seeded budget", async () => {
      const state = await withRateLimitRetry("session.start", () =>
        session.start({ env: "testnet" })
      );

      expect(state.identity.env).toBe("testnet");
      expect(state.identity.address.toLowerCase()).toBe(masterAddress.toLowerCase());
      // `null`, not `""`. The wire spells the main perp dex as the empty string;
      // `null` is our canonical form, and two spellings for one dex would mean
      // two cache keys for one account.
      expect(state.identity.dex).toBeNull();
      expect(state.identity.subAccount).toBeNull();
      expect(["ready", "rotation_due"]).toContain(state.agent.status.kind);
      expect(session.canTrade()).toBe(true);

      // Seeded from `userRateLimit`, not defaulted. `limit` alone cannot show
      // this — the unseeded floor is also 10,000 — but `used` can: the server
      // has counted real requests for this address, and an unseeded identity
      // reports `used: 0`.
      const budget = actionBudget.snapshot(state.identity);
      expect(budget.used).toBeGreaterThan(0);
      expect(budget.limit).toBeGreaterThanOrEqual(budget.used);
    }, 90_000);

    it("reports [] sub-accounts where the wire says null, keeping the two distinguishable", async () => {
      // The raw endpoint answers a literal `null` for this account. If that
      // reached `session.state()` unchanged it would be indistinguishable from
      // "the read failed" — and a failed read rendered as "you have no
      // sub-accounts" is how a user loses sight of an account holding funds.
      const raw = await retrying(() => info.subAccounts2({ user: masterAddress }));
      expect(raw).toBeNull();

      const state = session.state();
      expect(state?.subAccounts).not.toBeNull();
      expect(state?.subAccounts).toEqual([]);
      // That `null` stays reachable as the *other* meaning is proved in phase 1,
      // not here: the refusal carried `reason: "not_owned"` rather than
      // `subaccounts_unreadable`, which is only produced when the list read
      // itself came back null.
    }, 60_000);

    it("populates the account store from a real main-dex frame", async () => {
      const account = await waitFor(() => session.stores.account.read(), 45_000);

      // Money as a STRING, and a non-zero one: the main dex is where this
      // account's ~6 USDC lives, and the dex-switch tests below use that
      // difference as the evidence that the stores actually re-targeted.
      expect(typeof account.summary.total.accountValue).toBe("string");
      expect(account.summary.total.accountValue).toMatch(/^[0-9]+(\.[0-9]+)?$/);
      expect(new BigNumber(account.summary.total.accountValue).gt(0)).toBe(true);
      expectLiveTimestamp(account.summary.serverTime);

      expect(session.stores.account.currentTarget()?.identity.dex).toBeNull();
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe("3. switching to a HIP-3 builder dex", () => {
    let dex: DexInfo;
    let mainIdentity: HlIdentity;
    let mainAccountValue: string;
    let agentBefore: string;
    let agentsOnChainBefore: string[];
    let socketBefore: unknown;
    /** `accountValue` as the store reported it on every emission during the switch. */
    const emitted: (string | null)[] = [];

    it("finds a real builder dex and moves the whole session onto it", async () => {
      const dexs = parsePerpDexs(await retrying(() => info.perpDexs()));
      // Index 0 is a literal `null` on the wire — that slot IS the main dex, and
      // its position still counts in the asset-id formula, so the array is
      // parsed in place rather than compacted.
      expect(dexs.length).toBeGreaterThan(1);
      expect(dexs[0].name).toBe("");

      const builder = dexs.find((candidate) => candidate.index > 0 && candidate.name.length > 0);
      if (!builder) throw new Error("no builder dex on testnet: nothing to switch to");
      dex = builder;
      // A deployer address is what makes it a *builder* dex rather than a
      // mis-parsed main-dex slot.
      expect(dex.deployer).toMatch(/^0x[0-9a-fA-F]{40}$/);

      mainIdentity = session.state()!.identity;
      mainAccountValue = session.stores.account.read()!.summary.total.accountValue;
      agentBefore = agentAddressOf(session);
      agentsOnChainBefore = await onChainAgents(info, masterAddress);
      // State read BEFORE the getter, always. `getSubscriptionClient()` lazily
      // CONSTRUCTS a client, and constructing one opens a socket — so probing
      // it first would manufacture the very transport the assertion is meant to
      // observe.
      expect(getConnectionState()).toBe("open");
      socketBefore = getSubscriptionClient();

      // Record every store emission across the switch. This is the only way to
      // see the CLEAR from outside: `start()` resolves after the new target is
      // already installed, so a poll afterwards cannot distinguish "cleared then
      // refilled" from "never cleared".
      emitted.push(session.stores.account.read()?.summary.total.accountValue ?? null);
      const unsubscribe = session.stores.account.subscribe(() => {
        emitted.push(session.stores.account.read()?.summary.total.accountValue ?? null);
      });
      try {
        const state = await session.start({ env: "testnet", dex: dex.name });
        expect(state.identity.dex).toBe(dex.name);
        expect(identityKey(state.identity)).not.toBe(identityKey(mainIdentity));
      } finally {
        unsubscribe();
      }

      // Every store re-pointed, each at its OWN channel. A store handed another
      // channel's target rejects 100% of its events and simply displays nothing
      // — measured, and the app still looks alive because positions work.
      expect(session.stores.account.currentTarget()?.channel).toBe("clearinghouseState");
      expect(session.stores.openOrders.currentTarget()?.channel).toBe("openOrders");
      expect(session.stores.fills.currentTarget()?.channel).toBe("userFills");
      expect(session.stores.spot.currentTarget()?.channel).toBe("spotState");
      for (const store of [session.stores.account, session.stores.openOrders]) {
        expect(store.currentTarget()?.identity.dex).toBe(dex.name);
      }
    }, 120_000);

    it("cleared the stores rather than merely guarding them", async () => {
      // Before the switch the store held the main dex's balance.
      expect(typeof emitted[0]).toBe("string");
      expect(new BigNumber(emitted[0] as string).gt(0)).toBe(true);

      // The decisive one. A store that only guards never emits a null: it keeps
      // the previous identity's number and lets the new identity's header render
      // over the top of it. `setTarget` is the cure the guard is not.
      const cleared = emitted.indexOf(null, 1);
      expect(cleared).toBeGreaterThan(0);

      // That null on its own is weaker than it looks: `read()` returns null
      // whenever the target is null, whatever the store is still holding, so the
      // `setTarget(null)` emission would appear even in a guard-only store. The
      // NEXT emission is the sharp one — it is the `setTarget(newTarget)` clear,
      // taken with a live target installed, and a store that had merely been
      // unpointed hands back the main dex's 6 USDC there.
      expect(emitted.length).toBeGreaterThan(cleared + 1);
      expect(emitted[cleared + 1]).toBeNull();

      // And the old number never comes back afterwards. This account holds
      // nothing on any builder dex, so every reading from here is zero.
      for (const value of emitted.slice(cleared)) {
        if (value === null) continue;
        expect(new BigNumber(value).isZero()).toBe(true);
      }

      // The live view now shows the dex's own, different, empty account —
      // `accountValue "0.0"` against the main dex's non-zero string. A
      // real-but-wrong dex answers HTTP 200 with exactly this shape, which is
      // why the store also checks the echoed dex; here it is the *right* answer.
      const account = await waitFor(() => session.stores.account.read(), 45_000);
      expect(typeof account.summary.total.accountValue).toBe("string");
      expect(new BigNumber(account.summary.total.accountValue).isZero()).toBe(true);
      expect(account.summary.total.accountValue).not.toBe(mainAccountValue);
      expect(account.positions).toEqual([]);
      expectLiveTimestamp(account.summary.serverTime);

      // Frames the store had to throw away as belonging to another target. The
      // account channels are a ~5 s heartbeat, so if the main-dex subscription
      // were still open this would be climbing; three heartbeats is enough to
      // see it. Nothing else drops a `clearinghouseState` frame on an idle
      // account — the only other cause is a server clock going backwards.
      //
      // Pinned to a feed that is provably ALIVE across the same window, because
      // a dead subscription drops nothing and rejects nothing: `dropped === 0`
      // on its own is exactly what a silently-stopped feed looks like, and it is
      // the one assertion here a stub could otherwise satisfy.
      //
      // Waited on the server's own clock rather than slept for a fixed span. The
      // envelope's `serverTime` advances on every heartbeat even when the
      // account's content is unchanged, so requiring 15 s of movement means three
      // real frames landed — and it stays correct if the cadence is ever not the
      // ~5 s measured here, where a fixed sleep would silently under-wait.
      const clockBefore = session.stores.account.readScoped()!.serverTime!;
      expectLiveTimestamp(clockBefore);
      const clockAfter = await waitFor(() => {
        const at = session.stores.account.readScoped()?.serverTime ?? 0;
        return at - clockBefore >= 15_000 ? at : undefined;
      }, 60_000);
      expect(clockAfter - clockBefore).toBeGreaterThanOrEqual(15_000);

      expect(session.stores.account.dropped).toBe(0);
      // Nor is the store refusing the frames it does get: a non-zero count here
      // would mean the server is echoing a different dex than we asked for.
      expect(session.stores.account.rejected).toBe(0);
    }, 120_000);

    it("reuses the master's agent — no re-approval, no new agent on chain", async () => {
      const state = session.state()!;

      // `agentScopeKey` drops `dex`, so both identities resolve to one keychain
      // entry. If it regained `dex`, this lookup would miss, and since no
      // approver is supplied anywhere in this file the gate would degrade to
      // `approval_required` — the user locked out of trading by a dex switch.
      expect(agentScopeKey(state.identity)).toBe(agentScopeKey(mainIdentity));
      expect(["ready", "rotation_due"]).toContain(state.agent.status.kind);
      expect(session.canTrade()).toBe(true);
      expect(agentAddressOf(session)).toBe(agentBefore);

      // And nothing was written on chain. The testnet master's allowance is
      // three API wallets and all three are in use; a switch that minted one
      // would either prompt the user's real wallet or fail outright.
      const after = await onChainAgents(info, masterAddress);
      expect(after).toEqual(agentsOnChainBefore);
      // The agent the session is signing with is one the chain actually knows —
      // a locally-held key that is not registered signs orders the exchange
      // silently refuses.
      expect(after).toContain(agentBefore.toLowerCase());
    }, 90_000);

    it("rebuilt the transport and moved the action budget with the identity", async () => {
      // Rebuilt and *alive* — a switch that tears the socket down without
      // reopening it freezes every feed at its last value with nothing left to
      // recover it short of `stop()`.
      //
      // Read FIRST, before the getter below: `getSubscriptionClient()` lazily
      // constructs a client and opening a socket is a side effect of that
      // construction, so probing it first would silently repair a torn-down
      // transport and leave `not.toBe(socketBefore)` passing for the wrong
      // reason. Taken in this order, "closed and never reopened" reports `idle`.
      expect(getConnectionState()).toBe("open");

      // A NEW subscription client, which means a new websocket. Two identities
      // sharing one transport is not filterable downstream: measured on live
      // testnet, listener A and listener B each received the other's complete
      // 4,815-update `orderUpdates` stream, and those frames carry no user field
      // at all.
      const socketAfter = getSubscriptionClient();
      expect(socketAfter).not.toBe(socketBefore);

      // The old identity's accounting is gone: `snapshot` on a forgotten
      // identity falls back to the new-address default, whose `used` is 0. The
      // main identity's real `used` was non-zero (asserted above), so this can
      // only be the fallback.
      expect(actionBudget.snapshot(mainIdentity).used).toBe(0);

      // And the new identity was re-seeded from the server. Hyperliquid rate
      // limits per address, so carrying the old bucket over would let a switch
      // launder an exhausted budget into a fresh one.
      const seeded = actionBudget.snapshot(session.state()!.identity);
      expect(seeded.used).toBeGreaterThan(0);
      expect(seeded.limit).toBeGreaterThanOrEqual(seeded.used);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe("4. switching back to the main dex", () => {
    it("re-targets the stores and the main balance returns", async () => {
      const dexIdentity = session.state()!.identity;
      // If this throws `not_authorized` / `account_not_activated`, read it
      // literally before blaming the switch. `inspectAgent` calls `userRole` and
      // `extraAgents` OUTSIDE `api/weightBudget` and folds both through
      // `Promise.allSettled`, so a transient per-IP 429 becomes two *negative*
      // facts — `activated: false` and `registeredAgents: []` — and
      // `ensureAgentReady` then reports a funded, agent-holding account as
      // unfunded. Observed on this suite while a second agent shared the IP.
      // Documented, not worked around: no retry wraps `start` here, because the
      // point of the check below is what the production path really does.
      const state = await withRateLimitRetry("session.start", () =>
        session.start({ env: "testnet" })
      );
      expect(state.identity.dex).toBeNull();

      // Symmetry is the point: a switch that only works one way leaves a user
      // who visited a builder dex looking at a permanently empty portfolio.
      const account = await waitFor(() => {
        const read = session.stores.account.read();
        return read && new BigNumber(read.summary.total.accountValue).gt(0) ? read : undefined;
      }, 45_000);
      expect(typeof account.summary.total.accountValue).toBe("string");
      expect(new BigNumber(account.summary.total.accountValue).gt(0)).toBe(true);
      expect(session.stores.account.currentTarget()?.identity.dex).toBeNull();

      // The dex identity's budget is forgotten in turn — `forget` runs on every
      // switch, not just the outbound one.
      expect(actionBudget.snapshot(dexIdentity).used).toBe(0);
      expect(actionBudget.snapshot(state.identity).used).toBeGreaterThan(0);

      // Still the same agent, after two switches.
      expect(session.canTrade()).toBe(true);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  describe("5. restarting the SAME identity", () => {
    it("is a no-op that does not tear down the websocket", async () => {
      // The flow this class invites: start read-only at launch, then start again
      // once the user opts into trading. `configureClients` CLOSES the socket
      // and `switchTo` correctly no-ops on an unchanged identity — so an
      // unguarded reconfigure froze every feed with nothing left to reopen it.
      // State before the getter, for the same reason as above — the getter
      // constructs, and constructing opens.
      expect(getConnectionState()).toBe("open");
      const socketBefore = getSubscriptionClient();
      // `serverTime` off the scoped envelope, not off the snapshot: on an
      // unchanged account the store deliberately keeps the OLD value object so
      // React does not re-render a whole portfolio tree every 5 s, and the
      // snapshot's own timestamp therefore stands still on an idle account.
      const before = session.stores.account.readScoped()!.serverTime!;
      expectLiveTimestamp(before);

      await withRateLimitRetry("session.start", () => session.start({ env: "testnet" }));

      // The SAME transport object. A different one here means the socket was
      // rebuilt for an identity that never changed.
      expect(getSubscriptionClient()).toBe(socketBefore);
      expect(getConnectionState()).toBe("open");
      expect(session.canTrade()).toBe(true);

      // And it is still delivering: a frozen feed passes every check above and
      // is only visible as a timestamp that stops advancing.
      const advanced = await waitFor(() => {
        const at = session.stores.account.readScoped()?.serverTime ?? 0;
        return at > before ? at : undefined;
      }, 45_000);
      expect(advanced).toBeGreaterThan(before);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  describe("6. teardown", () => {
    it("stops cleanly, clearing the session and every store", async () => {
      await session.stop();
      expect(session.state()).toBeNull();
      // `switchTo(null)` has to reach the stores too. A stop that clears only
      // the session leaves the last account's numbers on screen behind a
      // logged-out shell.
      expect(session.stores.account.currentTarget()).toBeNull();
      expect(session.stores.account.read()).toBeNull();
      expect(getConnectionState()).toBe("idle");
    }, 60_000);
  });
});

/**
 * Poll until `read` returns something truthy, or fail with a useful message.
 *
 * Live frames arrive on the exchange's schedule — the account channels are a
 * ~5 s heartbeat — so every assertion about arriving state has to wait rather
 * than sample once.
 */
async function waitFor<T>(
  read: () => T | null | undefined,
  timeoutMs: number
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for live state`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Assert a server timestamp belongs to **this run**, not merely to this decade.
 *
 * `> 1_700_000_000_000` is the obvious form and it is nearly free of content: it
 * accepts anything stamped after November 2023, so a replayed frame, a recorded
 * fixture leaking into the live path, or a store handing back a snapshot it
 * captured half an hour ago all pass it. A ten-minute window either side of the
 * device clock still tolerates real skew — the mobile clock this module distrusts
 * on purpose — while failing on anything that is not current.
 */
function expectLiveTimestamp(serverTime: number): void {
  const now = Date.now();
  expect(serverTime).toBeGreaterThan(now - 10 * 60_000);
  expect(serverTime).toBeLessThan(now + 10 * 60_000);
}

/**
 * Run a direct info call, retrying once after a backoff.
 *
 * Only for the raw `InfoClient` reads this file makes **as a test fixture** —
 * the perp-dex catalogue, the on-chain agent list, the raw `subAccounts2`
 * envelope. Those bypass `api/weightBudget`, which is what production goes
 * through, and Hyperliquid's weight limit is per **IP**: a shared address (a
 * phone behind carrier NAT, or another agent driving the same testnet from this
 * machine) can spend the budget on our behalf. Observed exactly that — an nginx
 * `429 Too Many Requests` on `perpDexs()` while a second suite was running.
 *
 * Deliberately bounded — two backoffs, then the error stands. A persistent 429
 * is a real finding and must still fail the run rather than be papered over,
 * and nothing here wraps `session.start`: the production path's own resilience
 * (or lack of it) is under test and must not be propped up by the harness.
 */
async function retrying<T>(call: () => Promise<T>): Promise<T> {
  const backoffs = [5_000, 15_000];
  for (const backoff of backoffs) {
    try {
      return await call();
    } catch {
      await sleep(backoff);
    }
  }
  return call();
}

/** The address the session's agent gate settled on. */
function agentAddressOf(session: HyperliquidSession): string {
  const status = session.state()!.agent.status;
  if (status.kind !== "ready" && status.kind !== "rotation_due") {
    throw new Error(`agent is not usable: ${status.kind}`);
  }
  return status.account.address;
}

/** Every agent address Hyperliquid has registered against this master, lowercased. */
async function onChainAgents(info: InfoClient, master: Hex): Promise<string[]> {
  const agents = parseRegisteredAgents(await retrying(() => info.extraAgents({ user: master })));
  return agents.map((agent) => agent.address.toLowerCase()).sort();
}

/**
 * The agent key `probe-vault-signer.ts` derives — already approved on testnet.
 *
 * Seeded into the (mocked, in-memory) keychain before the session starts, so the
 * agent gate finds a valid key and reuses it. The master's allowance is three
 * agents and all three are already used, so approving a fresh one is not an
 * option this suite has.
 */
function deriveApprovedAgentKey(master: Hex): Hex {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { keccak256, stringToBytes } = require("viem") as typeof import("viem");
  return keccak256(stringToBytes(`hl-vault-probe:${master.toLowerCase()}`)) as Hex;
}
