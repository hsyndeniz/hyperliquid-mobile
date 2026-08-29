/**
 * The contract for a prediction-market conversion.
 *
 * Same shape as `vaults/preflight.ts` — quote, echo, unforgeable ticket — because
 * the risk is the same: a signature that cannot be recalled. What differs is the
 * mistake being defended against.
 *
 * A vault deposit's hazard is picking the wrong row from a list. A conversion's
 * hazard is that **the preconditions are invisible from the identifiers alone**.
 * Nothing in `outcome: 1017, amount: "50"` reveals that the account holds no No
 * shares, that the question has one outcome so a negate returns nothing, or that
 * the outcome settled last night. The wire refuses some of those and silently
 * accepts others; this is where they become sentences.
 *
 * Four facts drive the checks, each measured:
 *
 * 1. **A merge burns a PAIR.** The mergeable quantity is `min(side0, side1)`, not
 *    either balance — so an account holding 6,923 Yes and 0 No can merge nothing,
 *    while both numbers look healthy on a portfolio screen.
 * 2. **Side 0 is the Yes side, by index and not by name.** Measured across both
 *    networks: `sideSpecs[0].name` is `"Yes"` on mainnet and `"template:Yes"` on
 *    testnet. The name is data; the index is the contract.
 * 3. **A question's outcome set includes an unnamed one.** `fallbackOutcome` — the
 *    "none of the above" market — is tradeable, carries no slug, and is skipped by
 *    the SDK's symbol converter. `mergeQuestion` needs Yes shares of it too, so a
 *    client that enumerates markets by name computes a complete set that is short
 *    by one and merges nothing.
 * 4. **An outcome does not know its question.** Outcome rows carry no `question`
 *    field at all; only questions list their outcomes. And the mapping is partial:
 *    on the recorded mainnet catalog **4 of 8 outcomes belong to no listed
 *    question**, including 1017 — the one the recorded live holder actually owns.
 *    So "which question is this outcome in" is a reverse scan that legitimately
 *    answers *nothing*, and `negateOutcome`, which needs both ids, must say so
 *    rather than guess.
 *
 * What this deliberately does **not** do is price anything. A conversion has no
 * book and no slippage — one quote token is always one Yes plus one No — so there
 * is no execution estimate to get wrong.
 */

import { BigNumber } from "bignumber.js";

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import type { OutcomeHolding, OutcomeHoldings } from "@/hyperliquid/predictions/holdings";
import type { PredictionCatalog, PredictionOutcome } from "@/hyperliquid/predictions/types";
import type { OutcomeId, QuestionId, ShareAmount } from "@/hyperliquid/predictions/convert";
import { isWholeShares } from "@/hyperliquid/predictions/convert";

const logger = log.child("predictions.preflight");

/** How long a quote's facts may be considered current. */
export const CONVERT_QUOTE_TTL_MS = 60_000;

/**
 * The Yes side's index.
 *
 * Named because `sides[0]` at a call site reads like an arbitrary choice. It is
 * not: settlement pays side 0 the `settleFraction`, `mergeQuestion` consumes side
 * 0 of every outcome, and `negateOutcome` produces side 0 of the others.
 */
export const YES_SIDE = 0;
/** The No side's index. `negateOutcome` consumes this one. */
export const NO_SIDE = 1;

export type ConvertKind = "split" | "merge_outcome" | "merge_question" | "negate";

export type ConvertBlockerCode =
  /** Not in `outcomeMeta` — settled, or from another network. */
  | "outcome_not_listed"
  | "question_not_listed"
  /** No listed question contains this outcome, so `negateOutcome` has no question id. */
  | "question_unknown_for_outcome"
  | "insufficient_quote_tokens"
  /** A merge burns a pair; the shortfall is on whichever side holds less. */
  | "insufficient_pair"
  /** `mergeQuestion` needs side 0 of EVERY outcome, including the unnamed one. */
  | "incomplete_yes_set"
  | "insufficient_no_shares"
  /** A question with one outcome has no "every other outcome" to negate into. */
  | "nothing_to_negate_into";

