import {
  submitWithdrawal,
  type WithdrawClient,
  type WithdrawJournal,
} from "@/hyperliquid/transfers/withdraw";
import {
  buildWithdrawalQuote,
  confirmWithdrawal,
  type WithdrawalQuote,
} from "@/hyperliquid/transfers/preflight";
import {
  clearWithdrawals,
  lastUnsettledAt,
  listUnsettled,
  pruneWithdrawals,
  recordWithdrawal,
  settleWithdrawal,
} from "@/hyperliquid/transfers/journal";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import { WITHDRAW_TIMINGS } from "@/hyperliquid/config/constants";
import { createIdentity, identityKey } from "@/hyperliquid/core/identity";
import { HlError } from "@/hyperliquid/core/errors";
import type { Hex } from "@/hyperliquid/types/domain";

const OWNER = "0x5Bf8287BAeDA8De01C88b3016D64f3875B0B4347" as Hex;
const NOW = 1_800_000_000_000;
const identity = createIdentity({ env: "testnet", accountId: "acc", address: OWNER });
const KEY = identityKey(identity);

function ticketFor() {
  const quote = buildWithdrawalQuote({
    identity,
    env: "testnet",
    signerAddress: OWNER,
    ownerAddress: OWNER,
    destinationInput: OWNER,
    amount: canonicalAmount("10"),
    available: canonicalAmount("100"),
    confidence: "authoritative",
    destinationProbe: { userExists: true, userHasSentTx: true, isSanctioned: false },
    now: () => NOW,
  });
  return confirmWithdrawal(
    quote,
    {
      token: quote.token,
      destinationDisplayed: quote.destination.display,
      grossDisplayed: quote.amount.gross,
      netDisplayed: quote.amount.net,
      acknowledged: quote.warnings.map((w) => w.code),
    },
    NOW
  );
}

function spyJournal() {
  const recorded: unknown[] = [];
  const settled: number[] = [];
  const journal: WithdrawJournal = {
    record: (entry) => recorded.push(entry),
    markSettled: (nonce) => settled.push(nonce),
    reviseNonce: () => undefined,
  };
  return { journal, recorded, settled };
}

describe("submitWithdrawal", () => {
  it("signs the GROSS amount and the LOWERCASE destination", () => {
    // The net was shown to the user; the gross is what the exchange debits and
    // therefore what must be signed. The checksummed form exists only so a
    // human could verify it — the signature covers the lowercase one.
    const calls: { destination: string; amount: string }[] = [];
    const client: WithdrawClient = {
      withdraw3: async (params) => {
        calls.push(params);
        return {};
      },
    };
    const { journal } = spyJournal();

    return submitWithdrawal({ client, ticket: ticketFor(), journal, now: () => NOW }).then(() => {
      expect(calls[0].amount).toBe("10");
      expect(calls[0].destination).toBe(OWNER.toLowerCase());
    });
  });

  it("journals BEFORE the request, so a crash mid-flight still leaves evidence", async () => {
    const order: string[] = [];
    const client: WithdrawClient = {
      withdraw3: async () => {
        order.push("request");
        return {};
      },
    };
    const journal: WithdrawJournal = {
      record: () => order.push("journal"),
      markSettled: () => undefined,
      reviseNonce: () => undefined,
    };

    await submitWithdrawal({ client, ticket: ticketFor(), journal, now: () => NOW });

    expect(order).toEqual(["journal", "request"]);
  });

  it("settles the journal entry when the server articulates a rejection", async () => {
    // A rejection is a fact: nothing moved, so the entry must not block the
    // next attempt.
    const client: WithdrawClient = {
      withdraw3: async () => {
        throw new HlError("Insufficient balance for withdrawal", { code: "api_error" });
      },
    };
    const { journal, settled } = spyJournal();

    const outcome = await submitWithdrawal({
      client,
      ticket: ticketFor(),
      journal,
      now: () => NOW,
    });

    expect(outcome.kind).toBe("rejected_by_server");
    expect(settled).toEqual([NOW]);
  });

  it("leaves the entry UNSETTLED when the outcome is unknown", async () => {
    // The decisive case. A network failure does not mean nothing happened —
    // the withdrawal may well have landed, and there is no idempotency key
    // that would make a second attempt safe.
    const client: WithdrawClient = {
      withdraw3: async () => {
        throw new HlError("socket hang up", { code: "transport_error" });
      },
    };
    const { journal, settled } = spyJournal();

    const outcome = await submitWithdrawal({
      client,
      ticket: ticketFor(),
      journal,
      now: () => NOW,
    });

    expect(outcome.kind).toBe("unknown");
    expect(settled).toEqual([]);
    if (outcome.kind !== "unknown") return;
    expect(outcome.window.toMs - outcome.window.fromMs).toBe(WITHDRAW_TIMINGS.settlementFloorMs);
  });

  it("exposes no retry helper", () => {
    // A blind retry does not re-attempt a withdrawal; it performs a second one.
    // Asserted structurally so nobody adds one back.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require("@/hyperliquid/transfers/withdraw") as Record<string, unknown>;
    const names = Object.keys(module).join(" ").toLowerCase();
    expect(names).not.toContain("retry");
    expect(names).not.toContain("resend");
  });
});

