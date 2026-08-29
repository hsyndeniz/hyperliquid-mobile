/**
 * The two `BuildQuoteParams` fields nothing in production ever passed.
 *
 * `buildWithdrawalQuote` and its blockers are tested exhaustively next door.
 * What was never tested — because there was no production caller — is whether a
 * screen actually *supplies* `inFlightSince` and `destinationProbe`. Both are
 * optional, so omitting them compiles, type-checks, and silently disables the
 * guard each one exists to power:
 *
 * - no `inFlightSince` → `withdrawal_in_flight` can never fire, and the journal
 *   this project maintains for duplicate protection protects nothing.
 * - no `destinationProbe` → every quote carries `checks_incomplete`, and
 *   `userExists === false` — 14/14 single-character substitutions, 9/9
 *   transpositions, 30/30 random addresses — is switched off.
 *
 * `diagnostics.tsx` omits both. That is exactly the bug this file pins.
 */

import { buildQuote } from "@/hyperliquid/hooks/withdraw";
import { identityKey } from "@/hyperliquid/core/identity";
import { clearWithdrawals, recordWithdrawal } from "@/hyperliquid/transfers/journal";
import { WITHDRAW_TIMINGS } from "@/hyperliquid/config/constants";
import { QUOTE_TTL_MS } from "@/hyperliquid/transfers/preflight";
import type { HlIdentity } from "@/hyperliquid/types/domain";
import type { SessionState } from "@/hyperliquid/session";

const IDENTITY: HlIdentity = {
  env: "testnet",
  accountId: "acct",
  address: "0x5Bf8c2d0b8c1f0e3a4b5c6d7e8f9a0b1c2d34347",
  dex: null,
  subAccount: null,
};

/** A fixed basis: the quote builder is impure in time, so the tests pin it. */
const NOW = 1_800_000_000_000;

const DESTINATION = "0x1111111111111111111111111111111111111112";

function stateFor(overrides: Partial<HlIdentity> = {}): SessionState {
  const identity = { ...IDENTITY, ...overrides };
  return {
    identity,
    signer: { address: identity.address },
    agent: { registeredAgents: [] },
    config: { env: identity.env },
  } as unknown as SessionState;
}

beforeEach(() => clearWithdrawals());
afterAll(() => clearWithdrawals());

describe("the in-flight guard is armed", () => {
  it("blocks a second withdrawal while one is still settling", () => {
    // The whole point of the journal. Without `inFlightSince` this blocker is
    // unreachable, and every test of it passes on a quote nothing produces.
    // Journalled AT the basis, not at the wall clock — the quote is now built
    // against `NOW`, and a real clock here would put the entry years in its
    // past and let the settlement floor elapse before the check ever runs.
    recordWithdrawal({
      nonce: NOW,
      destination: DESTINATION,
      amount: "5",
      identityKey: identityKey(IDENTITY),
      at: NOW,
    });

    const quote = buildQuote(
      stateFor(),
      { destinationInput: DESTINATION, amount: "5", available: "100" },
      null,
      NOW
    );

    expect(quote?.blockers.map((b) => b.code)).toContain("withdrawal_in_flight");
  });

  it("does not block when nothing is outstanding", () => {
    const quote = buildQuote(
      stateFor(),
      { destinationInput: DESTINATION, amount: "5", available: "100" },
      null,
      NOW
    );

    expect(quote?.blockers.map((b) => b.code)).not.toContain("withdrawal_in_flight");
  });

  it("scopes the guard to the identity that signed", () => {
    // An account switch must not conceal a withdrawal in flight on the account
    // being left — but must equally not block a DIFFERENT account for it.
    // AT the basis. With a real clock the entry ages past the settlement floor
    // before the quote is built, and the assertion below then holds whether or
    // not the guard is scoped at all — a test that passes for the wrong reason.
    // Journalled at `NOW`, the entry is genuinely in flight, so the ONLY thing
    // that can keep the blocker away is the identity mismatch.
    recordWithdrawal({
      nonce: NOW,
      destination: DESTINATION,
      amount: "5",
      identityKey: identityKey({ ...IDENTITY, accountId: "someone-else" }),
      at: NOW,
    });

    const quote = buildQuote(
      stateFor(),
      { destinationInput: DESTINATION, amount: "5", available: "100" },
      null,
      NOW
    );

    expect(quote?.blockers.map((b) => b.code)).not.toContain("withdrawal_in_flight");
  });
});