export type ConvertWarningCode =
  /** A maximum: the exchange decides the figure, so none can be shown before signing. */
  | "amount_decided_by_exchange"
  /** Every observed quantity is whole; a fraction is untested, not known-refused. */
  | "fractional_shares_untested"
  /** No routing exists, and an agent signature resolves to the master. */
  | "acts_on_master_account"
  /** Balances were unavailable, so none of the sufficiency checks ran. */
  | "holdings_not_checked"
  /** The set includes the unnamed "none of the above" outcome. */
  | "question_includes_unnamed_outcome"
  /** Burning is charged; minting is not. */
  | "burn_is_charged"
  /** A split takes both sides at once — it expresses no view on the result. */
  | "split_buys_both_sides";

export interface ConvertBlocker {
  code: ConvertBlockerCode;
  detail: string;
}

export interface ConvertWarning {
  code: ConvertWarningCode;
  detail: string;
}

/** What the user is being asked to confirm, in the terms they will see it. */
export interface ConvertSubject {
  /** The id the wire takes — never the encoding, never the asset id. */
  readonly outcomeId: number | null;
  readonly questionId: number | null;
  /** Verbatim from the catalog, or `null` when the market is not listed. */
  readonly name: string | null;
}

export interface ConvertQuote {
  /** A correctness join over every field below, not a secret. */
  readonly token: string;
  readonly kind: ConvertKind;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly subject: ConvertSubject;
  /**
   * The amount, or `null` for a maximum.
   *
   * `null` is why `amount_decided_by_exchange` exists: there is no figure to
   * display, so the user is agreeing to a quantity nobody knows yet.
   */
  readonly amount: string | null;
  /** What the account could convert right now, when balances were available. */
  readonly available: string | null;
  readonly blockers: readonly ConvertBlocker[];
  readonly warnings: readonly ConvertWarning[];
}

/** What the caller must send back to proceed. Every field is re-derived. */
export interface ConvertEcho {
  readonly token: string;
  /**
   * The verb the caller rendered.
   *
   * Split and merge are exact opposites, so a UI that labelled the button wrong
   * fails here rather than converting in the direction nobody chose.
   */
  readonly kindDisplayed: ConvertKind;
  /** The identifier the caller SHOWED — the defence against the three-integer trap. */
  readonly outcomeIdDisplayed: number | null;
  readonly questionIdDisplayed: number | null;
  readonly amountDisplayed: string | null;
  /** Must contain every code in `quote.warnings`. A superset is fine. */
  readonly acknowledged: readonly ConvertWarningCode[];
}

declare const ConvertTicketBrand: unique symbol;

/** Proof that a quote was built, displayed and confirmed. */
export interface ConvertTicket {
  readonly [ConvertTicketBrand]: true;
  readonly quote: ConvertQuote;
  readonly confirmedAt: number;
}

// ---------------------------------------------------------------------------
// Catalog joins
// ---------------------------------------------------------------------------

