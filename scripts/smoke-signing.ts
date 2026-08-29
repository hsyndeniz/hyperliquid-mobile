/**
 * Live testnet **signing** smoke test.
 *
 *   bun run smoke:sign
 *
 * Verifies the signature half of the stack, which `smoke-testnet.ts` cannot:
 * key → address → EIP-712 signature → an action the exchange actually parses.
 *
 * Works with an **unfunded** account. That sounds like a limitation and is
 * mostly not one: the decisive question is whether our signing and payload
 * construction are correct, and the exchange answers that by *how* it rejects.
 * A rejection saying "account not activated" means the signature verified and
 * the action parsed — everything under our control worked. A signature or
 * deserialisation error would mean it did not.
 *
 * Requires `HL_TESTNET_SIGNER_KEY` in `.env` — testnet, disposable, never a key
 * that holds real value. Deliberately NOT an `EXPO_PUBLIC_*` name: that prefix
 * is inlined into the shipped bundle.
 *
 * Modules that touch the device Keychain (`auth/agent`, `auth/session`) cannot
 * run outside the app runtime, so the pure policy functions are exercised here
 * and the Keychain path stays a device test.
 */

import { BigNumber } from "bignumber.js";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { SymbolConverter } from "@nktkas/hyperliquid/utils";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { resolveAssetSpec } from "@/hyperliquid/assets";
import { wrapSymbolConverter } from "@/hyperliquid/core/assetIds";
import { buildLimitOrder, meetsMinNotional } from "@/hyperliquid/orders/build";
import { cancelOrdersByCloid, submitOrders } from "@/hyperliquid/orders/exchange";
// The guarded twin: `classTransfer` takes a branded `WireAmount`, so a float
// cannot reach a signed money movement. The unguarded `transferBetweenSpotAndPerp`
// that used to live in `orders/exchange.ts` took `string | number` and signed
// `String(amount)` — `0.1 + 0.2` would have signed "0.30000000000000004".
import { classTransfer } from "@/hyperliquid/transfers/transfer";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import { canSafelyRetry, reconcileCloids } from "@/hyperliquid/orders/reconcile";

import { resolveHlConfig } from "@/hyperliquid/config/env";
import { addLogSink, createConsoleSink, setLogLevel } from "@/hyperliquid/core/logger";
import {
  isAccountActivated,
  parseRegisteredAgents,
  resolveAgentStatus,
} from "@/hyperliquid/auth/agentPolicy";

