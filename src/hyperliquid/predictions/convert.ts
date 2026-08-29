/**
 * Converting between quote tokens and outcome shares — `userOutcome`.
 *
 * Four actions share one wire type, and every one of them moves money:
 *
 * | Action          | Consumes                                 | Produces                                |
 * | --------------- | ---------------------------------------- | --------------------------------------- |
 * | `splitOutcome`  | `X` quote tokens                         | `X` Yes **and** `X` No of one outcome   |
 * | `mergeOutcome`  | `X` Yes **and** `X` No of one outcome    | `X` quote tokens                        |
 * | `mergeQuestion` | `X` Yes of **every** outcome of a question | `X` quote tokens                      |
 * | `negateOutcome` | `X` No of one outcome                    | `X` Yes of every **other** outcome      |
 *
 * Split and merge are exact inverses, and neither is a trade: no book, no price,
 * no slippage. `1` quote token always becomes one Yes plus one No, because
 * exactly one of them will settle to `1`. That is also why merging is how a
 * position is closed without paying the spread — Hyperliquid calls the two
 * "minting" and "burning" in its fee table.
 *
 * Three hazards this module exists to make unreachable:
 *
 * 1. **`amount` means different things in different variants.** Quote tokens for
 *    a split, shares for every merge. The field is spelled the same in all four,
 *    so the two are branded types here and the parameters are named for the unit.
 * 2. **The identifier is the OUTCOME ID, not the asset id and not the encoding.**
 *    `outcome: 1017` — never `100010170` (asset id) and never `10170`
 *    (`outcomeId * 10 + sideIndex`). All three are plausible integers and the
 *    wrong one silently converts a different market, so an {@link OutcomeId} can
 *    only be made from something a parser produced.
 * 3. **`amount: null` means "all of it".** On both merges. A null that arrives by
 *    accident — an unparsed field, an optional chain — liquidates the entire
 *    position. It is never reachable from a value here: the maximum is a separate,
 *    named function.
 *
 * **Routing is not offered, but it is not absent either.** `userOutcome`'s request
 * schema carries no `vaultAddress`, so the SDK's options type has none and a
 * caller cannot deliberately route the way every action in `orders/exchange.ts`
 * can. But `executeL1Action` resolves `options?.vaultAddress ??
 * config.defaultVaultAddress` for **every** L1 action alike — so a client
 * constructed with a default would route this too, through a seam no type
 * mentions. `api/clients.ts` sets no default and a structural guard keeps it that
 * way; whether the exchange would even honour routing here is untested, and
 * untestable without spending money.
 *
 * Meanwhile this is an L1 action, so an agent signature resolves to the
 * **master** — a client that believes it is converting a sub-account's shares
 * converts the master's.
 *
 * The response is a bare `{status:"ok",response:{type:"default"}}` — **no id, no
 * amount, no echo of what was converted.** There is nothing to reconcile against
 * and no idempotency key, so a lost response is resolved by re-reading balances,
 * never by re-sending. That is why the return type is the same
 * {@link TransferOutcome} the transfer path uses rather than an order-shaped one.
 */

import type { BigNumber } from "bignumber.js";

import { serverNow } from "@/hyperliquid/core/clock";
import { HlError, toHlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { ORDER_EXPIRY_WINDOW_MS } from "@/hyperliquid/orders/exchange";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import type { AgentSignable, TransferOutcome } from "@/hyperliquid/transfers/types";

const logger = log.child("predictions.convert");

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

declare const OutcomeIdBrand: unique symbol;
/**
 * An outcome's own id — the `outcome` field of `outcomeMeta`.
 *
 * Branded because three different integers describe the same market and only one
 * of them belongs here. For outcome 1017 side 0 they are `1017` (this), `10170`
 * (the encoding, and the number inside `#10170` / `+10170`) and `100010170` (the
 * asset id an order carries). None of the three is out of range for the others,
 * so no magnitude check can tell them apart — which is why the only producers
 * take an already-parsed object.
 */
export type OutcomeId = number & { readonly [OutcomeIdBrand]: true };

declare const QuestionIdBrand: unique symbol;
/** A question's id — the group inside which exactly one outcome settles Yes. */
export type QuestionId = number & { readonly [QuestionIdBrand]: true };

function assertId(kind: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HlError(`${kind} must be a non-negative integer`, {
      code: "validation_error",
      context: { received: String(value) },
    });
  }
}

/**
 * The outcome id of anything a parser produced.
 *
 * Accepts a `PredictionOutcome`, an `OutcomeHolding`, a `SettledHolding`, or a
 * `SettledOutcome.outcome` — every one of them decoded the id through
 * `core/assetIds` rather than by arithmetic at a call site.
 */
export function outcomeIdOf(parsed: { outcomeId: number }): OutcomeId {
  assertId("outcome id", parsed.outcomeId);
  return parsed.outcomeId as OutcomeId;
}

