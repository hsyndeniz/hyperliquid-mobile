/**
 * The leader's side: which vaults you lead, changing their settings, and paying
 * followers out.
 *
 * **`leadingVaults` is the only ownership check.** A vault never appears in its
 * leader's `subAccounts2` — measured — so the Phase 8 ownership path cannot be
 * reused, and `userRole` on a vault answers a bare `{"role":"vault"}` with no
 * `data` and therefore no pointer back to the leader. Ownership only resolves in
 * one direction: leader → vaults.
 *
 * It also **omits closed vaults**, so a leader with a closed vault sees nothing
 * for it here even though the address still exists and still reports
 * `{"role":"vault"}`. That is why `assertLedVault` says "not one of your *open*
 * vaults" rather than claiming the vault is not yours.
 *
 * Two traps in the write path:
 *
 * 1. **`vaultModify`'s booleans are nullish, and `null` means "leave
 *    unchanged".** Defaulting an unspecified flag to `false` does not leave it
 *    alone — it switches deposits off for every follower, or changes how
 *    withdrawals are funded, from a call that meant to change neither. So this
 *    module only ever sends the fields a caller explicitly names.
 * 2. **`vaultDistribute.usd` allows 0**, unlike `vaultTransfer.usd` which
 *    requires at least 1. Zero is not a no-op here — it is the wire's
 *    "distribute the maximum" convention, and sending it by accident pays out
 *    the vault's entire free margin.
 */

import { HlError, toHlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { weightBudget, type WeightBudget } from "@/hyperliquid/api/weightBudget";
import { sameAddress } from "@/hyperliquid/transfers/destination";
import { BigNumber } from "bignumber.js";

import { amountsEqual, toMicroUsd } from "@/hyperliquid/transfers/amount";
import type { MicroUsd, TransferOutcome, WireAmount } from "@/hyperliquid/transfers/types";
import type { Hex } from "@/hyperliquid/types/domain";
import {
  VAULT_CREATION_FEE_USDC,
  VAULT_CREATION_MIN_USDC,
  VAULT_DESCRIPTION_MAX,
  VAULT_DESCRIPTION_MIN,
  VAULT_NAME_MAX,
  VAULT_NAME_MIN,
  type VaultAddress,
  type VaultDescription,
  type VaultName,
} from "@/hyperliquid/vaults/types";

const logger = log.child("vaults.manage");

export interface LeadingVaultsProbe {
  leadingVaults(params: { user: string }): Promise<unknown>;
}

/** A vault this user leads. `leadingVaults` returns only address and name. */
export interface LedVault {
  address: VaultAddress;
  /** Verbatim, untrimmed — the same identity rule the directory follows. */
  name: string;
}

/** Parse a `leadingVaults` response. */
export function parseLeadingVaults(raw: unknown): LedVault[] {
  // Coalesced rather than rejected: `subAccounts2` one phase away answers `null`
  // for "none", so a null here is entirely plausible and must not crash a leader
  // screen on first load.
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new HlError("leadingVaults returned neither an array nor null", {
      code: "validation_error",
    });
  }
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as { address?: unknown; name?: unknown };
    if (typeof row.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(row.address)) return [];
    return [
      {
        address: row.address.toLowerCase() as VaultAddress,
        name: typeof row.name === "string" ? row.name : "",
      },
    ];
  });
}

export interface LeadingVaultsResult {
  /** `null` only when the weight budget refused — never for "leads none". */
  value: LedVault[] | null;
  deferred: boolean;
}

