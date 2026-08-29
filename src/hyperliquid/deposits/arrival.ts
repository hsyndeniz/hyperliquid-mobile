/**
 * Knowing a deposit arrived.
 *
 * The transaction confirming on Arbitrum is **not** the deposit arriving. What
 * follows it is a validator quorum — "credited when more than 2/3 of the staking
 * power has signed the deposit" — and only then does Hyperliquid know about the
 * money. Measured over five real deposits, that gap was **5.7 to 10.0 seconds**.
 *
 * So there are two separate things a screen can say, and conflating them is the
 * mistake this module exists to prevent: *sent* is on-chain, *arrived* is on
 * Hyperliquid, and a client that reports the first as the second shows a balance
 * the user cannot yet trade with.
 *
 * ## What to watch
 *
 * The `{type:"deposit", usdc}` row in `userNonFundingLedgerUpdates`, and **not**
 * the balance. Two reasons, both measured:
 *
 * - The ledger row states the credited amount explicitly, so it can be matched to
 *   the deposit that was sent. A balance only moves, and it moves for trading,
 *   funding and transfers too.
 * - The money lands in **perp**, not spot — three of four first-time depositors
 *   showed `accountValue` equal to the deposit with `balances: []`. A watcher
 *   pointed at the spot store never fires.
 *
 * ## Only the NATIVE bridge is detected
 *
 * This watches for `{type:"deposit"}`, which is what Hyperliquid's own Arbitrum
 * bridge produces — 1,371 measured deposits, no exceptions. A **third-party
 * bridge is invisible to it**: one was traced end to end on testnet, burning
 * USDC on Arbitrum Sepolia and paying out on Hyperliquid as an ordinary
 * `{type:"send"}` from the bridge operator's own account, 30 seconds later and
 * 4% lighter.
 *
 * Widening the match to `send` would be worse than the gap: every incoming
 * transfer, from a friend or a sub-account sweep, would then read as a deposit
 * arriving.
 *
 * ## What this deliberately does not do
 *
 * It never concludes a deposit is **lost**. A quorum that has not been reached is
 * indistinguishable from one that is slow, and the only honest states are "not
 * yet" and "longer than usual". Nothing here would tell a user their money is
 * gone, because nothing here could know that.
 */

import { BigNumber } from "bignumber.js";

import { log } from "@/hyperliquid/core/logger";
import { DEPOSIT_CREDIT_MS, USDC_DECIMALS } from "@/hyperliquid/deposits/network";
import type { Hex } from "@/hyperliquid/types/domain";

const logger = log.child("deposits.arrival");

/**
 * When to stop saying "a few seconds" and start saying "this is taking a while".
 *
 * Ten times the slowest observed credit. Generous on purpose: the measured range
 * is five samples of a consensus latency, not a service-level guarantee, and the
 * cost of being early here is telling a user something is wrong when it is not.
 */
export const DEPOSIT_SLOW_AFTER_MS = DEPOSIT_CREDIT_MS.observedMax * 10;

/** One `{type:"deposit"}` row, as the ledger reports it. */
export interface DepositCredit {
  /** Server time of the credit. */
  at: number;
  /** Credited USDC, verbatim. Equal to the amount sent — there is no fee. */
  usdc: string;
  hash: string | null;
}

export type ArrivalState =
  | { kind: "arrived"; credit: DepositCredit; waitedMs: number }
  /** Not credited yet, and within the normal window. */
  | { kind: "waiting"; waitedMs: number }
  /** Not credited, and past the point where a client should say so plainly. */
  | { kind: "slow"; waitedMs: number };

export interface LedgerProbe {
  userNonFundingLedgerUpdates(params: { user: Hex; startTime: number }): Promise<unknown>;
}

/**
 * Deposit rows credited to `user` at or after `since`.
 *
 * Parsed defensively: a shape change must degrade to "we cannot see it yet",
 * never to a false arrival.
 */
export function parseDepositCredits(rows: unknown, since: number): DepositCredit[] {
  if (!Array.isArray(rows)) return [];
  const credits: DepositCredit[] = [];
  for (const entry of rows) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { time?: unknown; hash?: unknown; delta?: unknown };
    const delta = row.delta;
    if (typeof delta !== "object" || delta === null) continue;
    if ((delta as { type?: unknown }).type !== "deposit") continue;

    const at = typeof row.time === "number" ? row.time : null;
    const usdc = (delta as { usdc?: unknown }).usdc;
    if (at === null || typeof usdc !== "string") continue;
    if (at < since) continue;

    credits.push({ at, usdc, hash: typeof row.hash === "string" ? row.hash : null });
  }
  return credits.sort((a, b) => a.at - b.at);
}

/**
 * How far a credit may predate the local send time and still be this deposit.
 *
 * Covers device-clock skew only, not history. It is deliberately far smaller than
 * the ledger query's lookback: an earlier version used one 60-second value for
 * both, which let a credit that landed a **minute before the transaction was
 * sent** satisfy the match. A user topping up 100 USDC twice in a minute would
 * have seen the first credit reported as the second deposit's arrival, and
 * stopped waiting for money still in flight.
 */
export const CLOCK_SKEW_MS = 5_000;

