/**
 * Every order action **except** the plain limit place/cancel, against live
 * Hyperliquid testnet.
 *
 *   HL_E2E=1 bun run test:e2e --testPathPattern order-variants
 *
 * **Why this exists.** `session.e2e.ts` proves one limit order can be placed and
 * cancelled. That is the single path the Phase 8 `vaultAddress` bug did *not*
 * break: submission carried the routing field, and cancel, modify, batchModify,
 * scheduleCancel and twap carried nothing — so an order placed on a sub-account
 * could never be reached again. Every module was individually correct; the
 * composition was not. This file drives the rest of the surface:
 *
 *   batch of 3 -> modify -> batchModify -> cancelByCloid -> scheduleCancel -> twap
 *
 * Two things are deliberately *not* tested against the live exchange, because
 * they cannot be: this account has $0 lifetime volume, so it can create neither
 * a sub-account (needs $100k) nor a vault (10,000 USDC fee). The routing
 * invariant those would exercise is therefore asserted one layer down, at the
 * **signed wire payload**, through a recording transport — real production
 * functions, real signing, no network. That is where the asymmetry in
 * `scheduleCancel` shows up (see section 2).
 *
 * **What it costs.** Three resting limit orders far below the mid, amended twice
 * and then cancelled; two refused `scheduleCancel` attempts; one reduce-only
 * TWAP on a flat account, cancelled immediately. Nothing can fill. It spends
 * from the testnet action budget.
 */

import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { SymbolConverter } from "@nktkas/hyperliquid/utils";
import { BigNumber } from "bignumber.js";
import { privateKeyToAccount } from "viem/accounts";

import { actionBudget } from "@/hyperliquid/api/rateLimit";
import { resolveAssetSpec } from "@/hyperliquid/assets";
import { storeAgentKey } from "@/hyperliquid/auth/keychain";
import { wrapSymbolConverter } from "@/hyperliquid/core/assetIds";
import { HlError } from "@/hyperliquid/core/errors";
import { createIdentity } from "@/hyperliquid/core/identity";
import { addLogSink, createConsoleSink, setLogLevel } from "@/hyperliquid/core/logger";
import { formatSize } from "@/hyperliquid/core/precision";
import { buildLimitOrder, type AssetSpec, type OrderLeg } from "@/hyperliquid/orders/build";
import { generateCloid, type Cloid } from "@/hyperliquid/orders/cloid";
import {
  batchModifyOrders,
  cancelOrders,
  cancelOrdersByCloid,
  cancelTwapOrder,
  modifyOrder,
  placeTwapOrder,
  scheduleCancel,
  submitOrders,
  ORDER_EXPIRY_WINDOW_MS,
  SCHEDULE_CANCEL_MIN_LEAD_MS,
  TWAP_MIN_MINUTES,
  TWAP_MAX_MINUTES,
} from "@/hyperliquid/orders/exchange";
import { placeOrders } from "@/hyperliquid/orders/place";
import { HyperliquidSession } from "@/hyperliquid/session";
import { setupHyperliquid } from "@/hyperliquid/setup";
import type { Hex, HlIdentity, OpenOrderRow } from "@/hyperliquid/types/domain";
import { importPrivateKey } from "@/hyperliquid/wallet/accounts";
import { withRateLimitRetry } from "@/hyperliquid/__e2e__/support";

const KEY = process.env.HL_TESTNET_SIGNER_KEY;
const ENABLED = process.env.HL_E2E === "1" && Boolean(KEY);

/** A perp that is liquid on testnet and certain to exist. */
const SYMBOL = "BTC";

/**
 * Notional per leg, in USDC.
 *
 * Above Hyperliquid's $10 server-side minimum with enough headroom that a tick
 * of rounding cannot drop under it, and small enough that three of them post
 * ~$1.9 of initial margin at the account's 20x cross leverage. The shared
 * testnet account measured $4.00 of withdrawable collateral at the time of
 * writing, so `beforeAll` asserts a floor rather than trusting that number to
 * hold.
 */
const TARGET_NOTIONAL = new BigNumber(11);

/**
 * Free collateral this file needs before it will place anything.
 *
 * Three legs of {@link TARGET_NOTIONAL} at 20x cross post ~$1.9 of initial
 * margin. Below this the exchange refuses individual legs for insufficient
 * margin — a per-leg rejection that reads exactly like an order-builder bug and
 * sends the next reader into `orders/build.ts` for an hour.
 */
const REQUIRED_COLLATERAL_USDC = new BigNumber(3);

/**
 * A sub-account/vault address used only against the recording transport.
 *
 * Never signed against the network. It exists so the routing field has a value
 * to be present or absent.
 */
const ROUTED_ADDRESS = "0x1111111111111111111111111111111111111111";

const describeE2E = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.warn(
    process.env.HL_E2E === "1"
      ? "e2e SKIPPED: HL_TESTNET_SIGNER_KEY is not set (is .env present?)"
      : "e2e SKIPPED: set HL_E2E=1 to run against live testnet"
  );
}

