/**
 * The money history — `userNonFundingLedgerUpdates`.
 *
 * Everything that moved USDC or a token without being a trade: deposits,
 * withdrawals, transfers, vault operations, liquidations, rewards, gas auctions.
 * Measured over 22,832 rows across ~190 mainnet accounts.
 *
 * ## The paging trap, which is the whole reason this module exists
 *
 * The response is **hard-capped at 2,000 rows**, and *which* 2,000 you get
 * depends on a parameter whose absence the SDK documents as having no effect:
 *
 * | Request | Order | Which 2,000 |
 * | --- | --- | --- |
 * | `startTime` supplied (**including `0`**) | ascending | the **oldest** — newest truncated |
 * | `startTime` omitted | descending | the **newest** |
 *
 * So the obvious call — `{ startTime: 0 }`, meaning "give me everything" — hands
 * a busy account a history that stops months ago and never advances. The two
 * windows are disjoint: on four capped accounts they shared **zero** rows.
 *
 * {@link fetchLedgerPage} therefore always reports `hasMore`, and
 * {@link seedLedger} uses the omitted-`startTime` form, because seeding a screen
 * with the newest rows is what a user expects and it needs no cursor.
 *
 * Both bounds are **inclusive**, so a page cursor advances by 1 ms — the same
 * convention `api/account.ts` uses for fills. `endTime` without `startTime` is an
 * HTTP 500, not an empty result.
 *
 * ## `hash` is not a key
 *
 * Two distinct rows on one account can share a hash, and even a `(time, hash)`
 * pair. Deduping on either **silently discards real money movements** — on one
 * measured account it would drop a 99,999 USDC withdrawal. {@link ledgerKey}
 * includes the serialised delta for that reason. A hash is also shared by *both
 * sides* of a transfer, so it is a legitimate cross-reference between a master
 * and its sub-account, but never an identity.
 *
 * 18 of 22,832 rows carry the all-zero hash. That means "no L1 transaction", not
 * "missing".
 *
 * ## Direction is not on the wire
 *
 * `send` and `spotTransfer` carry no direction field. It is inferable only by
 * comparing `user`/`destination` against the account being viewed — and **45.7%
 * of `send` rows are self-transfers**, where both equal the viewer and the row is
 * really a move between the account's own books. See {@link ledgerDirection}.
 */

import { BigNumber } from "bignumber.js";

import { log } from "@/hyperliquid/core/logger";
import { HlError } from "@/hyperliquid/core/errors";
import type { Hex } from "@/hyperliquid/types/domain";

const logger = log.child("history.ledger");

/** Measured hard cap. A full page means there is more, always. */
export const LEDGER_PAGE_CAP = 2_000;

/**
 * Delta types seen on the live wire.
 *
 * The SDK declares 19. Two more exist and are **absent from its union**:
 * `gossipPriorityGasAuction` — the 6th most common type at 1,921 rows, more than
 * `withdraw` — and `accountActivationGas`. TypeScript narrows both to `never`
 * against the SDK's type, so a `switch` written from it silently drops them.
 *
 * Kept as a plain list rather than a closed union for exactly that reason: this
 * has already grown twice, and a client that cannot render an unknown type must
 * fall back, not blank.
 */
export const LEDGER_TYPES = [
  "accountClassTransfer",
  "accountActivationGas",
  "activateDexAbstraction",
  "borrowLend",
  "cStakingTransfer",
  "deployGasAuction",
  "deposit",
  "gossipPriorityGasAuction",
  "internalTransfer",
  "liquidation",
  "rewardsClaim",
  "send",
  "spotGenesis",
  "spotTransfer",
  "subAccountTransfer",
  "vaultCreate",
  "vaultDeposit",
  "vaultDistribution",
  "vaultLeaderCommission",
  "vaultWithdraw",
  "withdraw",
] as const;

export interface LedgerRow {
  time: number;
  /**
   * The L1 transaction hash — **not unique**, and all-zero on 18 of 22,832 rows,
   * which means "no L1 transaction" rather than "missing".
   */
  hash: string;
  type: string;
  /** Verbatim, because per-type fields differ and new types keep appearing. */
  delta: Readonly<Record<string, unknown>>;
}