/**
 * How far back the ledger is *queried*.
 *
 * Wide on purpose, and distinct from {@link CLOCK_SKEW_MS}: fetching too little
 * loses a credit, whereas matching too widely claims the wrong one. Only the
 * second is dangerous, so the two windows are separate constants.
 */
export const QUERY_LOOKBACK_MS = 60_000;

/**
 * Match a credit to the deposit that was sent.
 *
 * By **amount and time**, because the ledger row carries no transaction hash from
 * Arbitrum — there is no shared identifier between the two chains. Compared
 * numerically: the wire spells the credit `"5.0"` where the user typed `"5"`.
 *
 * ONE bound is enforced: **not before the send**, give or take
 * {@link CLOCK_SKEW_MS}. A credit older than that is somebody else's deposit,
 * or an earlier one of this user's.
 *
 * A second bound — "not sooner than physically possible", since crediting needs
 * a validator quorum and was never observed faster than
 * `DEPOSIT_CREDIT_MS.observedMin` — reads well and **cannot coexist with the
 * first**. The skew allowance is 5,000 ms and the physical minimum is 5,751 ms,
 * so requiring both leaves a 751 ms window and rejects the very case the skew
 * allowance exists for: a device clock running ahead of the server's, where a
 * legitimate credit timestamps BEFORE the send. Tried and reverted 2026-08-29;
 * the two tests it broke are both measured behaviour, not oversights. Widening
 * it would need the send timestamped on the server's clock, which is not
 * available at that point.
 *
 * So the duplicate case is handled by the caller, not here: this cannot
 * distinguish **two identical deposits sent seconds apart** — nothing in either
 * system links them — and a caller watching several at once must pass
 * `exclude` with the credits it has already attributed.
 */
export function matchCredit(
  credits: readonly DepositCredit[],
  amount: string,
  sentAt: number,
  exclude: readonly DepositCredit[] = []
): DepositCredit | null {
  const wanted = usdcPrecision(amount);
  const floor = sentAt - CLOCK_SKEW_MS;
  const claimed = new Set(exclude.map((c) => `${c.at}:${c.usdc}:${c.hash ?? ""}`));

  return (
    credits.find(
      (c) =>
        c.at >= floor &&
        wanted.isEqualTo(usdcPrecision(c.usdc)) &&
        !claimed.has(`${c.at}:${c.usdc}:${c.hash ?? ""}`)
    ) ?? null
  );
}

/**
 * Round to what USDC can actually represent, before comparing.
 *
 * **Exact equality is wrong here, and measured to be wrong.** 12.2% of real
 * `deposit` ledger rows carry a ten-decimal float-serialisation artifact — a user
 * who deposits `1500000.88` is credited `"1500000.8799999999"`. Under
 * `isEqualTo` that deposit never matches: it sits in `waiting`, ages into `slow`,
 * and the client tells someone their money has not arrived when it has.
 *
 * Rounding to six places is not a fudge factor. USDC has six decimals on-chain —
 * `deposits/network.ts` reads `decimals() = 6` from the contract — so every digit
 * past the sixth is noise the token cannot hold, and two amounts agreeing to six
 * places are the same amount.
 */
function usdcPrecision(amount: string): BigNumber {
  return new BigNumber(amount).decimalPlaces(USDC_DECIMALS, BigNumber.ROUND_HALF_UP);
}

/**
 * Check once whether a deposit has arrived.
 *
 * Deliberately a single check rather than a loop: the caller owns the polling
 * cadence, because it knows whether the screen is visible and it holds the weight
 * budget. `userNonFundingLedgerUpdates` is one of the expensive reads.
 */
export async function checkArrival(params: {
  probe: LedgerProbe;
  user: Hex;
  /** The amount that was sent, as a decimal string. */
  amount: string;
  /** When the transaction was sent, in ms. */
  sentAt: number;
  /** Credits already attributed to other deposits. See {@link matchCredit}. */
  exclude?: readonly DepositCredit[];
  now?: () => number;
}): Promise<ArrivalState> {
  const now = (params.now ?? Date.now)();
  const waitedMs = now - params.sentAt;

  // The QUERY window is wide, so a credit stamped slightly before our local send
  // time still comes back. The MATCH window is narrow — see `matchCredit`. An
  // earlier version used this same 60s value for both, which made a credit from a
  // minute before the send count as this deposit's arrival.
  const rows = await params.probe.userNonFundingLedgerUpdates({
    user: params.user,
    startTime: params.sentAt - QUERY_LOOKBACK_MS,
  });

  const credits = parseDepositCredits(rows, params.sentAt - QUERY_LOOKBACK_MS);
  const credit = matchCredit(credits, params.amount, params.sentAt, params.exclude);
  if (credit) {
    logger.info("deposit.arrived", {
      // The credit's own latency, not how long this poll happened to take —
      // `waitedMs` depends on when the caller last checked.
      context: { usdc: credit.usdc, creditedAfterMs: credit.at - params.sentAt },
    });
    return { kind: "arrived", credit, waitedMs };
  }

  return waitedMs > DEPOSIT_SLOW_AFTER_MS
    ? { kind: "slow", waitedMs }
    : { kind: "waiting", waitedMs };
}
