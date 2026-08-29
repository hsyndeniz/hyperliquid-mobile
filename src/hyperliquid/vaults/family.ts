/**
 * What a vault family actually holds.
 *
 * A **parent vault holds nothing itself.** Measured on mainnet HLP: the parent
 * address reports `assetPositions: []` and $48.2M of account value, while its
 * seven child strategies hold the positions and the rest of the money. Reading
 * the parent alone and rendering "no positions" would be the most confident
 * lie this screen could tell — the vault has 175 coins on the book. Summed
 * across parent + children the family came to $87,218,835, which matches what
 * the official app shows for the same vault to the dollar.
 *
 * So a position view has to aggregate the family. The subtlety is that
 * aggregation is only honest for *some* fields:
 *
 * **The children run against each other.** Of the 175 coins both active HLP
 * children hold, **171 are held in opposite directions** — child 1 is short
 * 0.084 BTC at 63,132.8 while child 4 is long 0.117 BTC at 63,119.1. That is
 * market making, not a mistake, and it means:
 *
 * - Net size, unrealized PnL, entry NOTIONAL and gross notional are additive
 *   and stay exactly true (`entryNotional` is a subtraction, never a division —
 *   see `Position.entryNotional`).
 * - An **entry price** across a long and a short is not the entry price of
 *   anything. `entryNotional / netSize` there divides a sum of opposing costs
 *   by a near-cancelled size and prints a number in the millions. Refused.
 * - A **liquidation price** is per-leg. Two legs have two of them (and one of
 *   HLP's is `null` outright), so any single value is invented. Refused
 *   whenever more than one leg contributes.
 * - **Margin used** is a different quantity in cross and isolated mode — the
 *   domain type says summing across modes mixes them — so a family holding one
 *   coin in both modes reports `null` rather than a blended figure.
 *
 * Refusing is cheap here: the row still carries size, PnL and exposure, which
 * is what the question "what is this vault holding" actually wants.
 */

import { BigNumber } from "bignumber.js";

import { weightBudget, type WeightBudget } from "@/hyperliquid/api/weightBudget";
import { log } from "@/hyperliquid/core/logger";
import { toBigNumber } from "@/hyperliquid/core/precision";
import { parseClearinghouseState, positionSideOf } from "@/hyperliquid/state/accountWire";
import type { Hex, MarginMode, Position, PositionSide } from "@/hyperliquid/types/domain";
import type { VaultDetail } from "@/hyperliquid/vaults/types";

const logger = log.child("vaults.family");

/** One family member's snapshot, tagged with whose it is. */
export interface FamilyMember {
  address: Hex;
  positions: readonly Position[];
  /** `marginSummary.accountValue` — the member's share of the family's money. */
  accountValue: string;
  /**
   * The server's own withdrawable figure, NEVER derived.
   *
   * `accountValue - totalMarginUsed` was measured at $67,004 where the API
   * said $12.75, because resting-order reservations are in neither term.
   */
  withdrawable: string;
}

