/**
 * Fills and transfers as CSV, for the share sheet.
 *
 * The web app has a CSV download; a phone's equivalent is the share sheet with
 * the text handed over directly — no file, no new dependency, and the receiver
 * (Mail, Files, Notes) decides what to do with it.
 *
 * Two rules with money consequences:
 *
 * - **Wire strings verbatim.** Every amount is emitted exactly as the exchange
 *   sent it — a CSV opened in a spreadsheet is often the user's reconciliation
 *   tool, and a reformatted number defeats the comparison.
 * - **Times are ISO-8601 UTC**, not locale strings: locale output varies by
 *   device settings and cannot be parsed back reliably.
 *
 * Fields are escaped per RFC 4180 (quote when a comma, quote, or newline is
 * present; double interior quotes). `dir` values like "Open Long" carry spaces
 * today and could carry commas tomorrow — the escaper is not optional.
 */

import {
  ledgerAmount,
  ledgerAmountToken,
  ledgerDirection,
  type LedgerRow,
} from "@/hyperliquid/history/ledger";
import type { Fill } from "@/hyperliquid/types/domain";

export function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

function line(fields: readonly string[]): string {
  return fields.map(csvField).join(",");
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Fills, oldest first as given. Columns chosen to reconcile against the exchange. */
export function fillsCsv(fills: readonly Fill[]): string {
  const rows = fills.map((fill) =>
    line([
      iso(fill.time),
      fill.coin,
      fill.side,
      fill.dir,
      fill.px,
      fill.sz,
      fill.fee,
      fill.feeToken,
      // Gross of fees and only meaningful on a closing fill — same caveat the
      // detail sheet states; the column name cannot carry it, the docs must.
      fill.closedPnl,
      String(fill.oid),
      fill.hash,
    ])
  );
  return ["time,coin,side,dir,price,size,fee,fee_token,closed_pnl,oid,hash", ...rows].join("\n");
}

/**
 * Transfers. `direction` is relative to `viewer` — the same resolution the
 * list rows use, so the CSV never disagrees with the screen. A row whose
 * amount is unknown exports an empty cell, not a zero.
 *
 * The amount column is `amount` with a `token` beside it, NOT `amount_usdc`.
 * `ledgerAmount` resolves `usdcValue ?? usdc ?? amount ?? netWithdrawnUsd`, and
 * `amount` is a TOKEN quantity on every type that carries no USD field —
 * `rewardsClaim`, `cStakingTransfer`, `borrowLend`, `spotGenesis`, the gas
 * auctions. Under the old header an account that staked HYPE exported
 * `cStakingTransfer,…,1000` as USDC; summing that column in a spreadsheet added
 * 1,000 HYPE to a dollar total with nothing on the row to reveal it. The header
 * now says what the cell actually is, and `token` says which unit — empty when
 * the figure really is USD.
 */
export function ledgerCsv(rows: readonly LedgerRow[], viewer: string): string {
  const body = rows.map((row) =>
    line([
      iso(row.time),
      row.type,
      ledgerDirection(row, viewer),
      ledgerAmount(row) ?? "",
      ledgerAmountToken(row) ?? "",
      row.hash,
    ])
  );
  return ["time,type,direction,amount,token,hash", ...body].join("\n");
}
