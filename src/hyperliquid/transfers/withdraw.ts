/**
 * The withdrawal itself.
 *
 * The **only** call site of `withdraw3` in the codebase, and it accepts nothing
 * but a `WithdrawalTicket`. Since the ticket's brand is a private symbol in
 * `preflight.ts`, there is no way to reach the exchange without having built a
 * quote, displayed it, and echoed back what was displayed. That is the whole
 * design: the guard is the type signature, not a convention someone has to
 * remember.
 *
 * The ticket is re-validated here rather than trusted. A `unique symbol` brand
 * stops an object *literal*, but it does not stop `x as WithdrawalTicket` — an
 * assertion compiles wherever the shapes are comparable. The doc that once
 * claimed the ticket "cannot be constructed anywhere else" was wrong, and the
 * person most likely to reach for that cast is the next author, who hits a type
 * error writing the withdrawal screen and works around it. So the guarantees
 * are re-checked at the point of harm, and a ticket is single-use.
 *
 * There is deliberately **no retry helper in this module**, and `unknown` has no
 * retry branch. A withdrawal has no idempotency key, no client order id and no
 * `expiresAfter`, so a stalled request stays valid across a wide nonce window. A
 * blind retry does not re-attempt a withdrawal — it performs a second one.
 *
 * **Verified against live testnet with a real signature, twice.** The first
 * attempt was refused at the business layer with `"Error withdrawing from
 * bridge"` and left both balances untouched — which proved signing and payload
 * construction correct (a malformed action fails at deserialisation, not with a
 * business message) but left the routing question open.
 *
 * A later withdrawal **completed**, and settles it: perp `accountValue` moved
 * 6.0 -> 4.0 while spot stayed at 14.0, and the ledger reported
 * `{type:"withdraw", usdc:"1.0", fee:"1.0"}`. So `withdraw3` debits **perp**, the
 * gross is what leaves, and the fee comes out of it. The earlier note that
 * testnet withdrawal never completes was a conclusion drawn from one refusal and
 * is wrong.
 */

