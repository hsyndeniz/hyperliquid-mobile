/**
 * The withdrawal contract, end to end, against live Hyperliquid testnet.
 *
 *   HL_E2E=1 bun run test:e2e --testPathPattern withdrawals
 *
 * **Why this exists.** `session.e2e.ts` proved the composition root wires up;
 * this proves the *irreversible* path does. Withdrawal is the one action in the
 * codebase with no `cloid`, no `expiresAfter`, no cancel and no status endpoint,
 * so every safeguard it has is spent before the signature:
 *
 *   buildWithdrawalQuote(...)  ->  facts + blockers + warnings
 *   confirmWithdrawal(quote, echo)  ->  an unforgeable, single-use ticket
 *   submitWithdrawal(ticket)   ->  the only path to `withdraw3`
 *
 * Every unit test for those three drives them against hand-written inputs. That
 * is exactly the shape of the gap that hid the Phase 8 `vaultAddress` bug: each
 * module correct in isolation, the composition wrong. So this drives the real
 * chain — live `preTransferCheck`, the live `withdrawable` figure arriving over
 * the websocket, the master-signed `ExchangeClient` from `session.masterClient()`,
 * and the real MMKV-backed journal — in the real order.
 *
 * **What it costs, and the one opt-in.** Everything here runs by default except
 * the packet leaving the process. Section 4 builds the quote, confirms the
 * ticket and calls `submitWithdrawal` for real; the injected `withdraw3` records
 * exactly what it was handed and, unless `HL_WITHDRAW_EXECUTE=1`, returns the
 * observed success envelope instead of forwarding it. With the flag set it
 * forwards to `session.masterClient()` and signs.
 *
 * That gate is not squeamishness. `withdraw3` has no idempotency key and no
 * cancel, the UI floor is 2 USDC, and this testnet account holds 4 USDC perp /
 * 14 USDC spot (measured 2026-08-05, no positions, no resting orders) — a suite
 * that signed on every invocation would empty it in two runs and then fail
 * forever on `insufficient_balance`. So the EXECUTE branch additionally refuses
 * to sign unless the live `withdrawable` can absorb the gross **twice**.
 *
 *     HL_E2E=1 HL_WITHDRAW_EXECUTE=1 bun run test:e2e --testPathPattern withdrawals
 *
 * **The one authorised live run, measured.** 2 USDC to the account's own
 * address. It **settled** — `{kind:"settled"}`, not the refusal `withdraw.ts`'s
 * own header records — perp `withdrawable` went 6.0 -> 4.0 while spot USDC
 * stayed at 14.0, and the ledger row appeared 243 s later reading
 * `{"type":"withdraw","usdc":"1.0","fee":"1.0"}`. So testnet withdrawal DOES
 * complete now, the debited pot is **perp**, the **gross** is what leaves, and
 * the 1 USDC fee is taken **out of** it. Two long-standing "unverified"
 * assumptions in `config/constants.ts` are answered by that; see the report.
 *
 * Because that run cannot be repeated without spending real balance, the
 * EXECUTE branch's balance assertions are the only unexecuted code in the file.
 * Every other exchange-facing assertion uses a client that counts its calls and
 * fails the test if it was reached at all — including, in the default mode, a
 * counter on `session.masterClient()` itself, so "nothing was signed" is a
 * measured fact rather than an inference from a balance that barely moves.
 *
 * Skips itself unless `HL_E2E=1`, so it can never run in the fast suite by
 * accident, and skips loudly if the signing key is absent.
 */

import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { BigNumber } from "bignumber.js";
import { getAddress, isAddress, keccak256, stringToBytes } from "viem";

import { checkDestination } from "@/hyperliquid/api/transferMeta";
import { MIN_WITHDRAW_USDC_UI_FLOOR } from "@/hyperliquid/config/constants";
import { HlError } from "@/hyperliquid/core/errors";
import { createIdentity, identityKey } from "@/hyperliquid/core/identity";
import { addLogSink, createConsoleSink, setLogLevel } from "@/hyperliquid/core/logger";
import { HyperliquidSession } from "@/hyperliquid/session";
import { setupHyperliquid } from "@/hyperliquid/setup";
import { storeAgentKey } from "@/hyperliquid/auth/keychain";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import {
  clearWithdrawals,
  lastUnsettledAt,
  listUnsettled,
  recordWithdrawal,
  reviseWithdrawalNonce,
  settleWithdrawal,
} from "@/hyperliquid/transfers/journal";
import {
  buildWithdrawalQuote,
  confirmWithdrawal,
  QUOTE_TTL_MS,
  type DestinationProbeResult,
  type WithdrawalEcho,
  type WithdrawalQuote,
  type WithdrawalTicket,
} from "@/hyperliquid/transfers/preflight";
import {
  submitWithdrawal,
  type WithdrawClient,
  type WithdrawJournal,
} from "@/hyperliquid/transfers/withdraw";
import type { ValidatedAddress, WireAmount } from "@/hyperliquid/transfers/types";
import { importPrivateKey } from "@/hyperliquid/wallet/accounts";
import type { Hex, HlIdentity } from "@/hyperliquid/types/domain";
import { withRateLimitRetry } from "@/hyperliquid/__e2e__/support";

const KEY = process.env.HL_TESTNET_SIGNER_KEY;
const ENABLED = process.env.HL_E2E === "1" && Boolean(KEY);

/** Whether section 4 forwards its `withdraw3` to the exchange. See the header. */
const EXECUTE = process.env.HL_WITHDRAW_EXECUTE === "1";

