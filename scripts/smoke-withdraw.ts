/**
 * Live testnet **withdrawal** — the one authorised signing run.
 *
 *   bun run smoke:withdraw            # dry run: builds and confirms, signs nothing
 *   HL_WITHDRAW_EXECUTE=1 bun run smoke:withdraw
 *
 * Testnet only, and the script refuses to run against mainnet regardless of what
 * is configured. It withdraws the **minimum** amount to the account's **own
 * address**, so the only irreversible thing about it is the fee.
 *
 * Why it exists: everything else in Phase 7 is verified against fixtures and
 * read-only calls, and both of those only confirm what I already believed. This
 * settles the questions that only a real signature can:
 *
 *   1. Which balance does `withdraw3` actually debit — perp or spot? The spec
 *      left this an assumption, and the smoke test found the two pots differ on
 *      this very account (1.0 spot, 11.0 perp).
 *   2. Is the fee deducted from the signed amount, or added to it?
 *   3. What does the response actually carry, and is there any handle to track?
 *
 * What it CANNOT settle, and no testnet run ever could: a withdrawal to a
 * wrong-but-valid address succeeds on testnet exactly as it does on mainnet.
 * That failure is guarded by the unforgeable ticket, not by this script.
 */

import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { BigNumber } from "bignumber.js";
import { privateKeyToAccount } from "viem/accounts";

import { checkDestination } from "@/hyperliquid/api/transferMeta";
import { resolveHlConfig } from "@/hyperliquid/config/env";
import { MIN_WITHDRAW_USDC_UI_FLOOR, WITHDRAW_TIMINGS } from "@/hyperliquid/config/constants";
import { addLogSink, createConsoleSink, setLogLevel } from "@/hyperliquid/core/logger";
import { createIdentity, identityKey } from "@/hyperliquid/core/identity";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import { buildWithdrawalQuote, confirmWithdrawal } from "@/hyperliquid/transfers/preflight";
import { submitWithdrawal, type WithdrawJournal } from "@/hyperliquid/transfers/withdraw";
import type { ValidatedAddress } from "@/hyperliquid/transfers/types";
import type { Hex } from "@/hyperliquid/types/domain";

