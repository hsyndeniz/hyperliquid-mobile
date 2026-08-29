/**
 * Creating and renaming sub-accounts.
 *
 * Both are **L1 actions, and the agent key may sign them** — measured, not
 * assumed, and the opposite of what the transfer family taught. `withdraw3` and
 * friends are user-signed, so an agent signature there acts on the *agent's* own
 * address; these resolve through the L1 phantom-agent scheme to the agent's
 * master instead. A `subAccountModify` signed by a freshly approved agent
 * answered `"Sub-account 0x…dead is not registered to 0x5bf8…4347"` — naming the
 * master, not the agent — byte-identical to the master-signed attempt.
 *
 * So creating, renaming and funding a sub-account costs **no wallet prompt**
 * once an agent exists. Route them through the agent-backed exchange client;
 * reserving them for the master wallet would add an interruption the protocol
 * does not ask for.
 *
 * Three more things measured against live testnet rather than assumed:
 *
 * 1. **Creation is gated on traded volume**, and the gate catches almost
 *    everyone. A fresh account gets
 *    `"Cannot create sub-accounts until enough volume traded. Required: $100000.
 *    Traded: $0."` — an `ApiRequestError` that, unhandled, surfaces as an opaque
 *    string next to a button the user just pressed. The numbers are in the
 *    message, so the honest thing is to show them.
 * 2. **There is no client-side precondition available.** `userFees` returns
 *    `dailyUserVlm` — 15 days, not lifetime — and no other info endpoint carries
 *    a cumulative figure. Computing one from 15 days would be a guess presented
 *    as a fact, so this module does not gate; it explains the refusal after it
 *    happens.
 * 3. **The name limit is UTF-16 code units.** Nine emoji is nine characters and
 *    eighteen units: the SDK's own validator answers
 *    `"Invalid length: Expected <=16 but received 18"`. That is technically
 *    correct and useless to a user, which is why `canonicalSubAccountName` runs
 *    first and says which name and how long.
 *
 * The allowance is scarce — ten sub-accounts at $100k volume, one more per
 * additional $100M, capped at fifty — so a blind retry after a lost response is
 * not merely untidy, it can spend a slot the user cannot get back. Hence
 * `expiresAfter` on both actions and a `kind: "unknown"` that says *re-list*,
 * never *re-send*.
 */

import { serverNow } from "@/hyperliquid/core/clock";
import { HlError, toHlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import {
  SUB_ACCOUNT_NAME_MAX,
  type SubAccountName,
  type SubAccountSummary,
} from "@/hyperliquid/subaccounts/types";
import type { Hex } from "@/hyperliquid/types/domain";

const logger = log.child("subaccounts.manage");

/**
 * How long a signed create/rename stays valid.
 *
 * Longer than the 30 s used for orders because the master signature may involve
 * a wallet round-trip the user has to physically approve, and an expiry that
 * fires mid-approval turns a working flow into a mystery. Short enough that a
 * request stalled in the network cannot land minutes later, after the user has
 * given up and pressed the button again — which for a create would burn a second
 * slot out of ten.
 */
export const SUB_ACCOUNT_ADMIN_EXPIRY_MS = 120_000;

/** The slice of `ExchangeClient` this module needs, so tests need no network. */
export interface SubAccountAdminClient {
  createSubAccount(params: { name: string }, opts?: { expiresAfter?: number }): Promise<unknown>;
  subAccountModify(
    params: { subAccountUser: string; name: string },
    opts?: { expiresAfter?: number }
  ): Promise<unknown>;
}

/**
 * Why the server refused, as far as its prose can be trusted.
 *
 * **Presentation only.** `core/errors` forbids branching on message text because
 * Hyperliquid's strings are not a contract, and that rule holds here: the
 * `HlError.code` stays `api_error`, nothing retries or gates on this value, and
 * no state depends on it. All a rename upstream can do is degrade this to
 * `"other"`, which shows the server's own sentence — visibly no worse than not
 * having classified it at all.
 */
export type SubAccountFailure =
  /** Lifetime traded volume is below the threshold for a first sub-account. */
  | { kind: "insufficient_volume"; requiredUsd: string | null; tradedUsd: string | null }
  /** The volume-scaled allowance is used up. */
  | { kind: "limit_reached" }
  | { kind: "other" };

const VOLUME_REFUSAL = /volume traded/i;
const LIMIT_REFUSAL = /too many sub-?accounts|sub-?account limit/i;
/** `Required: $100000. Traded: $0.` — both groups optional by construction. */
const VOLUME_FIGURES = /required:\s*\$?([0-9][0-9,._]*)[^0-9]+traded:\s*\$?([0-9][0-9,._]*)/i;

function digitsOnly(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,_]/g, "").replace(/\.$/, "");
  return /^[0-9]+(\.[0-9]+)?$/.test(cleaned) ? cleaned : null;
}