const describeE2E = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  // Loud, and says which of the two conditions failed — a silently skipped e2e
  // suite reads exactly like a passing one.
  console.warn(
    process.env.HL_E2E === "1"
      ? "e2e SKIPPED: HL_TESTNET_SIGNER_KEY is not set (is .env present?)"
      : "e2e SKIPPED: set HL_E2E=1 to run against live testnet"
  );
} else if (!EXECUTE) {
  // Equally loud. A reader who assumes the withdrawal was signed would take this
  // run as proof of something it did not test.
  console.warn(
    "withdrawals e2e: the final withdraw3 is CAPTURED, not signed. " +
      "Set HL_WITHDRAW_EXECUTE=1 to sign a real 2 USDC testnet withdrawal."
  );
}

/** A plain positive decimal: what the exchange emits and what may be signed. */
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

/**
 * The measured withdrawal fee, in USDC.
 *
 * Deliberately a literal rather than `WITHDRAW_FEE_USDC`: asserting a constant
 * against itself passes whatever the constant says. This is the number the live
 * ledger row reported — `{"usdc":"1.0","fee":"1.0"}` against a 2.0 gross — so if
 * `WITHDRAW_FEE_USDC` ever drifts from what the exchange charges, the quote's
 * "you will receive" line is wrong by exactly that drift and this fails.
 */
const MEASURED_FEE_USDC = "1";

/**
 * The measured UI floor, in USDC. A literal, for the same reason as the fee.
 *
 * Not a protocol rule — 2.2 succeeded live on testnet — so if it moves, the
 * copy and the sub-floor test below both have to move with it, on purpose.
 */
const MEASURED_UI_FLOOR = "2";

/**
 * `WITHDRAW_TIMINGS.settlementFloorMs`, as a literal.
 *
 * 15 minutes, chosen to clear the observed maxima (530.8 s mainnet, 738.7 s
 * testnet). Nothing may be called failed before this and — decisively — no
 * second withdrawal may be signed before it.
 */
const MEASURED_SETTLEMENT_FLOOR_MS = 900_000;

/** The canonical black hole. Both a preflight blocklist entry and a live probe subject. */
const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Hex;

