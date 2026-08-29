/**
 * The non-funding ledger, and settlement watching.
 *
 * A withdrawal cannot be cancelled, has no status endpoint and its response
 * carries no handle. The **only** evidence it completed is a row appearing in
 * `userNonFundingLedgerUpdates` — roughly four minutes later, median 236.8 s
 * across 989 mainnet samples, with observed maxima of 530.8 s on mainnet and
 * 738.7 s on testnet.
 *
 * That is what this module watches for, and it matters for a specific reason:
 * without it, a *successful* withdrawal leaves its journal entry unresolved, and
 * the duplicate guard then blocks the next withdrawal for the full 15-minute
 * settlement floor. Not wrong — a conservative failure is the right kind here —
 * but unnecessary, and a user who cannot withdraw twice in a row will assume the
 * app is broken.
 *
 * The sign convention is worth stating: a withdrawal's `delta.usdc` is the
 * **gross** amount, and `delta.fee` is reported separately — the arrival is
 * `usdc − fee`. That mirrors the signing convention, where the gross is what
 * gets signed and the fee comes out of it.
 */

import { BigNumber } from "bignumber.js";

import { log } from "@/hyperliquid/core/logger";
import { amountsEqual } from "@/hyperliquid/transfers/amount";
import { weightBudget, type WeightBudget } from "@/hyperliquid/api/weightBudget";

const logger = log.child("transfers.ledger");

/**
 * Every `delta.type` worth rendering in a transaction history.
 *
 * Left as a plain string on the row rather than a union, because the set is open
 * — an unrecognised type must display as itself, not vanish from history.
 */
export const LEDGER_TYPES = [
  "deposit",
  "withdraw",
  "internalTransfer",
  "spotTransfer",
  "accountClassTransfer",
  "subAccountTransfer",
  "vaultCreate",
  "vaultDeposit",
  "vaultWithdraw",
  "liquidation",
  "rewardsClaim",
  "send",
] as const;

export interface LedgerRow {
  time: number;
  hash: string;
  /** Verbatim. The value set is open; an unknown type still belongs in history. */
  type: string;
  /**
   * The literal `delta.usdc` field.
   *
   * **On a `withdraw` this is the NET, not the gross.** Measured on all three
   * withdrawals this account has ever made: a 2 USDC withdrawal reports
   * `{usdc: "1.0", fee: "1.0"}` and a 7 USDC one reports `{usdc: "6.0", fee:
   * "1.0"}`. The gross — the figure that was signed — is `usdc + fee`, and it
   * appears nowhere on the row.
   *
   * This field was documented as the gross for two phases. Nothing caught it
   * because the only consumer, `judgeSettlement`, compared it against a gross
   * that no live row could ever equal, and the duplicate guard that would have
   * surfaced the mismatch had no production caller until now.
   *
   * **Absent on a `send`**, which is the most common row of all — measured live,
   * a send's delta is
   * `{type, user, destination, sourceDex, destinationDex, token, amount,
   * usdcValue, fee, nativeTokenFee, nonce, feeToken}`. There is no `usdc` key.
   * Read {@link LedgerRow.usdValue} instead of this unless you specifically want
   * the raw field.
   */
  usdc: string | null;
  /**
   * The row's value in USD, wherever the wire happens to put it.
   *
   * `delta.usdc` on a withdrawal, a class transfer or a vault deposit;
   * `delta.usdcValue` on a `send`. Reading only `usdc` renders every send with a
   * blank amount — and `transfers/transfer.ts` recommends `agentSendAsset` as the
   * DEFAULT in-account move, which produces exactly a `send` row. 590 of 1,938
   * sampled live sends were that self spot-perp move.
   */
  usdValue: string | null;
  /** Token units on a `send`, which can be a non-USDC token. Null elsewhere. */
  amount: string | null;
  /** The token a `send` moved, e.g. `"USDC"`. Null elsewhere. */
  token: string | null;
  /**
   * Reported separately. On a `withdraw` it has **already been deducted** from
   * `usdc` — see the note there.
   */
  fee: string | null;
  /**
   * **Never present on a `withdraw`.** Its delta is exactly
   * `{type, usdc, fee, nonce}` — verified on every withdrawal this account has
   * made. So a settlement match cannot use the destination at all.
   */
  destination: string | null;
  /**
   * Milliseconds on `send`/`spotTransfer`, where it may still be null;
   * **microseconds** on `withdraw`, where it is always present.
   *
   * The microsecond scaling is exact, not an approximation: all three
   * withdrawals end in `000`, and `nonce / 1000` equals the millisecond nonce
   * `submitWithdrawal` journalled, to the millisecond. That makes it the
   * strongest settlement key available — see {@link judgeSettlement}.
   */
  nonce: number | null;
  /** The raw delta, for anything this shape does not name. */
  raw: Record<string, unknown>;
}