/** Every outcome a question settles together, the unnamed fallback included. */
export function outcomeIdsOfQuestion(catalog: PredictionCatalog, questionId: number): number[] {
  const question = catalog.questions.find((q) => q.questionId === questionId);
  if (!question) return [];
  const ids = [...question.namedOutcomeIds];
  if (question.fallbackOutcomeId !== null) ids.push(question.fallbackOutcomeId);
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * The question an outcome belongs to, by reverse scan.
 *
 * Returns `null` when no listed question contains it, which is a **real and
 * common answer** rather than a lookup failure: 4 of 8 outcomes on the recorded
 * mainnet catalog are in no question, including the one the recorded holder owns.
 * Outcome rows carry no `question` field, so there is no other direction to try.
 */
export function questionForOutcome(catalog: PredictionCatalog, outcomeId: number): number | null {
  for (const question of catalog.questions) {
    if (
      question.fallbackOutcomeId === outcomeId ||
      question.namedOutcomeIds.includes(outcomeId) ||
      question.settledNamedOutcomeIds.includes(outcomeId)
    ) {
      return question.questionId;
    }
  }
  return null;
}

function outcomeIn(catalog: PredictionCatalog, outcomeId: number): PredictionOutcome | null {
  return catalog.outcomes.find((o) => o.outcomeId === outcomeId) ?? null;
}

// ---------------------------------------------------------------------------
// Balance arithmetic
// ---------------------------------------------------------------------------

/**
 * Shares of one side that are actually CONVERTIBLE — total minus held.
 *
 * `OutcomeHolding.shares` is the wire's `total`, and `held` is documented as
 * "shares locked in resting orders, and therefore not sellable right now" — a
 * portion OF that total, parsed and named and, until this, read by nothing.
 * Every consumer here (`mergeablePair`, `completeYesSets`, the merge and
 * negate gates) is asking what can be converted, and a share backing a resting
 * order cannot be: hold 100 Yes and 100 No with 60 No resting and the sheet
 * would offer to merge 100, no blocker would fire, a ticket would be issued,
 * and the exchange would refuse — opaquely, since `convert.ts` records that the
 * response is a bare `{status:"ok"}` with no echo.
 *
 * The recorded mainnet fixture carries `{"coin":"+10171","total":"8548.0",
 * "hold":"93.0"}` — real locked outcome shares — while every test row here
 * hardcoded `hold: "0.0"`, so the path was untested rather than covered.
 *
 * Floored at zero: `total - held` is non-negative by construction, and a
 * negative would silently invert a `min()` if the wire ever disagreed.
 *
 * This is the same rule the spot mover follows (`available`, never `total`) and
 * the same mistake, in a second place.
 */
function sharesOf(holdings: OutcomeHoldings, outcomeId: number, sideIndex: number): BigNumber {
  const row = holdings.unsettled.find(
    (h: OutcomeHolding) => h.outcomeId === outcomeId && h.sideIndex === sideIndex
  );
  if (!row) return new BigNumber(0);
  return BigNumber.max(0, new BigNumber(row.shares).minus(row.held || 0));
}

/**
 * How much of an outcome could be merged: `min(side0, side1)`.
 *
 * The number a merge screen must show. Displaying either balance alone tells a
 * user holding 6,923 Yes and 0 No that they can merge 6,923.
 */
export function mergeablePair(holdings: OutcomeHoldings, outcomeId: OutcomeId): string {
  return BigNumber.min(
    sharesOf(holdings, outcomeId, YES_SIDE),
    sharesOf(holdings, outcomeId, NO_SIDE)
  ).toFixed();
}

/**
 * How many complete Yes sets of a question are held — the minimum across
 * **every** outcome, unnamed fallback included.
 *
 * Zero when the question lists no outcomes, because a set of nothing is not a
 * set: returning `Infinity` from an empty minimum would report an unlimited
 * merge on a question the catalog knows nothing about.
 */
export function completeYesSets(
  catalog: PredictionCatalog,
  holdings: OutcomeHoldings,
  questionId: QuestionId
): string {
  const ids = outcomeIdsOfQuestion(catalog, questionId);
  if (ids.length === 0) return "0";
  return BigNumber.min(...ids.map((id) => sharesOf(holdings, id, YES_SIDE))).toFixed();
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

function token(quote: Omit<ConvertQuote, "token">): string {
  const material = JSON.stringify([
    quote.kind,
    quote.issuedAt,
    quote.subject,
    quote.amount,
    quote.available,
    quote.blockers.map((b) => b.code),
    quote.warnings.map((w) => w.code),
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `cq_${hash.toString(16).padStart(8, "0")}`;
}

function finish(quote: Omit<ConvertQuote, "token">): ConvertQuote {
  return { ...quote, token: token(quote) };
}

/**
 * Warnings every conversion carries, whatever the direction.
 *
 * @param balancesChecked whether the caller supplied what the sufficiency check
 *   needs — holdings for a merge or negate, a quote-token balance for a split.
 */
function universal(amount: string | null, balancesChecked: boolean): ConvertWarning[] {
  const warnings: ConvertWarning[] = [
    {
      code: "acts_on_master_account",
      detail:
        "This acts on the main account. Outcome conversions cannot be routed to a sub-account.",
    },
  ];
  if (amount === null) {
    warnings.push({
      code: "amount_decided_by_exchange",
      detail: "The exchange decides the quantity when this runs, so no figure can be shown first.",
    });
  } else if (!isWholeShares(amount as ShareAmount)) {
    warnings.push({
      code: "fractional_shares_untested",
      detail: "Every observed quantity is a whole share; a fraction may be refused.",
    });
  }
  if (!balancesChecked) {
    // "We could not check" must never render as "checked and clean".
    warnings.push({
      code: "holdings_not_checked",
      detail: "Balances were unavailable, so the amount was not checked against what you hold.",
    });
  }
  return warnings;
}

export interface SplitQuoteParams {
  catalog: PredictionCatalog;
  outcome: OutcomeId;
  /** Quote tokens to split. Whole quote tokens become whole shares of each side. */
  quoteTokens: string;
  /** Spendable quote-token balance. Omit and the sufficiency check does not run. */
  availableQuoteTokens?: string;
  now?: () => number;
}

/** Quote a split: `X` quote tokens into `X` of each side. */
export function buildSplitQuote(params: SplitQuoteParams): ConvertQuote {
  const now = (params.now ?? Date.now)();
  const blockers: ConvertBlocker[] = [];
  const outcome = outcomeIn(params.catalog, params.outcome);
  const warnings: ConvertWarning[] = universal(
    params.quoteTokens,
    params.availableQuoteTokens !== undefined
  );

  if (!outcome) {
    blockers.push({
      code: "outcome_not_listed",
      detail: "This market is not in the catalog. It may have already settled.",
    });
  }
  if (
    params.availableQuoteTokens !== undefined &&
    new BigNumber(params.quoteTokens).gt(params.availableQuoteTokens)
  ) {
    blockers.push({
      code: "insufficient_quote_tokens",
      detail: `Only ${params.availableQuoteTokens} available.`,
    });
  }

  warnings.push({
    code: "split_buys_both_sides",
    detail: "This buys both sides at once, so it takes no view on the result.",
  });

  return finish({
    kind: "split",
    issuedAt: now,
    expiresAt: now + CONVERT_QUOTE_TTL_MS,
    subject: {
      outcomeId: params.outcome,
      questionId: questionForOutcome(params.catalog, params.outcome),
      name: outcome?.name ?? null,
    },
    amount: params.quoteTokens,
    available: params.availableQuoteTokens ?? null,
    blockers,
    warnings,
  });
}

export interface MergeOutcomeQuoteParams {
  catalog: PredictionCatalog;
  outcome: OutcomeId;
  /** Shares of each side to burn, or `null` for the maximum. */
  shares: string | null;
  /** Omit and the pair check does not run. */
  holdings?: OutcomeHoldings;
  now?: () => number;
}

/** Quote a merge of one outcome: `X` of each side back into `X` quote tokens. */
export function buildMergeOutcomeQuote(params: MergeOutcomeQuoteParams): ConvertQuote {
  const now = (params.now ?? Date.now)();
  const blockers: ConvertBlocker[] = [];
  const warnings = universal(params.shares, params.holdings !== undefined);
  const outcome = outcomeIn(params.catalog, params.outcome);

  if (!outcome) {
    blockers.push({
      code: "outcome_not_listed",
      detail: "This market is not in the catalog. It may have already settled.",
    });
  }

  const available = params.holdings ? mergeablePair(params.holdings, params.outcome) : null;
  if (available !== null && params.shares !== null && new BigNumber(params.shares).gt(available)) {
    // Names the pair, not a balance: the user is almost certainly looking at the
    // larger side and cannot see why the smaller one is the limit.
    blockers.push({
      code: "insufficient_pair",
      detail: `A merge burns one of each side, so only ${available} can be merged.`,
    });
  }
  if (available !== null && new BigNumber(available).isZero()) {
    blockers.push({
      code: "insufficient_pair",
      detail: "You hold only one side of this market, so there is no pair to merge.",
    });
  }

  warnings.push({
    code: "burn_is_charged",
    detail: "Merging is charged a fee; splitting is not.",
  });

  return finish({
    kind: "merge_outcome",
    issuedAt: now,
    expiresAt: now + CONVERT_QUOTE_TTL_MS,
    subject: {
      outcomeId: params.outcome,
      questionId: questionForOutcome(params.catalog, params.outcome),
      name: outcome?.name ?? null,
    },
    amount: params.shares,
    available,
    blockers,
    warnings,
  });
}

export interface MergeQuestionQuoteParams {
  catalog: PredictionCatalog;
  question: QuestionId;
  /** Complete Yes sets to burn, or `null` for the maximum. */
  shares: string | null;
  holdings?: OutcomeHoldings;
  now?: () => number;
}

/** Quote a merge of a whole question: `X` Yes of every outcome into `X` quote tokens. */
export function buildMergeQuestionQuote(params: MergeQuestionQuoteParams): ConvertQuote {
  const now = (params.now ?? Date.now)();
  const blockers: ConvertBlocker[] = [];
  const warnings = universal(params.shares, params.holdings !== undefined);

  const question = params.catalog.questions.find((q) => q.questionId === params.question);
  const ids = outcomeIdsOfQuestion(params.catalog, params.question);

  if (!question) {
    blockers.push({
      code: "question_not_listed",
      detail: "This question is not in the catalog. It may have already settled.",
    });
  } else if (question.fallbackOutcomeId !== null) {
    warnings.push({
      code: "question_includes_unnamed_outcome",
      detail:
        "This question has a 'none of the above' outcome with no name. A complete set includes it.",
    });
  }

  const available = params.holdings
    ? completeYesSets(params.catalog, params.holdings, params.question)
    : null;
  if (available !== null && params.shares !== null && new BigNumber(params.shares).gt(available)) {
    const short = ids.filter((id) =>
      sharesOf(params.holdings!, id, YES_SIDE).lt(params.shares ?? 0)
    );
    // Numeric, not `available === "0"`. Every wire zero is spelled "0.0", so a
    // string comparison silently never fires — the failure this module's own
    // structural guard exists to catch, and it caught this line.
    const none = new BigNumber(available).isZero();
    blockers.push({
      code: "incomplete_yes_set",
      detail: none
        ? `A complete set needs Yes shares of all ${ids.length} outcomes; ${short.length} are short.`
        : `Only ${available} complete sets are held.`,
    });
  }

  warnings.push({
    code: "burn_is_charged",
    detail: "Merging is charged a fee; splitting is not.",
  });

  return finish({
    kind: "merge_question",
    issuedAt: now,
    expiresAt: now + CONVERT_QUOTE_TTL_MS,
    subject: {
      outcomeId: null,
      questionId: params.question,
      name: question?.name ?? null,
    },
    amount: params.shares,
    available,
    blockers,
    warnings,
  });
}

export interface NegateQuoteParams {
  catalog: PredictionCatalog;
  outcome: OutcomeId;
  /**
   * The question the outcome sits in.
   *
   * Optional because the catalog can supply it — but only sometimes: 4 of 8
   * mainnet outcomes are in no listed question. When neither this nor the catalog
   * has one, the quote blocks rather than inventing an id.
   */
  question?: QuestionId;
  /** No shares to negate. */
  noShares: string;
  holdings?: OutcomeHoldings;
  now?: () => number;
}

/**
 * Quote a negate: `X` No of one outcome into `X` Yes of every **other** outcome.
 *
 * Blocks when there is no other outcome to negate into. Nothing on the wire
 * prevents that call, and the shares would be consumed for no return.
 */
export function buildNegateQuote(params: NegateQuoteParams): ConvertQuote {
  const now = (params.now ?? Date.now)();
  const blockers: ConvertBlocker[] = [];
  const warnings = universal(params.noShares, params.holdings !== undefined);
  const outcome = outcomeIn(params.catalog, params.outcome);

  if (!outcome) {
    blockers.push({
      code: "outcome_not_listed",
      detail: "This market is not in the catalog. It may have already settled.",
    });
  }

  const questionId = params.question ?? questionForOutcome(params.catalog, params.outcome);
  if (questionId === null) {
    blockers.push({
      code: "question_unknown_for_outcome",
      detail:
        "No listed question contains this market, and negating requires one. " +
        "Outcomes carry no question of their own.",
    });
  } else {
    const siblings = outcomeIdsOfQuestion(params.catalog, questionId).filter(
      (id) => id !== params.outcome
    );
    if (siblings.length === 0) {
      blockers.push({
        code: "nothing_to_negate_into",
        detail: "This question has no other outcome, so negating would return nothing.",
      });
    }
  }

  const available = params.holdings
    ? sharesOf(params.holdings, params.outcome, NO_SIDE).toFixed()
    : null;
  if (available !== null && new BigNumber(params.noShares).gt(available)) {
    blockers.push({
      code: "insufficient_no_shares",
      detail: `You hold ${available} No shares of this market.`,
    });
  }

  return finish({
    kind: "negate",
    issuedAt: now,
    expiresAt: now + CONVERT_QUOTE_TTL_MS,
    subject: {
      outcomeId: params.outcome,
      questionId,
      name: outcome?.name ?? null,
    },
    amount: params.noShares,
    available,
    blockers,
    warnings,
  });
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

function refuse(code: ConvertBlockerCode | "echo_mismatch", detail: string): never {
  throw new HlError(`Refused: ${detail}`, {
    code: "not_authorized",
    context: { reason: code },
  });
}

/**
 * Turn a displayed quote into a ticket.
 *
 * The only producer of `ConvertTicket`. Throws rather than returning a result: a
 * caller that ignores a returned error still holds a quote and might proceed.
 */
export function confirmConversion(
  quote: ConvertQuote,
  echo: ConvertEcho,
  now: number = Date.now()
): ConvertTicket {
  if (quote.blockers.length > 0) {
    refuse(quote.blockers[0].code, quote.blockers.map((b) => b.detail).join(" "));
  }
  if (now > quote.expiresAt) {
    refuse("echo_mismatch", "the quote has expired; re-read your balances and try again.");
  }
  if (echo.token !== quote.token) {
    refuse("echo_mismatch", "the confirmation does not match the quote it was built from.");
  }
  if (echo.kindDisplayed !== quote.kind) {
    // Split and merge are exact opposites. A mislabelled button dies here.
    refuse("echo_mismatch", "the displayed action does not match the quoted one.");
  }
  if (echo.outcomeIdDisplayed !== quote.subject.outcomeId) {
    refuse("echo_mismatch", "the displayed market does not match the quoted one.");
  }
  if (echo.questionIdDisplayed !== quote.subject.questionId) {
    refuse("echo_mismatch", "the displayed question does not match the quoted one.");
  }
  if (echo.amountDisplayed !== quote.amount) {
    refuse("echo_mismatch", "the displayed amount does not match the quoted one.");
  }

  const acknowledged = new Set(echo.acknowledged);
  const missing = quote.warnings.filter((w) => !acknowledged.has(w.code));
  if (missing.length > 0) {
    refuse("echo_mismatch", `unacknowledged warnings: ${missing.map((w) => w.code).join(", ")}.`);
  }

  logger.info("convert.confirmed", {
    context: {
      kind: quote.kind,
      outcomeId: quote.subject.outcomeId,
      questionId: quote.subject.questionId,
      amount: quote.amount,
      warnings: quote.warnings.length,
    },
  });

  return { quote, confirmedAt: now } as ConvertTicket;
}

/** Whether a quote could be confirmed as it stands. */
export function isConfirmable(quote: ConvertQuote, now: number = Date.now()): boolean {
  return quote.blockers.length === 0 && now <= quote.expiresAt;
}