describe("the journal survives a restart", () => {
  beforeEach(() => clearWithdrawals());

  it("remembers an unsettled withdrawal", () => {
    // This is what stops a user who force-quits the app from withdrawing twice.
    recordWithdrawal({
      nonce: NOW,
      destination: OWNER.toLowerCase(),
      amount: "10",
      identityKey: KEY,
      at: NOW,
    });

    expect(listUnsettled()).toHaveLength(1);
    expect(lastUnsettledAt()).toBe(NOW);
  });

  it("forgets it once settled", () => {
    recordWithdrawal({
      nonce: NOW,
      destination: OWNER.toLowerCase(),
      amount: "10",
      identityKey: KEY,
      at: NOW,
    });
    settleWithdrawal(NOW, NOW + 1_000);

    expect(listUnsettled()).toEqual([]);
    expect(lastUnsettledAt()).toBeNull();
  });

  it("scopes by identity, so one account does not block another", () => {
    recordWithdrawal({
      nonce: NOW,
      destination: OWNER.toLowerCase(),
      amount: "10",
      identityKey: KEY,
      at: NOW,
    });

    expect(lastUnsettledAt(KEY)).toBe(NOW);
    expect(lastUnsettledAt("some:other:identity")).toBeNull();
  });

  it("reports the most recent when several are outstanding", () => {
    for (const at of [NOW, NOW + 5_000, NOW + 1_000]) {
      recordWithdrawal({
        nonce: at,
        destination: OWNER.toLowerCase(),
        amount: "2",
        identityKey: KEY,
        at,
      });
    }
    expect(lastUnsettledAt()).toBe(NOW + 5_000);
  });

  it("never prunes an unsettled entry inside its settlement floor", () => {
    // That entry is precisely the one the duplicate guard depends on.
    recordWithdrawal({
      nonce: NOW,
      destination: OWNER.toLowerCase(),
      amount: "10",
      identityKey: KEY,
      at: NOW,
    });

    pruneWithdrawals(NOW + WITHDRAW_TIMINGS.settlementFloorMs - 1);

    expect(listUnsettled()).toHaveLength(1);
  });

  it("survives a corrupt journal rather than crashing startup", () => {
    // Degrading the in-flight guard is bad; failing to launch is worse.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { hlStringStorage } = require("@/hyperliquid/storage/mmkv");
    hlStringStorage.setItem("hl:withdrawals", "{not json");

    expect(() => listUnsettled()).not.toThrow();
    expect(listUnsettled()).toEqual([]);
  });

  it("drops entries written by an older schema", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { hlStringStorage } = require("@/hyperliquid/storage/mmkv");
    hlStringStorage.setItem(
      "hl:withdrawals",
      JSON.stringify([{ schemaVersion: 0, nonce: 1, at: NOW, settledAt: null }])
    );

    // A half-understood record is worse than none when it feeds the one guard
    // between a user and a duplicate withdrawal.
    expect(listUnsettled()).toEqual([]);
  });
});

