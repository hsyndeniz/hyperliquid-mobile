/**
 * The composition root, end to end, against live Hyperliquid testnet.
 *
 *   HL_E2E=1 bun run test:e2e
 *
 * **Why this exists.** After nine phases the module had 80 source files and 1,435
 * unit tests — and 13 modules with no production caller at all, including
 * `session.ts` (the composition root) and `orders/place.ts` (the thing that
 * places orders). Every test verified a module in isolation against mocks and
 * recorded fixtures. Nothing verified that the pieces work *together* against a
 * real exchange, which is exactly the gap that hid the Phase 8 `vaultAddress`
 * bug: every module individually correct, the composition broken.
 *
 * So this drives the real objects in the real order:
 *
 *   import a key -> vault -> signerFor -> session.start -> agent gate
 *     -> six live subscriptions -> stores populated from real frames
 *     -> placeOrders -> the order appears in the store -> cancel -> it leaves
 *
 * Only storage is mocked, and those mocks are real in-memory implementations.
 *
 * **What it costs.** One resting limit order, placed far from the mid so it
 * cannot fill, then cancelled. No fill, no fee, no funds moved. It does spend
 * from the testnet action budget.
 *
 * Skips itself unless `HL_E2E=1`, so it can never run in the fast suite by
 * accident, and skips loudly if the signing key is absent.
 */

import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { SymbolConverter } from "@nktkas/hyperliquid/utils";
import { privateKeyToAccount } from "viem/accounts";

import { HyperliquidSession } from "@/hyperliquid/session";
import { importPrivateKey, signerFor, walletState } from "@/hyperliquid/wallet/accounts";
import { storeAgentKey } from "@/hyperliquid/auth/keychain";
import { createIdentity, effectiveAddress } from "@/hyperliquid/core/identity";
import { actionBudget } from "@/hyperliquid/api/rateLimit";
import { placeOrders } from "@/hyperliquid/orders/place";
import { cancelOrders } from "@/hyperliquid/orders/exchange";
import { buildLimitOrder } from "@/hyperliquid/orders/build";
import { wrapSymbolConverter } from "@/hyperliquid/core/assetIds";
import { resolveAssetSpec } from "@/hyperliquid/assets";
import { addLogSink, createConsoleSink, setLogLevel } from "@/hyperliquid/core/logger";
import { setupHyperliquid } from "@/hyperliquid/setup";
import type { Hex } from "@/hyperliquid/types/domain";
import { withRateLimitRetry } from "@/hyperliquid/__e2e__/support";

const KEY = process.env.HL_TESTNET_SIGNER_KEY;
const ENABLED = process.env.HL_E2E === "1" && Boolean(KEY);

/** A perp that is liquid on testnet and certain to exist. */
const SYMBOL = "BTC";

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