/**
 * Which way the money went, relative to the account being viewed.
 *
 * `internal` is not a rounding case — it is 45.7% of `send` rows. Those are moves
 * between the same account's own books (spot ↔ perp ↔ a builder dex), and
 * rendering one as an outgoing payment tells a user they sent money away.
 */
export type LedgerDirection = "in" | "out" | "internal" | "unknown";

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/**
 * Parse one page.
 *
 * Rows whose envelope is malformed are dropped and counted rather than throwing:
 * a shape change must cost a row, never the whole history.
 */
export function parseLedger(rows: unknown): LedgerRow[] {
  if (!Array.isArray(rows)) return [];
  const parsed: LedgerRow[] = [];
  let dropped = 0;

  for (const entry of rows) {
    if (typeof entry !== "object" || entry === null) {
      dropped += 1;
      continue;
    }
    const row = entry as { time?: unknown; hash?: unknown; delta?: unknown };
    const delta = row.delta;
    if (typeof row.time !== "number" || typeof delta !== "object" || delta === null) {
      dropped += 1;
      continue;
    }
    const type = (delta as { type?: unknown }).type;
    if (typeof type !== "string") {
      dropped += 1;
      continue;
    }
    parsed.push({
      time: row.time,
      hash: typeof row.hash === "string" ? row.hash : "",
      type,
      delta: delta as Record<string, unknown>,
    });
  }

  if (dropped > 0) logger.warn("ledger.rows_dropped", { context: { dropped } });
  return parsed;
}

/**
 * A dedup key that cannot lose a row.
 *
 * **Not `hash`, and not `(time, hash)`** — both collide on real accounts, and
 * deduping on either discards genuine money movements. The delta is serialised
 * into the key because it is the only thing that distinguishes two same-hash,
 * same-millisecond rows.
 *
 * Scope it per account: a transfer's hash appears identically on both sides.
 */
/**
 * The window for the next older-ledger page, or `null` if there is nothing to
 * walk into.
 *
 * The upper bound is a CONSTANT of the whole walk — the oldest row the seed
 * already covers down to — while `cursor` advances forward through the pages
 * below it. Deriving the bound from the rows held so far instead moved it older
 * on every page, so from page two it sat below the cursor and the fetch threw
 * its own inverted-window error: budget already charged, `done` still false, so
 * the button stayed live and each further tap burned another 20 weight.
 *
 * Returning `null` rather than an inverted window is the point — the caller
 * cannot spend on a request that cannot succeed.
 */
export function ledgerPageWindow(params: {
  cursor: number;
  seedRows: readonly LedgerRow[];
}): { startTime: number; endTime: number } | null {
  const seedOldest = params.seedRows[0]?.time;
  if (seedOldest === undefined) return null;
  if (params.cursor > seedOldest) return null;
  return { startTime: params.cursor, endTime: seedOldest };
}

export function ledgerKey(row: LedgerRow): string {
  return `${row.time}:${row.hash}:${JSON.stringify(row.delta)}`;
}