describe("the preflight blocker reads the journal", () => {
  beforeEach(() => clearWithdrawals());

  function quoteWithJournal(now: number): WithdrawalQuote {
    return buildWithdrawalQuote({
      identity,
      env: "testnet",
      signerAddress: OWNER,
      ownerAddress: OWNER,
      destinationInput: OWNER,
      amount: canonicalAmount("10"),
      available: canonicalAmount("100"),
      confidence: "authoritative",
      destinationProbe: { userExists: true, userHasSentTx: true, isSanctioned: false },
      inFlightSince: lastUnsettledAt(KEY),
      now: () => now,
    });
  }

  it("blocks a second withdrawal after a real journal write", () => {
    recordWithdrawal({
      nonce: NOW,
      destination: OWNER.toLowerCase(),
      amount: "10",
      identityKey: KEY,
      at: NOW,
    });

    const quote = quoteWithJournal(NOW + 60_000);

    expect(quote.blockers.map((b) => b.code)).toContain("withdrawal_in_flight");
  });

  it("allows one once the floor has passed", () => {
    recordWithdrawal({
      nonce: NOW,
      destination: OWNER.toLowerCase(),
      amount: "10",
      identityKey: KEY,
      at: NOW,
    });

    const quote = quoteWithJournal(NOW + WITHDRAW_TIMINGS.settlementFloorMs + 1);

    expect(quote.blockers).toEqual([]);
  });
});

describe("a forged or stale ticket cannot reach the exchange", () => {
  const client: WithdrawClient = { withdraw3: async () => ({}) };

  function forge(overrides: Record<string, unknown> = {}) {
    // A `unique symbol` brand stops an object literal, NOT an `as` assertion.
    // The next author hits a type error writing the withdrawal screen and
    // reaches for exactly this.
    const real = ticketFor();
    return { ...real, ...overrides } as typeof real;
  }

  it("refuses a ticket whose quote carries blockers", async () => {
    const blocked = forge({
      quote: {
        ...ticketFor().quote,
        blockers: [{ code: "insufficient_balance", detail: "no funds" }],
      },
    });

    await expect(
      submitWithdrawal({ client, ticket: blocked, journal: spyJournal().journal, now: () => NOW })
    ).rejects.toThrow(/blocked/);
  });

  it("refuses a ticket that was never confirmed", async () => {
    const unconfirmed = forge({ confirmedAt: 0 });

    await expect(
      submitWithdrawal({
        client,
        ticket: unconfirmed,
        journal: spyJournal().journal,
        now: () => NOW,
      })
    ).rejects.toThrow(/never confirmed/);
  });

  it("refuses an expired quote", async () => {
    // Its balance and fee may have moved since it was built.
    await expect(
      submitWithdrawal({
        client,
        ticket: ticketFor(),
        journal: spyJournal().journal,
        now: () => NOW + 10 * 60_000,
      })
    ).rejects.toThrow(/expired/);
  });

  it("refuses the SAME ticket twice", async () => {
    // No idempotency key exists, so a replayed ticket is a second withdrawal.
    const ticket = ticketFor();
    const { journal } = spyJournal();

    await submitWithdrawal({ client, ticket, journal, now: () => NOW });
    await expect(submitWithdrawal({ client, ticket, journal, now: () => NOW })).rejects.toThrow(
      /already submitted/
    );
  });

  it("does not journal a refused ticket", async () => {
    // A rejected attempt must not leave an entry that blocks the real one.
    const { journal, recorded } = spyJournal();
    await expect(
      submitWithdrawal({ client, ticket: forge({ confirmedAt: 0 }), journal, now: () => NOW })
    ).rejects.toThrow();

    expect(recorded).toEqual([]);
  });
});

/** A wallet that cannot sign. The SDK raises this BEFORE `transport.request`. */
const signingFailure = () =>
  Promise.reject(
    Object.assign(new Error("Failed to sign the typed data using the wallet"), {
      name: "AbstractWalletError",
    })
  );

/** A lost response. This one may well have landed. */
const timedOut = () =>
  Promise.reject(
    Object.assign(new Error("Request timed out after 10000 ms"), { name: "HttpRequestError" })
  );

