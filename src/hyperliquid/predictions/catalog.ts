/**
 * Reading the prediction-market catalog.
 *
 * The boundary where `outcomeMeta`'s wire shape stops. Four things it does that
 * the obvious implementation does not, each measured rather than assumed:
 *
 * 1. **It does NOT use the SDK's slug as an identity.** The SDK invents that
 *    string (`slugify(question)-slugify(outcome)-slugify(side)`); no API field
 *    carries it, and it is neither injective nor covering — on live testnet 606
 *    sides collapse to 200 distinct slugs, the worst colliding **66 ways**, and
 *    406 sides have no slug at all. The identity here is the wire coin.
 * 2. **It knows the SDK's type is wrong in three places.** `deployer?` is
 *    declared and present on 0 of 309 outcomes; `venue` is undeclared and present
 *    on 185; `sideSpec.token` is declared and present on 0 of 618 sides.
 * 3. **It expects only unsettled outcomes.** A settled one is deleted from
 *    `outcomeMeta` and appears in `settledOutcome` instead. Both endpoints are
 *    parsed here so a caller can resolve either.
 * 4. **It surfaces the fallback outcome**, which `SymbolConverter` skips. That
 *    market is real and tradeable, and code that enumerates by name never sees it.
 */

import { BigNumber } from "bignumber.js";

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { weightBudget, type WeightBudget } from "@/hyperliquid/api/weightBudget";
import { outcomeBalanceCoin, outcomeWireCoin } from "@/hyperliquid/core/assetIds";
import type { Hex } from "@/hyperliquid/types/domain";
import type {
  OutcomeAttributes,
  OutcomeDeployer,
  OutcomeSide,
  PredictionCatalog,
  PredictionOutcome,
  PredictionQuestion,
  SettledOutcome,
} from "@/hyperliquid/predictions/types";

const logger = log.child("predictions.catalog");

/** The asset-id base for the outcome range. Arithmetic lives in `core/assetIds`. */
const OUTCOME_RANGE_START = 100_000_000;
const SIDES_PER_MARKET = 10;

export interface OutcomeMetaProbe {
  outcomeMeta(): Promise<unknown>;
}

export interface SettledOutcomeProbe {
  settledOutcome(params: { outcome: number }): Promise<unknown>;
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * Parse the pipe-delimited attribute string a recurring market carries.
 *
 * `class:priceBucket|underlying:BTC|expiry:20260807-0600|period:1d` becomes a
 * record. A one-off market's description is ordinary prose, which yields `null`
 * rather than `{}` — "not this format" and "this format, empty" are different
 * answers and only one of them should render as a parameter table.
 */
export function parseOutcomeAttributes(description: string): OutcomeAttributes {
  if (!description.includes("|") || !description.includes(":")) return null;

  const entries = description.split("|").flatMap((part) => {
    const at = part.indexOf(":");
    if (at <= 0) return [];
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    return key.length > 0 ? [[key, value] as const] : [];
  });
  // A prose description containing one stray colon and pipe would otherwise
  // produce a one-entry record that looks like structured data.
  return entries.length >= 2 ? Object.freeze(Object.fromEntries(entries)) : null;
}

function parseSides(outcomeId: number, raw: unknown): OutcomeSide[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, sideIndex) => {
    if (typeof entry !== "object" || entry === null) return [];
    // The encoding reserves ten slots per outcome; beyond that the id would
    // collide with the NEXT outcome's side 0, which is a silent cross-market
    // mix-up rather than a visible error.
    if (sideIndex >= SIDES_PER_MARKET) return [];
    const assetId = OUTCOME_RANGE_START + outcomeId * SIDES_PER_MARKET + sideIndex;
    return [
      {
        sideIndex,
        name: str(entry as Record<string, unknown>, "name") ?? String(sideIndex),
        assetId,
        wireCoin: outcomeWireCoin(assetId),
        balanceCoin: outcomeBalanceCoin(assetId),
      },
    ];
  });
}

/** Parse one outcome, or `null` when it carries no usable id. */
export function parseOutcome(raw: unknown): PredictionOutcome | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const outcomeId = int(record.outcome);
  if (outcomeId === null || outcomeId < 0) return null;

  const description = str(record, "description") ?? "";
  return {
    outcomeId,
    // Verbatim. Names are display text, not identity — see the module note.
    name: str(record, "name") ?? "",
    description,
    attributes: parseOutcomeAttributes(description),
    quoteToken: str(record, "quoteToken") ?? "",
    venue: str(record, "venue"),
    sides: parseSides(outcomeId, record.sideSpecs),
  };
}

function parseQuestion(raw: unknown): PredictionQuestion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  // Live rows carry a plain number; a settled response nests it as
  // `{settled: 87}`. Both are the question's id.
  const direct = int(record.question);
  const nested =
    typeof record.question === "object" && record.question !== null
      ? int((record.question as { settled?: unknown }).settled)
      : null;
  const questionId = direct ?? nested;
  if (questionId === null) return null;

  const description = str(record, "description") ?? "";
  const ids = (value: unknown): number[] =>
    Array.isArray(value) ? value.flatMap((n) => (int(n) === null ? [] : [n as number])) : [];

  return {
    questionId,
    name: str(record, "name") ?? "",
    description,
    attributes: parseOutcomeAttributes(description),
    fallbackOutcomeId: int(record.fallbackOutcome),
    namedOutcomeIds: ids(record.namedOutcomes),
    settledNamedOutcomeIds: ids(record.settledNamedOutcomes),
  };
}

