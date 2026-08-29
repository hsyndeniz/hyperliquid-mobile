/**
 * A user's prediction-market holdings.
 *
 * **They are spot balances, not positions.** Measured on 4 of 4 live holders:
 * `clearinghouseState.assetPositions` contained 0 outcome rows while
 * `spotClearinghouseState.balances` contained 5 to 20. `state/accountWire.ts`
 * parses the former, so it is not wrong about prediction markets — it cannot see
 * them at all, and no amount of fixing it would help.
 *
 * Three row shapes share that one array, and telling them apart matters:
 *
 * | Row                                                  | Meaning                        |
 * | ---------------------------------------------------- | ------------------------------ |
 * | `{coin:"USDC", token:0, total, hold, entryNtl}`       | ordinary spot                  |
 * | `{coin:"+10170", total:"6923.0", entryNtl:"3535.56"}` | live shares, unsettled         |
 * | `{coin:"o498", total, hold, entryNtl}`                | shares of a SETTLED outcome    |
 *
 * The outcome rows carry **no `token` field**, and the `o` form's number is the
 * **outcome id, not the `outcomeId * 10 + sideIndex` encoding** — `o482` is
 * outcome 482, which `settledOutcome(482)` resolves to "Argentina". Reading it as
 * an encoding gives outcome 48, side 2, and side 2 does not exist.
 */

import { BigNumber } from "bignumber.js";

import { log } from "@/hyperliquid/core/logger";
import {
  decomposeAssetId,
  outcomeWireCoin,
  settledOutcomeIdFromBalanceCoin,
} from "@/hyperliquid/core/assetIds";
import type { SpotBalance } from "@/hyperliquid/types/domain";

const logger = log.child("predictions.holdings");

const OUTCOME_RANGE_START = 100_000_000;

/** A live holding in an unsettled outcome. */
export interface OutcomeHolding {
  assetId: number;
  outcomeId: number;
  sideIndex: number;
  /** `#N` — for the book, candles and trades. */
  wireCoin: string;
  /** `+N` — the balance row this came from. */
  balanceCoin: string;
  /**
   * Shares held, as a decimal string.
   *
   * Always an integer **value** — 197 of 197 live book levels and 16 of 16
   * balance rows — but the wire renders it `"6923.0"`, and a closed position
   * renders `"0.0"`. So `shares === "0"` never fires; compare with BigNumber, or
   * use {@link nonZero}.
   */
  shares: string;
  /** Shares locked in resting orders, and therefore not sellable right now. */
  held: string;
  /**
   * Total USDC paid for the position — the wire's `entryNtl`.
   *
   * A **cost basis**, not a current value. Observed `entryNtl:"3535.56496788"`
   * against `total:"6923.0"`, i.e. an average of about $0.5107 a share.
   */
  costBasis: string;
}

/**
 * Shares of an outcome that has already resolved.
 *
 * Still in the balance list, and still worth showing: this is what the user is
 * owed, or what they lost. `settledOutcome(outcomeId)` says which.
 *
 * **The side is not recoverable from this row.** `o482` names the outcome and
 * nothing more, so which side was held has to come from the settlement or from
 * the user's fills — a client must not guess it.
 */
export interface SettledHolding {
  outcomeId: number;
  balanceCoin: string;
  shares: string;
  held: string;
  costBasis: string;
}

export interface OutcomeHoldings {
  unsettled: readonly OutcomeHolding[];
  settled: readonly SettledHolding[];
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "0";
}

/** The market a balance coin names, or `null` when it names no prediction market. */
type DecodedCoin =
  | { kind: "unsettled"; assetId: number; outcomeId: number; sideIndex: number; wireCoin: string }
  | { kind: "settled"; outcomeId: number };

/**
 * Decode a balance coin.
 *
 * The one place the `+`/`o` prefixes are read. Shared by the wire parser and by
 * {@link outcomeHoldingsOf}, which sees the same rows after the spot store has
 * renamed their fields — two readers, one decoder, so they cannot drift.
 */
function decodeBalanceCoin(coin: string): DecodedCoin | null {
  const liveMatch = /^\+(\d+)$/.exec(coin);
  if (liveMatch) {
    const assetId = OUTCOME_RANGE_START + Number(liveMatch[1]);
    const decoded = decomposeAssetId(assetId);
    if (decoded.kind !== "outcome") return null;
    return {
      kind: "unsettled",
      assetId,
      outcomeId: decoded.outcomeId,
      sideIndex: decoded.sideIndex,
      wireCoin: outcomeWireCoin(assetId),
    };
  }
  const settledId = settledOutcomeIdFromBalanceCoin(coin);
  return settledId === undefined ? null : { kind: "settled", outcomeId: settledId };
}