/** Fetch the vaults a user leads, through the weight budget. */
export async function fetchLeadingVaults(params: {
  probe: LeadingVaultsProbe;
  user: string;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<LeadingVaultsResult> {
  const budget = params.budget ?? weightBudget;
  const at = (params.now ?? Date.now)();

  const wrapped = await budget.tryRun(
    "leadingVaults",
    async () => ({ raw: await params.probe.leadingVaults({ user: params.user }) }),
    { now: () => at }
  );
  if (wrapped === null) return { value: null, deferred: true };

  const value = parseLeadingVaults(wrapped.raw);
  logger.info("vaults.leading", { context: { count: value.length } });
  return { value, deferred: false };
}

/** Whether this address is one of the user's open vaults. */
export function isLedVault(led: readonly LedVault[], candidate: string): boolean {
  return led.some((vault) => sameAddress(vault.address, candidate));
}

/**
 * As above, but throws — for a path about to sign a leader-only action.
 *
 * Worded around **open**, because `leadingVaults` omits closed vaults: telling a
 * leader a vault they closed is "not theirs" would be wrong and alarming.
 */
export function assertLedVault(led: readonly LedVault[], candidate: string): void {
  if (!isLedVault(led, candidate)) {
    throw new HlError("That address is not one of your open vaults", {
      code: "not_authorized",
      context: { reason: "not_led", known: led.length },
    });
  }
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

export interface VaultAdminClient {
  vaultModify(params: {
    vaultAddress: string;
    allowDeposits: boolean | null;
    alwaysCloseOnWithdraw: boolean | null;
  }): Promise<unknown>;
  vaultDistribute(params: { vaultAddress: string; usd: number }): Promise<unknown>;
}

async function run(
  label: string,
  nonceAt: number,
  call: () => Promise<unknown>
): Promise<TransferOutcome> {
  try {
    await call();
    return { kind: "settled", nonce: nonceAt };
  } catch (error) {
    const hl = toHlError(error, { stage: label });
    // Never left the device, in two distinct ways, and both are correctable
    // rather than unresolved.
    //
    // `validation_error` is raised while the payload is still being built — a
    // schema rejection, a formatting failure, a wallet that would not sign.
    // `offline` is the connection never opening at all. Falling through to
    // `unknown` tells a user their money MAY be in flight and forbids the retry
    // that is the only thing that would help.
    //
    // `offline` only began firing once `looksOffline` learned to walk the cause
    // chain — the SDK wraps every throw, so the bare `TypeError` this used to
    // match never reached a classifier in production.
    if (hl.code === "validation_error" || hl.code === "offline") {
      logger.warn(`${label}.rejected_locally`, { error: hl });
      return { kind: "rejected_locally", error: hl };
    }

    if (hl.code === "api_error") {
      logger.warn(`${label}.rejected`, { error: hl });
      return { kind: "rejected_by_server", reason: hl.message };
    }
    logger.warn(`${label}.unknown`, { error: hl });
    return {
      kind: "unknown",
      error: hl,
      nonce: nonceAt,
      window: { fromMs: nonceAt, toMs: nonceAt + 900_000 },
    };
  }
}

/**
 * Change a vault's settings.
 *
 * Both flags are **optional here and nullish on the wire**, where `null` means
 * "leave unchanged". A caller naming only `allowDeposits` sends `null` for the
 * other, which is the whole point: the alternative — defaulting to `false` —
 * would silently switch a setting the caller never mentioned, on a vault holding
 * other people's money.
 *
 * At least one flag must be named, because a call that changes nothing still
 * costs a signature and reads, in a log, exactly like one that did something.
 */
export async function modifyVault(params: {
  client: VaultAdminClient;
  vault: VaultAddress;
  /** Omit to leave unchanged. */
  allowDeposits?: boolean;
  /** Omit to leave unchanged. */
  alwaysCloseOnWithdraw?: boolean;
  now?: () => number;
}): Promise<TransferOutcome> {
  const at = (params.now ?? Date.now)();

  if (params.allowDeposits === undefined && params.alwaysCloseOnWithdraw === undefined) {
    return {
      kind: "rejected_locally",
      error: new HlError("Nothing to change on this vault", {
        code: "validation_error",
        context: { reason: "no_changes" },
      }),
    };
  }

  return run("vaultModify", at, () =>
    params.client.vaultModify({
      vaultAddress: params.vault,
      // `?? null`, never `?? false`. See the module note.
      allowDeposits: params.allowDeposits ?? null,
      alwaysCloseOnWithdraw: params.alwaysCloseOnWithdraw ?? null,
    })
  );
}

/**
 * Pay followers out of the vault's free margin.
 *
 * Capped by `maxDistributable`, which is the vault's **free margin** — not its
 * TVL and not the leader's share. A caller showing "available to distribute"
 * must read that field and not confuse it with `maxWithdrawable`, which is a
 * different quantity scoped to a different user.
 *
 * Micro-USD, like every other vault amount.
 */
export async function distributeFromVault(params: {
  client: VaultAdminClient;
  vault: VaultAddress;
  usd: MicroUsd;
  now?: () => number;
}): Promise<TransferOutcome> {
  const at = (params.now ?? Date.now)();

  // The wire accepts 0 here — unlike `vaultTransfer.usd`, whose minimum is 1 —
  // and 0 is not a no-op, it means "distribute the maximum". A caller that
  // arrived at zero by arithmetic almost certainly did not mean to pay out the
  // vault's entire free margin, so it has to be asked for explicitly.
  if (params.usd === 0) {
    return {
      kind: "rejected_locally",
      error: new HlError(
        "A zero distribution means 'pay out everything' on the wire; use distributeMaximumFromVault to ask for that",
        { code: "validation_error", context: { reason: "ambiguous_zero" } }
      ),
    };
  }

  return run("vaultDistribute", at, () =>
    params.client.vaultDistribute({ vaultAddress: params.vault, usd: params.usd })
  );
}

/**
 * Distribute the vault's entire free margin.
 *
 * The wire spells this `usd: 0`. It exists as its own function so that value can
 * never be reached by accident — a subtraction that happens to land on zero is
 * not a request to empty the vault.
 */
export async function distributeMaximumFromVault(params: {
  client: VaultAdminClient;
  vault: VaultAddress;
  now?: () => number;
}): Promise<TransferOutcome> {
  const at = (params.now ?? Date.now)();
  return run("vaultDistribute", at, () =>
    params.client.vaultDistribute({ vaultAddress: params.vault, usd: 0 })
  );
}

/**
 * Whether this user leads the vault, by address rather than by list membership.
 *
 * For a `vaultDetails` response, which names its leader directly. Cheaper than
 * `leadingVaults` when the details are already in hand — and it works for a
 * **closed** vault, which `leadingVaults` omits entirely.
 */
export function leadsVault(vault: { leader: Hex }, user: string): boolean {
  return sameAddress(vault.leader, user);
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Creating a vault is the most expensive and least reversible action in this
 * module, and its numbers are not close to anything else here:
 *
 * - **A 10,000 USDC gas fee**, one-off, documented rather than measured —
 *   because measuring it costs $10,000. An underfunded testnet attempt is
 *   refused with a bare `"Insufficient balance to create vault"` that names no
 *   figure, so the wire does not confirm it either.
 * - **A 100 USDC minimum initial deposit**, which the SDK enforces before the
 *   request leaves: `"Invalid value: Expected >=100000000 but received 5000000"`.
 * - **The name and description can NEVER be changed.** `vaultModify` alters only
 *   `allowDeposits` and `alwaysCloseOnWithdraw`; there is no rename anywhere in
 *   the API. A typo is permanent, on a vault that cost $10,000.
 * - **The leader must keep at least 5% of the vault** afterwards, and cannot
 *   withdraw below it.
 *
 * Hence the ticket: the fee, the amount and the permanent text must be echoed
 * back before anything is signed. Same shape as the deposit preflight, for the
 * same reason — except that here a caller who never displayed the fee literally
 * cannot construct the echo.
 */

/** C0 and C1 controls. A vault name is one line in a picker, not a document. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

function canonicalText(input: string, bounds: { min: number; max: number; what: string }): string {
  const text = input.trim();
  if (CONTROL_CHARS.test(text)) {
    throw new HlError(`A vault ${bounds.what} cannot contain control characters`, {
      code: "validation_error",
      context: { reason: "control_chars" },
    });
  }
  // UTF-16 code units, matching valibot — an emoji counts twice, so a name that
  // looks short enough to a user can still be refused.
  if (text.length < bounds.min || text.length > bounds.max) {
    throw new HlError(
      `A vault ${bounds.what} must be ${bounds.min}-${bounds.max} characters; "${text}" counts as ${text.length}`,
      { code: "validation_error", context: { reason: "length", units: text.length } }
    );
  }
  return text;
}

/**
 * The only producer of `VaultName`.
 *
 * Does **not** Unicode-normalise, for the reason the sub-account name check does
 * not: NFC can change the code-unit count that was just validated, so the string
 * checked would not be the string sent.
 */
export function canonicalVaultName(input: string): VaultName {
  return canonicalText(input, {
    min: VAULT_NAME_MIN,
    max: VAULT_NAME_MAX,
    what: "name",
  }) as VaultName;
}

/** The only producer of `VaultDescription`. */
export function canonicalVaultDescription(input: string): VaultDescription {
  return canonicalText(input, {
    min: VAULT_DESCRIPTION_MIN,
    max: VAULT_DESCRIPTION_MAX,
    what: "description",
  }) as VaultDescription;
}

declare const CreateTicketBrand: unique symbol;

/**
 * Proof that the cost and the permanence were shown and confirmed.
 *
 * Branded with a module-private symbol, so `createVault` cannot be reached
 * without one. There is no cheaper guard available: the action carries no
 * `expiresAfter`, no cancel, and no way back.
 */
export interface CreateVaultTicket {
  readonly [CreateTicketBrand]: true;
  readonly name: VaultName;
  readonly description: VaultDescription;
  readonly initialUsd: MicroUsd;
  readonly confirmedAt: number;
}

/** What the caller must echo back. Every field is re-derived and compared. */
export interface CreateVaultEcho {
  /** The name displayed, verbatim. It can never be changed afterwards. */
  readonly nameDisplayed: string;
  /** The description displayed. Also permanent. */
  readonly descriptionDisplayed: string;
  /** The initial deposit displayed, in USDC as a decimal string. */
  readonly initialUsdcDisplayed: string;
  /**
   * The creation fee displayed, in USDC.
   *
   * Compared against `VAULT_CREATION_FEE_USDC`. A caller that never showed the
   * fee cannot produce this field, which closes by construction the hazard of a
   * user meeting a $10,000 charge only after it has been taken.
   */
  readonly feeUsdcDisplayed: string;
}

export interface CreateVaultPlan {
  name: VaultName;
  description: VaultDescription;
  /** In USDC, as a decimal string. Converted to micro-USD only inside the ticket. */
  initialUsdc: WireAmount;
}

function refuseCreate(detail: string): never {
  throw new HlError(`Vault creation refused: ${detail}`, {
    code: "not_authorized",
    context: { reason: "create_echo_mismatch" },
  });
}

/**
 * Turn a displayed plan into a ticket.
 *
 * The only producer of `CreateVaultTicket`. Throws rather than returning a
 * result, because a caller that ignores a returned error still holds the plan
 * and might proceed.
 */
export function confirmVaultCreation(
  plan: CreateVaultPlan,
  echo: CreateVaultEcho,
  now: number = Date.now()
): CreateVaultTicket {
  // Exact equality on the two permanent strings: the user will be stuck with
  // them, so it matters that these are the ones they actually read.
  if (echo.nameDisplayed !== plan.name) {
    refuseCreate("the displayed name does not match the one to be created.");
  }
  if (echo.descriptionDisplayed !== plan.description) {
    refuseCreate("the displayed description does not match the one to be created.");
  }
  // Numeric, not string: "100.00" and "100" are the same deposit.
  if (!amountsEqual(echo.initialUsdcDisplayed, plan.initialUsdc)) {
    refuseCreate("the displayed initial deposit does not match.");
  }
  if (!amountsEqual(echo.feeUsdcDisplayed, VAULT_CREATION_FEE_USDC)) {
    refuseCreate(`the ${VAULT_CREATION_FEE_USDC} USDC creation fee was not shown to the user.`);
  }
  if (new BigNumber(plan.initialUsdc).isLessThan(VAULT_CREATION_MIN_USDC)) {
    refuseCreate(`the initial deposit must be at least ${VAULT_CREATION_MIN_USDC} USDC.`);
  }

  logger.info("vault.creation_confirmed", {
    context: { initialUsdc: plan.initialUsdc, feeUsdc: VAULT_CREATION_FEE_USDC },
  });
  return {
    name: plan.name,
    description: plan.description,
    initialUsd: toMicroUsd(plan.initialUsdc),
    confirmedAt: now,
  } as CreateVaultTicket;
}

/** Tickets already spent, so one confirmation cannot create two vaults. */
const spentCreateTickets = new WeakSet<CreateVaultTicket>();

export interface CreatedVault {
  /**
   * The new vault, or `null` when the response could not be parsed.
   *
   * Not an error: the vault exists either way and `leadingVaults` will show it.
   * Reporting failure because a field moved is how someone pays the fee twice.
   */
  address: VaultAddress | null;
  name: VaultName;
}

export interface CreateVaultClient {
  createVault(params: { name: string; description: string; initialUsd: number }): Promise<unknown>;
}

/** Pull the new vault address out of `{ response: { data } }`, or `null`. */
export function readCreatedVaultAddress(raw: unknown): VaultAddress | null {
  if (typeof raw !== "object" || raw === null) return null;
  const response = (raw as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return null;
  const data = (response as { data?: unknown }).data;
  return typeof data === "string" && /^0x[0-9a-fA-F]{40}$/.test(data)
    ? (data.toLowerCase() as VaultAddress)
    : null;
}

/** `createVault` settles with an address, so it needs its own settled variant. */
export type CreateVaultOutcome =
  | { kind: "created"; value: CreatedVault; nonce: number }
  | { kind: "rejected_by_server"; reason: string }
  | { kind: "unknown"; error: HlError; nonce: number };

/**
 * Create a vault. **Agent-signable**, like every other vault action.
 *
 * Accepts only a `CreateVaultTicket`, so the fee and the permanence must have
 * been displayed and echoed. Single-use: the same ticket cannot create a second
 * vault, because there is no idempotency key and a duplicate costs another
 * 10,000 USDC.
 *
 * An `unknown` outcome means **re-list, never re-send** — `leadingVaults` shows
 * the vault if it landed.
 */
export async function createVault(params: {
  client: CreateVaultClient;
  ticket: CreateVaultTicket;
  now?: () => number;
}): Promise<CreateVaultOutcome> {
  const at = (params.now ?? Date.now)();
  const { ticket } = params;

  if (spentCreateTickets.has(ticket)) {
    throw new HlError("Vault creation refused: this ticket was already used", {
      code: "not_authorized",
      context: { reason: "ticket_replayed" },
    });
  }
  if (!Number.isFinite(ticket.confirmedAt) || ticket.confirmedAt <= 0) {
    throw new HlError("Vault creation refused: the ticket was never confirmed", {
      code: "not_authorized",
      context: { reason: "unconfirmed" },
    });
  }
  spentCreateTickets.add(ticket);

  let raw: unknown;
  try {
    raw = await params.client.createVault({
      name: ticket.name,
      description: ticket.description,
      initialUsd: ticket.initialUsd,
    });
  } catch (error) {
    const hl = toHlError(error, { stage: "createVault" });
    // A rejection the server articulated is a fact: no vault, no fee taken.
    if (hl.code === "api_error") {
      logger.warn("createVault.rejected", { error: hl });
      return { kind: "rejected_by_server", reason: hl.message };
    }
    logger.warn("createVault.unknown", { error: hl });
    return { kind: "unknown", error: hl, nonce: at };
  }

  const address = readCreatedVaultAddress(raw);
  if (address === null) logger.warn("vault.created_address_unparsed", {});
  logger.info("vault.created", { context: { hasAddress: address !== null } });
  return { kind: "created", value: { address, name: ticket.name }, nonce: at };
}
