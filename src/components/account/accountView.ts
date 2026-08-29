/**
 * Account screen logic — every string and tone the screen renders, computed
 * where Jest can reach it.
 *
 * The rules this module keeps are the module-wide ones, restated at the edge:
 *
 * - **`null` is "we could not read it", never "none".** `activated`,
 *   `subAccounts` and `ledVaults` all arrive nullable from a deferred weight
 *   budget or a failed read, and each renders as an explicit unknown. Showing
 *   "0 sub-accounts" to someone whose read failed teaches them they have none.
 * - **A wallet that exists but cannot be opened is its own state.** `locked`
 *   rendered as "no wallet" invites someone who already has funds to create a
 *   second wallet on top of them.
 * - **Tones are semantic, not decorative.** A `danger` here means money or
 *   access is at risk; `warning` means action is expected; `muted` means idle.
 */

import type { ConnectionState } from "@/hyperliquid/api/clients";
import type { AgentReadiness } from "@/hyperliquid/auth/session";
import type { WalletState } from "@/hyperliquid/wallet/accounts";

export type Tone = "success" | "warning" | "danger" | "muted";

export interface StatusLine {
  label: string;
  tone: Tone;
}

/** The session lifecycle, as the provider reports it. */
export function sessionPhase(status: "idle" | "starting" | "ready" | "error"): StatusLine {
  switch (status) {
    case "idle":
      return { label: "Signed out", tone: "muted" };
    case "starting":
      return { label: "Starting…", tone: "warning" };
    case "ready":
      return { label: "Live", tone: "success" };
    case "error":
      return { label: "Start failed", tone: "danger" };
  }
}

/**
 * Why an agent is not ready, in words a user can act on.
 *
 * `key_address_mismatch` is the subtle one: an agent IS approved on chain, but
 * its key is not the one this device holds — approving again is the fix, and
 * "not this device's" says that where "mismatch" does not.
 */
const AGENT_REASONS: Record<string, string> = {
  no_agents_registered: "none approved yet",
  no_local_key: "key not on this device",
  key_address_mismatch: "approved key is not this device's",
  expired: "expired",
};

/** The agent gate, one line. `null` before a session has run it. */
export function agentLine(agent: AgentReadiness | null): StatusLine {
  if (agent === null) return { label: "—", tone: "muted" };
  const status = agent.status;
  switch (status.kind) {
    case "ready":
      return { label: "Ready", tone: "success" };
    case "rotation_due":
      return { label: "Ready · rotation due", tone: "warning" };
    case "approval_required":
      return {
        label: `Approval required — ${AGENT_REASONS[status.reason] ?? status.reason}`,
        tone: "warning",
      };
  }
}

/**
 * The account-activation read. `null` stays "unknown": under a shared-IP 429
 * this read fails while the account is fine, and rendering that as "not
 * activated" tells a funded user to deposit — see `AgentReadiness.activated`.
 */
export function activatedLabel(activated: boolean | null): string {
  if (activated === null) return "unknown (read failed)";
  return activated ? "activated" : "not activated — deposit first";
}

/** A count that refuses to render a failed read as zero. */
export function countLabel(list: readonly unknown[] | null | undefined, started: boolean): string {
  if (!started) return "—";
  if (list == null) return "unknown (read failed)";
  return String(list.length);
}

/**
 * How loudly the weight gauge should speak.
 *
 * Green under half: the budget is doing its job silently. Warning from 50%:
 * bursts (a cold start is 62, a list refresh 42) start getting deferred soon.
 * Danger from 85%: the next real action is likely to be declined.
 */
export function budgetTone(used: number, limit: number): Tone {
  if (limit <= 0) return "muted";
  const ratio = used / limit;
  if (ratio >= 0.85) return "danger";
  if (ratio >= 0.5) return "warning";
  return "success";
}

/**
 * What the collapsed Connection header says.
 *
 * A section that has to be opened to find out whether anything is wrong is a
 * section nobody opens, so the trigger carries the one fact that matters — and
 * which fact that is depends on the state. **A socket that is not open beats a
 * quiet budget**: "659 / 1200" next to a terminated connection reads as
 * healthy, when the truth is that nothing is arriving at all. Once the socket
 * is up, the budget is the only thing left that can degrade the app, so it
 * takes the slot back.
 */
export function connectionMeasure(
  socket: ConnectionState,
  used: number,
  limit: number
): StatusLine {
  if (socket !== "open") return socketLine(socket);
  // The unit is part of the fact. `8 / 1000` alone is a bare fraction of
  // nothing — it reads as a count of connections, or messages, or anything
  // else the word "Connection" above it might imply. What it actually meters
  // is REQUEST WEIGHT per minute, and naming it is the difference between a
  // number the user can act on and one they scroll past.
  return { label: `${used} / ${limit} weight`, tone: budgetTone(used, limit) };
}