function parseDeployers(raw: unknown): OutcomeDeployer[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const venue = str(record, "venue");
    const deployer = str(record, "deployer");
    if (!venue || !deployer || !/^0x[0-9a-fA-F]{40}$/.test(deployer)) return [];
    return [{ venue, deployer: deployer.toLowerCase() as Hex }];
  });
}

/**
 * Parse an `outcomeMeta` response.
 *
 * Tolerates both the documented object (`{outcomes, questions[, deployers]}`) and
 * a bare array, because the SDK's own type and the live shape have already
 * diverged three times and a top-level change is the cheapest one to absorb.
 */
export function parseCatalog(raw: unknown): PredictionCatalog {
  if (raw === null || raw === undefined) {
    return { outcomes: [], questions: [], deployers: [] };
  }
  const source = Array.isArray(raw)
    ? { outcomes: raw, questions: [], deployers: [] }
    : typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : null;
  if (!source) {
    throw new HlError("outcomeMeta returned neither an object nor an array", {
      code: "validation_error",
    });
  }

  const outcomes = (Array.isArray(source.outcomes) ? source.outcomes : []).flatMap((entry) => {
    const parsed = parseOutcome(entry);
    return parsed ? [parsed] : [];
  });
  const questions = (Array.isArray(source.questions) ? source.questions : []).flatMap((entry) => {
    const parsed = parseQuestion(entry);
    return parsed ? [parsed] : [];
  });

  return { outcomes, questions, deployers: parseDeployers(source.deployers) };
}

export interface CatalogResult {
  /** `null` only when the weight budget refused — never for "there are none". */
  value: PredictionCatalog | null;
  deferred: boolean;
}

/** Fetch the catalog of UNSETTLED markets, through the weight budget. */
export async function fetchCatalog(params: {
  probe: OutcomeMetaProbe;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<CatalogResult> {
  const budget = params.budget ?? weightBudget;
  const at = (params.now ?? Date.now)();

  const wrapped = await budget.tryRun(
    "outcomeMeta",
    async () => ({ raw: await params.probe.outcomeMeta() }),
    { now: () => at }
  );
  if (wrapped === null) return { value: null, deferred: true };

  const value = parseCatalog(wrapped.raw);
  logger.info("predictions.catalog", {
    context: { outcomes: value.outcomes.length, questions: value.questions.length },
  });
  return { value, deferred: false };
}

/** Parse a `settledOutcome` response, or `null` when the market is not settled. */
export function parseSettledOutcome(raw: unknown): SettledOutcome | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const outcome = parseOutcome(record.spec);
  if (!outcome) return null;

  const question =
    typeof record.question === "object" && record.question !== null
      ? (record.question as Record<string, unknown>)
      : null;

  return {
    outcome,
    // A decimal string, deliberately. It is a payout per share and gets
    // subtracted from 1; doing that as a double is how a payout ends up at
    // 0.30000000000000004.
    settleFraction: str(record, "settleFraction") ?? "0",
    details: str(record, "details") ?? "",
    questionName: question ? str(question, "name") : null,
  };
}

/**
 * What one share of a side pays out, given the settlement.
 *
 * Side 0 pays `settleFraction`; every other side pays `1 − settleFraction`.
 * Exposed as a function rather than leaving the subtraction to a call site,
 * because getting it backwards reports a total loss as a full win.
 */
export function payoutForSide(settled: SettledOutcome, sideIndex: number): string {
  const fraction = new BigNumber(settled.settleFraction);
  return sideIndex === 0 ? fraction.toFixed() : new BigNumber(1).minus(fraction).toFixed();
}

/**
 * Every tradeable side in the catalog, flattened.
 *
 * The unit a market list actually renders: a user picks "Yes on Argentina", not
 * "the Argentina outcome".
 */
export function tradableSides(
  catalog: PredictionCatalog
): { outcome: PredictionOutcome; side: OutcomeSide }[] {
  return catalog.outcomes.flatMap((outcome) => outcome.sides.map((side) => ({ outcome, side })));
}

/** Find a side by its wire coin — the identity every live feed echoes. */
export function sideByWireCoin(
  catalog: PredictionCatalog,
  wireCoin: string
): { outcome: PredictionOutcome; side: OutcomeSide } | null {
  return tradableSides(catalog).find((entry) => entry.side.wireCoin === wireCoin) ?? null;
}

/**
 * Outcomes a question covers that the catalog cannot name.
 *
 * The fallback outcome is tradeable and has no slug, so anything enumerating by
 * name misses it entirely; a settled outcome has been deleted from `outcomes`
 * outright. Both are reported here so a caller can decide to fetch them rather
 * than silently rendering a partial question.
 */
export function unlistedOutcomeIds(catalog: PredictionCatalog): number[] {
  const listed = new Set(catalog.outcomes.map((outcome) => outcome.outcomeId));
  const referenced = catalog.questions.flatMap((question) => [
    ...(question.fallbackOutcomeId === null ? [] : [question.fallbackOutcomeId]),
    ...question.namedOutcomeIds,
    ...question.settledNamedOutcomeIds,
  ]);
  return [...new Set(referenced)].filter((id) => !listed.has(id)).sort((a, b) => a - b);
}
