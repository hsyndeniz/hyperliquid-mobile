/**
 * Live testnet **transfer** smoke test — read-only.
 *
 *   bun run smoke:transfers
 *
 * No wallet, no signing, no funds moved. It verifies the facts the withdrawal
 * path is built on, which is the only class of bug unit tests cannot reach: the
 * fixtures encode what I already believed, and this checks whether the exchange
 * agrees.
 *
 * The one thing it deliberately does NOT test is the failure that matters most —
 * a withdrawal to a wrong-but-valid address. That succeeds on testnet exactly as
 * it would on mainnet, which is precisely why the guard against it is type-level
 * (`WithdrawalTicket` cannot be forged) rather than something a test could catch.
 */

import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { BigNumber } from "bignumber.js";

import { checkDestination } from "@/hyperliquid/api/transferMeta";
import { MIN_WITHDRAW_USDC_UI_FLOOR, WITHDRAW_FEE_USDC } from "@/hyperliquid/config/constants";
import { addLogSink, createConsoleSink, setLogLevel } from "@/hyperliquid/core/logger";
import { createIdentity } from "@/hyperliquid/core/identity";
import { canonicalAmount, maxWithdrawable, netAfterFee } from "@/hyperliquid/transfers/amount";
import { validateDestination } from "@/hyperliquid/transfers/destination";
import { buildWithdrawalQuote, confirmWithdrawal } from "@/hyperliquid/transfers/preflight";
import { loadTokenCatalogue } from "@/hyperliquid/transfers/tokens";
import type { ValidatedAddress } from "@/hyperliquid/transfers/types";
import type { Hex } from "@/hyperliquid/types/domain";