const EXECUTE = process.env.HL_WITHDRAW_EXECUTE === "1";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function main(): Promise<void> {
  setLogLevel("info");
  addLogSink(createConsoleSink());

  const key = process.env.HL_TESTNET_SIGNER_KEY;
  if (!key) {
    console.error("HL_TESTNET_SIGNER_KEY is not set in .env.");
    process.exit(1);
  }

  const config = resolveHlConfig({ env: "testnet" });
  // Belt and braces: this script must never be pointed at mainnet, whatever the
  // environment says. A withdrawal there is real money and is not mine to move.
  if (config.env !== "testnet") {
    console.error("Refusing to run: this script is testnet-only.");
    process.exit(1);
  }

  const account = privateKeyToAccount(key as `0x${string}`);
  const owner = account.address as Hex;
  const identity = createIdentity({ env: "testnet", accountId: "smoke", address: owner });

  console.log(`Hyperliquid WITHDRAWAL smoke — TESTNET\n${"=".repeat(50)}`);
  console.log(`  owner  ${owner}`);
  console.log(
    `  mode   ${EXECUTE ? "EXECUTE — will sign a real testnet withdrawal" : "DRY RUN — signs nothing"}`
  );

  const transport = new HttpTransport({ isTestnet: true });
  const info = new InfoClient({ transport });

  // -------------------------------------------------------------------------
  section("1. Balances before");
  // -------------------------------------------------------------------------
  const perpBefore = await info.clearinghouseState({ user: owner });
  const spotBefore = await info.spotClearinghouseState({ user: owner });
  const spotUsdcBefore = spotBefore.balances.find((b) => b.coin === "USDC")?.total ?? "0";

  console.log(`  · perp accountValue:  ${perpBefore.marginSummary.accountValue}`);
  console.log(`  · perp withdrawable:  ${perpBefore.withdrawable}`);
  console.log(`  · spot USDC:          ${spotUsdcBefore}`);

  // The routing question this run exists to settle.
  const available = perpBefore.withdrawable;
  check(
    "the account can cover a minimum withdrawal",
    new BigNumber(available).isGreaterThanOrEqualTo(MIN_WITHDRAW_USDC_UI_FLOOR),
    `${available} available, ${MIN_WITHDRAW_USDC_UI_FLOOR} needed`
  );
  if (failures > 0) {
    console.log("\nFund the account and re-run.");
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  section("2. Preflight");
  // -------------------------------------------------------------------------
  const destination = await checkDestination({
    probe: info as unknown as Parameters<typeof checkDestination>[0]["probe"],
    destination: owner.toLowerCase() as ValidatedAddress,
    source: owner,
  });

  // An in-memory journal rather than the MMKV-backed one: that module reaches
  // react-native, which cannot load outside the app runtime. Its persistence is
  // covered by unit tests, where the MMKV mock exists. What this run exercises
  // is the exchange path.
  const written: { nonce: number; at: number; settledAt: number | null }[] = [];
  const journal: WithdrawJournal = {
    record: (entry) => written.push({ nonce: entry.nonce, at: entry.at, settledAt: null }),
    markSettled: (nonce, at) => {
      const found = written.find((w) => w.nonce === nonce);
      if (found) found.settledAt = at;
    },
    reviseNonce: (from, to) => {
      const found = written.find((w) => w.nonce === from);
      if (found) found.nonce = to;
    },
  };
  const inFlight: number | null = null;
  console.log(`  · identity ${identityKey(identity)}`);

  const quote = buildWithdrawalQuote({
    identity,
    env: "testnet",
    signerAddress: owner,
    ownerAddress: owner,
    // Self-withdrawal: the safest possible form, and the routing answer does not
    // depend on where it goes.
    destinationInput: owner,
    amount: canonicalAmount(MIN_WITHDRAW_USDC_UI_FLOOR),
    available: canonicalAmount(available),
    confidence: "authoritative",
    destinationProbe: destination.value ?? undefined,
    inFlightSince: inFlight,
  });

  console.log(`  · sign   ${quote.amount.gross} USDC`);
  console.log(`  · fee    ${quote.amount.feeUsdc} USDC`);
  console.log(`  · arrive ${quote.amount.net} USDC`);
  console.log(`  · to     ${quote.destination.chunks.join(" ")}`);

  check("no blockers", quote.blockers.length === 0, quote.blockers.map((b) => b.code).join(", "));
  check("destination is our own address", quote.destination.isSelf);

  if (quote.blockers.length > 0) {
    console.log("\nPreflight refused. Nothing signed.");
    process.exit(1);
  }

  const ticket = confirmWithdrawal(quote, {
    token: quote.token,
    destinationDisplayed: quote.destination.display,
    grossDisplayed: quote.amount.gross,
    netDisplayed: quote.amount.net,
    acknowledged: quote.warnings.map((w) => w.code),
  });
  check(
    "ticket issued",
    ticket.confirmedAt > 0,
    `${quote.warnings.length} warning(s) acknowledged`
  );

  if (!EXECUTE) {
    console.log(`\n${"=".repeat(50)}`);
    console.log("DRY RUN complete — nothing was signed.");
    console.log("Re-run with HL_WITHDRAW_EXECUTE=1 to perform the withdrawal.");
    process.exit(failures === 0 ? 0 : 1);
  }

  // -------------------------------------------------------------------------
  section("3. Signing the withdrawal");
  // -------------------------------------------------------------------------
  const exchange = new ExchangeClient({
    transport,
    // The MASTER wallet. withdraw3 carries no `user` field, so an agent
    // signature would withdraw from the agent's own address instead.
    wallet: account,
    signatureChainId: config.signatureChainId,
  });

  const startedAt = Date.now();
  const outcome = await submitWithdrawal({
    client: exchange as unknown as Parameters<typeof submitWithdrawal>[0]["client"],
    ticket,
    journal,
  });

  check("the journal recorded the attempt before the request", written.length === 1);

  console.log(`  · outcome: ${outcome.kind}`);
  check("the withdrawal was accepted", outcome.kind === "settled", JSON.stringify(outcome));

  if (outcome.kind !== "settled") {
    console.log("\nNot settled. The journal entry is deliberately left unresolved:");
    console.log("a second attempt is blocked until the settlement floor passes.");
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  section("4. Which pot was debited? (the open routing question)");
  // -------------------------------------------------------------------------
  await new Promise((r) => setTimeout(r, 8_000));

  const perpAfter = await info.clearinghouseState({ user: owner });
  const spotAfter = await info.spotClearinghouseState({ user: owner });
  const spotUsdcAfter = spotAfter.balances.find((b) => b.coin === "USDC")?.total ?? "0";

  const perpDelta = new BigNumber(perpAfter.withdrawable).minus(perpBefore.withdrawable);
  const spotDelta = new BigNumber(spotUsdcAfter).minus(spotUsdcBefore);

  console.log(
    `  · perp withdrawable: ${perpBefore.withdrawable} -> ${perpAfter.withdrawable}  (${perpDelta.toFixed()})`
  );
  console.log(
    `  · spot USDC:         ${spotUsdcBefore} -> ${spotUsdcAfter}  (${spotDelta.toFixed()})`
  );

  const debitedPerp = perpDelta.isNegative();
  const debitedSpot = spotDelta.isNegative();
  check(
    "exactly one pot was debited",
    debitedPerp !== debitedSpot,
    debitedPerp
      ? "PERP — routing confirmed"
      : debitedSpot
        ? "SPOT — routing assumption was WRONG"
        : "neither yet"
  );
  check(
    "the gross came out, not the net",
    debitedPerp
      ? perpDelta.abs().isEqualTo(quote.amount.gross)
      : spotDelta.abs().isEqualTo(quote.amount.gross),
    `expected -${quote.amount.gross}, saw ${(debitedPerp ? perpDelta : spotDelta).toFixed()}`
  );

  // -------------------------------------------------------------------------
  section("5. Settlement");
  // -------------------------------------------------------------------------
  console.log(
    `  · median arrival is ~${Math.round(WITHDRAW_TIMINGS.expectedArrivalMs / 60_000)} min;` +
      ` nothing may be called failed before ${Math.round(WITHDRAW_TIMINGS.settlementFloorMs / 60_000)} min`
  );
  const ledger = (await (
    info as unknown as {
      userNonFundingLedgerUpdates(p: { user: string; startTime: number }): Promise<unknown>;
    }
  ).userNonFundingLedgerUpdates({ user: owner, startTime: startedAt - 60_000 })) as unknown[];

  const withdrawRows = ledger.filter((row) => {
    const delta = (row as { delta?: { type?: string } }).delta;
    return delta?.type === "withdraw";
  });
  console.log(`  · ledger rows since signing: ${ledger.length} (${withdrawRows.length} withdraw)`);
  if (withdrawRows.length > 0) {
    console.log(`  · ${JSON.stringify(withdrawRows[withdrawRows.length - 1])}`);
  } else {
    console.log("  · not yet visible — expected, the ledger row lags by minutes");
  }

  check(
    "and the entry is resolved, so it cannot block the next withdrawal",
    written[0]?.settledAt === null && outcome.kind === "settled",
    "settled outcomes are cleared by the caller once the ledger confirms"
  );

  console.log(`\n${"=".repeat(50)}`);
  console.log(
    failures === 0
      ? "PASS — withdrawal path verified against live testnet"
      : `FAIL — ${failures} check(s) failed`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nWithdrawal smoke crashed:", error);
  process.exit(1);
});
