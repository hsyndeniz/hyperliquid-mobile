/**
 * Recovery, end to end, against live Hyperliquid testnet.
 *
 *   HL_E2E=1 bun run test:e2e --testPathPattern recovery
 *
 * **Why this exists.** `session.e2e.ts` proves the composition root works on a
 * connection that never drops. A dropped connection is the single most common
 * real-world condition a mobile client meets — a tunnel, a lock screen, a
 * carrier handover — and nothing in the suite proved the client survives one.
 * Every module that makes recovery work was verified in isolation against a
 * mock: the registry's generation token, the stores' `markStale`, the overlay's
 * eviction rules, the per-cloid journal. None of them had ever been driven by a
 * real socket going away and coming back.
 *
 * Four things are exercised, each against live frames:
 *
 * 1. **Reconnect.** The live socket is dropped underneath the running session,
 *    twice, two different ways — once at the transport (`socket.reconnect()`,
 *    which the SDK is meant to heal by itself) and once through the session's
 *    own teardown seam (`stop()` then `start()`, which rebuilds everything). In
 *    both cases the account channels have to start delivering again.
 * 2. **Staleness.** A store must FLAG on resume, not discard. A greyed-out
 *    balance is honest; a blank one reads as "your money is gone".
 * 3. **The unconfirmed overlay.** A reconciler's `landed` verdict is a claim,
 *    not a fact, and its `oid` can be `null`. It goes to an overlay that the
 *    `openOrders` feed evicts — never into the authoritative order map, where a
 *    null-oid row is a phantom the user can see and cannot cancel.
 * 4. **The per-cloid journal.** A crash between sending an order and hearing
 *    back leaves the cloid on disk as the only handle on it. Startup
 *    reconciliation has to resolve that entry — scoped to the identity that
 *    wrote it, because an identity-less sweep adopts other accounts' orders.
 *
 * **What it costs.** One resting limit order placed far below the mid so it
 * cannot fill, cancelled by cloid at the end and again in `afterAll`. No fill,
 * no fee, no funds moved. Journal writes go to the in-memory MMKV mock, so
 * nothing is left on disk either.
 *
 * Skips itself unless `HL_E2E=1`, so it can never run in the fast suite by
 * accident, and skips loudly if the signing key is absent.
 */

import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { SymbolConverter } from "@nktkas/hyperliquid/utils";
import { BigNumber } from "bignumber.js";

import { HyperliquidSession } from "@/hyperliquid/session";
import { importPrivateKey } from "@/hyperliquid/wallet/accounts";
import { storeAgentKey } from "@/hyperliquid/auth/keychain";
import { createIdentity, effectiveAddress, identityKey } from "@/hyperliquid/core/identity";
import { actionBudget } from "@/hyperliquid/api/rateLimit";
import {
  getConnectionState,
  getInfoClient,
  getWebSocketTransport,
} from "@/hyperliquid/api/clients";
import { placeOrders } from "@/hyperliquid/orders/place";
import { cancelOrdersByCloid } from "@/hyperliquid/orders/exchange";
import { buildLimitOrder } from "@/hyperliquid/orders/build";
import { generateCloid, type Cloid } from "@/hyperliquid/orders/cloid";
import {
  clearPending,
  listPending,
  pendingForIdentity,
  recordPending,
} from "@/hyperliquid/orders/pending";
import {
  reconcilePendingSubmits,
  type StartupReconcileParams,
} from "@/hyperliquid/orders/startupReconcile";
import { ACCOUNT_STALE_AFTER_MS } from "@/hyperliquid/state/account";
import { wrapSymbolConverter } from "@/hyperliquid/core/assetIds";
import { resolveAssetSpec } from "@/hyperliquid/assets";
import { setLogLevel } from "@/hyperliquid/core/logger";
import { setupHyperliquid } from "@/hyperliquid/setup";
import type { Hex, HlIdentity } from "@/hyperliquid/types/domain";

const KEY = process.env.HL_TESTNET_SIGNER_KEY;
const ENABLED = process.env.HL_E2E === "1" && Boolean(KEY);

/** A perp that is liquid on testnet and certain to exist. */
const SYMBOL = "BTC";

/**
 * A cloid for an order that was never placed and never will be.
 *
 * Well-formed (`0x` + 32 hex digits) and far above `Number.MAX_SAFE_INTEGER`,
 * so `orderStatus` cannot mistake it for a numeric oid. It stands in for the
 * dangerous shape: a claim about an order the exchange has never heard of.
 */