describeE2E("the composition root against live testnet", () => {
  let session: HyperliquidSession;
  let masterAddress: Hex;
  const info = new InfoClient({ transport: new HttpTransport({ isTestnet: true }) });

  beforeAll(async () => {
    setLogLevel("warn");
    addLogSink(createConsoleSink());

    // The module bootstrap, exactly as `src/app/_layout.tsx` calls it. Skipping
    // it was the first thing this suite caught: the vault refuses to operate
    // without its AES-GCM backend registered, and the only production call site
    // is the root layout — so no unit test had ever exercised the contract.
    setupHyperliquid();

    // The REAL wallet path: encrypt into the vault, key in the keychain. Only
    // the storage backends are in-memory.
    const derived = await importPrivateKey(KEY as string);
    masterAddress = derived.address;

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
  describe("1. wallet -> signer", () => {
    it("stores the key and reports a wallet on this device", async () => {
      const state = await walletState();
      expect(state.kind).not.toBe("none");
    });

    it("signerFor returns the account that key derives to", async () => {
      const signer = await signerFor(0);
      const expected = privateKeyToAccount(KEY as `0x${string}`);
      expect(signer.address.toLowerCase()).toBe(expected.address.toLowerCase());
      // An imported key lives in the vault, so it signs without prompting.
      expect(signer.kind).toBe("silent");
    });
  });

  // -------------------------------------------------------------------------
  describe("2. session.start", () => {
    it("starts, passes the agent gate with the SEEDED agent, and can trade", async () => {
      const state = await withRateLimitRetry("session.start", () =>
        session.start({ env: "testnet" })
      );

      expect(state.identity.env).toBe("testnet");
      expect(state.identity.address.toLowerCase()).toBe(masterAddress.toLowerCase());
      // `ready` or `rotation_due` both mean the agent is usable — the whole
      // point of seeding it rather than approving a fresh one.
      expect(["ready", "rotation_due"]).toContain(state.agent.status.kind);
      expect(session.canTrade()).toBe(true);
    }, 90_000);

    it("reads the account's sub-accounts and led vaults, distinguishing none from unknown", async () => {
      const state = session.state();
      // `[]` means "read, and there are none". `null` would mean the read failed.
      expect(state?.subAccounts).toEqual([]);
      expect(state?.ledVaults).not.toBeNull();
    });

    it("seeds the action budget from the server's own view", async () => {
      const snapshot = actionBudget.snapshot(session.state()!.identity);
      // Anything above the unseeded floor proves `userRateLimit` was read and
      // applied, rather than the identity being assumed new.
      expect(snapshot.limit).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("3. live state arrives in the stores", () => {
    it("populates the account store from a real clearinghouseState frame", async () => {
      const account = await waitFor(() => session.stores.account.read(), 45_000);

      // Deliberately not just `toBeTruthy()`. A non-null but empty snapshot would
      // pass that and prove nothing — the exact vacuous assertion this whole
      // exercise exists to avoid. These check the frame carried real content, and
      // that money arrived as a STRING rather than a parsed double.
      expect(typeof account.summary.total.accountValue).toBe("string");
      expect(account.summary.total.accountValue).toMatch(/^[0-9]+(\.[0-9]+)?$/);
      expect(typeof account.summary.withdrawable).toBe("string");
      expect(Array.isArray(account.positions)).toBe(true);
      // The server stamps this inside `clearinghouseState`; a fabricated or
      // default-constructed snapshot would not carry a plausible one.
      expect(account.summary.serverTime).toBeGreaterThan(1_700_000_000_000);
    }, 60_000);

    it("echoes back OUR address, which is what the store's guard checks", () => {
      const target = session.stores.account.currentTarget();
      expect(target?.channel).toBe("clearinghouseState");
      expect(effectiveAddress(target!.identity).toLowerCase()).toBe(masterAddress.toLowerCase());
    });

    it("points each store at its OWN channel", () => {
      expect(session.stores.openOrders.currentTarget()?.channel).toBe("openOrders");
      expect(session.stores.fills.currentTarget()?.channel).toBe("userFills");
      expect(session.stores.spot.currentTarget()?.channel).toBe("spotState");
    });
  });

  // -------------------------------------------------------------------------
  describe("4. an order round-trip through the real order path", () => {
    let restingOid: number | null = null;
    let assetId: number;
    let price: string;
    let size: string;

    it("places a resting limit far below the mid, so it cannot fill", async () => {
      // The REAL asset path: SymbolConverter -> our wrapper -> AssetSpec. A raw
      // integer would bypass `core/assetIds`, which is the module whose whole job
      // is making sure an order lands on the market the user meant.
      const converter = await SymbolConverter.create({
        transport: new HttpTransport({ isTestnet: true }),
        dexs: true,
      });
      const spec = resolveAssetSpec(wrapSymbolConverter(converter), SYMBOL);
      assetId = spec.assetId;

      const mids = (await info.allMids()) as Record<string, string>;
      const mid = Number(mids[SYMBOL]);
      expect(Number.isFinite(mid) && mid > 0).toBe(true);
      // Half the mid: deep enough that it can never trade, and a valid tick once
      // `buildLimitOrder` formats it against live szDecimals.
      price = String(Math.floor(mid / 2));
      // Above the $10 minimum notional at half price, so the exchange accepts it.
      size = (30 / Number(price)).toFixed(spec.szDecimals);

      const state = session.state()!;
      const outcome = await placeOrders({
        client: session.exchangeClient(),
        identity: state.identity,
        agentStatus: state.agent.status,
        budget: actionBudget,
        orders: [buildLimitOrder({ asset: spec, isBuy: true, price, size, tif: "Gtc" })],
      });

      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") throw new Error("unreachable");
      // Not a fill and not a rejection: a resting order with an oid.
      expect(outcome.result.anyRejected).toBe(false);
      const leg = outcome.result.legs[0];
      expect(leg.kind).toBe("resting");
      if (leg.kind === "resting") restingOid = leg.oid;
      expect(restingOid).toBeGreaterThan(0);
    }, 90_000);

    it("shows up in the openOrders store, via the websocket rather than the response", async () => {
      // The decisive check for the composition: the order was placed through the
      // exchange client and observed through an entirely separate subscription.
      // Nothing in the unit suite crosses that boundary.
      const found = await waitFor(() => {
        return session.stores.openOrders.byOid(restingOid!) ? true : undefined;
      }, 45_000);
      expect(found).toBe(true);
    }, 60_000);

    it("cancels, and the store stops showing it", async () => {
      const result = await cancelOrders({
        client: session.exchangeClient(),
        cancels: [{ assetId, oid: restingOid! }],
        onSpend: (n) => actionBudget.spend(session.state()!.identity, "cancel", n),
      });
      expect(result.ok).toBe(true);

      const gone = await waitFor(() => {
        return session.stores.openOrders.byOid(restingOid!) === null ? true : undefined;
      }, 45_000);
      expect(gone).toBe(true);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe("5. restarting the SAME identity does not kill the feeds", () => {
    it("keeps the session alive and still tradeable", async () => {
      // This exact flow was a real bug: `configureClients` closes the websocket
      // and `switchTo` correctly no-ops on an unchanged identity, so an
      // unguarded reconfigure froze every feed with nothing left to reopen it.
      await withRateLimitRetry("session.start", () => session.start({ env: "testnet" }));

      expect(session.canTrade()).toBe(true);
      const account = await waitFor(() => session.stores.account.read(), 45_000);
      expect(typeof account.summary.total.accountValue).toBe("string");
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  describe("6. teardown", () => {
    it("stops cleanly and clears the session", async () => {
      await session.stop();
      expect(session.state()).toBeNull();
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

/**
 * The agent key `probe-vault-signer.ts` derives — already approved on testnet.
 *
 * Seeded into the (mocked, in-memory) keychain before the session starts, so the
 * agent gate finds a valid key and reuses it. Without this, every run would
 * approve a **new** agent, and the allowance is three per master until volume is
 * traded: three runs and the account is wedged.
 */
function deriveApprovedAgentKey(master: Hex): Hex {
  // Imported lazily so the module graph above stays about the session.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { keccak256, stringToBytes } = require("viem") as typeof import("viem");
  return keccak256(stringToBytes(`hl-vault-probe:${master.toLowerCase()}`)) as Hex;
}
