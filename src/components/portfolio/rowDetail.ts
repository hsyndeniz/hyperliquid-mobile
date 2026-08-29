/**
 * What a row's detail view shows — as data, so it can be tested.
 *
 * Every row on this screen renders a summary; the full wire record has fields
 * the row deliberately drops. This is where they come back, and the point is
 * that several of them are **only meaningful with their caveat attached**:
 *
 * - A fill's `hash` is **not unique** and is all-zero on 5.6% of mainnet fills.
 *   Shown as an identifier without that, it invites someone to use it as a key.
 * - `closedPnl` is **gross of fees** and per-fill, so it is labelled as such
 *   rather than presented as what the trade earned.
 * - A ledger row's `delta` is deliberately **unparsed** by `history/ledger.ts`
 *   because new types keep appearing. The detail view is where that raw record
 *   belongs, rather than being flattened into fields that may not exist.
 * - `isTerminal === false` on an order means the history ENDS there, not that
 *   the order is live.
 *
 * Values are strings because the wire is strings; nothing here is parsed.
 */

import { BigNumber } from "bignumber.js";

import { ledgerAmount, ledgerDexes, ledgerDirection } from "@/hyperliquid/history/ledger";
import type { FundingLedgerRow } from "@/hyperliquid/api/accountMeta";
import type { LedgerRow } from "@/hyperliquid/history/ledger";
import type { OrderLifecycle } from "@/hyperliquid/history/orders";
import type { Fill, OpenOrderRow, Position } from "@/hyperliquid/types/domain";

export interface DetailField {
  label: string;
  value: string;
  /** Shown under the value. For the fields that lie without one. */
  caveat?: string;
}

export interface RowDetail {
  title: string;
  subtitle: string;
  fields: DetailField[];
}

/** `null`/absent becomes an explicit dash, never an empty row or "0". */
function shown(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "--";
  return String(value);
}

/**
 * A wire ratio as a readable percentage — `"-0.1816324927"` → `"-18.16%"`.
 *
 * The one place this file formats rather than passes through: a ten-decimal
 * ratio is not information at reading distance, and percent is what the figure
 * MEANS. BigNumber so the conversion cannot pick up float dust.
 */
function asPercent(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "--";
  const ratio = new BigNumber(value);
  if (!ratio.isFinite()) return "--";
  return `${ratio.multipliedBy(100).toFixed(2)}%`;
}

export function positionDetail(position: Position): RowDetail {
  return {
    title: position.coin,
    subtitle: `${position.side} ${position.leverage}x · ${position.marginMode}`,
    fields: [
      // The size is unsigned on the wire; the direction is already in the
      // subtitle ("long 20x"), so no caveat — that note was for developers.
      { label: "Size", value: shown(position.size) },
      { label: "Entry price", value: shown(position.entryPxDisplay) },
      { label: "Unrealised P&L", value: shown(position.unrealizedPnl) },
      { label: "Return on equity", value: asPercent(position.returnOnEquity) },
      {
        label: "Funding paid",
        value: shown(position.fundingPaid.sinceOpen),
        // The sign convention is the position's, not the ledger's: POSITIVE is
        // money this position cost in funding — verified by reconciliation in
        // `types/domain.ts`. Without the caveat a cost reads as income.
        caveat: "since open; positive means you paid, negative you received",
      },
      {
        label: "Liquidation price",
        value: shown(position.liquidationPx),
        // Real state, not missing data: an isolated position fully funded, or a
        // cross position the exchange does not publish one for.
        caveat: position.liquidationPx === null ? "not published for this position" : undefined,
      },
      { label: "Margin mode", value: shown(position.marginMode) },
    ],
  };
}

export function fillDetail(fill: Fill): RowDetail {
  return {
    title: fill.coin,
    subtitle: `${fill.dir} · ${fill.crossed ? "taker" : "maker"}`,
    fields: [
      { label: "Size", value: shown(fill.sz) },
      { label: "Price", value: shown(fill.px) },
      {
        label: "Fee",
        value: `${shown(fill.fee)} ${shown(fill.feeToken)}`,
        caveat: "negative is a maker rebate; the token is not always USDC",
      },
      { label: "Builder fee", value: shown(fill.builderFee) },
      {
        label: "Closed P&L",
        value: shown(fill.closedPnl),
        caveat: "gross of fees, and only meaningful on a closing fill",
      },
      { label: "Order id", value: shown(fill.oid) },
      {
        label: "Trade id",
        value: shown(fill.tid),
        caveat: fill.tid === 0 ? "0 is a real value here, not a missing one" : undefined,
      },
      {
        label: "Transaction",
        value: shown(fill.hash),
        caveat: "not unique, and all-zero on some fills — not usable as a key",
      },
      { label: "TWAP id", value: shown(fill.twapId) },
      {
        label: "Liquidation",
        value: fill.liquidation === null ? "no" : shown(fill.liquidation.method),
        caveat:
          fill.liquidation === null
            ? undefined
            : "this block is attached to BOTH sides of the trade",
      },
    ],
  };
}