function collect(
  rows: readonly { coin: string; shares: string; held: string; costBasis: string }[]
): OutcomeHoldings {
  const unsettled: OutcomeHolding[] = [];
  const settled: SettledHolding[] = [];

  for (const row of rows) {
    const decoded = decodeBalanceCoin(row.coin);
    if (!decoded) continue;
    if (decoded.kind === "unsettled") {
      unsettled.push({
        assetId: decoded.assetId,
        outcomeId: decoded.outcomeId,
        sideIndex: decoded.sideIndex,
        wireCoin: decoded.wireCoin,
        balanceCoin: row.coin,
        shares: row.shares,
        held: row.held,
        costBasis: row.costBasis,
      });
    } else {
      settled.push({
        outcomeId: decoded.outcomeId,
        balanceCoin: row.coin,
        shares: row.shares,
        held: row.held,
        costBasis: row.costBasis,
      });
    }
  }

  return { unsettled, settled };
}

/**
 * Split a `spotClearinghouseState.balances` array into its three row kinds.
 *
 * Ordinary spot rows are dropped: this module is about prediction markets, and
 * the spot store already owns the rest.
 */
export function parseOutcomeHoldings(balances: unknown): OutcomeHoldings {
  if (!Array.isArray(balances)) return { unsettled: [], settled: [] };

  const rows: { coin: string; shares: string; held: string; costBasis: string }[] = [];
  for (const entry of balances) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.coin !== "string" || row.coin.length === 0) continue;
    rows.push({
      coin: row.coin,
      shares: str(row, "total"),
      held: str(row, "hold"),
      costBasis: str(row, "entryNtl"),
    });
  }
  return collect(rows);
}

/**
 * The same holdings, read from the **live spot store** instead of a fresh call.
 *
 * This is the path a subscribed client should use. `spotState` is one of the
 * channels a session already opens, it carries the identical balance array, and
 * it pushes on every change — so polling {@link fetchOutcomeHoldings} beside it
 * spends weight to learn something the socket already delivered.
 *
 * The store renames the wire's fields on the way in (`entryNtl` becomes
 * `costBasisNtl`, and `available` is derived), which is why this exists rather
 * than handing `store.read()!.balances` to the parser: that call type-checks
 * against `unknown` and silently yields zero for every quantity.
 */
export function outcomeHoldingsOf(
  state: { balances: readonly SpotBalance[] } | null
): OutcomeHoldings {
  if (!state) return { unsettled: [], settled: [] };
  return collect(
    state.balances.map((balance) => ({
      coin: balance.coin,
      shares: balance.total,
      held: balance.hold,
      costBasis: balance.costBasisNtl,
    }))
  );
}

/** Only the rows the user actually holds. Zero rows persist long after a position closes. */
export function nonZero<T extends { shares: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => new BigNumber(row.shares).gt(0));
}

/**
 * Average price paid per share, or `null` when there are no shares.
 *
 * `null` rather than zero: a zero average reads as "bought at nothing", which is
 * a free position rather than no position.
 *
 * Safe to compute here — both terms come off the wire, so this derives no
 * price-dependent number. Anything needing a *current* value must take a price
 * from the book, and that stays out of this module for the same reason
 * `state/accountWire.ts` refuses to recompute `unrealizedPnl`.
 */
export function averageEntryPrice(holding: { shares: string; costBasis: string }): string | null {
  const shares = new BigNumber(holding.shares);
  if (!shares.gt(0)) return null;
  return new BigNumber(holding.costBasis).dividedBy(shares).toFixed();
}

/** Total USDC paid across every unsettled holding. */
export function totalCostBasis(holdings: readonly { costBasis: string }[]): string {
  return holdings
    .reduce((total, holding) => total.plus(holding.costBasis), new BigNumber(0))
    .toFixed();
}

/** Find a holding by the wire coin every live feed echoes. */
export function holdingByWireCoin(
  holdings: OutcomeHoldings,
  wireCoin: string
): OutcomeHolding | null {
  return holdings.unsettled.find((holding) => holding.wireCoin === wireCoin) ?? null;
}

export interface SpotStateProbe {
  spotClearinghouseState(params: { user: string }): Promise<unknown>;
}

/**
 * Read a user's prediction holdings.
 *
 * Deliberately its own call rather than a field on the account store: the store
 * is fed by the `spotState` websocket channel, which carries the same balances —
 * so once a caller is subscribed it should parse from there instead of polling
 * this. This exists for the one-shot case.
 */
export async function fetchOutcomeHoldings(params: {
  probe: SpotStateProbe;
  user: string;
}): Promise<OutcomeHoldings> {
  const raw = (await params.probe.spotClearinghouseState({ user: params.user })) as {
    balances?: unknown;
  } | null;
  const holdings = parseOutcomeHoldings(raw?.balances);
  logger.info("predictions.holdings", {
    context: {
      unsettled: nonZero(holdings.unsettled).length,
      settled: nonZero(holdings.settled).length,
    },
  });
  return holdings;
}
