/**
 * Prediction-market domain types.
 *
 * A prediction market is **spot-shaped, not perp-shaped**, and almost everything
 * below follows from that. Measured on 4 of 4 live holders: an outcome holding
 * appears in `spotClearinghouseState.balances`, never in
 * `clearinghouseState.assetPositions` — 0 perp rows against 5-20 spot rows. There
 * is no leverage, no margin table, no liquidation price and no funding; 0 of 232
 * `meta().universe` entries is an outcome, and every one of those 232 carries
 * `maxLeverage` and `marginTableId`.
 *
 * The economics are "buy a share for `p` in (0,1), receive 0 or 1" — a payoff, not
 * a mark-to-market derivative. Both sides share one book: `markPx_yes +
 * markPx_no = 1.000000` exactly on all 8 live mainnet pairs, with the two ladders
 * mirrored index-for-index and byte-identical size strings.
 */

import type { Hex } from "@/hyperliquid/types/domain";

/**
 * One tradeable side of an outcome — the thing a user actually buys.
 *
 * `sideIndex` is the low digit of the asset id. The encoding reserves ten slots
 * (`outcomeId * 10 + sideIndex`), but **every live market has exactly two**:
 * measured `sideSpecs.length === 2` on 309 of 309 outcomes across both networks.
 * The parser still accepts N rather than hard-requiring 2, because the encoding
 * plainly allows more and a future three-way market should degrade to "we can
 * see three sides", not to a thrown error on launch.
 */
export interface OutcomeSide {
  sideIndex: number;
  /** e.g. `"Yes"` / `"No"`. The only field a `sideSpec` actually carries. */
  name: string;
  assetId: number;
  /** `#<outcomeId * 10 + sideIndex>` — the only coin `l2Book` accepts. */
  wireCoin: string;
  /** `+<same>` — how this side appears as a spot balance while unsettled. */
  balanceCoin: string;
}

/**
 * Structured fields parsed out of a recurring market's `description`.
 *
 * Recurring markets encode their parameters as a pipe-delimited string, e.g.
 * `class:priceBucket|underlying:BTC|expiry:20260807-0600|priceThresholds:63571,66166|period:1d`.
 * One-off markets carry ordinary prose instead, so this is `null` for them —
 * never an empty object, which would read as "parsed, and it said nothing".
 */
export type OutcomeAttributes = Readonly<Record<string, string>> | null;

export interface PredictionOutcome {
  outcomeId: number;
  /** Verbatim. Often `"Recurring"`, and often `template:<id>` on testnet. */
  name: string;
  description: string;
  /** Parsed from `description` when it is the pipe-delimited recurring form. */
  attributes: OutcomeAttributes;
  /** e.g. `"USDC"`. What a winning share redeems into. */
  quoteToken: string;
  /**
   * The deploying venue, or `null`.
   *
   * **Undeclared by the SDK and present 185 of 309** (all on testnet, none on
   * mainnet). Deployer attribution is only reachable by joining
   * `venue -> deployers[].venue -> deployer`; the SDK's declared `deployer` field
   * is present on **0** of 309, so a client following the type shows no deployer
   * for any market.
   */
  venue: string | null;
  sides: readonly OutcomeSide[];
}

/**
 * A question groups the outcomes that resolve together.
 *
 * Exactly one named outcome resolves Yes; the rest resolve No. The catch is
 * `fallbackOutcome` — the "none of the above" market, which is a real tradeable
 * outcome that `SymbolConverter` **skips by design**, so it has no slug and is
 * invisible to any code that enumerates markets by name.
 */
export interface PredictionQuestion {
  questionId: number;
  name: string;
  description: string;
  attributes: OutcomeAttributes;
  /** The "none of the above" outcome. Tradeable, and unnamed by the SDK. */
  fallbackOutcomeId: number | null;
  namedOutcomeIds: readonly number[];
  /** Already resolved — these are gone from `outcomes` but still listed here. */
  settledNamedOutcomeIds: readonly number[];
}

/** A deployer, reachable only by joining on `venue`. Testnet-only so far. */
export interface OutcomeDeployer {
  venue: string;
  deployer: Hex;
}

/**
 * Everything `outcomeMeta` returns.
 *
 * **It lists only UNSETTLED outcomes.** A settled outcome is deleted from it —
 * verified twice: outcomes 482 and 500 return full data from `settledOutcome` and
 * are absent here, and outcome 1009 moved from one endpoint to the other within
 * five hours while this was being written. So the two endpoints are disjoint and
 * the membership boundary moves; a catalog built from this alone can never name a
 * settled market, **including the coin on the user's own settlement fill**.
 */
export interface PredictionCatalog {
  outcomes: readonly PredictionOutcome[];
  questions: readonly PredictionQuestion[];
  /** Undeclared by the SDK, absent on mainnet. */
  deployers: readonly OutcomeDeployer[];
}

/**
 * A resolved market, from `settledOutcome` — the other, disjoint source.
 *
 * The payoff is `settleFraction` for side 0 and `1 − settleFraction` for side 1,
 * which is why it is kept as a string and read through {@link payoutForSide}
 * rather than exposed as a number to be subtracted at a call site.
 */
export interface SettledOutcome {
  outcome: PredictionOutcome;
  /** Decimal string. Side 0's payout per share; observed `"1.0"` and `"0.0"`. */
  settleFraction: string;
  /** Human explanation, e.g. "FIFA declared Argentina the winner of the Game." */
  details: string;
  /** The question it resolved under, when the response carried one. */
  questionName: string | null;
}