describe("the quote is stamped against a basis it is given, not a clock it reads", () => {
  // The freeze this parameter exists to prevent. `buildQuote` used to call
  // `Date.now()` down inside `buildWithdrawalQuote`, and the React Compiler
  // memoises the whole call against the values it can SEE it read — a clock is
  // not one of them. The quote therefore stuck at the last keystroke: the TTL
  // expired while the user read the echo sheet, confirming was refused, and
  // tapping Review again replayed the SAME expired quote. A dead end, on an
  // irreversible path. See `hooks/quoteBasis.ts`.
  const inputs = { destinationInput: DESTINATION, amount: "5", available: "100" } as const;

  it("moves expiresAt with the basis, so a re-opened confirmation gets a live TTL", () => {
    const first = buildQuote(stateFor(), inputs, null, NOW);
    const later = buildQuote(stateFor(), inputs, null, NOW + 90_000);
    expect(first?.expiresAt).toBe(NOW + QUOTE_TTL_MS);
    expect(later?.expiresAt).toBe(NOW + 90_000 + QUOTE_TTL_MS);
    // The first quote is already expired by the time the second is stamped —
    // which is precisely the state the user got stuck in.
    expect(first?.expiresAt).toBeLessThan(NOW + 90_000);
  });

  it("lets the in-flight blocker CLEAR once the floor has passed", () => {
    // The other half of the dead end: this blocker disables the Review button,
    // so the button cannot be what refreshes it. Frozen, it never clears.
    recordWithdrawal({
      nonce: NOW,
      destination: DESTINATION,
      amount: "5",
      identityKey: identityKey(IDENTITY),
      at: NOW,
    });

    const during = buildQuote(stateFor(), inputs, null, NOW);
    const after = buildQuote(
      stateFor(),
      inputs,
      null,
      NOW + WITHDRAW_TIMINGS.settlementFloorMs + 1
    );

    expect(during?.blockers.map((b) => b.code)).toContain("withdrawal_in_flight");
    expect(after?.blockers.map((b) => b.code)).not.toContain("withdrawal_in_flight");
  });
});

describe("the destination probe reaches the quote", () => {
  it("warns that checks are incomplete when there is no probe", () => {
    // Absence must read as "we could not check", never as a green light.
    const quote = buildQuote(
      stateFor(),
      { destinationInput: DESTINATION, amount: "5", available: "100" },
      null,
      NOW
    );

    expect(quote?.warnings.map((w) => w.code)).toContain("checks_incomplete");
  });

  it("drops that warning once a probe answers", () => {
    const quote = buildQuote(
      stateFor(),
      { destinationInput: DESTINATION, amount: "5", available: "100" },
      { userExists: true, userHasSentTx: true, isSanctioned: false },
      NOW
    );

    expect(quote?.warnings.map((w) => w.code)).not.toContain("checks_incomplete");
  });

  it("turns an unknown destination into the typo warning", () => {
    // The strongest signal available, and it only exists when the probe is
    // passed through.
    const quote = buildQuote(
      stateFor(),
      { destinationInput: DESTINATION, amount: "5", available: "100" },
      { userExists: false, userHasSentTx: false, isSanctioned: false },
      NOW
    );

    expect(quote?.warnings.map((w) => w.code)).toContain("new_destination_account");
  });

  it("blocks a sanctioned destination outright", () => {
    const quote = buildQuote(
      stateFor(),
      { destinationInput: DESTINATION, amount: "5", available: "100" },
      { userExists: true, userHasSentTx: true, isSanctioned: true },
      NOW
    );

    expect(quote?.blockers.map((b) => b.code)).toContain("destination_sanctioned");
  });
});

describe("a quote is only built when the inputs can produce one", () => {
  it("returns null while the amount is empty", () => {
    // `canonicalAmount` throws on "", which is right for a signing path and
    // wrong for a field being typed into.
    expect(
      buildQuote(
        stateFor(),
        { destinationInput: DESTINATION, amount: "", available: "100" },
        null,
        NOW
      )
    ).toBeNull();
  });

  it("returns null on a malformed amount rather than throwing", () => {
    expect(
      buildQuote(
        stateFor(),
        { destinationInput: DESTINATION, amount: "1.2.3", available: "100" },
        null,
        NOW
      )
    ).toBeNull();
  });

  it("returns null while the balance is still unread", () => {
    // `null` available is "not read yet", never zero.
    expect(
      buildQuote(
        stateFor(),
        { destinationInput: DESTINATION, amount: "5", available: null },
        null,
        NOW
      )
    ).toBeNull();
  });

  it("still builds a quote for a MALFORMED destination, carrying the blocker", () => {
    // The screen needs something to render the refusal from; returning null
    // would leave the field silently rejected with no reason shown.
    const quote = buildQuote(
      stateFor(),
      { destinationInput: "0xnope", amount: "5", available: "100" },
      null,
      NOW
    );

    expect(quote?.blockers.map((b) => b.code)).toContain("destination_malformed");
  });
});

describe("sub-account context", () => {
  it("blocks the withdrawal", () => {
    // `withdraw3` carries no `user` field, so it always debits the master.
    const quote = buildQuote(
      stateFor({ subAccount: "0x2222222222222222222222222222222222222222" }),
      { destinationInput: DESTINATION, amount: "5", available: "100" },
      null,
      NOW
    );

    expect(quote?.blockers.map((b) => b.code)).toContain("sub_account_context");
  });
});