describe("a withdrawal that never reached the exchange", () => {
  it("is rejected_locally AND settles the journal entry", async () => {
    // The journal matters as much as the code. An in-flight marker left behind
    // by a signing failure blocks the next attempt for the whole settlement
    // floor — for a withdrawal that does not exist.
    const { journal, settled } = spyJournal();
    const outcome = await submitWithdrawal({
      client: { withdraw3: signingFailure } as unknown as WithdrawClient,
      ticket: ticketFor(),
      journal,
      now: () => NOW,
    });
    expect(outcome.kind).toBe("rejected_locally");
    expect(settled).toHaveLength(1);
  });

  it("leaves the journal entry standing when the outcome is unknown", async () => {
    const { journal, settled } = spyJournal();
    const outcome = await submitWithdrawal({
      client: { withdraw3: timedOut } as unknown as WithdrawClient,
      ticket: ticketFor(),
      journal,
      now: () => NOW,
    });
    expect(outcome.kind).toBe("unknown");
    expect(settled).toEqual([]);
  });
});

describe("the journalled nonce is the one that was SIGNED", () => {
  /**
   * A withdrawal has no idempotency key and its response carries no handle, so
   * the nonce IS the transaction id — the ledger row that appears minutes later
   * is keyed by it, and the journal entry it matches drives the duplicate guard.
   *
   * The app never knew that nonce. It journalled its own `Date.now()` while the
   * real one was taken later and independently inside the SDK, after an
   * `await getWalletAddress()` and a lock acquisition. `ledger.ts` calls the two
   * "an identity, not a heuristic" on the evidence of three warm-path samples.
   *
   * When they diverge, matching falls back to amount-and-window — which settles
   * the SECOND withdrawal of a size against the FIRST one's row.
   */
  function journalSpy() {
    const revisions: [number, number][] = [];
    const recorded: number[] = [];
    return {
      revisions,
      recorded,
      journal: {
        record: (entry: { nonce: number }) => void recorded.push(entry.nonce),
        markSettled: () => undefined,
        reviseNonce: (from: number, to: number) => void revisions.push([from, to]),
      },
    };
  }

  it("corrects the entry when the SDK signed a different millisecond", async () => {
    const spy = journalSpy();
    let issued: number | null = null;
    const outcome = await submitWithdrawal({
      client: { withdraw3: async () => ((issued = NOW + 7), {}) },
      ticket: ticketFor(),
      journal: spy.journal,
      readIssuedNonce: () => issued,
      now: () => NOW,
    });

    expect(spy.recorded).toEqual([NOW]); // written BEFORE the call, as it must be
    expect(spy.revisions).toEqual([[NOW, NOW + 7]]);
    expect(outcome).toMatchObject({ kind: "settled", nonce: NOW + 7 });
  });

  it("leaves the entry alone when the guess was right", async () => {
    const spy = journalSpy();
    let issued: number | null = null;
    await submitWithdrawal({
      client: { withdraw3: async () => ((issued = NOW), {}) },
      ticket: ticketFor(),
      journal: spy.journal,
      readIssuedNonce: () => issued,
      now: () => NOW,
    });
    expect(spy.revisions).toEqual([]);
  });

  it("does NOT adopt a stale nonce from an earlier action", async () => {
    // The trap in reading the manager after the fact: if this call threw before
    // the SDK ever reached its nonce manager — a schema rejection, a wallet that
    // would not sign — the value sitting there belongs to some PREVIOUS action.
    // Adopting it would key this entry to another withdrawal's row.
    const spy = journalSpy();
    const stale = NOW - 60_000;
    const outcome = await submitWithdrawal({
      client: {
        withdraw3: async () => {
          throw Object.assign(new Error("bad shape"), { name: "ValidationError" });
        },
      },
      ticket: ticketFor(),
      journal: spy.journal,
      readIssuedNonce: () => stale, // unchanged across the call
      now: () => NOW,
    });

    expect(spy.revisions).toEqual([]);
    expect(outcome.kind).toBe("rejected_locally");
  });
});