/** Merge pages without losing or duplicating rows, newest last. */
export function mergeLedger(
  held: readonly LedgerRow[],
  incoming: readonly LedgerRow[]
): LedgerRow[] {
  const seen = new Set(held.map(ledgerKey));
  const merged = [...held];
  for (const row of incoming) {
    const key = ledgerKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  // Stable within a millisecond: up to 10 rows were observed sharing one, so the
  // sort must not reorder them arbitrarily on each merge.
  return merged.sort((a, b) => a.time - b.time);
}

/**
 * Which way the money moved, from `viewer`'s point of view.
 *
 * Address comparison is case-insensitive: the wire is lowercase but a caller may
 * hold a checksummed address, and a case-sensitive compare would report every row
 * as `unknown`.
 */
export function ledgerDirection(row: LedgerRow, viewer: string): LedgerDirection {
  const me = viewer.toLowerCase();
  const from = str(row.delta as Record<string, unknown>, "user")?.toLowerCase() ?? null;
  const to = str(row.delta as Record<string, unknown>, "destination")?.toLowerCase() ?? null;

  // An INHERENT direction beats the address inference — but only when every
  // address the row carries is the viewer's own.
  //
  // The address inference reads `user` as the payer, which is right for `send`
  // and wrong for the vault types: on `vaultWithdraw` and
  // `vaultLeaderCommission` the SDK documents `user` as the RECIPIENT, and
  // neither carries a `destination`. So a viewer withdrawing from HLP matched
  // `from === me` and was labelled "out" — money arriving, painted danger-red
  // with a minus sign in the activity row, in the detail sheet, and in the CSV.
  //
  // The guard keeps the case the old branch existed to protect: a vault's own
  // ledger carries every follower's rows, and `vaultWithdraw.user` is frequently
  // somebody else. Those still fall through to "unknown" rather than claiming a
  // direction relative to a viewer who is not on the row.
  const inherent = INHERENTLY_IN.has(row.type) ? "in" : INHERENTLY_OUT.has(row.type) ? "out" : null;
  if (inherent !== null && (from === null || from === me) && (to === null || to === me)) {
    return inherent;
  }

  if (from === null && to === null) {
    // A counterparty-less type that is in neither set — nothing to infer from.
    return "unknown";
  }
  // Both sides are the viewer: a move between the account's own books. 45.7% of
  // `send` rows. `sourceDex`/`destinationDex` say which books.
  if (from === me && to === me) return "internal";
  if (to === me) return "in";
  if (from === me) return "out";
  // Neither side is the viewer. Real, and not a parse failure: a vault's own
  // ledger carries every follower's deposits, and `vaultWithdraw.user` is
  // frequently somebody else.
  return "unknown";
}

const INHERENTLY_IN = new Set([
  "deposit",
  "rewardsClaim",
  "vaultDistribution",
  "vaultLeaderCommission",
  // Withdrawing FROM a vault puts money INTO the account whose ledger this is.
  // Its `user` field is the recipient, not a payer, so the address inference
  // read it as money leaving — see `ledgerDirection`. Safe to list here because
  // that function only lets an inherent direction win when the row's addresses
  // are the viewer's own; a vault's own ledger, which carries every follower's
  // withdrawals, still resolves to "unknown".
  "vaultWithdraw",
]);
const INHERENTLY_OUT = new Set([
  "withdraw",
  "accountActivationGas",
  "deployGasAuction",
  "gossipPriorityGasAuction",
]);

/**
 * The dex a row moved money between, when it names them.
 *
 * The SDK's doc comment describes two values — `""` for the perp dex and
 * `"spot"`. **Eight** were measured, the rest being builder dexes (`xyz`, `vntl`,
 * `flx`, `hyna`, `cash`…). So a `send` between two builder dexes is not a
 * spot↔perp move and must not be labelled one.
 *
 * An empty string is a real value meaning the default perp dex, not an absent
 * field — which is why this returns `""` rather than `null` for it.
 */
export function ledgerDexes(row: LedgerRow): { from: string; to: string } | null {
  const delta = row.delta as Record<string, unknown>;
  const from = str(delta, "sourceDex");
  const to = str(delta, "destinationDex");
  return from === null || to === null ? null : { from, to };
}

/** A money field, as a string. `null` when the type does not carry one. */
export function ledgerAmount(row: LedgerRow): string | null {
  const delta = row.delta as Record<string, unknown>;
  // In preference order: the USD value of a token move, then plain USDC, then a
  // token amount, then the vault-withdraw spelling. Never coerced through a
  // number — values up to 20 significant digits were measured, and `Number()`
  // changes them.
  //
  // `netWithdrawnUsd` last and NET, not `requestedUsd`: a `vaultWithdraw` delta
  // carries none of the first three (its money fields are `requestedUsd`,
  // `commission`, `closingCost`, `basis`, `netWithdrawnUsd`), so every vault
  // withdrawal an account had ever made rendered "--" in the row, blank in the
  // detail sheet, and an empty cell in the CSV. The net is what actually landed
  // in the account, which is the same rule the withdrawal ledger already
  // follows elsewhere; the gross ask is `requestedUsd` and is not shown here.
  return (
    str(delta, "usdcValue") ??
    str(delta, "usdc") ??
    str(delta, "amount") ??
    str(delta, "netWithdrawnUsd")
  );
}

/**
 * The unit `ledgerAmount` returned, or `null` when it is USD.
 *
 * Exists because the amount is NOT always dollars: `usdcValue`, `usdc` and
 * `netWithdrawnUsd` are USD, but the bare `amount` field is a token quantity
 * carried by `rewardsClaim`, `cStakingTransfer`, `borrowLend`, `spotGenesis`
 * and the gas auctions. Anything that presents the figure as money — the CSV
 * export especially, where a column gets summed — has to be able to say which.
 */
export function ledgerAmountToken(row: LedgerRow): string | null {
  const delta = row.delta as Record<string, unknown>;
  if (str(delta, "usdcValue") !== null) return null;
  if (str(delta, "usdc") !== null) return null;
  if (str(delta, "amount") === null) return null;
  // `token` is the spelling on every type that carries a bare `amount`.
  return str(delta, "token") ?? "unknown";
}

/** Sum a set of rows exactly. Returns a decimal string. */
export function totalLedgerAmount(rows: readonly LedgerRow[]): string {
  return rows
    .reduce((total, row) => total.plus(ledgerAmount(row) ?? 0), new BigNumber(0))
    .toFixed();
}

export interface LedgerProbe {
  userNonFundingLedgerUpdates(params: {
    user: Hex;
    startTime?: number;
    endTime?: number;
  }): Promise<unknown>;
}

export interface LedgerPage {
  rows: LedgerRow[];
  /**
   * True when the page came back full, so rows were cut off.
   *
   * Never inferred from the caller's window — the cap is on the row count, and a
   * short window can still overflow it.
   */
  hasMore: boolean;
  /** Feed to the next `fetchLedgerPage` as `startTime`. `null` when done. */
  nextStartTime: number | null;
}

/**
 * Read one ascending page from `startTime`.
 *
 * The cursor advances by **1 ms** because both bounds are inclusive; reusing the
 * last row's timestamp re-reads it, and skipping past it can drop a sibling row
 * sharing that millisecond — up to 10 were observed sharing one.
 */
export async function fetchLedgerPage(params: {
  probe: LedgerProbe;
  user: Hex;
  startTime: number;
  endTime?: number;
}): Promise<LedgerPage> {
  if (params.endTime !== undefined && params.endTime < params.startTime) {
    // The server answers an inverted window with `[]`, which reads as "no
    // history" rather than as the programming error it is.
    throw new HlError("Ledger window ends before it starts", {
      code: "invalid_config",
      context: { startTime: params.startTime, endTime: params.endTime },
    });
  }

  const raw = await params.probe.userNonFundingLedgerUpdates({
    user: params.user,
    startTime: params.startTime,
    ...(params.endTime === undefined ? {} : { endTime: params.endTime }),
  });
  const rows = parseLedger(raw);
  const hasMore = rows.length >= LEDGER_PAGE_CAP;

  return {
    rows,
    hasMore,
    nextStartTime: hasMore && rows.length > 0 ? rows[rows.length - 1].time + 1 : null,
  };
}

/**
 * Seed a history screen with the **newest** rows.
 *
 * Omits `startTime` deliberately — that is what flips the endpoint to
 * newest-first and gets the recent 2,000 rather than the oldest 2,000. There is
 * no other way to reach the present on a capped account without already knowing a
 * timestamp.
 *
 * Returned ascending like every other page, so a caller never has to care which
 * form produced them.
 */
export async function seedLedger(params: { probe: LedgerProbe; user: Hex }): Promise<LedgerPage> {
  const raw = await params.probe.userNonFundingLedgerUpdates({ user: params.user });
  const rows = parseLedger(raw).sort((a, b) => a.time - b.time);
  const hasMore = rows.length >= LEDGER_PAGE_CAP;

  logger.info("ledger.seeded", { context: { rows: rows.length, hasMore } });
  return {
    rows,
    hasMore,
    // Older history is reached by walking BACKWARDS from the oldest row here,
    // using `endTime` — not forwards from it.
    nextStartTime: null,
  };
}