export interface FamilyPosition {
  coin: string;
  /** Sum of every leg's `signedSize`: the family's NET exposure. */
  netSignedSize: string;
  /** `|netSignedSize|`. */
  netSize: string;
  /** Direction of the NET. Meaningless to read per-leg — see `legs`. */
  side: PositionSide;
  /** True when the net cancels to exactly zero — real margin, no exposure. */
  isFlat: boolean;
  /** Sum of `|szi| × mark` over legs. GROSS: both sides of a hedge count. */
  grossNotional: string;
  /** Sum. Exact — the wire computes it, we never recompute from entry price. */
  unrealizedPnl: string;
  /** Sum of exact cost bases. */
  entryNotional: string;
  /** Sum, or `null` when legs mix cross and isolated. */
  marginUsed: string | null;
  /** `null` when legs disagree on direction — see the header. */
  entryPx: string | null;
  /** `null` unless exactly one leg reports one. */
  liquidationPx: string | null;
  /** Sum of `fundingPaid.sinceOpen`. */
  fundingSinceOpen: string;
  /**
   * Leverage, when every leg agrees. `null` otherwise — two strategies may
   * run the same coin at different leverage, and one number would pick a
   * winner between them.
   */
  leverage: number | null;
  /** `null` when legs mix cross and isolated. */
  marginMode: MarginMode | null;
  /**
   * Mark price — market-wide, so ANY leg yields it: `notionalValue / |szi|`.
   * Unlike entry, this is not a per-leg fact to be averaged; every leg on a
   * coin marks against the same price, so taking one is exact, not a guess.
   */
  markPx: string | null;
  /**
   * Unrealized PnL over the margin POSTED — deliberately NOT the wire's
   * `returnOnEquity`, which divides by entry equity and is per-leg.
   *
   * Both terms here are exactly additive, so the ratio is true for a family
   * the way a blended entry price never could be. It is a different quantity
   * from the official page's ROE and the UI labels it as such rather than
   * borrowing the more familiar name for a number that is not it.
   */
  returnOnMargin: string | null;
  /** How many family members hold this coin. */
  legs: number;
  /** Legs hold this coin in BOTH directions. */
  conflicted: boolean;
}

/**
 * Every address whose state must be read to describe this vault.
 *
 * The parent first, then its children in wire order. A `normal` or `child`
 * vault is just itself — a child does NOT walk back up to its parent, which
 * would attribute the whole family's book to one strategy.
 */
export function familyAddresses(detail: VaultDetail): readonly Hex[] {
  if (detail.relationship.kind === "parent") {
    return [detail.address, ...detail.relationship.childAddresses];
  }
  return [detail.address];
}

/** Sum of the family's account values — the money actually on the books. */
export function familyAccountValue(members: readonly FamilyMember[]): string {
  return members
    .reduce((total, member) => total.plus(toBigNumber(member.accountValue)), new BigNumber(0))
    .toFixed();
}

/**
 * One row per coin, biggest gross exposure first.
 *
 * Sorted by gross rather than net so a fully-hedged coin carrying real margin
 * does not sort to the bottom as if it were nothing.
 */
export function aggregateFamily(members: readonly FamilyMember[]): readonly FamilyPosition[] {
  const byCoin = new Map<string, Position[]>();
  for (const member of members) {
    for (const position of member.positions) {
      const legs = byCoin.get(position.coin);
      if (legs === undefined) byCoin.set(position.coin, [position]);
      else legs.push(position);
    }
  }

  const rows: FamilyPosition[] = [];
  for (const [coin, legs] of byCoin) rows.push(mergeLegs(coin, legs));

  return rows.sort(
    (a, b) => toBigNumber(b.grossNotional).comparedTo(toBigNumber(a.grossNotional)) ?? 0
  );
}