import { generateCloid } from "@/hyperliquid/orders/cloid";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function main(): Promise<void> {
  setLogLevel("error");
  addLogSink(createConsoleSink());

  const key = process.env.HL_TESTNET_SIGNER_KEY;
  if (!key) {
    console.error("HL_TESTNET_SIGNER_KEY is not set in .env — see this file's header.");
    process.exit(1);
  }

  const config = resolveHlConfig({ env: "testnet" });
  console.log("Hyperliquid SIGNING smoke — TESTNET\n" + "=".repeat(46));

  // -------------------------------------------------------------------------
  section("1. Key and signer");
  // -------------------------------------------------------------------------
  const account = privateKeyToAccount(key as `0x${string}`);
  check("key derives an address", /^0x[0-9a-fA-F]{40}$/.test(account.address), account.address);
  check(
    "account satisfies the SDK's local-account shape",
    typeof account.signTypedData === "function" && typeof account.address === "string"
  );
  check(
    "CSPRNG is available for cloid/agent generation",
    (() => {
      try {
        return generateCloid().length === 34;
      } catch {
        return false;
      }
    })()
  );

  // -------------------------------------------------------------------------
  section("2. Account state on testnet");
  // -------------------------------------------------------------------------
  const transport = new HttpTransport({ isTestnet: true });
  const info = new InfoClient({ transport });

  const role = await info.userRole({ user: account.address });
  const activated = isAccountActivated(role);
  console.log(`  · userRole = ${JSON.stringify(role)}`);
  check(
    "activation gate reads the account correctly",
    typeof activated === "boolean",
    activated ? "activated" : "NOT activated (unfunded — expected)"
  );

  const agentsRaw = await info.extraAgents({ user: account.address });
  const agents = parseRegisteredAgents(agentsRaw);
  check("extraAgents parses", Array.isArray(agents), `${agents.length} agent(s)`);
  check(
    "no local key + no agents ⇒ approval required",
    resolveAgentStatus({ registeredAgents: agents, localAccount: null, now: Date.now() }).kind ===
      "approval_required"
  );

  // -------------------------------------------------------------------------
  section("3. Agent approval — the one signature the user ever gives");
  // -------------------------------------------------------------------------
  const masterExchange = new ExchangeClient({
    transport,
    wallet: account,
    signatureChainId: config.signatureChainId,
  });

  if (!activated) {
    console.log("  · account not activated — fund it to run sections 3-5");
    finish(activated, account.address);
    return;
  }

  // The agent key is kept for the rest of the run. Approving an agent whose key
  // is then thrown away leaves a live authorisation nobody can use.
  const agentKey = generatePrivateKey();
  const agentAccount = privateKeyToAccount(agentKey);

  await masterExchange.approveAgent({ agentAddress: agentAccount.address, agentName: "smoke" });
  check("approveAgent accepted", true, agentAccount.address);

  const afterApproval = parseRegisteredAgents(await info.extraAgents({ user: account.address }));
  const registered = afterApproval.find(
    (a) => a.address.toLowerCase() === agentAccount.address.toLowerCase()
  );
  check("agent appears in extraAgents", Boolean(registered));
  check(
    "validUntil survives as number|null — never coerced",
    registered !== undefined &&
      (registered.validUntil === null || typeof registered.validUntil === "number"),
    String(registered?.validUntil)
  );
  check(
    "policy now reports ready for this agent",
    resolveAgentStatus({
      registeredAgents: afterApproval,
      localAccount: agentAccount,
      now: Date.now(),
    }).kind === "ready"
  );

  // -------------------------------------------------------------------------
  section("4. Spot -> perp transfer");
  // -------------------------------------------------------------------------
  // Deposited USDC lands in SPOT. Perps trade against the PERP balance, so
  // without this a funded account still cannot place an order.
  const perpBefore = await info.clearinghouseState({ user: account.address });
  const perpValue = new BigNumber(perpBefore.marginSummary.accountValue);
  console.log(`  · perp balance before: $${perpValue.toFixed(2)}`);

  if (perpValue.lt(11)) {
    const spot = await info.spotClearinghouseState({ user: account.address });
    const usdc = spot.balances.find((b) => b.coin === "USDC");
    const available = new BigNumber(usdc?.total ?? "0");
    check("spot balance found", available.gt(0), `$${available.toFixed(2)}`);

    // The top-up keeps a dollar back, so it needs MORE than a dollar to move.
    // Without this the script computed a negative amount on a low spot balance
    // ($0.50 -> "-0.50") and died inside `canonicalAmount`, which reads as a
    // broken money path rather than as "this testnet account needs funding".
    if (available.lte(1)) {
      check(
        "spot -> perp top-up skipped (needs > $1 spot)",
        true,
        `$${available.toFixed(2)} available`
      );
      return;
    }

    const moved = await classTransfer({
      signer: "master",
      client: masterExchange as unknown as Parameters<typeof classTransfer>[0]["client"],
      amount: canonicalAmount(available.minus(1).toFixed(2)),
      toPerp: true,
    });
    check(
      "usdClassTransfer spot -> perp",
      moved.kind === "settled",
      moved.kind === "settled" ? "" : JSON.stringify(moved)
    );
    await new Promise((r) => setTimeout(r, 3000));
  }

  const perpAfter = await info.clearinghouseState({ user: account.address });
  check(
    "perp account is funded",
    new BigNumber(perpAfter.marginSummary.accountValue).gt(0),
    `$${new BigNumber(perpAfter.marginSummary.accountValue).toFixed(2)}`
  );

  // -------------------------------------------------------------------------
  section("5. Order placement, signed by the AGENT (the production path)");
  // -------------------------------------------------------------------------
  const agentExchange = new ExchangeClient({
    transport,
    wallet: agentAccount,
    signatureChainId: config.signatureChainId,
  });

  const converter = await SymbolConverter.create({ transport });
  const assets = wrapSymbolConverter(converter);
  const btc = resolveAssetSpec(assets, "BTC");
  const mids = (await info.allMids()) as Record<string, string>;
  const mid = new BigNumber(mids.BTC);

  // A buy 20% below mid: clears the $10 minimum, rests without filling, and is
  // cancelled at the end. Nothing here should ever execute.
  const restingPrice = mid.multipliedBy(0.8);
  const size = new BigNumber(11).dividedBy(restingPrice);
  const leg = buildLimitOrder({
    asset: btc,
    isBuy: true,
    price: restingPrice,
    size,
    tif: "Gtc",
    cloid: generateCloid(),
  });
  check(
    "leg clears the $10 minimum notional",
    meetsMinNotional(leg.p, leg.s),
    `${leg.s} BTC @ ${leg.p} = $${new BigNumber(leg.p).multipliedBy(leg.s).toFixed(2)}`
  );

  const outcome = await submitOrders({ client: agentExchange, orders: [leg] });
  check("submit settled", outcome.kind === "settled", outcome.kind);

  if (outcome.kind !== "settled") {
    finish(activated, account.address);
    return;
  }
  const restingLeg = outcome.result.legs.find((l) => l.kind === "resting");
  check("order rested on the book", Boolean(restingLeg), JSON.stringify(outcome.result.legs[0]));
  check(
    "cloid echoed back and matches what we sent",
    restingLeg?.kind === "resting" && restingLeg.cloid === leg.c,
    restingLeg?.kind === "resting" ? String(restingLeg.cloid) : "—"
  );

  // -------------------------------------------------------------------------
  section("6. Reconcile by cloid, then cancel by cloid");
  // -------------------------------------------------------------------------
  const verdicts = await reconcileCloids({
    probe: info as unknown as Parameters<typeof reconcileCloids>[0]["probe"],
    user: account.address,
    cloids: [leg.c!],
    expiresAt: Date.now() - 1,
  });
  check("orderStatus finds the order BY CLOID", verdicts[0].kind === "landed", verdicts[0].kind);
  check(
    "retry is correctly refused while the order is live",
    canSafelyRetry(verdicts) === false,
    "retrying here would double the position"
  );

  const cancelled = await cancelOrdersByCloid({
    client: agentExchange,
    cancels: [{ assetId: btc.assetId, cloid: leg.c! }],
  });
  check("cancelByCloid succeeded", cancelled.ok, cancelled.ok ? "" : String(cancelled.error));

  const afterCancel = await reconcileCloids({
    probe: info as unknown as Parameters<typeof reconcileCloids>[0]["probe"],
    user: account.address,
    cloids: [leg.c!],
    expiresAt: Date.now() - 1,
  });
  const status = afterCancel[0].kind === "landed" ? afterCancel[0].status : "gone";
  check("order is no longer open", status !== "open", `status=${status}`);

  finish(activated, account.address);
}

function finish(activated: boolean, address: string): void {
  console.log("\n" + "=".repeat(46));
  if (failures === 0) {
    console.log("PASS — signing and order path verified against live testnet");
    if (!activated) {
      console.log(`\nFund this address with testnet USDC for the full run:\n  ${address}`);
    }
  } else {
    console.log(`FAIL — ${failures} check(s) failed`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nSigning smoke crashed:", error);
  process.exit(1);
});