describeE2E("order actions beyond place/cancel, against live testnet", () => {
  let session: HyperliquidSession;
  let identity: HlIdentity;
  let masterAddress: Hex;
  let spec: AssetSpec;
  /** Six descending integer prices, all far below the mid so nothing can fill. */
  let ladder: string[];
  let size: string;
  /**
   * Every oid this file has ever created, including the ones an amend replaced.
   *
   * The teardown cancels the intersection of this and the account's live open
   * orders — never "everything that is open". This testnet account is shared, and
   * a blanket cancel-all would silently destroy another suite's in-flight
   * fixtures and make its failure look like a product bug.
   */
  const placedOids = new Set<number>();
  /**
   * Every cloid this file has ever signed, registered **before** the request goes
   * out.
   *
   * The oid of a replacement leg is only knowable after the amend has landed and
   * been read back, so an assertion that throws in between would orphan a real
   * resting order that `placedOids` has never heard of. A cloid is chosen by us
   * up front, so it is the only handle that exists on both sides of that gap.
   */
  const placedCloids = new Set<string>();
  /** Wall clock at suite start — the floor for "this order was placed by this run". */
  let runStartedAt = 0;
  const info = new InfoClient({ transport: new HttpTransport({ isTestnet: true }) });

  beforeAll(async () => {
    runStartedAt = Date.now();
    setLogLevel("warn");
    addLogSink(createConsoleSink());

    // The module bootstrap, exactly as `src/app/_layout.tsx` calls it — the vault
    // refuses to operate without its AES-GCM backend registered.
    setupHyperliquid();

    const derived = await importPrivateKey(KEY as string);
    masterAddress = derived.address;

    // Seed the ALREADY-APPROVED agent. The master's allowance is three API
    // wallets and all three are spent; approving another would wedge the account.
    await storeAgentKey(
      createIdentity({ env: "testnet", accountId: masterAddress, address: masterAddress }),
      deriveApprovedAgentKey(masterAddress)
    );

    session = new HyperliquidSession();
    await withRateLimitRetry("session.start", () => session.start({ env: "testnet" }));
    identity = session.state()!.identity;

    const converter = await SymbolConverter.create({
      transport: new HttpTransport({ isTestnet: true }),
      dexs: true,
    });
    spec = resolveAssetSpec(wrapSymbolConverter(converter), SYMBOL);

    const mids = (await info.allMids()) as Record<string, string>;
    // BigNumber, not `Number`: the house rule is that no price ever becomes a
    // double, and the ladder below is the input to a signed order.
    const half = new BigNumber(mids[SYMBOL]).dividedBy(2).integerValue(BigNumber.ROUND_FLOOR);
    expect(half.isFinite() && half.gt(0)).toBe(true);
    // Integer prices are always legal regardless of significant figures, so this
    // ladder needs no tick snapping. Spaced $1000 apart so each amendment lands
    // on a price no other leg occupies and the store lookup is unambiguous.
    ladder = [0, 1000, 2000, 3000, 4000, 5000].map((step) => half.minus(step).toFixed(0));

    // Sized off the LOWEST rung so every order at every rung clears $10, and
    // rounded UP — truncating a size computed from a minimum is how an order
    // lands at $9.99 and is refused after the action is already spent.
    const lowest = new BigNumber(ladder[ladder.length - 1]);
    size = ceilToDecimals(TARGET_NOTIONAL.dividedBy(lowest), spec.szDecimals);
    expect(new BigNumber(size).multipliedBy(lowest).gte(10)).toBe(true);

    // The account is shared and small, and it drains. Check the precondition
    // here, where the failure names the real cause, rather than letting three
    // legs come back "insufficient margin" from inside the batch test.
    const chain = await info.clearinghouseState({ user: masterAddress });
    expect(new BigNumber(chain.withdrawable).gte(REQUIRED_COLLATERAL_USDC)).toBe(true);
  }, 90_000);

  afterAll(async () => {
    // Leave nothing behind, even if an assertion above threw mid-flight — but
    // only OUR orders. The exchange is the authority on which of them are still
    // resting; `placedOids` is the authority on which are ours.
    try {
      const client = session.exchangeClient();
      // A no-op on this account today (the $1M gate below refuses it), and the
      // one thing that must not survive the run the day that changes.
      await scheduleCancel({ client }).catch(() => undefined);

      const open = await info.openOrders({ user: masterAddress });
      // Matched on EITHER handle. An amend that landed but whose read-back
      // assertion threw leaves an order this run owns and whose oid it never
      // learned; only the cloid reaches it.
      const ours = open.filter(
        (row) => placedOids.has(row.oid) || (row.cloid ? placedCloids.has(row.cloid) : false)
      );
      if (ours.length > 0) {
        await cancelOrders({
          client,
          cancels: ours.map((row) => ({ assetId: spec.assetId, oid: row.oid })),
        });
      }
    } catch {
      // The session may never have started; teardown must still run.
    }
    await session?.stop().catch(() => undefined);
  }, 90_000);

  // -------------------------------------------------------------------------
  describe("1. guards that must refuse before anything is signed", () => {
    it("refuses a scheduled cancel under the 5s lead, without touching the transport", async () => {
      const { client, recorder } = recordingClient();
      await expect(
        scheduleCancel({ client, time: Date.now() + SCHEDULE_CANCEL_MIN_LEAD_MS - 1 })
      ).rejects.toBeInstanceOf(HlError);

      // The point of the local guard: the exchange rejects a too-tight deadline
      // on EVERY tick, so a heartbeat that re-arms at 4s leaves the account with
      // no dead-man switch at all while reporting success-shaped traffic. It has
      // to fail here, not there.
      expect(recorder.requests).toHaveLength(0);
    });

    it.each([TWAP_MIN_MINUTES - 1, TWAP_MAX_MINUTES + 1, 5.5])(
      "refuses a TWAP of %s minutes locally",
      async (durationMinutes) => {
        const { client, recorder } = recordingClient();
        await expect(
          placeTwapOrder({
            client,
            input: { assetId: spec.assetId, isBuy: true, size, durationMinutes },
          })
        ).rejects.toBeInstanceOf(HlError);
        // A TWAP rejected by the server still costs an action from a budget that
        // is earned by traded volume — and this account has earned none.
        expect(recorder.requests).toHaveLength(0);
      }
    );

    it("rejects the terse `{a,o}` cancel shape that `cancel` uses, before send", () => {
      const { client, recorder } = recordingClient();
      const terse = { cancels: [{ a: spec.assetId, o: generateCloid() }] } as unknown as Parameters<
        ExchangeClient["cancelByCloid"]
      >[0];

      // `cancelByCloid` spells its fields out — `{asset, cloid}` — while `cancel`
      // uses `{a, o}`. The mapping inside `cancelOrdersByCloid` is therefore
      // load-bearing, not cosmetic: copy the terse shape across and every
      // cancel-by-cloid fails, which is the path a client falls back to when it
      // has a cloid but lost the oid.
      //
      // Note it throws SYNCHRONOUSLY — schema validation runs before the async
      // body, so there is no promise to reject and `.rejects` never sees it. A
      // caller that only guards with `.catch()` and no `try` gets an uncaught
      // throw instead of the failure branch it wrote. `cancelOrdersByCloid`
      // wraps the call in `try`, which is what makes it safe.
      expect(() => client.cancelByCloid(terse)).toThrow(/asset/);
      expect(recorder.requests).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("2. what each action actually puts on the wire", () => {
    /**
     * Signed payloads, captured at the transport.
     *
     * The one dimension that cannot be tested live here: routing an action to a
     * sub-account or vault, when the account can create neither. So the real
     * production functions are driven against a transport that records the
     * signed body instead of sending it.
     */
    async function wireFor(
      run: (client: ExchangeClient) => Promise<unknown>
    ): Promise<RecordedRequest> {
      const { client, recorder } = recordingClient();
      await run(client);
      expect(recorder.requests).toHaveLength(1);
      const request = recorder.requests[0];

      // The recorder sits BELOW the signer, and this is what proves it. Without
      // these four lines the whole section would pass just as well against a spy
      // mounted *above* signing — and `vaultAddress` is a signing INPUT
      // (`signL1Action({action, nonce, vaultAddress, expiresAfter})`), so a
      // routed action that is signed without it produces a signature the exchange
      // resolves to the master. Observing the field on an unsigned object would
      // prove nothing about which account the exchange will credit.
      expect(request.signature.r).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(request.signature.s).toMatch(/^0x[0-9a-f]{64}$/i);
      expect([27, 28]).toContain(request.signature.v);
      // The nonce is the replay guard and must be a live wall-clock ms, not a
      // counter: the exchange refuses anything far from its own clock.
      expect(Math.abs(request.nonce - Date.now())).toBeLessThan(60_000);
      return request;
    }

    const leg = (): OrderLeg =>
      buildLimitOrder({
        asset: { assetId: 0, szDecimals: 2, marketType: "perp" },
        isBuy: true,
        price: "1",
        size: "1",
        cloid: generateCloid(),
      });

    it("routes vaultAddress on every mutating action, without exception", async () => {
      const routed = { vaultAddress: ROUTED_ADDRESS };
      const cloid = generateCloid();

      const wires = {
        order: await wireFor((client) => submitOrders({ client, orders: [leg()], ...routed })),
        cancel: await wireFor((client) =>
          cancelOrders({ client, cancels: [{ assetId: 0, oid: 1 }], ...routed })
        ),
        cancelByCloid: await wireFor((client) =>
          cancelOrdersByCloid({ client, cancels: [{ assetId: 0, cloid }], ...routed })
        ),
        modify: await wireFor((client) =>
          modifyOrder({ client, target: { oid: 1, order: leg() }, ...routed })
        ),
        batchModify: await wireFor((client) =>
          batchModifyOrders({ client, modifies: [{ oid: 1, order: leg() }], ...routed })
        ),
        scheduleCancelArm: await wireFor((client) =>
          scheduleCancel({ client, time: Date.now() + 60_000, ...routed })
        ),
        scheduleCancelClear: await wireFor((client) => scheduleCancel({ client, ...routed })),
        twapOrder: await wireFor((client) =>
          placeTwapOrder({
            client,
            input: { assetId: 0, isBuy: true, size: "1", durationMinutes: 5 },
            ...routed,
          })
        ),
        twapCancel: await wireFor((client) =>
          cancelTwapOrder({ client, assetId: 0, twapId: 1, ...routed })
        ),
      };

      // Routing is only half of it. An action that carries `vaultAddress` but
      // serialises to the WRONG TYPE still misses its target — and every one of
      // these nine goes through a different SDK method, so a copy-paste in
      // `orders/exchange.ts` (calling `cancel` from `modifyOrder`, say) would
      // route perfectly and cancel an order the user was trying to amend. Assert
      // the type each production function actually produces.
      const expectedTypes: Record<keyof typeof wires, string> = {
        order: "order",
        cancel: "cancel",
        cancelByCloid: "cancelByCloid",
        modify: "modify",
        batchModify: "batchModify",
        scheduleCancelArm: "scheduleCancel",
        scheduleCancelClear: "scheduleCancel",
        twapOrder: "twapOrder",
        twapCancel: "twapCancel",
      };
      for (const [name, type] of Object.entries(expectedTypes)) {
        expect([name, wires[name as keyof typeof wires].action.type]).toEqual([name, type]);
      }

      // The two cancels spell their keys differently and the difference is
      // silent: `cancel` takes `{a, o}`, `cancelByCloid` takes `{asset, cloid}`.
      // The guard in section 1 shows the terse shape is refused; this shows the
      // mapping inside `cancelOrdersByCloid` actually emits the long one, which
      // is the half that a stubbed implementation would fail.
      expect(wires.cancel.action.cancels).toEqual([{ a: 0, o: 1 }]);
      expect(wires.cancelByCloid.action.cancels).toEqual([{ asset: 0, cloid }]);
      // `{a, t}` at the TOP of the action — a TWAP cannot be cancelled by oid at
      // all, so a wrong shape here leaves a running algo with no stop.
      expect(wires.twapCancel.action).toMatchObject({ a: 0, t: 1 });
      // Minutes, not milliseconds; `r` present rather than absent (the schema
      // rejects a missing reduce-only flag, and `true` would silently turn an
      // opening TWAP into one that can only close).
      expect(wires.twapOrder.action.twap).toMatchObject({
        a: 0,
        b: true,
        s: "1",
        r: false,
        m: 5,
        t: false,
      });
      // Arm carries an absolute deadline; clear carries none. If `time` leaked
      // onto the clear path the exchange would re-arm instead of disarming.
      expect(wires.scheduleCancelArm.action.time).toBeGreaterThan(Date.now());
      expect(wires.scheduleCancelClear.action.time).toBeUndefined();

      // This is the Phase 8 bug, restated as a test. Hyperliquid's own wording:
      // sub-accounts and vaults have no private key, so the master signs and sets
      // `vaultAddress`. An action missing it is executed against the MASTER's own
      // account, where that oid does not exist — the order stays resting with no
      // way to reach it.
      for (const name of [
        "order",
        "cancel",
        "cancelByCloid",
        "modify",
        "batchModify",
        "scheduleCancelArm",
        "scheduleCancelClear",
        "twapOrder",
        "twapCancel",
      ] as const) {
        expect([name, wires[name].vaultAddress]).toEqual([name, ROUTED_ADDRESS]);
      }

      // `scheduleCancelClear` is in that list because of a defect this suite
      // FOUND and which is now fixed. `scheduleCancel(time === undefined ? {} :
      // {time}, routeTo(params))` hit the SDK's overload disambiguation —
      // `isFirstArgParams = paramsOrOpts && "time" in paramsOrOpts` — so on the
      // clear path the empty first argument was read as the OPTIONS and the
      // second, the only one carrying `vaultAddress`, was discarded. Arming a
      // sub-account's dead-man switch routed; clearing it did not, and was
      // applied to the master instead.
      //
      // Symptom, had it shipped: a user who armed the switch on a sub-account
      // could never disarm it. At the deadline every open order on that
      // sub-account is cancelled, and the "clear" they issued silently disarmed
      // their MASTER account instead.
      //
      // The fix is two explicit calls rather than one with a ternary, so the
      // routing can never land in the argument the SDK ignores.
    });

    it("stamps expiresAfter on every action that can REST an order", async () => {
      const before = Date.now();
      const wire = await wireFor((client) => submitOrders({ client, orders: [leg()] }));
      const expiresAfter = wire.expiresAfter;

      // Without it, a submit that stalls in a bad tunnel can be accepted minutes
      // later at a price the user never agreed to — and no probe can ever prove a
      // timed-out submit is dead, so a retry is never safe.
      //
      // The window opens from a clock read taken INSIDE `submitOrders`, which is
      // necessarily at or after `before` — so the deadline is at least a full
      // window out, never less. Bounding it the other way (`<= before + window`)
      // would fail the moment key derivation cost a millisecond.
      expect(typeof expiresAfter).toBe("number");
      expect(expiresAfter! - before).toBeGreaterThanOrEqual(ORDER_EXPIRY_WINDOW_MS);
      expect(expiresAfter! - before).toBeLessThan(ORDER_EXPIRY_WINDOW_MS + 10_000);

      // A gap this suite FOUND and which is now closed. `batchModify` places new
      // orders exactly as `order` does, and `modify` re-prices a resting one — so
      // the stalled-request hazard is identical on both, yet only `order` carried
      // an expiry. An amend that stalled in a bad tunnel could be accepted
      // minutes later and rest orders at a price the user never agreed to, with
      // no bound on how late and no way to prove a timed-out amend was dead.
      for (const [label, run] of [
        [
          "batchModify",
          (client: ExchangeClient) =>
            batchModifyOrders({ client, modifies: [{ oid: 1, order: leg() }] }),
        ],
        [
          "modify",
          (client: ExchangeClient) => modifyOrder({ client, target: { oid: 1, order: leg() } }),
        ],
      ] as const) {
        const wire = await wireFor(run);
        expect([label, typeof wire.expiresAfter]).toEqual([label, "number"]);
        expect(wire.expiresAfter! - before).toBeGreaterThanOrEqual(ORDER_EXPIRY_WINDOW_MS);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("3. a batch of three resting limits in ONE action", () => {
    const cloids: Cloid[] = [];
    let oids: number[] = [];
    let spent: { at: number; expiresAfter?: number }[] = [];

    it("settles three legs, charges three actions, and stamps an expiry", async () => {
      const state = session.state()!;
      const usedBefore = actionBudget.snapshot(identity).used;

      // Tied to the SERVER's own accounting, not to a remembered number. The
      // unseeded default is `limit: 10_000, used: 0` — and 10,000 also happens to
      // be the cap the server reports for a $0-volume address, so the cap alone
      // cannot tell a seeded budget from a defaulted one. `used` can: a budget
      // that believes nothing has been spent keeps submitting after the address
      // is already throttled to one request per 10 s, which is precisely when a
      // user is trying to close a position.
      const server = await info.userRateLimit({ user: masterAddress });
      expect(actionBudget.snapshot(identity).limit).toBe(server.nRequestsCap);
      expect(usedBefore).toBeGreaterThan(0);
      // Seeded at session start, so it can only lag the server's live count —
      // never lead it. A local number above the server's would mean the seed
      // invented a value rather than reading one.
      expect(usedBefore).toBeLessThanOrEqual(server.nRequestsUsed);

      // Cloids are supplied rather than left for `placeOrders` to mint
      // (`withCloids` does `order.c ?? generateCloid()`), for two reasons. It
      // registers a cleanup handle BEFORE anything is signed, so a submit whose
      // outcome we never learn is still reachable in teardown. And it makes the
      // echo assertion below a real comparison against a known value instead of a
      // shape check — while incidentally proving `withCloids` preserves a
      // caller's own idempotency key rather than overwriting it.
      const legs = ladder.slice(0, 3).map((price) => {
        const cloid = generateCloid();
        placedCloids.add(cloid);
        return buildLimitOrder({ asset: spec, isBuy: true, price, size, tif: "Gtc", cloid });
      });

      spent = [];
      const outcome = await placeOrders({
        client: spyOrderOptions(session.exchangeClient(), spent),
        identity,
        agentStatus: state.agent.status,
        budget: actionBudget,
        orders: legs,
      });

      // `unknown` means the request was sent and the outcome is genuinely not
      // known — the orders may still land after this assertion fails. Teardown
      // already holds their cloids, which is the only reason that is survivable.
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") throw new Error("unreachable");

      // Per-leg interpretation, not an all-or-nothing verdict. The SDK rejects the
      // whole promise if ANY leg errors while the others are live on the book, so
      // a caller that reads the batch as one boolean orphans real resting orders
      // and doubles the position on retry.
      expect(outcome.result.legs).toHaveLength(3);
      expect(outcome.result.anyRejected).toBe(false);
      expect(outcome.result.isPartial).toBe(false);
      expect(outcome.result.batchRejected).toBe(false);

      for (const [index, legOutcome] of outcome.result.legs.entries()) {
        expect(legOutcome.kind).toBe("resting");
        if (legOutcome.kind !== "resting") throw new Error("unreachable");
        expect(legOutcome.oid).toBeGreaterThan(0);
        // Compared against the cloid WE generated, leg by leg — not merely
        // "is 32 hex digits", which any echoed garbage satisfies. The cloid is
        // the only handle that exists before the exchange assigns an oid, so a
        // response that returns the right *shape* against the wrong leg is worse
        // than one that returns nothing: reconciliation after a timeout would
        // then confidently match a fill to the order that did not get it.
        expect(legOutcome.cloid).toBe(legs[index].c);
        cloids.push(legOutcome.cloid!);
      }
      oids = outcome.result.legs.map((l) => (l.kind === "resting" ? l.oid : -1));
      oids.forEach((oid) => placedOids.add(oid));
      // Legs correlate to statuses BY ARRAY INDEX and nothing echoes the price
      // back, so three identical oids would be indistinguishable from success.
      expect(new Set(oids).size).toBe(3);

      // Hyperliquid counts a batch as ONE request for the IP limit but N for the
      // ADDRESS limit. Charging 1 per request lets the local budget drift to 3x
      // the server's, so the client keeps submitting while the address is already
      // throttled.
      expect(actionBudget.snapshot(identity).used - usedBefore).toBe(3);
    }, 90_000);

    it("carried expiresAfter on the real live submit", () => {
      expect(spent).toHaveLength(1);
      const { at, expiresAfter } = spent[0];
      expect(typeof expiresAfter).toBe("number");
      // Measured against the clock read taken AT THE CALL, not at assertion time.
      // Comparing to `Date.now()` here would make the test a race against how
      // long the live submit above happened to take: the window is 30 s and that
      // test is allowed 90 s, so a slow testnet round-trip would "fail" a
      // perfectly correct expiry.
      //
      // A 30s window, deliberately longer than the 15s HTTP timeout so a submit
      // that times out locally can be waited out and then probed conclusively.
      expect(expiresAfter! - at).toBeGreaterThan(ORDER_EXPIRY_WINDOW_MS - 1_000);
      expect(expiresAfter! - at).toBeLessThanOrEqual(ORDER_EXPIRY_WINDOW_MS);
    });

    it("shows all three in the openOrders store, over the websocket", async () => {
      const rows = await waitFor(() => {
        const found = oids.map((oid) => session.stores.openOrders.byOid(oid));
        return found.every((row): row is OpenOrderRow => row !== null) ? found : undefined;
      }, 45_000);

      for (const [index, row] of rows.entries()) {
        // The wire spells an integer price "32165.0". A string compare against
        // the "32165" we signed silently never matches, so every price check in
        // the app has to go through BigNumber.
        expect(new BigNumber(row.limitPx).isEqualTo(ladder[index])).toBe(true);
        expect(row.cloid).toBe(cloids[index]);
        expect(row.side).toBe("buy");
        // `sz` is the size REMAINING; a cancel-and-replace built on it re-places
        // the wrong quantity once anything has partially filled.
        expect(new BigNumber(row.remainingSz).isEqualTo(size)).toBe(true);
        expect(new BigNumber(row.originalSz).isEqualTo(size)).toBe(true);
        // Bounded to THIS run (with a minute of slack each way for exchange/local
        // clock skew). A floor of "some time in 2023" is satisfied by every order
        // the account has ever placed, so it would pass just as happily on a row
        // replayed from a cache or left over from a previous suite.
        expect(row.placedAt).toBeGreaterThan(runStartedAt - 60_000);
        expect(row.placedAt).toBeLessThan(Date.now() + 60_000);
      }
    }, 60_000);

    // -----------------------------------------------------------------------
    it("modifyOrder amends leg 0 — and tells us nothing about the result", async () => {
      const newPrice = ladder[3];
      const newCloid = generateCloid();
      placedCloids.add(newCloid);

      const result = await modifyOrder({
        client: session.exchangeClient(),
        target: {
          oid: oids[0],
          order: buildLimitOrder({
            asset: spec,
            isBuy: true,
            price: newPrice,
            size,
            tif: "Gtc",
            cloid: newCloid,
          }),
        },
        onSpend: (n) => actionBudget.spend(identity, "other", n),
      });

      expect(result.ok).toBe(true);
      // `modifyOrder` returns `{ok}` and NOTHING else — it discards the response
      // body deliberately, because that body is a bare `{type:"default"}` with no
      // oid and no per-order data. This asserts the wrapper never grows a field a
      // caller could mistake for the amended order's identity; the identity is
      // recovered below, from the store, which is the only place it exists.
      expect(Object.keys(result)).toEqual(["ok"]);

      // Resolved by CLOID, not by price. This testnet account is shared with
      // other suites, and a price-keyed scan of the whole open-orders book can
      // land on somebody else's rung — asserting against a row we never placed.
      // Waiting on the cloid also *is* the proof it survived the amend:
      // `orders/build` exists because unknown keys are silently STRIPPED rather
      // than rejected, so spell it `cloid:` instead of `c:` and the replacement
      // comes back with no client id and this wait times out.
      const amended = await waitFor(() => rowWithCloid(newCloid), 45_000);
      expect(new BigNumber(amended.limitPx).isEqualTo(newPrice)).toBe(true);
      // The replacement is the same order re-priced, not a fourth one bolted on:
      // an amend that reset the quantity would quietly change the user's risk.
      expect(new BigNumber(amended.remainingSz).isEqualTo(size)).toBe(true);
      expect(amended.side).toBe("buy");
      placedOids.add(amended.oid);

      // An amend is a cancel-and-replace: the old oid is gone from the book, so
      // any client tracking the order by oid is now holding a dead handle. This
      // is the measured behaviour, and it is why the cloid above matters.
      expect(amended.oid).not.toBe(oids[0]);
      await waitFor(
        () => (session.stores.openOrders.byOid(oids[0]) === null ? true : undefined),
        45_000
      );
      oids[0] = amended.oid;
      placedOids.add(amended.oid);
      cloids[0] = newCloid;
    }, 90_000);

    // -----------------------------------------------------------------------
    it("batchModifyOrders amends legs 1 and 2 — and DOES report per-leg oids", async () => {
      const targets = [
        { index: 1, price: ladder[4], cloid: generateCloid() },
        { index: 2, price: ladder[5], cloid: generateCloid() },
      ];
      targets.forEach((target) => placedCloids.add(target.cloid));
      const usedBefore = actionBudget.snapshot(identity).used;

      const outcome = await batchModifyOrders({
        client: session.exchangeClient(),
        modifies: targets.map((target) => ({
          oid: oids[target.index],
          order: buildLimitOrder({
            asset: spec,
            isBuy: true,
            price: target.price,
            size,
            tif: "Gtc",
            cloid: target.cloid,
          }),
        })),
        onSpend: (n) => actionBudget.spend(identity, "other", n),
      });

      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") throw new Error("unreachable");
      expect(outcome.result.anyRejected).toBe(false);
      expect(outcome.result.batchRejected).toBe(false);
      expect(outcome.result.legs).toHaveLength(2);

      // The asymmetry a caller must not paper over: `batchModify` hands back
      // resting oids, `modify` hands back nothing. Code that treats the two the
      // same either wastes a round-trip re-reading what it was told, or invents
      // an oid it was never given.
      for (const [i, legOutcome] of outcome.result.legs.entries()) {
        expect(legOutcome.kind).toBe("resting");
        if (legOutcome.kind !== "resting") throw new Error("unreachable");
        expect(legOutcome.oid).toBeGreaterThan(0);
        expect(legOutcome.cloid).toBe(targets[i].cloid);
        oids[targets[i].index] = legOutcome.oid;
        placedOids.add(legOutcome.oid);
        cloids[targets[i].index] = targets[i].cloid;
      }

      // Two amendments, two actions. Same address-limit rule as a batch submit.
      expect(actionBudget.snapshot(identity).used - usedBefore).toBe(2);

      for (const target of targets) {
        const row = await waitFor(() => rowWithCloid(target.cloid), 45_000);
        expect(new BigNumber(row.limitPx).isEqualTo(target.price)).toBe(true);
        // The decisive cross-check the single `modify` cannot make: the oid
        // `batchModify` REPORTED is the oid the book actually shows for that
        // cloid. If the per-leg statuses were correlated to the wrong index, a
        // client would cancel the wrong order later and never know why.
        expect(row.oid).toBe(oids[target.index]);
      }
    }, 90_000);

    // -----------------------------------------------------------------------
    it("cancelOrdersByCloid removes one order by its client id alone", async () => {
      const doomed = { oid: oids[1], cloid: cloids[1] };

      const result = await cancelOrdersByCloid({
        client: session.exchangeClient(),
        cancels: [{ assetId: spec.assetId, cloid: doomed.cloid }],
        onSpend: (n) => actionBudget.spend(identity, "cancel", n),
      });
      expect(result.ok).toBe(true);

      // Observed through the websocket, not inferred from the response — the
      // point of cancel-by-cloid is the case where the oid was never received, so
      // "did it go" can only be answered by the feed.
      const gone = await waitFor(
        () => (session.stores.openOrders.byOid(doomed.oid) === null ? true : undefined),
        45_000
      );
      expect(gone).toBe(true);

      // The other two are untouched: a cancel keyed on the wrong field would
      // either miss entirely or, worse, take out orders the user still wants.
      expect(session.stores.openOrders.byOid(oids[0])).not.toBeNull();
      expect(session.stores.openOrders.byOid(oids[2])).not.toBeNull();
    }, 90_000);

    // -----------------------------------------------------------------------
    it("cancels what is left and the store empties", async () => {
      const remaining = [oids[0], oids[2]];
      const result = await cancelOrders({
        client: session.exchangeClient(),
        cancels: remaining.map((oid) => ({ assetId: spec.assetId, oid })),
        onSpend: (n) => actionBudget.spend(identity, "cancel", n),
      });
      expect(result.ok).toBe(true);

      const cleared = await waitFor(
        () =>
          remaining.every((oid) => session.stores.openOrders.byOid(oid) === null)
            ? true
            : undefined,
        45_000
      );
      expect(cleared).toBe(true);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe("4. the dead-man switch", () => {
    it("is gated behind $1,000,000 of volume, and reports it without throwing", async () => {
      const client = session.exchangeClient();

      const armed = await scheduleCancel({
        client,
        // Two minutes out: comfortably past the 5s local floor, so whatever comes
        // back is the exchange's own verdict and not our guard's.
        time: Date.now() + 120_000,
        onSpend: (n) => actionBudget.spend(identity, "other", n),
      });

      // MEASURED, and absent from the exchange-endpoint docs, which describe only
      // the 5s lead and the 10-triggers-per-day cap:
      //
      //   "Cannot set scheduled cancel time until enough volume traded.
      //    Required: $1000000. Traded: $0."
      //
      // This is the single most dangerous refusal in the whole order surface,
      // because the feature's entire purpose is to protect a user who is no
      // longer watching. A client that fires this on connect and ignores the
      // result shows a "protected" badge over an account with no protection at
      // all, and the user only finds out during the outage it was meant to cover.
      //
      // Note the refusal is RETURNED, not thrown — the `await` above completing
      // at all is the proof. `scheduleCancel` is called from heartbeats and
      // reconnect handlers, where an exception would take down the caller rather
      // than surface a badge.
      expect(armed.ok).toBe(false);
      expect(String(armed.error)).toMatch(/enough volume traded/i);
      expect(String(armed.error)).toMatch(/1000000/);

      // The clear path is refused by the same gate — so on this account there is
      // nothing armed to leave behind. `afterAll` still issues a clear, because
      // the moment the account crosses $1M this stops being true.
      const cleared = await scheduleCancel({
        client,
        onSpend: (n) => actionBudget.spend(identity, "other", n),
      });
      expect(cleared.ok).toBe(false);
      expect(String(cleared.error)).toMatch(/enough volume traded/i);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe("5. TWAP", () => {
    it("has a $100 minimum — TEN times the ordinary $10 floor the module encodes", async () => {
      // Reduce-only, on an account asserted flat: a TWAP is a MARKET algo. A
      // fillable one would open a real position the suite would then have to
      // trade out of, and the exchange's own minimum below ($100) is a large
      // fraction of this account's entire buying power at 20x cross — $80 against
      // the $4.00 of collateral measured here. Reduce-only with nothing to reduce
      // cannot fill, so the wire path is exercised at zero risk.
      //
      // The flat check is the safety interlock, not a nicety: a reduce-only BUY
      // against an open SHORT is fillable, and this account is shared.
      const positions = await info.clearinghouseState({ user: masterAddress });
      expect(positions.assetPositions).toEqual([]);

      const twapSize = ceilToDecimals(
        TARGET_NOTIONAL.dividedBy(new BigNumber(ladder[0]).multipliedBy(2)),
        spec.szDecimals
      );

      const placed = await placeTwapOrder({
        client: session.exchangeClient(),
        input: {
          assetId: spec.assetId,
          isBuy: true,
          size: formatSize(twapSize, spec.szDecimals),
          durationMinutes: TWAP_MIN_MINUTES,
          reduceOnly: true,
        },
        onSpend: (n) => actionBudget.spend(identity, "other", n),
      });

      // MEASURED: "TWAP order value too small. Min is $100."
      //
      // `orders/build.ts` encodes exactly one floor — `MIN_ORDER_NOTIONAL_USDC =
      // 10` — and nothing anywhere encodes this one. An order form that validates
      // a TWAP against the $10 constant tells the user their $11 TWAP is fine,
      // spends an action from a budget earned by volume this account has none of,
      // and comes back refused every single time.
      // `rejected`, NOT `unknown`. The refusal is a 200 carrying
      // `{status:"ok", response:{data:{status:{error}}}}` — the failure buried
      // two levels down inside a success envelope, which the SDK turns into a
      // throw. Nothing in it matches the top-level `{status:"err"}` shape, so
      // reading it takes `readSingleStatusError`; without that it classifies as
      // "sent, outcome unknown" and the sheet freezes a ticket whose only fault
      // is a size the user could raise.
      expect(placed.kind).toBe("rejected");
      if (placed.kind !== "rejected") throw new Error("unreachable");
      // Stringified rather than read through `.message`: if the SDK ever surfaces
      // this as something other than an `Error`, `.message` is `undefined` and
      // `toMatch` throws a type error that hides what the exchange actually said.
      expect(String(placed.error)).toMatch(/TWAP order value too small/);
      expect(String(placed.error)).toMatch(/\$100/);
    }, 90_000);

    it("cancelTwapOrder reaches the exchange rather than failing on its shape", async () => {
      // The TWAP above never started, so there is no live twapId to cancel. What
      // is still worth proving is that `{a, t}` is the shape the exchange accepts:
      // a wrong field name would fail schema validation locally, exactly like the
      // terse `{a, o}` cancel-by-cloid in section 1, and a client would never find
      // out until a real algo needed stopping. A cancel for an id that does not
      // exist gets past validation and is refused on merit instead.
      const cancelled = await cancelTwapOrder({
        client: session.exchangeClient(),
        assetId: spec.assetId,
        twapId: 1,
        onSpend: (n) => actionBudget.spend(identity, "other", n),
      });

      expect(cancelled.ok).toBe(false);
      // MEASURED: "TWAP was never placed, already canceled, or filled." — the
      // matching engine's verdict, which it could only reach if the action
      // serialised, signed and landed. A `ValidationError` here would instead
      // mean the shape never left the device.
      expect(String(cancelled.error)).toMatch(/TWAP was never placed/);
      expect(String(cancelled.error)).not.toMatch(/Invalid key|Expected/);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  /**
   * The store row carrying `cloid`, or undefined.
   *
   * Keyed on the client id rather than the price: this testnet account is shared
   * with other suites and can hold orders this file did not place, so a
   * price-keyed `find` over the whole book can return a stranger's row — and an
   * assertion made against it is an assertion about nothing.
   */
  function rowWithCloid(cloid: Cloid): OpenOrderRow | undefined {
    return session.stores.openOrders.read().rows.find((row) => row.cloid === cloid);
  }
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RecordedRequest {
  action: { type: string } & Record<string, unknown>;
  /** Replay guard — the SDK's own wall-clock ms, not a counter. */
  nonce: number;
  /** Present only because the recorder sits below the signer. */
  signature: { r: string; s: string; v: number };
  vaultAddress?: string;
  expiresAfter?: number;
}

/**
 * A transport that signs for real and records instead of sending.
 *
 * The routing field only appears in the payload AFTER signing, so nothing above
 * the transport can observe whether an action carries it. Since this account can
 * own neither a sub-account ($100k volume) nor a vault (10,000 USDC), this is the
 * only place the `vaultAddress` invariant can be checked at all.
 */
class RecordingTransport {
  readonly isTestnet = true;
  readonly requests: RecordedRequest[] = [];

  async request(_endpoint: string, payload: unknown): Promise<unknown> {
    const body = payload as RecordedRequest;
    this.requests.push(body);
    if (body.action.type === "twapOrder") {
      return {
        status: "ok",
        response: { type: "twapOrder", data: { status: { running: { twapId: 1 } } } },
      };
    }
    return { status: "ok", response: { type: "default", data: { statuses: [] } } };
  }
}

function recordingClient(): { client: ExchangeClient; recorder: RecordingTransport } {
  const recorder = new RecordingTransport();
  const client = new ExchangeClient({
    transport: recorder as unknown as HttpTransport,
    wallet: privateKeyToAccount(KEY as `0x${string}`),
  });
  return { client, recorder };
}

/**
 * Wrap a live client so the options passed to `order` can be inspected.
 *
 * `expiresAfter` is applied inside `submitOrders` and then disappears into the
 * signature, so this is the only seam at which a live submit can be shown to
 * carry one.
 */
function spyOrderOptions(
  client: ExchangeClient,
  sink: { at: number; expiresAfter?: number }[]
): ExchangeClient {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (prop !== "order") return method.bind(target);
      return (params: unknown, opts: { expiresAfter?: number }) => {
        // The wall clock AT the call, so the window can be checked against the
        // instant it was opened rather than against whenever the assertion runs.
        sink.push({ ...opts, at: Date.now() });
        return method.call(target, params, opts);
      };
    },
  });
}

/**
 * Round UP to `decimals`, in BigNumber.
 *
 * Sizes derived from a minimum notional must never truncate: $10.00 becomes
 * $9.99 and the exchange refuses the order after the action has already been
 * charged against a budget this account earns no more of.
 */
function ceilToDecimals(value: BigNumber, decimals: number): string {
  return value.decimalPlaces(decimals, BigNumber.ROUND_CEIL).toFixed(decimals);
}

/**
 * Poll until `read` returns something truthy, or fail with a useful message.
 *
 * The account channels are a ~5s heartbeat, not an event stream, so every
 * assertion about arriving state has to wait rather than sample once.
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
 * Seeded into the (mocked, in-memory) keychain so the agent gate reuses it. The
 * master's allowance is three API wallets and all three are spent; approving a
 * fresh one per run would wedge the account.
 */
function deriveApprovedAgentKey(master: Hex): Hex {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { keccak256, stringToBytes } = require("viem") as typeof import("viem");
  return keccak256(stringToBytes(`hl-vault-probe:${master.toLowerCase()}`)) as Hex;
}
