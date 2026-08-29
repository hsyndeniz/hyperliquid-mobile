import {
  buildWithdrawalQuote,
  confirmWithdrawal,
  isWithdrawable,
  QUOTE_TTL_MS,
  type WithdrawalEcho,
  type WithdrawalQuote,
} from "@/hyperliquid/transfers/preflight";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import { WITHDRAW_TIMINGS } from "@/hyperliquid/config/constants";
import { createIdentity } from "@/hyperliquid/core/identity";
import { HlError } from "@/hyperliquid/core/errors";
import type { Hex } from "@/hyperliquid/types/domain";

const OWNER = "0x5Bf8287BAeDA8De01C88b3016D64f3875B0B4347" as Hex;
/** A real testnet account, in its correct EIP-55 form. */
const THIRD_PARTY = "0xCC8A21B439951529281859f6aD39F279606304A7";
const NOW = 1_800_000_000_000;

const identity = createIdentity({ env: "testnet", accountId: "acc", address: OWNER });

const CLEAN_PROBE = { userExists: true, userHasSentTx: true, isSanctioned: false };

function quoteFor(overrides: Partial<Parameters<typeof buildWithdrawalQuote>[0]> = {}) {
  return buildWithdrawalQuote({
    identity,
    env: "testnet",
    signerAddress: OWNER,
    ownerAddress: OWNER,
    destinationInput: OWNER,
    amount: canonicalAmount("10"),
    available: canonicalAmount("100"),
    confidence: "authoritative",
    destinationProbe: CLEAN_PROBE,
    now: () => NOW,
    ...overrides,
  });
}

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

describe("buildWithdrawalQuote", () => {
  it("quotes gross, fee and net, with the fee deducted from the gross", () => {
    const quote = quoteFor();
    expect(quote.amount.gross).toBe("10");
    expect(quote.amount.feeUsdc).toBe("1");
    expect(quote.amount.net).toBe("9");
  });

  it("carries both address forms and the chunked display", () => {
    const quote = quoteFor();
    // Signed lowercase; verified checksummed.
    expect(quote.destination.wire).toBe(OWNER.toLowerCase());
    expect(quote.destination.display).toBe(OWNER);
    expect(quote.destination.chunks).toHaveLength(10);
    expect(quote.destination.isSelf).toBe(true);
  });

  describe("blockers", () => {
    it("blocks a failed checksum", () => {
      const quote = quoteFor({ destinationInput: "0x5Bf8287BAeDA8De01C88b3016D64f3875B0B4348" });
      expect(quote.blockers.map((b) => b.code)).toContain("destination_checksum_failed");
    });

    it("blocks a black-hole destination", () => {
      const quote = quoteFor({ destinationInput: `0x${"0".repeat(40)}` });
      expect(quote.blockers.map((b) => b.code)).toContain("destination_blacklisted");
    });

    it("blocks a withdrawal to a registered agent address", () => {
      const agent = "0x1234567890AbcdEF1234567890aBcdef12345678" as Hex;
      const quote = quoteFor({ destinationInput: agent, agentAddresses: [agent] });
      expect(quote.blockers.map((b) => b.code)).toContain("destination_is_agent");
    });

    it("blocks when the agent key would be signing", () => {
      // withdraw3 has no `user` field: the account debited is whoever signs, so
      // an agent signature withdraws from the agent's own address.
      const quote = quoteFor({
        signerAddress: "0x1111111111111111111111111111111111111111" as Hex,
      });
      expect(quote.blockers.map((b) => b.code)).toContain("signer_mismatch");
    });

    it("blocks an amount the fee would consume", () => {
      const quote = quoteFor({ amount: canonicalAmount("1") });
      expect(quote.blockers.map((b) => b.code)).toContain("amount_not_positive_after_fee");
    });

    it("blocks an amount above the balance", () => {
      const quote = quoteFor({ amount: canonicalAmount("500"), available: canonicalAmount("100") });
      expect(quote.blockers.map((b) => b.code)).toContain("insufficient_balance");
    });

    it("blocks a sanctioned destination", () => {
      const quote = quoteFor({
        destinationProbe: { ...CLEAN_PROBE, isSanctioned: true },
      });
      expect(quote.blockers.map((b) => b.code)).toContain("destination_sanctioned");
    });

    it("blocks a second withdrawal inside the settlement floor", () => {
      // The decisive guard: there is no idempotency key, so a second withdrawal
      // here is a second final withdrawal, not a retry.
      const quote = quoteFor({ inFlightSince: NOW - 60_000 });
      expect(quote.blockers.map((b) => b.code)).toContain("withdrawal_in_flight");
    });

    it("allows one once the settlement floor has passed", () => {
      const quote = quoteFor({ inFlightSince: NOW - WITHDRAW_TIMINGS.settlementFloorMs - 1 });
      expect(quote.blockers).toEqual([]);
    });
  });

  describe("warnings", () => {
    it("warns loudly about an address never seen on Hyperliquid", () => {
      // The strongest typo signal available: this caught 14/14 single-character
      // substitutions and 9/9 transpositions of a real address.
      const quote = quoteFor({
        destinationInput: THIRD_PARTY,
        destinationProbe: { userExists: false, userHasSentTx: false, isSanctioned: false },
      });
      expect(quote.warnings.map((w) => w.code)).toContain("new_destination_account");
    });

    it("warns that a third-party withdrawal cannot be reversed", () => {
      const quote = quoteFor({ destinationInput: THIRD_PARTY });
      expect(quote.warnings.map((w) => w.code)).toContain("third_party_destination");
    });

    it("does not warn about a third party when withdrawing to yourself", () => {
      expect(quoteFor().warnings.map((w) => w.code)).not.toContain("third_party_destination");
    });

    it("warns when the destination could not be checked at all", () => {
      const quote = quoteFor({ destinationProbe: undefined });
      expect(quote.destinationChecks.probed).toBe(false);
      expect(quote.warnings.map((w) => w.code)).toContain("checks_incomplete");
    });

    it("warns when the balance figure is inferred rather than reported", () => {
      const quote = quoteFor({ confidence: "derived" });
      expect(quote.warnings.map((w) => w.code)).toContain("balance_source_derived");
    });
  });

  it("returns a quote even when unusable, so the caller has something to render", () => {
    const quote = quoteFor({ amount: canonicalAmount("500") });
    expect(quote.blockers.length).toBeGreaterThan(0);
    expect(isWithdrawable(quote, NOW)).toBe(false);
  });
});