function mergeLegs(coin: string, legs: readonly Position[]): FamilyPosition {
  let netSigned = new BigNumber(0);
  let gross = new BigNumber(0);
  let pnl = new BigNumber(0);
  let entry = new BigNumber(0);
  let margin = new BigNumber(0);
  let funding = new BigNumber(0);

  const modes = new Set<MarginMode>();
  const directions = new Set<PositionSide>();
  const leverages = new Set<number>();
  let markPx: string | null = null;

  for (const leg of legs) {
    netSigned = netSigned.plus(toBigNumber(leg.signedSize));
    gross = gross.plus(toBigNumber(leg.notionalValue));
    pnl = pnl.plus(toBigNumber(leg.unrealizedPnl));
    entry = entry.plus(toBigNumber(leg.entryNotional));
    margin = margin.plus(toBigNumber(leg.marginUsed));
    funding = funding.plus(toBigNumber(leg.fundingPaid.sinceOpen));
    modes.add(leg.marginMode);
    directions.add(leg.side);
    leverages.add(leg.leverage);
    if (markPx === null) {
      const size = toBigNumber(leg.signedSize).abs();
      if (size.gt(0)) markPx = toBigNumber(leg.notionalValue).dividedBy(size).toFixed();
    }
  }

  const conflicted = directions.size > 1;
  const netSize = netSigned.abs();

  return {
    coin,
    netSignedSize: netSigned.toFixed(),
    netSize: netSize.toFixed(),
    side: positionSideOf(netSigned.toFixed()),
    isFlat: netSigned.isZero(),
    grossNotional: gross.toFixed(),
    unrealizedPnl: pnl.toFixed(),
    entryNotional: entry.toFixed(),
    // Mixing cross and isolated margin sums two different quantities.
    marginUsed: modes.size > 1 ? null : margin.toFixed(),
    // A blended entry needs one direction AND a size to divide by.
    entryPx: conflicted || netSize.isZero() ? null : entry.abs().dividedBy(netSize).toFixed(),
    // A SINGLE leg is the only case with a single answer — and its own `null`
    // is itself a fact ("cannot be liquidated by price at current equity").
    // Picking the one leg that happens to report a price, as HLP's BTC pair
    // would (child 1 has one, child 4 has `null`), publishes one strategy's
    // liquidation as the family's.
    liquidationPx: legs.length === 1 ? legs[0]!.liquidationPx : null,
    fundingSinceOpen: funding.toFixed(),
    leverage: leverages.size === 1 ? [...leverages][0]! : null,
    marginMode: modes.size === 1 ? [...modes][0]! : null,
    markPx,
    // Zero margin would divide by nothing; a mixed-mode sum is already null.
    returnOnMargin: modes.size > 1 || margin.isZero() ? null : pnl.dividedBy(margin).toFixed(),
    legs: legs.length,
    conflicted,
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface FamilyProbe {
  clearinghouseState(params: { user: string }): Promise<unknown>;
}

export interface FamilyResult {
  members: readonly FamilyMember[];
  /**
   * Addresses whose read was declined or failed.
   *
   * **Never empty-and-ignored.** A family read is N independent requests, and
   * losing one loses a whole strategy's book — with HLP that could be the only
   * child holding anything, turning "175 positions" into "0" with no error
   * anywhere. The caller must say so rather than present the survivors as the
   * whole vault.
   */
  missing: readonly Hex[];
}

/**
 * Read every family member's book.
 *
 * `clearinghouseState` is weight 2, so the whole HLP family costs **16** — the
 * reason a position view is affordable at all when the same family's open
 * orders would cost 160. Requests go out together: they are independent, and
 * eight sequential round trips on a phone is a visible wait.
 */
export async function fetchFamily(params: {
  probe: FamilyProbe;
  addresses: readonly Hex[];
  budget?: WeightBudget;
  now?: () => number;
}): Promise<FamilyResult> {
  const budget = params.budget ?? weightBudget;
  const at = (params.now ?? Date.now)();

  const settled = await Promise.all(
    params.addresses.map(async (address): Promise<FamilyMember | Hex> => {
      try {
        const wrapped = await budget.tryRun(
          "clearinghouseState",
          async () => ({ raw: await params.probe.clearinghouseState({ user: address }) }),
          { now: () => at }
        );
        if (wrapped === null) return address;
        const snapshot = parseClearinghouseState(wrapped.raw);
        return {
          address,
          positions: snapshot.positions,
          accountValue: snapshot.summary.total.accountValue,
          withdrawable: snapshot.summary.withdrawable,
        };
      } catch (caught) {
        // One member's malformed payload must not take the family down: the
        // rest is still true, and `missing` says the picture is partial.
        logger.warn("vault.family_member_failed", {
          error: caught,
          context: { address },
        });
        return address;
      }
    })
  );

  const members: FamilyMember[] = [];
  const missing: Hex[] = [];
  for (const entry of settled) {
    if (typeof entry === "string") missing.push(entry);
    else members.push(entry);
  }

  logger.info("vault.family", {
    context: { read: members.length, missing: missing.length },
  });
  return { members, missing };
}