export interface LedgerProbe {
  userNonFundingLedgerUpdates(params: {
    user: string;
    startTime: number;
    endTime?: number;
  }): Promise<unknown>;
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

export function parseLedger(raw: unknown): LedgerRow[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const delta = (typeof row.delta === "object" && row.delta !== null ? row.delta : {}) as Record<
      string,
      unknown
    >;

    return [
      {
        time: typeof row.time === "number" ? row.time : 0,
        hash: str(row, "hash") ?? "",
        type: str(delta, "type") ?? "unknown",
        usdc: str(delta, "usdc"),
        // `usdc` first so a withdrawal keeps its gross; `usdcValue` is the send's
        // spelling of the same idea.
        usdValue: str(delta, "usdc") ?? str(delta, "usdcValue"),
        amount: str(delta, "amount"),
        token: str(delta, "token"),
        fee: str(delta, "fee"),
        destination: str(delta, "destination"),
        nonce: typeof delta.nonce === "number" ? delta.nonce : null,
        raw: delta,
      },
    ];
  });
}

/** Fetch ledger rows since a point in time, through the weight budget. */
export async function fetchLedger(params: {
  probe: LedgerProbe;
  user: string;
  startTime: number;
  endTime?: number;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<{ rows: LedgerRow[]; deferred: boolean }> {
  const budget = params.budget ?? weightBudget;
  const at = (params.now ?? Date.now)();

  const raw = await budget.tryRun(
    "userNonFundingLedgerUpdates",
    () =>
      params.probe.userNonFundingLedgerUpdates({
        user: params.user,
        startTime: params.startTime,
        ...(params.endTime === undefined ? {} : { endTime: params.endTime }),
      }),
    { now: () => at }
  );
  if (raw === null) return { rows: [], deferred: true };

  return { rows: parseLedger(raw), deferred: false };
}

export type SettlementVerdict =
  /** A matching row appeared: the withdrawal completed. */
  | { kind: "settled"; row: LedgerRow }
  /** No row yet, and it is too early to expect one. Keep watching. */
  | { kind: "pending"; elapsedMs: number }
  /**
   * Past the observed maximum with no row.
   *
   * Deliberately **not** called "failed". A withdrawal has no cancel and no
   * status endpoint, so absence past the floor is grounds for telling the user
   * to check the destination chain — never grounds for re-sending.
   */
  | { kind: "unresolved"; elapsedMs: number };

/**
 * Decide whether a signed withdrawal has settled.
 *
 * ## Matched on the nonce, because it is exact
 *
 * The row's `nonce` is the signed nonce in **microseconds**, so `nonce / 1000`
 * is the nonce that was signed. That distinguishes two withdrawals of the same
 * amount in the same window, which amount matching cannot.
 *
 * **This is only an identity because the journal now stores the SIGNED nonce.**
 * It previously stored the app's own `Date.now()`, taken before the call, while
 * the real one was generated later and independently inside the SDK — after an
 * `await getWalletAddress()` and a lock acquisition, from a second `Date.now()`,
 * with `last + 1` substituted on a same-millisecond collision. The two agreed
 * whenever that gap rounded under a millisecond, which is why three warm-path
 * withdrawals all matched and this comment used to call it verified. It was a
 * race that usually won. `api/clients.ts` now supplies the nonce manager and
 * `submitWithdrawal` corrects the entry to what was actually signed.
 *
 * Amount plus window remains the fallback for a row without a nonce — and it is
 * genuinely a fallback, not a safety net: it takes the FIRST withdrawal at or
 * after `signedAt` with a matching gross, so two withdrawals of one size settle
 * the second against the first's row. Keeping the nonce exact is what keeps
 * that path unreached.
 *
 * ## The amount is the NET
 *
 * `row.usdc` on a withdraw row is what **arrived**, with `fee` already taken
 * out; the gross that was signed is `usdc + fee` and appears nowhere. Comparing
 * `row.usdc` to the gross — which this function did — can never match a real
 * withdrawal, so every entry sat `pending` to the floor and then `unresolved`
 * forever. Once the duplicate guard was wired, that would have blocked every
 * subsequent withdrawal permanently.
 *
 * The destination is not matched at all: a withdraw delta does not carry one.
 */
export function judgeSettlement(params: {
  rows: readonly LedgerRow[];
  signedAt: number;
  /** The signed gross. Compared as `row.usdc + row.fee`, never to `usdc` alone. */
  grossAmount: string;
  /** Kept for call-site symmetry; a withdraw row carries no destination to match. */
  destination?: string;
  /** The journalled nonce in MILLISECONDS. When present, the exact key. */
  nonce?: number;
  now: number;
  settlementFloorMs: number;
}): SettlementVerdict {
  const elapsedMs = params.now - params.signedAt;
  const withdrawals = params.rows.filter((row) => row.type === "withdraw");

  const byNonce =
    params.nonce === undefined
      ? undefined
      : withdrawals.find((row) => row.nonce !== null && row.nonce / 1000 === params.nonce);

  // The amount+window fallback is for entries whose nonce we never captured.
  // When the nonce IS known it is the identity, and a row carrying a DIFFERENT
  // one provably belongs to some other withdrawal — matching it by amount says
  // "yours arrived" about someone else's money movement.
  //
  // The scenario is ordinary rather than exotic: an app withdrawal ends
  // `unknown` (response lost), the user is unsure and withdraws the same amount
  // again from the web app, and that row lands minutes later carrying its own
  // nonce. The fallback claimed it, settled the journal entry, and told the
  // user the first withdrawal had arrived — while it had not.
  const match =
    byNonce ??
    withdrawals.find(
      (row) =>
        row.time >= params.signedAt &&
        // A row that names a nonce is only ever ITS OWN withdrawal. Rows with
        // no nonce stay eligible: that is the case the fallback exists for.
        (params.nonce === undefined || row.nonce === null) &&
        // NUMERIC, never `===`. We sign the canonical form ("9") and the ledger
        // reports the padded one ("9.0"), so string equality never matches a
        // real withdrawal.
        grossOf(row) !== null &&
        amountsEqual(grossOf(row)!, params.grossAmount)
    );

  if (match) {
    logger.info("withdrawal.settled", {
      context: {
        elapsedMs,
        arrived: match.usdc,
        fee: match.fee,
        matchedBy: byNonce ? "nonce" : "amount",
      },
    });
    return { kind: "settled", row: match };
  }

  return elapsedMs < params.settlementFloorMs
    ? { kind: "pending", elapsedMs }
    : { kind: "unresolved", elapsedMs };
}

/**
 * The gross a withdraw row represents — the figure that was signed.
 *
 * Reconstructed, because the wire does not carry it: `usdc` is the net and `fee`
 * is what was taken out, so the gross is their sum. `null` when either is
 * missing or unparseable, so a caller cannot mistake a partial row for a match.
 *
 * BigNumber rather than floats: live balances carry 18 to 20 significant digits,
 * and a double silently drops the tail while still rendering as a number.
 */
export function grossOf(row: LedgerRow): string | null {
  if (row.usdc === null) return null;
  const net = new BigNumber(row.usdc);
  const fee = row.fee === null ? new BigNumber(0) : new BigNumber(row.fee);
  if (!net.isFinite() || !fee.isFinite()) return null;
  return net.plus(fee).toFixed();
}

/**
 * What actually arrived, given a settled row.
 *
 * The `usdc` field already **is** the arrival — the fee has been taken out of it
 * upstream. This function used to subtract the fee a second time, which reported
 * `0` arrived for the 2 USDC withdrawal that is this project's standard test.
 */
export function arrivedAmount(row: LedgerRow): string | null {
  if (row.usdc === null) return null;
  const net = new BigNumber(row.usdc);
  return net.isFinite() ? net.toFixed() : null;
}