const GHOST_CLOID = "0xfeedfacedeadbeef0000000000000001" as Cloid;

/**
 * A second never-placed cloid, for the journal entry belonging to another
 * identity.
 *
 * Distinct from the real order's cloid on purpose: `resolvePending` filters the
 * whole journal by cloid with no identity in the filter, so reusing one cloid
 * across two identities clears both and the identity guard under test becomes
 * invisible. That behaviour is measured separately.
 */
const FOREIGN_CLOID = "0xfeedfacedeadbeef0000000000000002" as Cloid;

const describeE2E = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  // Loud, and explains which of the two conditions failed — a silently skipped
  // e2e suite reads exactly like a passing one.
  console.warn(
    process.env.HL_E2E === "1"
      ? "e2e SKIPPED: HL_TESTNET_SIGNER_KEY is not set (is .env present?)"
      : "e2e SKIPPED: set HL_E2E=1 to run against live testnet"
  );
}

describeE2E("recovery against live testnet", () => {
  let session: HyperliquidSession;
  let masterAddress: Hex;
  const info = new InfoClient({ transport: new HttpTransport({ isTestnet: true }) });

  /** The order this suite places, kept resting across sections 4-7. */
  const cloid: Cloid = generateCloid();
  let restingOid: number | null = null;
  let assetId = -1;

  beforeAll(async () => {
    setLogLevel("warn");

    // The module bootstrap, exactly as `src/app/_layout.tsx` calls it. The vault
    // refuses to operate without its AES-GCM backend registered — and this is
    // also what registers the console sink, so no sink is added here: a second
    // one prints every log line twice.
    setupHyperliquid();

    const derived = await importPrivateKey(KEY as string);
    masterAddress = derived.address;

    const identity = createIdentity({
      env: "testnet",
      accountId: masterAddress,
      address: masterAddress,
    });
    await storeAgentKey(identity, deriveApprovedAgentKey(masterAddress));

    // A journal left over from another suite in this process would be swept by
    // the identity-less probe in section 6 and confuse its assertions.
    clearPending();

    session = new HyperliquidSession();
    // `approveAgent` is deliberately omitted, so `start` signs nothing and is
    // safe to repeat. Worth retrying because `inspectAgent` reads `userRole`
    // through `Promise.allSettled` and treats a REJECTED read as
    // `activated: false` — so an HTTP 429 from a parallel run surfaces as
    // "Account is not activated — deposit before trading" and fails the suite
    // for a reason that has nothing to do with recovery.
    await retryRead("session.start", () => session.start({ env: "testnet" }));
  }, 120_000);

  afterAll(async () => {
    // Leave nothing resting. By cloid rather than by oid, and only OUR cloid:
    // other agents run against this same testnet account, and a blanket
    // "cancel every open order" would kill their orders too.
    try {
      if (session?.state()) {
        await cancelOrdersByCloid({
          client: session.exchangeClient(),
          cancels: [{ assetId, cloid }],
        });
      }
    } catch {
      // Already cancelled, or the session is gone. Either is fine here.
    }
    clearPending();
    await session?.stop().catch(() => undefined);
  }, 90_000);

  /** The live identity. Re-read each time — `start()` rebuilds the object. */
  function identity(): HlIdentity {
    const state = session.state();
    if (!state) throw new Error("session is not started");
    return state.identity;
  }

  /**
   * The oid of the resting order, or a message saying why there is none.
   *
   * Without this, a failed placement turns every later assertion into a 60 s
   * `waitFor` timeout that reads as a recovery bug rather than as fallout.
   */
  /**
   * An identity this session is not looking at, on the same address.
   *
   * Same address deliberately: it makes the probe's answer deterministic (the
   * order really is live) so the only variable under test is SCOPE.
   */
  function foreignIdentity(): HlIdentity {
    const foreign = createIdentity({
      env: "testnet",
      accountId: `${masterAddress}#not-this-session`,
      address: masterAddress,
    });
    // Guards the whole point of the scoping tests: if these keys ever collided
    // the "out of scope" entries would be in scope and every one of them would
    // pass for the wrong reason.
    expect(identityKey(foreign)).not.toBe(identityKey(identity()));
    return foreign;
  }

  /**
   * `session.reconcile()`, retried once if it resolved nothing in scope.
   *
   * It swallows its own errors by design — a session must start even when the
   * reconciler cannot reach the API — so under a 429 it silently does nothing,
   * which would otherwise read here as "the sweep is broken".
   */
  async function reconcileSessionWithRetry(): Promise<void> {
    await session.reconcile();
    if (pendingForIdentity(identity()).length === 0) return;
    console.warn("e2e: session.reconcile() resolved nothing in scope; retrying once");
    await sleep(BACKOFF_MS);
    await session.reconcile();
  }

  function requireRestingOid(): number {
    if (restingOid === null) {
      throw new Error(
        "no resting order — the placement in section 5 did not settle, so everything below is downstream of that failure, not of recovery"
      );
    }
    return restingOid;
  }

  // -------------------------------------------------------------------------
  describe("1. the baseline the rest of the suite disturbs", () => {
    it("has live account state before anything is broken", async () => {
      const account = await waitFor(() => session.stores.account.read(), 45_000);

      // Money as a STRING, not a parsed double. Live accounts carry 18-20
      // significant digits; a double silently drops the tail and still renders
      // as a plausible number.
      expect(typeof account.summary.total.accountValue).toBe("string");
      expect(account.summary.total.accountValue).toMatch(/^[0-9]+(\.[0-9]+)?$/);
      // Stamped by the server inside `clearinghouseState`. A default-constructed
      // or fabricated snapshot would not carry a plausible one.
      expect(account.summary.serverTime).toBeGreaterThan(1_700_000_000_000);
      expect(session.canTrade()).toBe(true);
    }, 60_000);

    it("has live spot balances, which is where deposited USDC actually sits", async () => {
      const spot = await waitFor(() => session.stores.spot.read(), 45_000);
      // Not `toBeTruthy()` on the object: an empty `balances` array would pass
      // that and prove nothing. This account holds spot USDC, so a zero-length
      // list means the feed answered for the wrong user or the parser dropped
      // every row — and the user is shown an empty wallet.
      expect(spot.balances.length).toBeGreaterThan(0);
      for (const balance of spot.balances) {
        expect(typeof balance.total).toBe("string");
        expect(balance.total).toMatch(/^[0-9]+(\.[0-9]+)?$/);
      }
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe("2. the websocket is dropped underneath the running session", () => {
    let dropAt = 0;
    let closes = 0;
    let opens = 0;

    it("drops the live socket and the SDK reopens it", async () => {
      const socket = getWebSocketTransport().socket;
      // Waited for rather than sampled: the SDK's own keep-alive can be
      // mid-reconnect at any instant, and a suite that fails here would be
      // reporting a healthy transport as a bug.
      const openBefore = await waitFor(
        () => (getConnectionState() === "open" ? true : undefined),
        30_000
      );
      expect(openBefore).toBe(true);

      // Counted rather than inferred: without proof the socket actually closed,
      // "the feed still works" is not evidence of recovery, only of nothing
      // having happened. Listeners on a ReconnectingWebSocket survive the
      // reconnection, so one registration covers both events.
      socket.addEventListener("close", () => {
        closes += 1;
      });
      socket.addEventListener("open", () => {
        opens += 1;
      });

      dropAt = Date.now();
      // A real close of the live connection — the same code path a carrier
      // handover takes, minus the wait.
      socket.reconnect();

      const reopened = await waitFor(
        () => (closes > 0 && opens > 0 && getConnectionState() === "open" ? true : undefined),
        45_000
      );
      expect(reopened).toBe(true);
      // `terminated` here would mean the transport gave up permanently: every
      // feed frozen at its last value, with nothing left to reopen it and no
      // error surfaced to the user.
      expect(getConnectionState()).toBe("open");
    }, 60_000);

    // Three of the six account channels — the three a quiet account can prove.
    // `userFills`, `userTwapSliceFills` and `orderUpdates` only speak when
    // something happens, so their resubscription is not observable here.
    it("resubscribes the account channels it can prove, and the stores repopulate", async () => {
      // The decisive check. Each store must receive a frame stamped AFTER the
      // drop — a store still holding its pre-drop value would satisfy any
      // "is it populated?" test while being permanently frozen, which is
      // precisely the failure this section exists to catch.
      const recovered = await waitFor(() => {
        const account = session.stores.account.readScoped();
        const spot = session.stores.spot.readScoped();
        // `isStale(dropAt, 0)` is false only when the last openOrders snapshot
        // landed at or after `dropAt` — this store exposes no timestamp.
        const orders = !session.stores.openOrders.isStale(dropAt, 0);
        return account && spot && account.receivedAt > dropAt && spot.receivedAt > dropAt && orders
          ? true
          : undefined;
      }, 60_000);
      expect(recovered).toBe(true);

      // And the content is real, not an empty frame that merely arrived.
      const account = session.stores.account.read()!;
      expect(account.summary.total.accountValue).toMatch(/^[0-9]+(\.[0-9]+)?$/);
      expect(account.summary.serverTime).toBeGreaterThan(dropAt - 60_000);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe("3. staleness flags, it does not discard", () => {
    it("retains every held value while marking it unusable", async () => {
      const account = await waitFor(() => session.stores.account.read(), 45_000);
      const spot = await waitFor(() => session.stores.spot.read(), 45_000);
      const accountValue = account.summary.total.accountValue;
      const spotTotals = spot.balances.map((b) => b.total);

      // No `await` between the mark and the assertions: the account channels
      // are a ~5 s heartbeat, and a frame landing in between would clear the
      // flag and make this read as a failure.
      session.markStale();

      expect(session.stores.account.isStale(Date.now())).toBe(true);
      expect(session.stores.spot.isStale(Date.now(), ACCOUNT_STALE_AFTER_MS)).toBe(true);
      // The third bound store, checked for one specific regression: `markStale`
      // fans out over the `stores` array the session builds in its constructor,
      // and a store dropped from that array marks nothing. Account and spot
      // alone would still pass — and the order list would render live-looking
      // rows from a feed that has stopped.
      expect(session.stores.openOrders.isStale(Date.now(), ACCOUNT_STALE_AFTER_MS)).toBe(true);

      // The whole point. Same object, same numbers — a store that cleared here
      // would blank the portfolio the instant the app came back from the
      // background, which reads as "your money is gone" rather than "hold on".
      expect(session.stores.account.read()).toBe(account);
      expect(session.stores.account.read()!.summary.total.accountValue).toBe(accountValue);
      expect(accountValue).toMatch(/^[0-9]+(\.[0-9]+)?$/);
      expect(session.stores.spot.read()).toBe(spot);
      expect(session.stores.spot.read()!.balances.map((b) => b.total)).toEqual(spotTotals);
    }, 60_000);

    it("clears the flag when the next live frame lands", async () => {
      // Staleness has to be recoverable without a restart, or the greyed-out
      // state is permanent and the user is told to relaunch the app.
      const fresh = await waitFor(
        () => (session.stores.account.isStale(Date.now()) ? undefined : true),
        45_000
      );
      expect(fresh).toBe(true);
      expect(session.stores.account.read()!.summary.total.accountValue).toMatch(
        /^[0-9]+(\.[0-9]+)?$/
      );
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe("4. the unconfirmed overlay is not the order map", () => {
    it("holds a null-oid claim without ever creating a row", () => {
      const store = session.stores.openOrders;
      const before = store.read();
      const rowsBefore = before.rows.map((row) => row.oid);

      const at = Date.now();
      const added = store.addUnconfirmed({
        cloid: GHOST_CLOID,
        // The shape a `landed` verdict can genuinely carry. Written into an
        // oid-keyed map it becomes a row nobody can cancel.
        oid: null,
        label: null,
        submittedAt: at - 2_000,
        expiresAt: at - 1_000,
      });
      expect(added).toBe(true);

      const view = store.read();
      expect(view.unconfirmed.map((u) => u.cloid)).toContain(GHOST_CLOID);
      expect(view.unconfirmed.find((u) => u.cloid === GHOST_CLOID)!.oid).toBeNull();

      // The authoritative set is untouched: no row appeared, and every row it
      // holds still has a real numeric oid. If a claim could leak in here the
      // user would see an order the exchange has never heard of.
      expect(view.rows.map((row) => row.oid)).toEqual(rowsBefore);
      expect(view.rows.every((row) => Number.isInteger(row.oid))).toBe(true);
      // `size` counts the authoritative map alone. If it moved, the overlay and
      // the order list would be one collection, and a claim would be
      // indistinguishable from a confirmed order everywhere downstream.
      expect(store.size).toBe(rowsBefore.length);
    });

    it("evicts the claim on the next live openOrders snapshot", async () => {
      // Its window has already closed, so the first snapshot to arrive after it
      // was submitted is proof it never rested. Driven by a real frame, not by
      // a timer: without this a pending row stays on the order list forever and
      // the user taps cancel on something that does not exist.
      const evicted = await waitFor(
        () =>
          session.stores.openOrders.read().unconfirmed.some((u) => u.cloid === GHOST_CLOID)
            ? undefined
            : true,
        45_000
      );
      expect(evicted).toBe(true);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe("5. the per-cloid journal survives a crash", () => {
    it("places a resting limit far below the mid, and settles its journal entry", async () => {
      // The REAL asset path: SymbolConverter -> our wrapper -> AssetSpec.
      const converter = await retryRead("SymbolConverter.create", () =>
        SymbolConverter.create({
          transport: new HttpTransport({ isTestnet: true }),
          dexs: true,
        })
      );
      const spec = resolveAssetSpec(wrapSymbolConverter(converter), SYMBOL);
      assetId = spec.assetId;

      const mids = (await retryRead("allMids", () => info.allMids())) as Record<string, string>;
      const rawMid = mids[SYMBOL];
      // Prices are strings on the wire and stay strings here: BigNumber over
      // `Number()`, which is banned in every money path for good reason.
      expect(typeof rawMid).toBe("string");
      const mid = new BigNumber(rawMid);
      expect(mid.isFinite() && mid.isGreaterThan(0)).toBe(true);

      // Half the mid: deep enough that it can never trade, and a valid tick once
      // `buildLimitOrder` formats it against live szDecimals.
      const price = mid.dividedBy(2).integerValue(BigNumber.ROUND_FLOOR).toFixed();
      // $30 notional — comfortably over the $10 server-side minimum.
      const size = new BigNumber(30)
        .dividedBy(price)
        .toFixed(spec.szDecimals, BigNumber.ROUND_CEIL);

      const state = session.state()!;
      const outcome = await placeOrders({
        client: session.exchangeClient(),
        identity: state.identity,
        agentStatus: state.agent.status,
        budget: actionBudget,
        // Our own cloid rather than a minted one, so the journal, the probe and
        // the cancel all name the same handle.
        orders: [buildLimitOrder({ asset: spec, isBuy: true, price, size, tif: "Gtc", cloid })],
      });

      // Deliberately not retried on `unknown`: re-signing mints a fresh nonce
      // and places a SECOND real order. The correct response to an unknown
      // outcome is reconciliation by cloid, which is what sections 5 and 6 do
      // to a journal entry — so a failure here is reported, not papered over.
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") throw new Error("unreachable");
      expect(outcome.result.anyRejected).toBe(false);
      const leg = outcome.result.legs[0];
      expect(leg.kind).toBe("resting");
      if (leg.kind === "resting") restingOid = leg.oid;
      expect(restingOid).toBeGreaterThan(0);

      // A submit whose outcome IS known must leave the journal. Left behind, it
      // is re-probed on every single launch forever, spending request weight on
      // a question that was settled the moment the response arrived.
      const journalled = pendingForIdentity(identity()).flatMap((entry) => entry.cloids);
      expect(journalled).not.toContain(cloid);
    }, 120_000);

    it("resolves a crash-shaped entry when reconciled with the real identity", async () => {
      const at = Date.now();
      // Exactly what `place.ts` writes before it sends, left behind because the
      // reply never arrived — an app killed mid-submit, which on mobile is
      // routine rather than exotic.
      recordPending({
        cloids: [cloid],
        identityKey: identityKey(identity()),
        address: effectiveAddress(identity()),
        // In the past, so absence would be conclusive and the entry is probed
        // rather than deferred.
        expiresAt: at - 1_000,
        submittedAt: at - 60_000,
      });
      expect(pendingForIdentity(identity())).toHaveLength(1);

      const result = await reconcileWithBackoff({
        probe: getInfoClient() as unknown as StartupReconcileParams["probe"],
        identity: identity(),
      });

      // Nothing deferred: a deferred entry means the window test misread the
      // clock, and the crash would stay unresolved until the next launch.
      expect(result.deferred).toBe(0);
      expect(result.unresolved).toEqual([]);
      expect(result.notLanded).toEqual([]);
      expect(result.landed).toHaveLength(1);

      const verdict = result.landed[0];
      expect(verdict.kind).toBe("landed");
      if (verdict.kind !== "landed") throw new Error("unreachable");
      expect(verdict.cloid).toBe(cloid);
      // The whole reason a cloid exists: it resolves to the SAME order the
      // exchange gave us an oid for. A mismatch here means the app would adopt
      // a different order than the one it placed.
      expect(verdict.oid).toBe(restingOid);
      // The literal status the exchange reports for an order resting on the
      // book. Not `typeof status === "string"`: `interpretOrderStatus` falls
      // back to the string `"unknown"` when it cannot read the field, so a
      // type check passes on exactly the parse failure worth catching — and a
      // caller that trusts it would show "unknown" beside a live order.
      expect(verdict.status).toBe("open");

      // Conclusive, so it leaves the journal.
      expect(pendingForIdentity(identity())).toHaveLength(0);
    }, 90_000);

    it("sweeps its own identity, leaves another's alone, and renders the order once", async () => {
      const store = session.stores.openOrders;
      const oid = requireRestingOid();
      // The row has to be authoritative BEFORE the sweep runs, or the
      // render-once check below measures a race rather than the guard.
      await waitFor(() => store.byOid(oid), 60_000);

      const foreign = foreignIdentity();
      const at = Date.now();
      // BOTH scopes are journalled, and under DIFFERENT cloids. Two reasons.
      //
      // The in-scope entry is what makes this a test at all: with only the
      // foreign one it passes against a `session.reconcile()` whose body has
      // been deleted, because "in scope is empty, out of scope survives" is
      // exactly what a sweep that does nothing produces. (Measured — that is
      // how the version this replaced behaved.)
      //
      // The distinct cloids are what make it a test of SCOPE. `resolvePending`
      // filters the whole journal by cloid, so reusing one cloid across both
      // entries clears the foreign one too and the identity guard is invisible.
      // That behaviour is measured on its own below.
      recordPending({
        cloids: [cloid],
        identityKey: identityKey(identity()),
        address: effectiveAddress(identity()),
        // In the past, so absence would be conclusive and the entry is probed
        // rather than deferred.
        expiresAt: at - 1_000,
        submittedAt: at - 60_000,
      });
      recordPending({
        cloids: [FOREIGN_CLOID],
        identityKey: identityKey(foreign),
        address: effectiveAddress(foreign),
        expiresAt: at - 1_000,
        submittedAt: at - 60_000,
      });
      expect(pendingForIdentity(identity())).toHaveLength(1);
      expect(pendingForIdentity(foreign)).toHaveLength(1);

      await reconcileSessionWithRetry();

      // In scope: consumed. An entry that survives its own reconciliation is
      // re-probed on every launch after it, forever.
      expect(pendingForIdentity(identity())).toHaveLength(0);
      // Out of scope: untouched. If the session's sweep were unscoped this
      // would be empty, and a verdict about an account the caller never asked
      // about would have been adopted into THIS session's state.
      expect(pendingForIdentity(foreign)).toHaveLength(1);
      expect(pendingForIdentity(foreign)[0].cloids).toEqual([FOREIGN_CLOID]);

      // What the sweep did with the `landed` verdict it just produced. The row
      // is already authoritative, so the overlay has to refuse the claim:
      // `read()` concatenates rows and overlay with no de-duplication, so an
      // accepted claim renders the SAME order twice — once cancellable, once
      // not. This is the live-data check on `addUnconfirmed`'s cloid guard,
      // reached through `session.reconcile()` rather than by calling the store.
      const view = store.read();
      expect(view.rows.filter((row) => row.oid === oid)).toHaveLength(1);
      expect(view.unconfirmed.map((u) => u.cloid)).not.toContain(cloid);
    }, 120_000);

    it("clears a resolved cloid from EVERY journalled identity, not only the swept one", async () => {
      // Measured, not endorsed. `resolvePending` filters `readAll()` — the
      // whole journal — by cloid, with no identity in the filter, so a sweep
      // scoped to one identity also erases that cloid from another's entry.
      //
      // Harmless while cloids are 128 bits of randomness, and worth pinning
      // anyway: the identity scoping in `reconcilePendingSubmits` decides WHAT
      // IS PROBED, not what is forgotten, and the two are easy to conflate.
      // This assertion is what would fail if cloids ever became derived or
      // caller-supplied and started colliding across accounts.
      const foreign = foreignIdentity();
      const at = Date.now();
      for (const scope of [identity(), foreign]) {
        recordPending({
          cloids: [cloid],
          identityKey: identityKey(scope),
          address: effectiveAddress(scope),
          expiresAt: at - 1_000,
          submittedAt: at - 60_000,
        });
      }
      expect(pendingForIdentity(identity())).toHaveLength(1);
      expect(pendingForIdentity(foreign).flatMap((entry) => entry.cloids)).toContain(cloid);

      await reconcileSessionWithRetry();

      expect(pendingForIdentity(identity())).toHaveLength(0);
      expect(pendingForIdentity(foreign).flatMap((entry) => entry.cloids)).not.toContain(cloid);
      // The foreign entry from the previous test is still there, so this is a
      // per-cloid erasure rather than the journal simply being wiped.
      expect(pendingForIdentity(foreign).flatMap((entry) => entry.cloids)).toEqual([FOREIGN_CLOID]);
    }, 90_000);

    it("an identity-less sweep resolves an account the caller never named", async () => {
      // What the omitted parameter actually does, run explicitly so the hazard
      // is documented by measurement rather than asserted in a comment.
      const foreign = foreignIdentity();
      const at = Date.now();
      recordPending({
        cloids: [cloid],
        identityKey: identityKey(foreign),
        address: effectiveAddress(foreign),
        expiresAt: at - 1_000,
        submittedAt: at - 60_000,
      });
      // Nothing of ours is journalled, so anything the sweep below resolves is
      // something it was never asked about.
      expect(pendingForIdentity(identity())).toHaveLength(0);

      const sweep = await reconcileWithBackoff({
        probe: getInfoClient() as unknown as StartupReconcileParams["probe"],
      });

      // A `landed` verdict for an order journalled under an identity this
      // session is not looking at — carrying a real oid on someone else's
      // behalf, with nothing in the result to say whose. `landed.oid` is also
      // allowed to be null, which is how a phantom nobody can cancel would
      // reach an oid-keyed store.
      const adopted = sweep.landed.find((verdict) => verdict.cloid === cloid);
      expect(sweep.landed.map((verdict) => verdict.cloid)).toContain(cloid);
      if (adopted?.kind !== "landed") throw new Error("unreachable");
      expect(adopted.oid).toBe(requireRestingOid());
      expect(adopted.status).toBe("open");
      // And the ghost from two tests ago goes with it: conclusively absent, so
      // conclusively forgotten.
      expect(sweep.notLanded).toContain(FOREIGN_CLOID);
      expect(pendingForIdentity(foreign)).toHaveLength(0);
      // Nothing left anywhere — the sweep drained the journal of every
      // identity, which is the point.
      expect(listPending()).toEqual([]);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe("6. startup reconciliation across a real teardown and restart", () => {
    it("consumes the journal on restart and never renders the order twice", async () => {
      const store = session.stores.openOrders;
      const oid = requireRestingOid();
      const at = Date.now();
      recordPending({
        cloids: [cloid],
        identityKey: identityKey(identity()),
        address: effectiveAddress(identity()),
        expiresAt: at - 1_000,
        submittedAt: at - 60_000,
      });
      expect(pendingForIdentity(identity())).toHaveLength(1);

      // Record every view the store publishes across the restart. The invariant
      // below is checked over the whole recording rather than over a sampled
      // instant, because the window where the overlay and the real row could
      // both exist is a few hundred milliseconds wide.
      const seen: { rows: number[]; unconfirmed: Cloid[] }[] = [];
      const unsubscribe = store.subscribe(() => {
        const view = store.read();
        seen.push({
          rows: view.rows.map((row) => row.oid),
          unconfirmed: view.unconfirmed.map((u) => u.cloid),
        });
      });

      // The other way to lose a connection: the session's own teardown seam.
      // `stop()` closes every subscription AND the transport; `start()` has to
      // rebuild both from nothing.
      await session.stop();
      expect(session.state()).toBeNull();
      await retryRead("session.start (restart)", () => session.start({ env: "testnet" }));
      expect(session.canTrade()).toBe(true);

      // Consumed by the session's OWN startup path, not by anything this test
      // called. An entry that survives a launch is one that will be re-probed
      // on every launch after it, forever.
      expect(pendingForIdentity(identity())).toHaveLength(0);

      // The feeds come back after a full teardown, and the resting order is
      // authoritative again.
      const row = await waitFor(() => store.byOid(oid), 60_000);
      expect(row.cloid).toBe(cloid);
      expect(row.coin).toBe(SYMBOL);
      expect(typeof row.limitPx).toBe("string");
      expect(row.limitPx).toMatch(/^[0-9]+(\.[0-9]+)?$/);

      // Settle before the steady-state check below. If the overlay WAS
      // populated — reconciliation beating the first snapshot — rule-1
      // eviction needs one live frame to clear it.
      await waitFor(
        () => (store.read().unconfirmed.some((u) => u.cloid === cloid) ? undefined : true),
        45_000
      );
      unsubscribe();

      // The recording is real, so the invariant below is not vacuous.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((frame) => frame.rows.includes(oid))).toBe(true);

      // THE invariant. Reconciliation's verdict is a claim; the `openOrders`
      // feed is the fact, and one order may never be both at once — that is
      // what the user would see as the same order listed twice, once
      // cancellable and once not.
      //
      // Deliberately unconditional. Written as `if (claimed) expect(rows).not
      // .toContain(oid)` the body never executes on a run where the overlay was
      // never populated — and that is the COMMON case, measured: the first
      // openOrders snapshot lands ~400 ms before reconciliation runs, so
      // `addUnconfirmed` de-duplicates and the claim is refused. A conditional
      // assertion that silently never fires proves nothing at all.
      for (const frame of seen) {
        const claimed = frame.unconfirmed.includes(cloid) ? 1 : 0;
        const confirmed = frame.rows.filter((each) => each === oid).length;
        expect(claimed + confirmed).toBeLessThanOrEqual(1);
      }

      // And the steady state after the restart: exactly one rendering of this
      // order, as an authoritative row with no claim beside it.
      const view = store.read();
      expect(view.rows.filter((r) => r.oid === oid)).toHaveLength(1);
      expect(view.unconfirmed.map((u) => u.cloid)).not.toContain(cloid);
      // Nothing the reconciler produced ever became a row: every row in the
      // authoritative map carries a real integer oid, which a `landed` verdict
      // is not obliged to.
      expect(view.rows.every((r) => Number.isInteger(r.oid))).toBe(true);
    }, 180_000);
  });

  // -------------------------------------------------------------------------
  describe("7. cleanup", () => {
    it("cancels the resting order by cloid and the store stops showing it", async () => {
      const oid = requireRestingOid();
      const result = await cancelOrdersByCloid({
        client: session.exchangeClient(),
        cancels: [{ assetId, cloid }],
        onSpend: (n) => actionBudget.spend(identity(), "cancel", n),
      });
      expect(result.ok).toBe(true);

      // Observed through the websocket rather than trusted from the response —
      // the same cross-boundary check the order round-trip makes.
      const gone = await waitFor(
        () => (session.stores.openOrders.byOid(oid) === null ? true : undefined),
        45_000
      );
      expect(gone).toBe(true);
      expect(pendingForIdentity(identity())).toHaveLength(0);
    }, 90_000);
  });
});

/** How long to wait before the single permitted retry of a read-only call. */
const BACKOFF_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a **read-only** call, retrying once after a pause.
 *
 * Other agents drive this same testnet account, and Hyperliquid's HTTP limit is
 * per-IP: a 429 here says nothing about this codebase, but it fails the run and
 * every assertion downstream of it. Reads are safe to repeat.
 *
 * Nothing that **signs** is retried anywhere in this file. Re-signing a submit
 * mints a fresh nonce and places a second real order — the exact hazard the
 * cloid journal exists to prevent — so a failed placement is reported, never
 * repeated.
 */
async function retryRead<T>(label: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    console.warn(`e2e: ${label} failed; backing off ${BACKOFF_MS}ms for one retry`, error);
    await sleep(BACKOFF_MS);
    return call();
  }
}

/**
 * Reconcile, retrying once if any cloid came back unresolved.
 *
 * `unresolved` means the **probe** failed rather than that the order's fate is
 * ambiguous — under contention that is a 429. `reconcilePendingSubmits` is
 * documented as idempotent and probes only what can be answered definitively,
 * so a second attempt is safe and changes no state on the exchange.
 */
async function reconcileWithBackoff(
  params: StartupReconcileParams
): Promise<Awaited<ReturnType<typeof reconcilePendingSubmits>>> {
  const first = await reconcilePendingSubmits(params);
  if (first.unresolved.length === 0) return first;
  console.warn(`e2e: reconcile left ${first.unresolved.length} unresolved; retrying once`);
  await sleep(BACKOFF_MS);
  return reconcilePendingSubmits(params);
}

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

/**
 * The agent key `probe-vault-signer.ts` derives — already approved on testnet.
 *
 * Seeded into the (mocked, in-memory) keychain before the session starts, so the
 * agent gate finds a valid key and reuses it. Without this, every run would
 * approve a **new** agent, and the allowance is three per master until volume is
 * traded: three runs and the account is wedged.
 */
function deriveApprovedAgentKey(master: Hex): Hex {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { keccak256, stringToBytes } = require("viem") as typeof import("viem");
  return keccak256(stringToBytes(`hl-vault-probe:${master.toLowerCase()}`)) as Hex;
}