const OWNER = (process.env.HL_SMOKE_ADDRESS ?? "0x5Bf8287BAeDA8De01C88b3016D64f3875B0B4347") as Hex;
/** A real, active testnet account — used only as a known-good destination to probe. */
const KNOWN_ACTIVE = "0xCC8A21B439951529281859f6aD39F279606304A7";

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

  console.log(
    `Hyperliquid TRANSFER smoke — TESTNET (read-only)\n${"=".repeat(50)}\n  owner ${OWNER}`
  );

  const transport = new HttpTransport({ isTestnet: true });
  const info = new InfoClient({ transport });
  const identity = createIdentity({ env: "testnet", accountId: "smoke", address: OWNER });

  // -------------------------------------------------------------------------
  section("1. Token ids are network-specific");
  // -------------------------------------------------------------------------
  // Every spotSend example in the SDK's doc comments uses the TESTNET id, and
  // the id sits inside the signed message while the SDK types it as a bare
  // string. A constant would be silently wrong on the other network.
  const { catalogue } = await loadTokenCatalogue({
    probe: info as unknown as Parameters<typeof loadTokenCatalogue>[0]["probe"],
    env: "testnet",
  });
  check(
    "spotMeta resolves a token catalogue",
    catalogue !== null,
    `${catalogue?.size ?? 0} tokens`
  );

  if (catalogue) {
    const usdc = catalogue.find("USDC");
    check("USDC is present", usdc !== null, usdc ? `tokenId ${usdc.tokenId}` : "");
    const wire = catalogue.wireToken("USDC");
    check("the wire token is NAME:tokenId", /^USDC:0x[0-9a-f]{32}$/.test(wire), wire);
    check(
      "it is the TESTNET id, not the one in the SDK docs' mainnet examples",
      wire !== "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
      "a hardcoded id would be wrong on one network or the other"
    );
    let threw = false;
    try {
      catalogue.wireToken("NOTATOKEN");
    } catch {
      threw = true;
    }
    check("an unknown token throws rather than signing a bad id", threw);
  }

  // -------------------------------------------------------------------------
  section("2. preTransferCheck — what it is actually worth");
  // -------------------------------------------------------------------------
  const probe = info as unknown as Parameters<typeof checkDestination>[0]["probe"];

  const active = await checkDestination({
    probe,
    destination: KNOWN_ACTIVE.toLowerCase() as ValidatedAddress,
    source: OWNER,
  });
  check(
    "a real active account reports userExists",
    active.value?.userExists === true,
    `${JSON.stringify(active.value)} deferred=${active.deferred}`
  );

  // A never-used address: the strongest typo signal we have.
  const random = `0x${"9a3f".repeat(10)}`;
  const unused = await checkDestination({
    probe,
    destination: random as ValidatedAddress,
    source: OWNER,
  });
  check(
    "an unused address reports userExists=false",
    unused.value?.userExists === false,
    `activation fee ${unused.value?.activationFee}`
  );

  // The critical negative result: green does NOT mean safe.
  const blackHole = await checkDestination({
    probe,
    destination: `0x${"0".repeat(40)}` as ValidatedAddress,
    source: OWNER,
  });
  check(
    "the zero address reports userExists=TRUE — so green is not a safety signal",
    blackHole.value?.userExists === true,
    "this is why the local blocklist exists"
  );
  check(
    "and the local blocklist catches it anyway",
    validateDestination(`0x${"0".repeat(40)}`).ok === false
  );

  // -------------------------------------------------------------------------
  section("3. Balances and the max-withdrawal figure");
  // -------------------------------------------------------------------------
  const spot = await info.spotClearinghouseState({ user: OWNER });
  const spotUsdc = spot.balances.find((b) => b.coin === "USDC")?.total ?? "0";
  const perp = await info.clearinghouseState({ user: OWNER });

  console.log(`  · spot USDC:         ${spotUsdc}`);
  console.log(`  · perp withdrawable: ${perp.withdrawable}`);

  // ASSUMPTION, to be settled by the authorised testnet withdrawal: `withdraw3`
  // draws from the PERP side, which is what `withdrawable` reports and what the
  // exchange's own interface implies. Reading the spot balance instead produces
  // a false "insufficient balance" on an account whose funds are all in perp —
  // which is this very account, and would have shipped unnoticed.
  const available = perp.withdrawable;
  check(
    "the two pots differ, so picking the wrong one is a real mistake",
    spotUsdc !== perp.withdrawable,
    `spot ${spotUsdc} vs perp ${perp.withdrawable} — routing is an ASSUMPTION until the live withdrawal settles it`
  );

  const max = maxWithdrawable(available, WITHDRAW_FEE_USDC);
  check(
    "max withdrawable is the WHOLE balance, not balance minus fee",
    max === null || new BigNumber(max).isEqualTo(new BigNumber(available).decimalPlaces(6, 1)),
    max === null ? "balance below the fee" : `${max} (fee comes out of this)`
  );
  if (max) {
    check(
      "and its net is one fee less",
      new BigNumber(netAfterFee(max, WITHDRAW_FEE_USDC)).isEqualTo(
        new BigNumber(max).minus(WITHDRAW_FEE_USDC)
      ),
      `${max} signed -> ${netAfterFee(max, WITHDRAW_FEE_USDC)} arrives`
    );
  }

  // -------------------------------------------------------------------------
  section("4. The preflight refuses what it should");
  // -------------------------------------------------------------------------
  const base = {
    identity,
    env: "testnet" as const,
    signerAddress: OWNER,
    ownerAddress: OWNER,
    amount: canonicalAmount(MIN_WITHDRAW_USDC_UI_FLOOR),
    available: canonicalAmount(available),
    confidence: "authoritative" as const,
    destinationProbe: active.value ?? undefined,
  };

  const typo = buildWithdrawalQuote({
    ...base,
    destinationInput: "0x5Bf8287BAeDA8De01C88b3016D64f3875B0B4348",
  });
  check(
    "a one-character typo is blocked by EIP-55",
    typo.blockers.some((b) => b.code === "destination_checksum_failed"),
    "the SDK lowercases first, so nothing downstream could catch this"
  );

  const agentSigned = buildWithdrawalQuote({
    ...base,
    destinationInput: OWNER,
    signerAddress: `0x${"1".repeat(40)}` as Hex,
  });
  check(
    "an agent-key signature is blocked",
    agentSigned.blockers.some((b) => b.code === "signer_mismatch"),
    "withdraw3 has no user field — it would withdraw from the agent's own address"
  );

  const good = buildWithdrawalQuote({ ...base, destinationInput: OWNER });
  check(
    "a self-withdrawal at the floor has no blockers",
    good.blockers.length === 0,
    good.blockers.map((b) => b.code).join(",") || "clean"
  );
  check(
    "and quotes gross, fee and net separately",
    good.amount.gross === MIN_WITHDRAW_USDC_UI_FLOOR &&
      good.amount.net ===
        new BigNumber(MIN_WITHDRAW_USDC_UI_FLOOR).minus(WITHDRAW_FEE_USDC).toFixed(),
    `sign ${good.amount.gross}, receive ${good.amount.net}`
  );

  // -------------------------------------------------------------------------
  section("5. The ticket cannot be obtained dishonestly");
  // -------------------------------------------------------------------------
  const honest = {
    token: good.token,
    destinationDisplayed: good.destination.display,
    grossDisplayed: good.amount.gross,
    netDisplayed: good.amount.net,
    acknowledged: good.warnings.map((w) => w.code),
  };

  let ticketed = false;
  try {
    confirmWithdrawal(good, honest);
    ticketed = true;
  } catch {
    ticketed = false;
  }
  check("an honest echo yields a ticket", ticketed);

  for (const [label, echo] of [
    ["a lowercased destination", { ...honest, destinationDisplayed: good.destination.wire }],
    ["the gross shown as the net", { ...honest, netDisplayed: good.amount.gross }],
    ["a mismatched amount", { ...honest, grossDisplayed: "999" }],
  ] as const) {
    let refused = false;
    try {
      confirmWithdrawal(good, echo);
    } catch {
      refused = true;
    }
    check(`${label} is refused`, refused);
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(
    failures === 0
      ? "PASS — transfer contracts verified against live testnet"
      : `FAIL — ${failures} check(s) failed`
  );
  console.log(
    "\nNOT covered here, and not coverable: a withdrawal to a wrong-but-valid\naddress succeeds on testnet exactly as on mainnet. That is why the guard\nis the unforgeable ticket, not a test."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nTransfer smoke crashed:", error);
  process.exit(1);
});