/** Best-effort reading of a server refusal. See `SubAccountFailure`. */
export function classifySubAccountFailure(reason: string): SubAccountFailure {
  if (LIMIT_REFUSAL.test(reason)) return { kind: "limit_reached" };
  if (VOLUME_REFUSAL.test(reason)) {
    const figures = VOLUME_FIGURES.exec(reason);
    return {
      kind: "insufficient_volume",
      requiredUsd: digitsOnly(figures?.[1]),
      tradedUsd: digitsOnly(figures?.[2]),
    };
  }
  return { kind: "other" };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** C0 and C1 controls. A name is one line of text in a picker, not a document. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * The only producer of `SubAccountName`.
 *
 * Counts **UTF-16 code units**, because that is what the wire counts: `"🙂"` is
 * one character to a user, two units to the schema, and a nine-emoji name is
 * rejected at eighteen. Counting `[...name].length` here would let such a name
 * through to a signature that then fails.
 *
 * Deliberately does **not** Unicode-normalise. NFC can change the unit count, so
 * normalising would mean validating one string and signing another — the exact
 * gap this module exists to close. Trimming is the one edit made, and the
 * trimmed string is both what is counted and what is sent.
 */
export function canonicalSubAccountName(input: string): SubAccountName {
  const name = input.trim();

  if (name.length === 0) {
    throw new HlError("A sub-account name cannot be empty", {
      code: "validation_error",
      context: { reason: "empty" },
    });
  }
  if (CONTROL_CHARS.test(name)) {
    throw new HlError("A sub-account name cannot contain control characters", {
      code: "validation_error",
      context: { reason: "control_chars" },
    });
  }
  if (name.length > SUB_ACCOUNT_NAME_MAX) {
    // The length is in the message because the user cannot see code units and
    // will otherwise count characters and conclude the app is broken.
    throw new HlError(
      `A sub-account name may be at most ${SUB_ACCOUNT_NAME_MAX} characters; "${name}" counts as ${name.length}`,
      {
        code: "validation_error",
        context: { reason: "too_long", units: name.length, max: SUB_ACCOUNT_NAME_MAX },
      }
    );
  }
  return name as SubAccountName;
}

/**
 * Whether a name is already taken, ignoring case.
 *
 * Hyperliquid permits duplicates; this is here so a picker can warn rather than
 * present two indistinguishable rows. Never enforced — refusing a name the
 * exchange would accept is not this module's call.
 */
export function isDuplicateSubAccountName(
  subAccounts: readonly SubAccountSummary[],
  name: string,
  /** Excluded from the comparison, so renaming an account to its own name is fine. */
  exceptAddress?: string
): boolean {
  const wanted = name.trim().toLowerCase();
  const skip = exceptAddress?.toLowerCase();
  return subAccounts.some(
    (account) => account.address !== skip && account.name.trim().toLowerCase() === wanted
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * The result of a create or rename.
 *
 * `unknown` means the action was signed and sent and its fate is genuinely
 * unresolved. The remedy is **re-list, never re-send**: unlike a transfer, the
 * truth is one `subAccounts2` call away, and unlike a transfer a blind retry
 * here can consume a second slot from an allowance that starts at ten.
 */
export type SubAccountAdminOutcome<T> =
  | { kind: "settled"; value: T }
  | { kind: "rejected_locally"; error: HlError }
  | { kind: "rejected_by_server"; reason: string; failure: SubAccountFailure }
  | { kind: "unknown"; error: HlError; nonce: number };

/** The address of a freshly created sub-account, when the response carried one. */
export interface CreatedSubAccount {
  /**
   * `null` when the response did not parse.
   *
   * Not an error: the sub-account exists either way, and `subAccounts2` will
   * show it. Treating an unparsed address as a failure is how a real
   * sub-account gets created and then reported as not created.
   */
  address: Hex | null;
  name: SubAccountName;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Pull the new address out of `{ response: { data } }`, or `null`. */
export function readCreatedAddress(raw: unknown): Hex | null {
  if (typeof raw !== "object" || raw === null) return null;
  const response = (raw as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return null;
  const data = (response as { data?: unknown }).data;
  return typeof data === "string" && ADDRESS.test(data) ? (data.toLowerCase() as Hex) : null;
}

async function run<T>(
  label: string,
  nonceAt: number,
  call: () => Promise<T>
): Promise<SubAccountAdminOutcome<T>> {
  try {
    return { kind: "settled", value: await call() };
  } catch (error) {
    const hl = toHlError(error, { stage: label });
    // A rejection the server articulated is a fact: nothing changed, and the
    // caller can act on the reason. Anything else — a dropped socket, a timeout
    // — leaves a validly signed action that may still land.
    if (hl.code === "api_error") {
      const failure = classifySubAccountFailure(hl.message);
      logger.warn(`${label}.rejected`, { context: { failure: failure.kind }, error: hl });
      return { kind: "rejected_by_server", reason: hl.message, failure };
    }
    if (hl.code === "validation_error") {
      logger.warn(`${label}.invalid`, { error: hl });
      return { kind: "rejected_locally", error: hl };
    }
    logger.warn(`${label}.unknown`, { error: hl });
    return { kind: "unknown", error: hl, nonce: nonceAt };
  }
}

/**
 * Create a sub-account. Agent-signable — no wallet prompt.
 *
 * Fails for most accounts — see the volume gate at the top of this file — so a
 * caller must render `rejected_by_server` properly rather than treating creation
 * as a formality.
 */
export async function createSubAccount(params: {
  client: SubAccountAdminClient;
  name: SubAccountName;
  now?: () => number;
}): Promise<SubAccountAdminOutcome<CreatedSubAccount>> {
  const at = (params.now ?? Date.now)();

  const outcome = await run("createSubAccount", at, () =>
    params.client.createSubAccount(
      { name: params.name },
      { expiresAfter: serverNow(at) + SUB_ACCOUNT_ADMIN_EXPIRY_MS }
    )
  );
  if (outcome.kind !== "settled") return outcome;

  const address = readCreatedAddress(outcome.value);
  if (address === null) {
    // Logged, not thrown: the account was created. The caller re-lists.
    logger.warn("createSubAccount.address_unparsed", { context: { name: params.name } });
  }
  logger.info("subaccount.created", { context: { hasAddress: address !== null } });
  return { kind: "settled", value: { address, name: params.name } };
}

/**
 * Rename a sub-account. Agent-signable — no wallet prompt.
 *
 * The name is the only mutable attribute a sub-account has. The response is a
 * bare `{ type: "default" }` carrying nothing, so `settled` means *the server
 * accepted it*, and a caller that displays names must re-list rather than
 * assume its local copy is now right.
 */
export async function renameSubAccount(params: {
  client: SubAccountAdminClient;
  /** Must be one of this master's own — check with `assertOwnedSubAccount` first. */
  subAccount: Hex;
  name: SubAccountName;
  now?: () => number;
}): Promise<SubAccountAdminOutcome<null>> {
  const at = (params.now ?? Date.now)();

  const outcome = await run("subAccountModify", at, () =>
    params.client.subAccountModify(
      { subAccountUser: params.subAccount, name: params.name },
      { expiresAfter: serverNow(at) + SUB_ACCOUNT_ADMIN_EXPIRY_MS }
    )
  );
  if (outcome.kind !== "settled") return outcome;

  logger.info("subaccount.renamed");
  return { kind: "settled", value: null };
}