/**
 * What the collapsed Wallet header says.
 *
 * `warning` for a seeded wallet that is not backed up is the point of the
 * whole line: it is the only state here where the user must still *do*
 * something, and it stays visible without opening the section. An imported key
 * has no phrase to write down, so it is never nagged — "Backed up" would be a
 * claim about a backup this app never held.
 */
export function walletMeasure(state: WalletState | null): StatusLine {
  if (state === null) return { label: "Checking…", tone: "muted" };
  switch (state.kind) {
    case "none":
      return { label: "None", tone: "muted" };
    case "locked":
      return { label: "Locked", tone: "danger" };
    case "ready":
      if (state.metadata.kind !== "seeded") return { label: "Imported key", tone: "success" };
      return state.metadata.backedUp
        ? { label: "Backed up", tone: "success" }
        : { label: "Back up", tone: "warning" };
  }
}

export interface WalletLine {
  title: string;
  detail: string;
  tone: Tone;
}

/**
 * The wallet, as the launch decision the vault reports.
 *
 * `null` is the async read still in flight — the caller shows a skeleton, not
 * "no wallet". `locked` is deliberately alarming: the encrypted blobs exist
 * but the master key is unavailable, and creating a fresh wallet on top of
 * that state is the one move that makes it unrecoverable.
 */
export function walletLine(state: WalletState | null): WalletLine {
  if (state === null) return { title: "Checking…", detail: "", tone: "muted" };
  switch (state.kind) {
    case "none":
      return {
        title: "No wallet",
        detail: "Create one or import a key to begin.",
        tone: "muted",
      };
    case "locked":
      return {
        title: "Wallet locked",
        detail:
          "A wallet exists but its vault key is unavailable. Do not create a new one — restart the app first.",
        tone: "danger",
      };
    case "ready": {
      const count = state.metadata.accounts.length;
      return {
        title: state.metadata.kind === "seeded" ? "Recovery-phrase wallet" : "Imported key",
        detail: `${count} account${count === 1 ? "" : "s"} on this device`,
        tone: "success",
      };
    }
  }
}

/** The socket, as `getConnectionState` spells it. */
export function socketLine(state: ConnectionState): StatusLine {
  switch (state) {
    case "open":
      return { label: "Connected", tone: "success" };
    case "connecting":
      return { label: "Connecting…", tone: "warning" };
    case "idle":
      return { label: "Idle", tone: "muted" };
    case "terminated":
      return { label: "Terminated", tone: "danger" };
  }
}

/**
 * The two hex characters the avatar wears.
 *
 * After the `0x`, uppercased — enough to tell two wallets apart at a glance
 * without pretending to be an identicon.
 */
export function avatarLabel(address: string | null): string {
  if (address === null || address.length < 4) return "· ·";
  return address.slice(2, 4).toUpperCase();
}

/**
 * The recovery phrase as numbered words for the reveal grid.
 *
 * Split defensively on any whitespace run: a phrase is joined with single
 * spaces today, but a word grid that silently renders an empty cell on a
 * double space would miscount every word after it.
 */
export function phraseWords(phrase: string): { index: number; word: string }[] {
  return phrase
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word, at) => ({ index: at + 1, word }));
}

export type ImportKind = "privateKey" | "mnemonic" | "invalid";

/** BIP-39 phrase lengths. Any other word count cannot checksum. */
const MNEMONIC_LENGTHS = [12, 15, 18, 21, 24];

/**
 * What a pasted secret looks like, so ONE field can accept both.
 *
 * Classification only — `importPrivateKey` and `importMnemonic` still validate
 * for real (checksum, curve range). This exists so the screen can route the
 * paste and caption it, not so it can trust it. Exactly 64 hex characters is a
 * key; 63 is not "close", it is a truncated paste that must not be padded into
 * someone's almost-key.
 */
export function importKind(input: string): ImportKind {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "invalid";
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) return "privateKey";
  const words = trimmed.split(/\s+/).filter((word) => word.length > 0);
  if (MNEMONIC_LENGTHS.includes(words.length) && words.every((word) => /^[a-zA-Z]+$/.test(word))) {
    return "mnemonic";
  }
  return "invalid";
}

/** The live caption under the import field. */
export function importCaption(kind: ImportKind, input: string): string {
  if (input.trim().length === 0) return "A 64-character private key, or a 12–24 word phrase.";
  switch (kind) {
    case "privateKey":
      return "Looks like a private key.";
    case "mnemonic":
      return `Looks like a ${input.trim().split(/\s+/).length}-word recovery phrase.`;
    case "invalid":
      return "Not a private key or recovery phrase yet.";
  }
}

/**
 * Tone → class name.
 *
 * Complete literal class names, not template fragments — Uniwind discovers
 * classes by scanning source for literals, and a computed `bg-${tone}` would
 * silently compile to nothing.
 *
 * They live beside the `Tone` they key rather than in a component file: five
 * screens import them, and a component file that also exports plain values
 * cannot keep component state across a Fast Refresh.
 */
export const TONE_DOT: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  muted: "bg-muted",
};

export const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-muted",
};