/** The question id of a parsed `PredictionQuestion`. */
export function questionIdOf(parsed: { questionId: number }): QuestionId {
  assertId("question id", parsed.questionId);
  return parsed.questionId as QuestionId;
}

/**
 * Take an outcome id from a bare integer — a deep link, a stored favourite.
 *
 * Named `unsafe` because the check it cannot perform is the one that matters:
 * `10170` is a valid outcome id *and* the encoding of outcome 1017. Both pass.
 * Prefer {@link outcomeIdOf} wherever a parsed object is in reach.
 */
export function unsafeOutcomeId(value: number): OutcomeId {
  assertId("outcome id", value);
  return value as OutcomeId;
}

/** See {@link unsafeOutcomeId}. */
export function unsafeQuestionId(value: number): QuestionId {
  assertId("question id", value);
  return value as QuestionId;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

declare const QuoteTokensBrand: unique symbol;
/** Quote tokens — USDC on all 309 measured outcomes. What a split consumes. */
export type QuoteTokenAmount = string & { readonly [QuoteTokensBrand]: true };

declare const SharesBrand: unique symbol;
/** Outcome shares. What a merge consumes and a negate converts. */
export type ShareAmount = string & { readonly [SharesBrand]: true };

/**
 * Quote tokens to split, through the single audited decimal producer.
 *
 * @throws {HlError} on anything a float or a stray keystroke could produce.
 */
export function quoteTokens(input: string | BigNumber): QuoteTokenAmount {
  return canonicalAmount(input, "quote token amount") as string as QuoteTokenAmount;
}

/**
 * Shares to merge or negate.
 *
 * **Not restricted to whole shares, deliberately.** Every quantity observed is an
 * integer — 197 of 197 live book levels and 16 of 16 balance rows — but nothing
 * in the schema or the docs says a fraction is refused, and this client has not
 * tried one. Rejecting locally on that evidence would block an action the
 * exchange may well accept; {@link isWholeShares} is here so a preflight can warn
 * without this gating.
 */
export function shares(input: string | BigNumber): ShareAmount {
  return canonicalAmount(input, "share amount") as string as ShareAmount;
}

/** Whether an amount is a whole number of shares — every observed quantity is. */
export function isWholeShares(amount: ShareAmount): boolean {
  return /^[0-9]+(\.0+)?$/.test(amount);
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/**
 * The slice of `ExchangeClient` this module needs.
 *
 * Note what the options do **not** include: there is no `vaultAddress`, because
 * `userOutcome`'s request schema has none. The absence is reproduced here so an
 * attempt to route is a type error rather than a field the SDK would quietly
 * forward into the signature — which, measured, it would.
 */
export interface OutcomeConvertClient {
  userOutcome(
    params:
      | { splitOutcome: { outcome: number; amount: string } }
      | { mergeOutcome: { outcome: number; amount: string | null } }
      | { mergeQuestion: { question: number; amount: string | null } }
      | { negateOutcome: { question: number; outcome: number; amount: string } },
    opts?: { expiresAfter?: number }
  ): Promise<unknown>;
}

type ConvertAction = Parameters<OutcomeConvertClient["userOutcome"]>[0];

interface Base extends AgentSignable {
  client: OutcomeConvertClient;
  now?: () => number;
}

/**
 * Send one `userOutcome` action.
 *
 * `expiresAfter` is stamped on every call. These actions do not rest, so the
 * window is not about an order sitting on a book — it is about a request that
 * stalls in the network and lands minutes later against balances the user has
 * since changed. The same window the order path uses, for the same reason.
 */
async function send(
  label: string,
  params: Base,
  action: ConvertAction,
  context: Record<string, unknown>
): Promise<TransferOutcome> {
  const at = (params.now ?? Date.now)();
  try {
    await params.client.userOutcome(action, {
      expiresAfter: serverNow(at) + ORDER_EXPIRY_WINDOW_MS,
    });
    logger.info(`convert.${label}`, { context });
    return { kind: "settled", nonce: at };
  } catch (error) {
    const hl = toHlError(error, { stage: "userOutcome" });
    // A schema rejection never left the device. Reporting it as `unknown` would
    // send a caller into a balance re-read for an action that was never signed —
    // and, worse, teach it to treat a fixable input error as unresolvable.
    if (hl.code === "validation_error") {
      logger.warn(`convert.${label}.rejected_locally`, { context, error: hl });
      return { kind: "rejected_locally", error: hl };
    }
    // A rejection the server articulated is a fact: nothing converted.
    if (hl.code === "api_error") {
      logger.warn(`convert.${label}.rejected`, { context, error: hl });
      return { kind: "rejected_by_server", reason: hl.message };
    }
    // Anything else leaves a signed action that may still land. The response
    // carries no id even on success, so there is nothing to poll for — the only
    // resolution is re-reading the balances.
    logger.warn(`convert.${label}.unknown`, { context, error: hl });
    return {
      kind: "unknown",
      error: hl,
      nonce: at,
      window: { fromMs: at, toMs: at + ORDER_EXPIRY_WINDOW_MS },
    };
  }
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

/**
 * Mint `X` Yes **and** `X` No shares of one outcome from `X` quote tokens.
 *
 * Not a purchase of a view — it buys both sides, so it is directionally flat. Its
 * uses are supplying liquidity (sell one side, keep the other) and acquiring a
 * side whose book is thin, at exactly `1` rather than at whatever the spread asks.
 *
 * Costs no fee: Hyperliquid's fee table lists minting as "no one pays fee".
 */
export async function splitOutcome(
  params: Base & { outcome: OutcomeId; quoteTokens: QuoteTokenAmount }
): Promise<TransferOutcome> {
  return send(
    "split",
    params,
    { splitOutcome: { outcome: params.outcome, amount: params.quoteTokens } },
    { outcome: params.outcome, quoteTokens: params.quoteTokens }
  );
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Burn `X` Yes **and** `X` No of one outcome back into `X` quote tokens.
 *
 * Requires **both** sides. Holding only Yes, this does nothing that a caller
 * might hope — the exchange refuses rather than merging what it can.
 *
 * Unlike a split, burning is charged: the fee table gives both sides paying, at a
 * combined `1 * sz`.
 */
export async function mergeOutcome(
  params: Base & { outcome: OutcomeId; shares: ShareAmount }
): Promise<TransferOutcome> {
  return send(
    "merge_outcome",
    params,
    { mergeOutcome: { outcome: params.outcome, amount: params.shares } },
    { outcome: params.outcome, shares: params.shares }
  );
}

/**
 * Merge **every** matched pair of one outcome — the wire's `amount: null`.
 *
 * A separate function rather than an optional argument, so "all of it" can only
 * be chosen, never defaulted into. The amount is decided by the exchange at
 * execution time, so the user cannot be shown the figure before signing; a
 * caller that needs a confirmable number must pass one to {@link mergeOutcome}.
 */
export async function mergeAllOfOutcome(
  params: Base & { outcome: OutcomeId }
): Promise<TransferOutcome> {
  return send(
    "merge_outcome_max",
    params,
    { mergeOutcome: { outcome: params.outcome, amount: null } },
    { outcome: params.outcome, shares: "max" }
  );
}

/**
 * Burn `X` Yes of **every** outcome of a question into `X` quote tokens.
 *
 * Exactly one outcome of a question settles Yes, so holding one Yes of each is
 * worth precisely `1` however it resolves — this redeems that without waiting for
 * settlement.
 *
 * **Every** outcome, including the "none of the above" fallback that carries no
 * name and is invisible to anything enumerating markets by symbol. Holding Yes on
 * all but one merges nothing.
 */
export async function mergeQuestion(
  params: Base & { question: QuestionId; shares: ShareAmount }
): Promise<TransferOutcome> {
  return send(
    "merge_question",
    params,
    { mergeQuestion: { question: params.question, amount: params.shares } },
    { question: params.question, shares: params.shares }
  );
}

/** Merge every complete Yes set of a question — the wire's `amount: null`. See {@link mergeAllOfOutcome}. */
export async function mergeAllOfQuestion(
  params: Base & { question: QuestionId }
): Promise<TransferOutcome> {
  return send(
    "merge_question_max",
    params,
    { mergeQuestion: { question: params.question, amount: null } },
    { question: params.question, shares: "max" }
  );
}

// ---------------------------------------------------------------------------
// Negate
// ---------------------------------------------------------------------------

/**
 * Convert `X` No of one outcome into `X` Yes of every **other** outcome of the
 * question.
 *
 * The two are equivalent claims: "not A" is the same bet as "B or C or D" when
 * exactly one of them settles Yes. Negating is how a No position becomes
 * mergeable — pair the resulting Yes shares with a Yes of the negated outcome and
 * {@link mergeQuestion} redeems the set.
 *
 * **On a question with only one outcome, "every other outcome" is nothing.** The
 * shares would be consumed for no return. Nothing in the wire prevents it and the
 * ids alone cannot reveal it, so the count has to come from the catalog —
 * `preflight.ts` is where that check lives.
 */
export async function negateOutcome(
  params: Base & { question: QuestionId; outcome: OutcomeId; noShares: ShareAmount }
): Promise<TransferOutcome> {
  return send(
    "negate",
    params,
    {
      negateOutcome: {
        question: params.question,
        outcome: params.outcome,
        amount: params.noShares,
      },
    },
    { question: params.question, outcome: params.outcome, noShares: params.noShares }
  );
}