describe("confirmWithdrawal", () => {
  it("issues a ticket for an honest echo", () => {
    const quote = quoteFor();
    const ticket = confirmWithdrawal(quote, echoFor(quote), NOW);
    expect(ticket.quote).toBe(quote);
    expect(ticket.confirmedAt).toBe(NOW);
  });

  it("refuses when any blocker is present", () => {
    const quote = quoteFor({ amount: canonicalAmount("500") });
    expect(() => confirmWithdrawal(quote, echoFor(quote), NOW)).toThrow(HlError);
  });

  it("refuses an expired quote", () => {
    // Its balance and fee may have moved since it was built.
    const quote = quoteFor();
    expect(() => confirmWithdrawal(quote, echoFor(quote), NOW + QUOTE_TTL_MS + 1)).toThrow(
      /expired/
    );
  });

  it("refuses a token from a different quote", () => {
    const quote = quoteFor();
    const other = quoteFor({ amount: canonicalAmount("20") });
    expect(() => confirmWithdrawal(quote, { ...echoFor(quote), token: other.token }, NOW)).toThrow(
      /does not match the quote/
    );
  });

  describe("the echo has to be honest", () => {
    it("refuses a lowercased destination, even though it is the same address", () => {
      // The point of the whole handshake: the human must have seen the
      // checksummed form, because that is the only form carrying the typo check.
      const quote = quoteFor();
      const echo = { ...echoFor(quote), destinationDisplayed: quote.destination.wire };
      expect(() => confirmWithdrawal(quote, echo, NOW)).toThrow(/displayed destination/);
    });

    it("refuses a displayed amount that differs from the quoted one", () => {
      const quote = quoteFor();
      expect(() =>
        confirmWithdrawal(quote, { ...echoFor(quote), grossDisplayed: "9" }, NOW)
      ).toThrow(/displayed amount/);
    });

    it("refuses when the net shown was the gross — the fee-direction trap", () => {
      // A caller that never computed "you will receive" cannot produce this
      // field correctly, which closes the hazard by construction.
      const quote = quoteFor();
      expect(() =>
        confirmWithdrawal(quote, { ...echoFor(quote), netDisplayed: quote.amount.gross }, NOW)
      ).toThrow(/displayed net/);
    });

    it("refuses when a warning was not acknowledged", () => {
      const quote = quoteFor({ destinationInput: THIRD_PARTY });
      expect(quote.warnings.length).toBeGreaterThan(0);
      expect(() => confirmWithdrawal(quote, { ...echoFor(quote), acknowledged: [] }, NOW)).toThrow(
        /unacknowledged/
      );
    });

    it("accepts a superset of acknowledgements", () => {
      const quote = quoteFor({ destinationInput: THIRD_PARTY });
      const echo = {
        ...echoFor(quote),
        acknowledged: [...quote.warnings.map((w) => w.code), "checks_incomplete" as const],
      };
      expect(() => confirmWithdrawal(quote, echo, NOW)).not.toThrow();
    });
  });

  it("changes its token when any quoted fact changes", () => {
    // A stale confirmation sheet must not be able to confirm a quote whose
    // balance or destination has since been re-read.
    const base = quoteFor();
    expect(quoteFor({ amount: canonicalAmount("11") }).token).not.toBe(base.token);
    expect(quoteFor({ available: canonicalAmount("99") }).token).not.toBe(base.token);
    expect(quoteFor({ destinationInput: THIRD_PARTY }).token).not.toBe(base.token);
  });

  it("produces a stable token for identical inputs", () => {
    expect(quoteFor().token).toBe(quoteFor().token);
  });

  describe("a sub-account cannot withdraw", () => {
    const onSubAccount = createIdentity({
      env: "testnet",
      accountId: "acc",
      address: OWNER,
      subAccount: "0xCC8A21B439951529281859f6aD39F279606304A7",
    });

    it("blocks a quote built while a sub-account is selected", () => {
      // `WithdrawAction3` is {signatureChainId, hyperliquidChain, destination,
      // amount, time} with deny_unknown_fields — there is no field to name a
      // sub-account, and a sub-account has no key. The master signs, so the
      // MASTER's balance leaves while the screen shows the sub-account's.
      // Everything else about the quote validates, which is exactly the danger.
      const quote = quoteFor({ identity: onSubAccount });
      expect(quote.blockers.map((b) => b.code)).toContain("sub_account_context");
      expect(isWithdrawable(quote, NOW)).toBe(false);
    });

    it("refuses to confirm it", () => {
      const quote = quoteFor({ identity: onSubAccount });
      expect(() => confirmWithdrawal(quote, echoFor(quote), NOW)).toThrow(HlError);
    });

    it("leaves the master's quote clean", () => {
      expect(quoteFor().blockers).toEqual([]);
    });
  });
});