import { HlError, toHlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { WITHDRAW_TIMINGS } from "@/hyperliquid/config/constants";
import type { WithdrawalTicket } from "@/hyperliquid/transfers/preflight";
import type { TransferOutcome } from "@/hyperliquid/transfers/types";

const logger = log.child("transfers.withdraw");

/** The slice of `ExchangeClient` needed to withdraw. */
export interface WithdrawClient {
  withdraw3(params: { destination: string; amount: string }): Promise<unknown>;
}

/**
 * The journal writes, injectable only so a test can observe them.
 *
 * Defaults to the real MMKV-backed journal. A caller does not get to opt out:
 * the in-flight guard on the next attempt is only as good as this write.
 */
export interface WithdrawJournal {
  record(entry: {
    nonce: number;
    destination: string;
    amount: string;
    identityKey: string;
    at: number;
  }): void;
  markSettled(nonce: number, at: number): void;
  /** Correct the entry's key to the nonce that was actually signed. */
  reviseNonce(from: number, to: number): void;
}

/**
 * The MMKV-backed journal, resolved on first use rather than at import.
 *
 * Loading it eagerly would pull `react-native` into the module graph, which
 * makes this file unimportable outside the app runtime — including from the
 * live smoke scripts, which are the only thing that exercises the real exchange
 * path. Lazy resolution keeps the default intact without that cost.
 */
function defaultJournal(): WithdrawJournal {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const journal = require("@/hyperliquid/transfers/journal") as {
    recordWithdrawal: WithdrawJournal["record"];
    settleWithdrawal: WithdrawJournal["markSettled"];
    reviseWithdrawalNonce: WithdrawJournal["reviseNonce"];
  };
  return {
    record: journal.recordWithdrawal,
    markSettled: journal.settleWithdrawal,
    reviseNonce: journal.reviseWithdrawalNonce,
  };
}

/**
 * Tickets already submitted.
 *
 * A `WeakSet` so a ticket does not outlive its own quote. Single-use matters
 * because a withdrawal has no idempotency key: handing the same ticket twice is
 * two withdrawals, not one retried.
 */
const spent = new WeakSet<WithdrawalTicket>();

export interface SubmitWithdrawalParams {
  client: WithdrawClient;
  ticket: WithdrawalTicket;
  journal?: WithdrawJournal;
  /**
   * Reads back the nonce the SDK actually signed for an address.
   *
   * Lazily resolved for the same reason the journal is — importing
   * `api/clients` eagerly would drag the SDK and its transports into every
   * module graph that touches this file.
   */
  readIssuedNonce?: (address: string) => number | null;
  now?: () => number;
}

/**
 * Submit a confirmed withdrawal.
 *
 * The nonce doubles as the transaction id — the response carries no handle of
 * its own (`{status:"ok", response:{type:"default"}}`), and the ledger row that
 * appears minutes later is keyed by it. It is therefore captured before the call
 * rather than derived afterwards.
 */
export async function submitWithdrawal(params: SubmitWithdrawalParams): Promise<TransferOutcome> {
  const now = (params.now ?? Date.now)();
  const { quote, confirmedAt } = params.ticket;

  // Everything below is re-derived, not trusted. A forged or stale ticket must
  // not reach `withdraw3`, because that call is final.
  if (spent.has(params.ticket)) {
    throw new HlError("Withdrawal refused: this ticket was already submitted", {
      code: "not_authorized",
      context: { reason: "ticket_replayed" },
    });
  }
  if (quote.blockers.length > 0) {
    throw new HlError("Withdrawal refused: the quote is blocked", {
      code: "not_authorized",
      context: { reason: "blocked", blockers: quote.blockers.map((b) => b.code).join(",") },
    });
  }
  if (!Number.isFinite(confirmedAt) || confirmedAt <= 0) {
    throw new HlError("Withdrawal refused: the ticket was never confirmed", {
      code: "not_authorized",
      context: { reason: "unconfirmed" },
    });
  }
  if (now > quote.expiresAt) {
    // The balance and fee it quoted may have moved since.
    throw new HlError("Withdrawal refused: the quote has expired", {
      code: "not_authorized",
      context: { reason: "expired", ageMs: now - quote.issuedAt },
    });
  }
  spent.add(params.ticket);

  const journal = params.journal ?? defaultJournal();

  // Before the request, deliberately. The crash this guards against happens
  // during the call, and an entry written afterwards would never exist.
  journal.record({
    nonce: now,
    destination: quote.destination.wire,
    amount: quote.amount.gross,
    identityKey: quote.identityKey,
    at: now,
  });

  // The nonce we THINK we signed, until the SDK tells us otherwise.
  let signedNonce = now;
  const readIssued =
    params.readIssuedNonce ??
    ((address: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const clients = require("@/hyperliquid/api/clients") as {
        lastIssuedNonce: (a: string) => number | null;
      };
      return clients.lastIssuedNonce(address);
    });

  // Captured BEFORE the call so a throw that happens before the SDK ever
  // reaches its nonce manager — a schema rejection, a wallet that would not
  // sign — cannot make us adopt the nonce of some EARLIER action that is still
  // sitting in the manager. Only a value that changed belongs to this call.
  const issuedBefore = readIssued(quote.source.address);

  const reconcileNonce = (): void => {
    const issuedAfter = readIssued(quote.source.address);
    if (issuedAfter === null || issuedAfter === issuedBefore) return;
    if (issuedAfter === signedNonce) return;
    journal.reviseNonce(signedNonce, issuedAfter);
    logger.info("withdrawal.nonce_corrected", {
      context: { driftMs: issuedAfter - signedNonce },
    });
    signedNonce = issuedAfter;
  };

  try {
    await params.client.withdraw3({
      // The lowercase form, which is what the signature covers. The checksummed
      // form exists only so a human could verify it.
      destination: quote.destination.wire,
      // The gross. The exchange deducts the fee from this; the net was shown to
      // the user and is not what gets signed.
      amount: quote.amount.gross,
    });

    // The SDK has signed by now, so the journal can stop guessing.
    reconcileNonce();

    logger.info("withdrawal.submitted", {
      context: { destinationTail: quote.destination.display.slice(-6), gross: quote.amount.gross },
    });
    return { kind: "settled", nonce: signedNonce };
  } catch (error) {
    // Also on the failure path: a request that reached the wire and then timed
    // out has a real nonce, and that is exactly the case the journal has to
    // resolve later. `reconcileNonce` is a no-op when the SDK never got as far
    // as issuing one.
    reconcileNonce();
    const hl = toHlError(error, { stage: "withdraw3" });

    // A rejection the server articulated is a fact: nothing moved, and the
    // journal entry should not block the next attempt. Confirmed live —
    // `"Error withdrawing from bridge"` left both balances untouched.
    // Never sent: a schema rejection, a formatting failure, or a wallet that
    // could not sign. The journal entry must be settled exactly as for a server
    // refusal — otherwise a signing failure leaves an in-flight marker that
    // blocks the next attempt for the whole settlement floor, for a withdrawal
    // that does not exist.
    if (hl.code === "validation_error") {
      journal.markSettled(signedNonce, now);
      logger.warn("withdrawal.rejected_locally", { error: hl });
      return { kind: "rejected_locally", error: hl };
    }

    if (hl.code === "api_error") {
      journal.markSettled(signedNonce, now);
      logger.warn("withdrawal.rejected", { error: hl });
      return { kind: "rejected_by_server", reason: hl.message };
    }

    // A 429 is the SERVER refusing to accept the request, so nothing was
    // withdrawn — it belongs with the definite refusals rather than with the
    // unknowns below.
    //
    // Falling through left an unsettled journal entry, which arms the
    // in-flight blocker for the full fifteen-minute settlement floor. The user
    // was told to wait a quarter of an hour for a withdrawal the exchange
    // never looked at, over a rate limit that clears in under a minute.
    if (hl.code === "server_rate_limited") {
      journal.markSettled(signedNonce, now);
      logger.warn("withdrawal.rate_limited", { error: hl });
      return {
        kind: "rejected_by_server",
        reason: "Too many requests just now — try the withdrawal again in a minute.",
      };
    }

    // Anything else and we genuinely do not know. The journal entry stays, so
    // the in-flight blocker refuses a second attempt for the settlement floor.
    logger.warn("withdrawal.unknown", { error: hl });
    return {
      kind: "unknown",
      error: hl,
      nonce: signedNonce,
      window: { fromMs: now, toMs: now + WITHDRAW_TIMINGS.settlementFloorMs },
    };
  }
}