describeE2E("the withdrawal contract against live testnet", () => {
  const info = new InfoClient({ transport: new HttpTransport({ isTestnet: true }) });
  /** `InfoClient` types its addresses as `0x${string}`; the probe port takes `string`. */
  const probePort = info as unknown as Parameters<typeof checkDestination>[0]["probe"];

  let session: HyperliquidSession;
  let identity: HlIdentity;
  /** Lowercase — the form that gets signed. */
  let ownerWire: ValidatedAddress;
  /** EIP-55 checksummed — the form a human verifies, and the only one carrying the typo check. */
  let ownerDisplay: Hex;
  /** The live `withdrawable` figure, taken from the websocket account frame. */
  let available: WireAmount;
  /** Live `preTransferCheck` on our own address. */
  let selfProbe: DestinationProbeResult;
  /** Live `preTransferCheck` on `0x0`, which the endpoint calls healthy. */
  let zeroProbe: DestinationProbeResult;

  beforeAll(async () => {
    setLogLevel("warn");
    addLogSink(createConsoleSink());

    // The module bootstrap, exactly as `src/app/_layout.tsx` calls it: the vault
    // refuses to operate without its AES-GCM backend registered.
    setupHyperliquid();

    const derived = await importPrivateKey(KEY as string);
    ownerDisplay = getAddress(derived.address) as Hex;
    ownerWire = ownerDisplay.toLowerCase() as ValidatedAddress;

    // Seed the ALREADY-APPROVED agent rather than approving a new one: the
    // testnet master allows three API wallets for a zero-volume account, and all
    // three are spoken for.
    const seedIdentity = createIdentity({
      env: "testnet",
      accountId: ownerDisplay,
      address: ownerDisplay,
    });
    await storeAgentKey(
      seedIdentity,
      keccak256(stringToBytes(`hl-vault-probe:${ownerDisplay.toLowerCase()}`)) as Hex
    );

    session = new HyperliquidSession();
    const state = await withRateLimitRetry("session.start", () =>
      session.start({ env: "testnet" })
    );
    identity = state.identity;

    // A journal entry left behind by an earlier run would block every quote
    // below with `withdrawal_in_flight` for 15 minutes and make the whole file
    // look like a preflight bug.
    clearWithdrawals();

    // The balance the preflight quotes comes from the live websocket frame, not
    // a REST call made for the test — that boundary is the thing unit tests
    // cannot cross.
    const account = await waitFor(() => session.stores.account.read(), 45_000);
    available = canonicalAmount(account.summary.withdrawable);

    // Fail here rather than six assertions later. Below the floor there is no
    // clean quote to build and every test in sections 2-4 fails for a reason
    // that has nothing to do with the code under test.
    if (new BigNumber(available).isLessThan(MEASURED_UI_FLOOR)) {
      throw new Error(
        `testnet account has ${available} USDC withdrawable, below the ${MEASURED_UI_FLOOR} ` +
          `USDC floor this suite quotes at — top it up before running`
      );
    }

    const check = await checkDestination({
      probe: probePort,
      destination: ownerWire,
      source: ownerDisplay,
    });
    if (!check.value) throw new Error("live preTransferCheck returned nothing; cannot proceed");
    selfProbe = check.value;

    // Probed once, here, so the blacklist test in section 2 can be handed the
    // exchange's REAL answer for `0x0` rather than a hand-written one that only
    // records what the author believed it would say.
    const zero = await checkDestination({
      probe: probePort,
      destination: ZERO_ADDRESS.toLowerCase() as ValidatedAddress,
      source: ownerDisplay,
    });
    if (!zero.value) throw new Error("live preTransferCheck on 0x0 returned nothing");
    zeroProbe = zero.value;
  }, 120_000);

  afterAll(async () => {
    // Leave no state behind: an unsettled row would block the next run's quotes.
    clearWithdrawals();
    await session?.stop().catch(() => undefined);
  }, 60_000);

  // -------------------------------------------------------------------------
  describe("1. preTransferCheck, the only destination signal not written by us", () => {
    it("answers for a real address: exists, has transacted, not sanctioned", () => {
      // `userExists === false` is the strongest typo signal the preflight has
      // (14/14 single-character substitutions caught). If it came back false for
      // our OWN, heavily used address, the preflight would raise
      // `new_destination_account` on every self-withdrawal and the warning would
      // be trained out of the user within a week.
      expect(selfProbe.userExists).toBe(true);
      expect(selfProbe.userHasSentTx).toBe(true);
      // A true here is a hard blocker. Never observed true across ~80 live calls;
      // if it flipped for our own account no withdrawal could ever be quoted.
      expect(selfProbe.isSanctioned).toBe(false);
    });

    it("surfaces the activation fee as a STRING, never summed into an amount", async () => {
      const check = await checkDestination({
        probe: probePort,
        destination: ownerWire,
        source: ownerDisplay,
      });
      expect(check.deferred).toBe(false);
      expect(check.value).not.toBeNull();
      // The 1-unit charge on a new destination is an account-activation fee in a
      // token that varies ("USDC", "USDT0" and "" all seen). Parsing it as a
      // number and adding it to the gross would sign an amount the user never
      // read; it stays a string and stays out of `amount`.
      expect(typeof check.value!.activationFee).toBe("string");
      expect(check.value!.activationFee).toMatch(DECIMAL);
      // And it really is an *activation* fee: our address is long established,
      // so the live answer is zero. A non-zero figure here would mean the field
      // is a transfer fee after all, and the quote's net would be short by it.
      expect(new BigNumber(check.value!.activationFee).isZero()).toBe(true);
    }, 30_000);

    it("requires `source` to be a 42-character address, not a label", async () => {
      // The SDK's schema rejects anything that is not `^0[xX][0-9a-fA-F]+$` of
      // length 42, before the request leaves the process. A caller that passed a
      // descriptive label — the obvious thing to write, since the value provably
      // does not change the answer — would get no destination checks at all.
      const labelled = await checkDestination({
        probe: probePort,
        destination: ownerWire,
        source: "withdrawal-preflight",
      });
      expect(labelled.value).toBeNull();
      // Not `deferred`: the weight budget allowed the call, the SDK refused it.
      // The preflight then emits `checks_incomplete` rather than throwing, so a
      // schema rejection degrades into "verify the address yourself" — which is
      // only safe because it is a warning the user sees, not a silent green light.
      expect(labelled.deferred).toBe(false);

      // The control. Without it, the null above is equally explained by the
      // endpoint being down, and this test would assert nothing. It asserts real
      // content, not merely non-null, so a stub returning `{value:{}}` fails too.
      const addressed = await checkDestination({
        probe: probePort,
        destination: ownerWire,
        source: ownerDisplay,
      });
      expect(addressed.deferred).toBe(false);
      expect(addressed.value?.userExists).toBe(true);
      expect(addressed.value?.userHasSentTx).toBe(true);
    }, 30_000);

    it("reports the ZERO address as an existing, unsanctioned account", () => {
      // Measured live, and the reason the blocklist in `destination.ts` exists:
      // the endpoint says the burn address exists and is not sanctioned. A UI
      // that rendered `userExists` as a green tick would wave through the one
      // destination from which funds can never be recovered.
      expect(zeroProbe.userExists).toBe(true);
      expect(zeroProbe.isSanctioned).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("2. every blocker fires against live data", () => {
    it("agrees with the exchange's own `withdrawable`, over the websocket", async () => {
      // The store's figure is a parsed websocket frame; the REST figure is the
      // same number fetched a different way. Everything downstream is quoted
      // from the store — the insufficient-balance blocker, and any max button —
      // so a store that merged rather than replaced would keep a pre-trade
      // balance on screen and every maximum withdrawal would be refused by the
      // exchange as an overdraw the user was never shown.
      //
      // Polled rather than sampled once: the account channel is a ~5 s
      // heartbeat, so a single sample can straddle a change and disagree for
      // reasons that are not a bug.
      const agreed = await waitFor(async () => {
        const rest = await info.clearinghouseState({ user: ownerDisplay });
        const live = session.stores.account.read();
        if (!live) return null;
        return new BigNumber(live.summary.withdrawable).isEqualTo(rest.withdrawable)
          ? { ws: live.summary.withdrawable, rest: rest.withdrawable }
          : null;
      }, 30_000);

      // A string, verbatim from the wire. `Number("6.0")` is how a 2 USDC debit
      // hides inside a floating-point comparison.
      expect(typeof agreed.ws).toBe("string");
      expect(agreed.ws).toMatch(DECIMAL);
      // Non-zero, or every quote below would be blocked and the whole section
      // would pass for the wrong reason.
      expect(new BigNumber(agreed.ws).isGreaterThan(0)).toBe(true);
      // Byte-for-byte, not merely numerically: the poll above already settled
      // the numeric comparison, so this asserts the parser hands the money
      // string through VERBATIM. A parser that normalised "4.0" to "4" would be
      // reformatting money on its way to the signature — the exact class of
      // rewrite `transfers/amount` exists to keep out of the signed message.
      expect(agreed.ws).toBe(agreed.rest);
      // And it is the server's own `withdrawable`, never derived:
      // `accountValue - totalMarginUsed` once gave $67,004 where the API said
      // $12.75, because resting-order margin reservations are in neither term.
    }, 60_000);

    it("quotes a clean self-withdrawal with no blockers, fee deducted FROM the gross", () => {
      const quote = quoteFor({});

      expect(quote.blockers).toEqual([]);
      // No warnings either. A `third_party_destination` warning on the user's
      // OWN address, or a `checks_incomplete` when the probe answered, is how a
      // confirmation sheet becomes a wall of dismissable noise — after which the
      // one warning that matters is dismissed too.
      expect(quote.warnings).toEqual([]);

      // The fee direction is the extremes hazard: a "max" button that
      // pre-subtracts strands 1 USDC in the account forever, and one that adds
      // overdraws and is rejected every time. gross - fee === net, always.
      expect(quote.amount.gross).toBe(MEASURED_UI_FLOOR);
      expect(quote.amount.feeUsdc).toBe(MEASURED_FEE_USDC);
      expect(quote.amount.net).toBe("1");
      expect(new BigNumber(quote.amount.gross).minus(quote.amount.feeUsdc).toFixed()).toBe(
        quote.amount.net
      );

      // Both address forms, and the chunking without which nobody actually
      // compares 40 hex characters. The chunks must REBUILD the address: four
      // groups of the wrong characters look exactly as reassuring as four groups
      // of the right ones.
      expect(quote.destination.wire).toBe(ownerWire);
      expect(quote.destination.display).toBe(ownerDisplay);
      expect(quote.destination.chunks).toHaveLength(10);
      expect(quote.destination.chunks.every((c) => c.length === 4)).toBe(true);
      expect(quote.destination.chunks.join("")).toBe(ownerDisplay.slice(2));
      expect(quote.destination.isSelf).toBe(true);

      // The live figure, carried through as a string, unmodified.
      expect(quote.source.available).toBe(available);
      // The scoping key the in-flight guard reads. Keyed on the wrong identity,
      // the guard would look for an account's in-flight withdrawal under
      // someone else's key and find nothing — which is the state in which a
      // second, equally final withdrawal gets signed.
      expect(quote.identityKey).toBe(identityKey(identity));
      expect(quote.timing.failureFloorMs).toBe(MEASURED_SETTLEMENT_FLOOR_MS);
    });

    it("blocks below the UI floor without confusing it for the protocol floor", () => {
      // 1.5 clears the 1 USDC fee, so a net does arrive — this is the UI floor
      // alone. If the two collapsed into one code, the copy would tell the user
      // the exchange forbids it, which is false, and nobody could ever raise or
      // lower the floor without an exchange change.
      const quote = quoteFor({ amount: canonicalAmount("1.5") });
      const codes = quote.blockers.map((b) => b.code);
      expect(codes).toContain("amount_below_ui_floor");
      expect(codes).not.toContain("amount_not_positive_after_fee");
      expect(quote.amount.net).toBe("0.5");
    });

    it("blocks more than the live withdrawable balance, quoting the real figure", () => {
      const tooMuch = canonicalAmount(new BigNumber(available).plus(1_000).toFixed());
      const quote = quoteFor({ amount: tooMuch });

      const blocker = quote.blockers.find((b) => b.code === "insufficient_balance");
      expect(blocker).toBeDefined();
      // The detail names the live number, as a standalone token. A bare
      // `toContain(available)` would pass on "14" when the balance is "4", which
      // is precisely the confusion this message exists to prevent.
      expect(blocker!.detail).toMatch(standaloneNumber(available));

      // And it TRACKS the input rather than being a fixed string that happens to
      // contain a digit: a different balance produces a different sentence. A
      // hard-coded or stale figure sends the user to re-read a balance that
      // never changes, and the block never lifts.
      const control = quoteFor({ amount: tooMuch, available: canonicalAmount("7.25") });
      const controlBlocker = control.blockers.find((b) => b.code === "insufficient_balance");
      expect(controlBlocker!.detail).toMatch(standaloneNumber("7.25"));
      expect(controlBlocker!.detail).not.toBe(blocker!.detail);
    });

    it("blocks a checksum-failed destination the SDK itself would have accepted", () => {
      const typo = misChecksummedNeighbour(ownerDisplay);

      // The decisive fact: the SDK lowercases before validating and then checks
      // only for 42 hex characters, so it sees nothing wrong here. EIP-55 is the
      // last place a single mistyped character is still detectable, and it has to
      // be enforced before the SDK ever sees the string.
      expect(isAddress(typo, { strict: false })).toBe(true);
      expect(typo.toLowerCase()).not.toBe(ownerWire);

      const quote = quoteFor({ destinationInput: typo });
      expect(quote.blockers.map((b) => b.code)).toContain("destination_checksum_failed");
      // Nothing usable escapes a blocked quote.
      expect(quote.destination.wire).toBe("0x");

      // The control: the SAME address with its casing repaired is accepted. So
      // the block came from the checksum, not from "any address but our own" —
      // which would be a different, and much weaker, rule than the one claimed.
      const repaired = quoteFor({ destinationInput: getAddress(typo.toLowerCase()) });
      expect(repaired.blockers.map((b) => b.code)).not.toContain("destination_checksum_failed");
      expect(repaired.destination.wire).toBe(typo.toLowerCase());
      // It is someone else's address, so it warns — loudly, and only that.
      expect(repaired.warnings.map((w) => w.code)).toContain("third_party_destination");
    });

    it("blocks a black-hole destination that the live probe calls healthy", () => {
      // The genuine live answer for 0x0, taken from the exchange in `beforeAll`
      // rather than typed out here. Handing the preflight the reassuring probe
      // proves the block comes from the local blocklist and not from anything
      // the exchange told us — and because it is the live object, it cannot
      // silently stop being reassuring without this test noticing.
      expect(zeroProbe.userExists).toBe(true);
      expect(zeroProbe.isSanctioned).toBe(false);

      const quote = quoteFor({ destinationInput: ZERO_ADDRESS, destinationProbe: zeroProbe });
      expect(quote.blockers.map((b) => b.code)).toContain("destination_blacklisted");
      // And it never leaks a usable destination: a blocked quote carries no wire
      // address, so even a caller that ignored `blockers` has nothing to sign.
      expect(quote.destination.wire).toBe("0x");
    });

    it("blocks a second withdrawal inside the settlement floor, reading the REAL journal", () => {
      const key = identityKey(identity);
      const signedAt = Date.now() - 1_000;
      // Written through the production journal (MMKV-backed, in-memory here), not
      // injected as a number: the in-flight guard is only ever as good as this
      // round trip, and the write happens before the request precisely so a
      // process that dies mid-flight still leaves the evidence.
      recordWithdrawal({
        nonce: signedAt,
        destination: ownerWire,
        amount: canonicalAmount("2"),
        identityKey: key,
        at: signedAt,
      });
      expect(lastUnsettledAt(key)).toBe(signedAt);
      // Scoped by identity, and really scoped: a different account does not
      // inherit this block (it would be told to wait for a withdrawal that is
      // not its own), and the unscoped read still sees it (so the filter is a
      // filter, not an empty journal reading empty).
      expect(lastUnsettledAt(`${key}#someone-else`)).toBeNull();
      expect(lastUnsettledAt()).toBe(signedAt);

      const quote = quoteFor({ inFlightSince: lastUnsettledAt(key) });
      // There is no idempotency key: a second withdrawal inside this 15-minute
      // window is a second, equally final withdrawal — the user pays twice and
      // one of them is unrecoverable.
      expect(quote.blockers.map((b) => b.code)).toEqual(["withdrawal_in_flight"]);

      settleWithdrawal(signedAt, Date.now());
      expect(lastUnsettledAt(key)).toBeNull();
      // And the guard lifts once settled, or the user is locked out forever.
      expect(quoteFor({ inFlightSince: lastUnsettledAt(key) }).blockers).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("3. the echo really gates", () => {
    it("issues a ticket for an honest echo", () => {
      const quote = quoteFor({});
      const before = Date.now();
      const ticket = confirmWithdrawal(quote, echoFor(quote));

      // The very quote that was displayed, by identity — not a copy, not a
      // re-derivation. `submitWithdrawal` re-reads `ticket.quote` to decide what
      // goes on the wire, so anything else here means the amount signed is not
      // the amount confirmed.
      expect(ticket.quote).toBe(quote);
      // A plausible wall-clock stamp, not 0 and not a counter: `submitWithdrawal`
      // refuses any ticket whose `confirmedAt` is not finite and positive.
      expect(ticket.confirmedAt).toBeGreaterThanOrEqual(before);
      expect(ticket.confirmedAt).toBeLessThanOrEqual(Date.now());
    });

    it("refuses a LOWERCASED destination even though it is the same address", () => {
      const quote = quoteFor({});
      const echo: WithdrawalEcho = {
        ...echoFor(quote),
        destinationDisplayed: quote.destination.display.toLowerCase(),
      };

      // Byte-identical to the quoted destination — and still refused. That is the
      // point: an all-lowercase address carries NO checksum information, so a
      // caller that displayed this form showed the human a string in which a
      // single mistyped character is undetectable. The comparison is exact
      // equality on purpose.
      const error = expectRefusal(() => confirmWithdrawal(quote, echo));
      expect(error.context?.reason).toBe("echo_mismatch");
    });

    it("refuses a missing `netDisplayed`, so nobody can skip showing what arrives", () => {
      const quote = quoteFor({});
      const error = expectRefusal(() =>
        confirmWithdrawal(quote, { ...echoFor(quote), netDisplayed: "" })
      );
      expect(error.context?.reason).toBe("echo_mismatch");

      // And the specific hazard it closes: the fee is deducted FROM the gross, so
      // a caller that never computed "you will receive" is exactly the caller who
      // would show 2 USDC arriving when 1 does.
      const wrongDirection = new BigNumber(quote.amount.gross).plus(quote.amount.feeUsdc).toFixed();
      expect(wrongDirection).toBe("3");
      const reversed = expectRefusal(() =>
        confirmWithdrawal(quote, { ...echoFor(quote), netDisplayed: wrongDirection })
      );
      expect(reversed.context?.reason).toBe("echo_mismatch");
    });

    it("refuses an echo that did not acknowledge every warning the quote raised", () => {
      // Omitting the probe is how a real caller reaches this: the endpoint was
      // unreachable, so the quote carries `checks_incomplete` — "verify the
      // address yourself" — and that is the ONLY thing standing between the user
      // and an unverified destination.
      const quote = quoteFor({ destinationProbe: undefined });
      expect(quote.warnings.map((w) => w.code)).toEqual(["checks_incomplete"]);
      expect(quote.blockers).toEqual([]);

      // A caller that rendered the sheet without the warning cannot produce the
      // code, so it cannot confirm. Silently degrading to a green light is the
      // failure this closes.
      const error = expectRefusal(() =>
        confirmWithdrawal(quote, { ...echoFor(quote), acknowledged: [] })
      );
      expect(error.context?.reason).toBe("echo_mismatch");
      expect(error.message).toContain("checks_incomplete");

      // With the acknowledgement, the same quote confirms — so the refusal above
      // is about the warning and not about the missing probe.
      expect(confirmWithdrawal(quote, echoFor(quote)).quote).toBe(quote);
    });
  });

  // -------------------------------------------------------------------------
  describe("4. the full path through submitWithdrawal", () => {
    /** The ticket spent on the wire. Reused below to prove a replay cannot happen. */
    let spentTicket: WithdrawalTicket | null = null;
    let wireCall: { destination: string; amount: string } | null = null;
    /** How many times `session.masterClient().withdraw3` was actually invoked. */
    let masterCalls = 0;
    const trace: string[] = [];

    it(`quote -> confirm -> submit, ${EXECUTE ? "SIGNED LIVE" : "captured at the wire"}`, async () => {
      const key = identityKey(identity);
      // Nothing in flight, or the quote below would be blocked and this test
      // would fail for a reason that has nothing to do with the exchange.
      expect(lastUnsettledAt(key)).toBeNull();

      const quote = quoteFor({});
      expect(quote.blockers).toEqual([]);
      // Own address only. Every other destination on testnet behaves identically
      // and is unrecoverable if the key ever pointed somewhere else.
      expect(quote.destination.isSelf).toBe(true);
      const ticket = confirmWithdrawal(quote, echoFor(quote));
      spentTicket = ticket;

      const before = await readBalances();

      if (EXECUTE) {
        // The account is small and this call is final. Refuse unless it can
        // absorb the gross TWICE, so a run always leaves enough behind for the
        // next one to build a clean quote — without this, two runs empty the
        // account and every later run fails on `insufficient_balance` forever.
        const headroom = new BigNumber(before.withdrawable);
        const needed = new BigNumber(quote.amount.gross).multipliedBy(2);
        if (headroom.isLessThan(needed)) {
          throw new Error(
            `refusing to sign: ${headroom.toFixed()} USDC withdrawable cannot absorb ` +
              `${quote.amount.gross} twice — top the account up first`
          );
        }
      }

      // The production journal, wrapped so the ORDER of the writes is observable.
      const journal: WithdrawJournal = {
        record: (entry) => {
          trace.push("journal.record");
          recordWithdrawal(entry);
        },
        markSettled: (nonce, at) => {
          trace.push("journal.markSettled");
          settleWithdrawal(nonce, at);
        },
        reviseNonce: (from, to) => {
          trace.push("journal.reviseNonce");
          reviseWithdrawalNonce(from, to);
        },
      };

      // `masterClient()`, not `exchangeClient()`. `withdraw3` carries no `user`
      // field, so the account debited is whoever signs: an agent signature would
      // silently withdraw from the agent's own empty address.
      const master = session.masterClient() as unknown as WithdrawClient;
      const client: WithdrawClient = {
        withdraw3: async (params) => {
          trace.push("withdraw3");
          wireCall = params;
          // Unsigned by default. The packet is final and the account holds a few
          // dollars, so signing every run would empty it in two — see the
          // opt-in note at the top of the file.
          if (!EXECUTE) return { status: "ok", response: { type: "default" } };
          masterCalls += 1;
          return master.withdraw3(params);
        },
      };

      const submittedAfter = Date.now();
      const outcome = await submitWithdrawal({ client, ticket, journal });

      // --- what goes on the wire -------------------------------------------
      expect(wireCall).not.toBeNull();
      // The GROSS is signed; the net is only ever displayed. The exchange
      // deducts the fee from what it is given, so signing the net delivers
      // 1 USDC less than the user asked for, every single time.
      expect(wireCall!.amount).toBe(quote.amount.gross);
      expect(wireCall!.amount).not.toBe(quote.amount.net);
      // The lowercase form is what the signature covers; the checksummed form
      // exists only so a human could verify it.
      expect(wireCall!.destination).toBe(ownerWire);

      // Whether the real, master-signed client was reached at all. In the
      // default mode this is the assertion that "nothing was signed" rests on —
      // a balance that barely moves would say the same thing whether or not a
      // packet left, and a rejected signature moves no balance either.
      expect(masterCalls).toBe(EXECUTE ? 1 : 0);

      // --- ordering ---------------------------------------------------------
      // The journal write lands BEFORE the irreversible call. A process that
      // dies during the request still leaves the record the in-flight guard
      // reads, which is the only thing standing between a user who reopens the
      // app and a second withdrawal.
      expect(trace).toEqual(["journal.record", "withdraw3"]);

      // --- the outcome ------------------------------------------------------
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") throw new Error(JSON.stringify(outcome));
      // The nonce is the transaction id. The response carries no handle of its
      // own (`{status:"ok", response:{type:"default"}}`) and the ledger row that
      // appears minutes later is keyed by it — lose it and the withdrawal is
      // untraceable. So it must be a wall-clock millisecond stamp taken during
      // THIS call, not a constant that merely looks like one.
      expect(outcome.nonce).toBeGreaterThanOrEqual(submittedAfter);
      expect(outcome.nonce).toBeLessThanOrEqual(Date.now());

      // --- the journal, and its consequence ---------------------------------
      // A settled withdrawal deliberately leaves its entry OPEN: nothing has
      // arrived yet, and the caller resolves it when the ledger confirms. The
      // effect is the guard doing its job — the very next quote is blocked.
      expect(trace).not.toContain("journal.markSettled");
      const open = listUnsettled(key);
      expect(open).toHaveLength(1);
      expect(open[0].nonce).toBe(outcome.nonce);
      expect(open[0].amount).toBe(quote.amount.gross);
      expect(open[0].destination).toBe(ownerWire);
      expect(open[0].identityKey).toBe(key);
      expect(quoteFor({ inFlightSince: lastUnsettledAt(key) }).blockers.map((b) => b.code)).toEqual(
        ["withdrawal_in_flight"]
      );

      // --- and what the money did -------------------------------------------
      if (EXECUTE) {
        // Measured on the one authorised live run: perp `withdrawable` went
        // 6.0 -> 4.0 and spot USDC stayed at 14.0. That is the GROSS leaving the
        // PERP pot — which settles the routing question `constants.ts` flags as
        // unverified, and confirms the fee comes out of the signed amount rather
        // than on top of it.
        //
        // Polled, not slept on: a fixed sleep either wastes the run or fails it
        // depending on how the exchange feels that minute.
        const after = await waitFor(async () => {
          const now = await readBalances();
          const moved = new BigNumber(before.withdrawable).minus(now.withdrawable);
          return moved.isGreaterThanOrEqualTo(quote.amount.gross) ? now : null;
        }, 60_000);

        const perpDrop = new BigNumber(before.withdrawable).minus(after.withdrawable);
        // The gross left, and only the gross. More would mean the fee was added
        // on top of the signed amount; less would mean the net was signed.
        expect(perpDrop.minus(quote.amount.gross).abs().isLessThan("0.000001")).toBe(true);
        // And it left the PERP pot, not the spot one — the question
        // `WITHDRAW_SOURCE_POT_UNVERIFIED` records as open.
        expect(after.spot).toBe(before.spot);
      }
    }, 120_000);

    // -----------------------------------------------------------------------
    it("refuses to submit that SAME ticket again, without touching the wire", async () => {
      if (!spentTicket) throw new Error("the submit test did not run; nothing to replay");
      const wire = recordingClient();

      const error = await refusalFrom(
        submitWithdrawal({ client: wire.client, ticket: spentTicket })
      );

      expect(error.code).toBe("not_authorized");
      expect(error.context?.reason).toBe("ticket_replayed");
      // The assertion that matters. There is no idempotency key, so a ticket that
      // reached `withdraw3` twice is TWO withdrawals — a "retry" after a lost
      // response would take the money a second time.
      expect(wire.calls).toBe(0);
      // And nothing signed either, for the same reason.
      expect(masterCalls).toBe(EXECUTE ? 1 : 0);
    });
  });

  // -------------------------------------------------------------------------
  describe("5. a forged ticket is rejected by re-validation, not by the type system", () => {
    it("refuses a ticket that was cast around the brand while carrying blockers", async () => {
      // `WithdrawalTicket`'s brand is a module-private symbol, which stops an
      // object *literal* — but `x as unknown as WithdrawalTicket` compiles fine,
      // and the person most likely to write it is the next author who hits a type
      // error building the withdrawal screen. So every guarantee is re-derived at
      // the point of harm.
      const blocked = quoteFor({ amount: canonicalAmount("1.5") });
      expect(blocked.blockers.map((b) => b.code)).toContain("amount_below_ui_floor");
      const forged = { quote: blocked, confirmedAt: Date.now() } as unknown as WithdrawalTicket;

      const wire = recordingClient();
      const error = await refusalFrom(submitWithdrawal({ client: wire.client, ticket: forged }));

      expect(error.code).toBe("not_authorized");
      expect(error.context?.reason).toBe("blocked");
      expect(wire.calls).toBe(0);
    });

    it("refuses a ticket that was never confirmed", async () => {
      // The shape of a ticket built by hand from a perfectly good quote: the one
      // field a forger has no reason to fill in is the one that records a human
      // having seen the confirmation sheet.
      const clean = quoteFor({});
      expect(clean.blockers).toEqual([]);
      const forged = { quote: clean, confirmedAt: 0 } as unknown as WithdrawalTicket;

      const wire = recordingClient();
      const error = await refusalFrom(submitWithdrawal({ client: wire.client, ticket: forged }));

      expect(error.code).toBe("not_authorized");
      expect(error.context?.reason).toBe("unconfirmed");
      expect(wire.calls).toBe(0);
    });

    it("refuses a ticket whose quote has expired", async () => {
      // Two TTLs in the past. The balance and the fee it quoted may both have
      // moved since — submitting it would sign against numbers no longer true,
      // and a stale `available` is exactly how an overdraw gets past the
      // insufficient-balance blocker.
      const stale = quoteFor({ now: () => Date.now() - 2 * QUOTE_TTL_MS });
      expect(stale.blockers).toEqual([]);
      expect(stale.expiresAt).toBeLessThan(Date.now());
      const forged = { quote: stale, confirmedAt: Date.now() } as unknown as WithdrawalTicket;

      const wire = recordingClient();
      const error = await refusalFrom(submitWithdrawal({ client: wire.client, ticket: forged }));

      expect(error.code).toBe("not_authorized");
      expect(error.context?.reason).toBe("expired");
      expect(wire.calls).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("6. a refusal the server articulated must not lock the user out", () => {
    it("settles the journal on api_error, so the next quote is clean", async () => {
      // Section 4 deliberately left an entry open; start where a first-ever
      // withdrawal starts.
      clearWithdrawals();
      const key = identityKey(identity);

      const quote = quoteFor({});
      const ticket = confirmWithdrawal(quote, echoFor(quote));

      // The exchange's own refusal, reproduced rather than provoked: the only
      // way to make live testnet refuse a withdrawal is to sign one it will
      // reject, and every such amount is either recoverable-by-luck or larger
      // than this account holds. `classifySdkError` keys on `name`, and
      // `ApiRequestError` is what the SDK throws for a `{status:"err"}` body;
      // the message is the one `withdraw.ts` records from a live signature.
      const refusal = Object.assign(new Error("Error withdrawing from bridge"), {
        name: "ApiRequestError",
      });
      let calls = 0;
      const client: WithdrawClient = {
        withdraw3: async () => {
          calls += 1;
          throw refusal;
        },
      };

      // No journal injected: this runs through `defaultJournal()`, the real
      // MMKV-backed one, which is the path production takes.
      const outcome = await submitWithdrawal({ client, ticket });

      expect(calls).toBe(1);
      expect(outcome.kind).toBe("rejected_by_server");
      if (outcome.kind !== "rejected_by_server") throw new Error(JSON.stringify(outcome));
      // The server's own words, not a generic failure: "Error withdrawing from
      // bridge" is actionable where "something went wrong" is not.
      expect(outcome.reason).toBe("Error withdrawing from bridge");

      // The decisive part. A rejection the server articulated is a fact —
      // nothing moved, nothing is settling — so the entry must be closed. Left
      // open, a user whose withdrawal was REFUSED would be told to wait fifteen
      // minutes before they may try again, for a withdrawal that never happened.
      expect(listUnsettled(key)).toHaveLength(0);
      expect(lastUnsettledAt(key)).toBeNull();
      expect(quoteFor({ inFlightSince: lastUnsettledAt(key) }).blockers).toEqual([]);

      clearWithdrawals();
    }, 30_000);
  });

  // ==========================================================================
  // helpers
  // ==========================================================================

  /** A quote against the live balance and the live destination probe. */
  function quoteFor(
    overrides: Partial<Parameters<typeof buildWithdrawalQuote>[0]>
  ): WithdrawalQuote {
    return buildWithdrawalQuote({
      identity,
      env: "testnet",
      signerAddress: ownerDisplay,
      ownerAddress: ownerDisplay,
      destinationInput: ownerDisplay,
      amount: canonicalAmount(MIN_WITHDRAW_USDC_UI_FLOOR),
      available,
      confidence: "authoritative",
      destinationProbe: selfProbe,
      ...overrides,
    });
  }

  /** Both pots, plus the figure a withdrawal is actually quoted against. */
  async function readBalances(): Promise<{
    perp: string;
    spot: string;
    withdrawable: string;
  }> {
    const [perp, spot] = await Promise.all([
      info.clearinghouseState({ user: ownerDisplay }),
      info.spotClearinghouseState({ user: ownerDisplay }),
    ]);
    const spotUsdc = spot.balances.find((b) => b.coin === "USDC")?.total ?? "0";
    // Raw strings throughout, compared with BigNumber at the call site:
    // `Number("6.0")` is how a 2 USDC debit hides inside a float comparison.
    return {
      perp: perp.marginSummary.accountValue,
      spot: spotUsdc,
      withdrawable: perp.withdrawable,
    };
  }
});

/** An echo built honestly from a quote — what a correct caller sends back. */
function echoFor(quote: WithdrawalQuote): WithdrawalEcho {
  return {
    token: quote.token,
    destinationDisplayed: quote.destination.display,
    grossDisplayed: quote.amount.gross,
    netDisplayed: quote.amount.net,
    acknowledged: quote.warnings.map((w) => w.code),
  };
}

/** A `withdraw3` that must never be reached, and counts it if it is. */
function recordingClient(): { client: WithdrawClient; readonly calls: number } {
  const state = { calls: 0 };
  return {
    client: {
      withdraw3: async () => {
        state.calls += 1;
        return {};
      },
    },
    get calls() {
      return state.calls;
    },
  };
}

/**
 * A pattern matching `value` as a standalone number inside a sentence.
 *
 * `String.includes("4")` is satisfied by "14", "0.4" and "2024" — so a message
 * quoting the wrong balance would pass a naive substring check. This requires
 * the figure to stand alone.
 */
function standaloneNumber(value: string): RegExp {
  const escaped = value.replace(/[.]/g, "\\.");
  return new RegExp(`(^|[^0-9.])${escaped}([^0-9.]|$)`);
}

/** Assert a synchronous refusal and hand back the error for inspection. */
function expectRefusal(run: () => unknown): HlError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HlError);
  expect((caught as HlError).code).toBe("not_authorized");
  return caught as HlError;
}

/** The same, for a promise that must reject. */
async function refusalFrom(promise: Promise<unknown>): Promise<HlError> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error
  );
  expect(caught).toBeInstanceOf(HlError);
  return caught as HlError;
}

/**
 * A different address, one hex digit away, presented in a form the SDK accepts.
 *
 * Derived rather than hard-coded so it stays a real neighbour of whatever key is
 * configured. Searched rather than assumed: changing a digit re-derives the
 * whole EIP-55 casing, which *almost* always breaks it — and a test that relied
 * on "almost" would flake on some future key.
 */
function misChecksummedNeighbour(display: Hex): string {
  const body = display.slice(2);
  for (let i = body.length - 1; i >= 0; i -= 1) {
    for (const digit of "0123456789abcdef") {
      if (digit === body[i].toLowerCase()) continue;
      const candidate = `0x${body.slice(0, i)}${digit}${body.slice(i + 1)}`;
      const tail = candidate.slice(2);
      // Mixed case, or there is no checksum claim to falsify in the first place.
      if (!/[a-f]/.test(tail) || !/[A-F]/.test(tail)) continue;
      if (getAddress(candidate.toLowerCase()) !== candidate) return candidate;
    }
  }
  throw new Error(`no mis-checksummed neighbour of ${display}`);
}

/**
 * Poll until `read` returns something truthy, or fail with a useful message.
 *
 * The account channels are a ~5 s heartbeat, so every assertion about arriving
 * state has to wait rather than sample once. Accepts an async reader so a live
 * REST comparison can be retried the same way.
 */
async function waitFor<T>(
  read: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for live state`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