export function orderDetail(row: OpenOrderRow): RowDetail {
  return {
    title: row.coin,
    subtitle: `${row.side} · ${row.orderType}`,
    fields: [
      {
        label: "Remaining",
        value: shown(row.remainingSz),
        caveat: "what a cancel acts on",
      },
      { label: "Placed size", value: shown(row.originalSz) },
      { label: "Limit price", value: shown(row.limitPx) },
      { label: "Time in force", value: shown(row.tif) },
      { label: "Reduce only", value: row.reduceOnly ? "yes" : "no" },
      {
        label: "Trigger",
        value: row.isTrigger ? shown(row.triggerCondition) : "no",
      },
      { label: "Trigger price", value: shown(row.triggerPx) },
      { label: "Order id", value: shown(row.oid) },
      { label: "Client id", value: shown(row.cloid), caveat: "not unique — reused in practice" },
    ],
  };
}

export function orderHistoryDetail(order: OrderLifecycle): RowDetail {
  return {
    title: order.coin,
    subtitle: `${order.side} · ${order.finalStatus}`,
    fields: [
      {
        label: "Final status",
        value: shown(order.finalStatus),
        caveat: order.isTerminal ? undefined : "the history ends here — NOT that the order is live",
      },
      { label: "Events", value: String(order.events.length) },
      {
        label: "Placed",
        value: new Date(order.placedAt).toLocaleString(),
        caveat: "first event — a fired trigger reports its fire time elsewhere",
      },
      { label: "Last event", value: new Date(order.lastAt).toLocaleString() },
      { label: "Order id", value: shown(order.oid) },
      { label: "Client id", value: shown(order.cloid) },
    ],
  };
}

export function ledgerDetail(row: LedgerRow, viewer: string): RowDetail {
  const dexes = ledgerDexes(row);
  return {
    title: row.type,
    subtitle: new Date(row.time).toLocaleString(),
    fields: [
      { label: "Direction", value: ledgerDirection(row, viewer) },
      { label: "Amount", value: shown(ledgerAmount(row)) },
      {
        label: "Between",
        value: dexes === null ? "--" : `${dexes.from || "perp"} → ${dexes.to || "perp"}`,
        caveat: dexes === null ? undefined : "an empty dex name is the default perp dex",
      },
      {
        label: "Transaction",
        value: shown(row.hash),
        caveat: "all-zero means no L1 transaction, not missing data",
      },
      {
        label: "Raw record",
        // Verbatim: `history/ledger.ts` keeps `delta` unparsed because new
        // types keep appearing, and this is where that record belongs.
        value: JSON.stringify(row.delta, null, 2),
      },
    ],
  };
}

export function fundingDetail(row: FundingLedgerRow): RowDetail {
  const received = !row.usdc.startsWith("-");
  return {
    title: row.coin,
    subtitle: `funding · ${received ? "received" : "paid"}`,
    fields: [
      {
        label: received ? "Received" : "Paid",
        value: shown(row.usdc),
        // The convention was verified by exact reconciliation against
        // `cumFunding` — see FundingLedgerRow — so this label is earned.
        caveat: "the account's cash delta — negative is paid out",
      },
      {
        label: "Funding rate",
        // Full precision, not `asPercent`'s two decimals: a funding rate of
        // 0.00125% would round to "0.00%", which reads as no funding at all.
        value: new BigNumber(row.fundingRate).isFinite()
          ? `${new BigNumber(row.fundingRate).multipliedBy(100).toFixed()}%`
          : "--",
      },
      {
        label: "Position size",
        value: shown(row.szi),
        caveat: "at the time of the tick, signed — negative is short",
      },
      { label: "Time", value: new Date(row.time).toLocaleString() },
    ],
  };
}
