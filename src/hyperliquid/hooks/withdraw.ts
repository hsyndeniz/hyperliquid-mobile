/**
 * Quote → echo → ticket → `withdraw3`, as a screen can use it.
 *
 * The module below this hook is complete and tested. What was missing was a
 * production caller that passes the two optional `BuildQuoteParams` fields:
 *
 * - **`inFlightSince`** — without it the `withdrawal_in_flight` blocker can
 *   never fire, and the duplicate-withdrawal guard the journal exists for has
 *   simply never armed. `diagnostics.tsx` omits it, which is why the guard has
 *   no live evidence behind it.
 * - **`destinationProbe`** — without it every quote carries `checks_incomplete`,
 *   and `userExists === false`, the strongest typo signal available (14/14
 *   single-character substitutions, 9/9 transpositions, 30/30 random), is off.
 *
 * ## Master, not agent — and the accessor is the whole reason two exist
 *
 * `withdraw3` carries no `user` field, so the signature *is* the account
 * selector. An agent signature withdraws from the agent's own empty address and
 * succeeds. `session.masterClient()` signs with the master key — SILENTLY, so
 * the presence gate below is what makes this deliberate; `session.exchangeClient()` would
 * not, and that silence is exactly the hazard.
 *
 * ## `unknown` is not a failure, and offers no retry
 *
 * A withdrawal has no idempotency key and no cancel. Re-sending is a *second*
 * withdrawal. So `unknown` renders as "check the ledger" and the journal entry
 * deliberately stays unsettled, blocking the next attempt for the settlement
 * floor. The two `rejected_*` outcomes are different in kind — the module
 * settles the journal on both *because nothing moved* — so a corrected
 * re-attempt is legitimate there, and only there.
 */

import { useCallback, useEffect, useState } from "react";

import { getInfoClient } from "@/hyperliquid/api/clients";
import { checkDestination, type TransferMetaProbe } from "@/hyperliquid/api/transferMeta";
import { toHlError, type HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { identityKey } from "@/hyperliquid/core/identity";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import { validateDestination } from "@/hyperliquid/transfers/destination";
import { lastUnsettledAt } from "@/hyperliquid/transfers/journal";
import {
  buildWithdrawalQuote,
  confirmWithdrawal,
  type DestinationProbeResult,
  type WithdrawalEcho,
  type WithdrawalQuote,
} from "@/hyperliquid/transfers/preflight";
import { requireUserPresence } from "@/hyperliquid/wallet/signer";
import { submitWithdrawal, type WithdrawClient } from "@/hyperliquid/transfers/withdraw";
import { useQuoteBasis } from "@/hyperliquid/hooks/quoteBasis";
import { useSessionState } from "@/hyperliquid/hooks/session";
import type { ValidatedAddress } from "@/hyperliquid/transfers/types";
import type { HyperliquidSession, SessionState } from "@/hyperliquid/session";

const logger = log.child("hooks.withdraw");

/** How long after the last keystroke the destination is probed. */
const PROBE_DEBOUNCE_MS = 600;

export type WithdrawPhase =
  | { kind: "idle" }
  | { kind: "sending" }
  /** Signed and accepted. `arrives` is when, not whether. */
  | { kind: "sent"; nonce: number | null; net: string; arrivesAtMs: number }
  /**
   * Nothing moved — the only phase from which a corrected re-attempt is
   * legitimate, because both `rejected_*` outcomes settle the journal.
   */
  | { kind: "rejected"; message: string }
  /**
   * The signature may have landed. **No retry.** The journal entry stays
   * unsettled on purpose, so the next quote is blocked for the settlement floor.
   */
  | { kind: "unknown"; message: string };

export interface WithdrawInputs {
  destinationInput: string;
  amount: string;
  /** The server's own `withdrawable`. `null` until the first frame. */
  available: string | null;
}

export interface UseWithdraw {
  /**
   * `null` when the inputs cannot produce one — an empty or malformed amount.
   * A malformed *destination* still yields a quote, carrying the blocker that
   * says so, because that is what the screen needs to render.
   */
  quote: WithdrawalQuote | null;
  /** True while the destination probe is in flight. */
  isChecking: boolean;
  phase: WithdrawPhase;
  /** Throws nothing; failures land in `phase`. */
  submit: (echo: Omit<WithdrawalEcho, "acknowledged">) => Promise<void>;
  reset: () => void;
  /**
   * Restamp the quote's TTL and re-read the journal.
   *
   * Call it when an input changes and when the confirmation opens — the quote
   * is memoised against values the compiler can see, and neither the clock nor
   * the journal is one of them. See `useQuoteBasis` for what freezes without it.
   */
  refreshQuote: () => void;
}

export function useWithdraw(session: HyperliquidSession, inputs: WithdrawInputs): UseWithdraw {
  // The probe result is stored WITH the address it describes, and read back
  // only for that address. A bare result would survive an edit to the field and
  // vouch for a destination it never saw — which is the one thing this check
  // exists to prevent.
  const [probed, setProbed] = useState<{
    wire: string;
    result: DestinationProbeResult | null;
  } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [phase, setPhase] = useState<WithdrawPhase>({ kind: "idle" });

  // `useSessionState`, not `session.state()` in the render path: React Compiler
  // memoises a plain method call on a stable object and freezes it at whatever
  // it returned first. That bug emptied the Portfolio charts.
  const state = useSessionState(session);

  const destination = validateDestination(inputs.destinationInput);
  // A string, so it is a stable effect dependency — the result object is not.
  const wire: ValidatedAddress | null = destination.ok ? destination.value.wire : null;
  const sourceAddress = state?.identity.address ?? null;

  useEffect(() => {
    if (wire === null || sourceAddress === null) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      setChecking(wire);
      void checkDestination({
        probe: getInfoClient() as unknown as TransferMetaProbe,
        destination: wire,
        // Schema-required and verified not to affect the answer; the sender's
        // own address is the honest value to pass.
        source: sourceAddress,
      })
        .then((result) => {
          if (cancelled) return;
          // `null` is "we could not check", which the quote turns into the
          // `checks_incomplete` warning — deliberately not a green light.
          setProbed({ wire, result: result.value });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          logger.warn("withdraw.probe_failed", { error: toHlError(error) });
          setProbed({ wire, result: null });
        })
        .finally(() => {
          if (!cancelled) setChecking(null);
        });
    }, PROBE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wire, sourceAddress]);

  // Read back only for the address it describes.
  const probe = probed !== null && probed.wire === wire ? probed.result : null;
  const { basisMs, refresh } = useQuoteBasis();
  const quote = buildQuote(state, inputs, probe, basisMs);

  const submit = useCallback(
    async (echo: Omit<WithdrawalEcho, "acknowledged">): Promise<void> => {
      if (quote === null) return;
      setPhase({ kind: "sending" });
      try {
        // Throws unless every displayed value matches. The screen cannot get
        // here without having rendered them — `withdrawView.ts` builds the rows
        // and this echo from one expression.
        const ticket = confirmWithdrawal(quote, {
          ...echo,
          acknowledged: quote.warnings.map((w) => w.code),
        });

        // AFTER the ticket is confirmed, BEFORE anything is signed.
        //
        // `signer.ts` says the gate exists to sit "in front of the operations
        // that actually move money", and `GatedOperation` has declared
        // `"withdraw"` since it was written — but nothing ever called it, so
        // the only two gated operations in the app were reading the recovery
        // phrase and forgetting the wallet. A withdrawal was signed with the
        // in-vault master key with no authentication of any kind.
        //
        // The comment above `masterClient()` claimed it "prompts". That is only
        // true of an `interactive` signer, and `externalSigner()` has no call
        // sites: `signerFor` returns `localSigner` on both branches, which is
        // `kind: "silent"` — "the user sees nothing".
        //
        // Ordered here so a ticket that fails its own echo check costs no
        // prompt, and a cancel lands in the same `rejected` phase as any other
        // local refusal: nothing was sent.
        await requireUserPresence("withdraw", {
          reason: `Withdraw ${quote.amount.net} USDC`,
          // A phone with no lock screen still belongs to someone who needs
          // their own money — the same call `export_recovery_phrase` makes.
          allowWithoutBiometry: true,
        });

        const outcome = await submitWithdrawal({
          // MASTER. See the header — this is the whole reason two accessors exist.
          client: session.masterClient() as unknown as WithdrawClient,
          ticket,
        });

        if (outcome.kind === "settled") {
          setPhase({
            kind: "sent",
            nonce: outcome.nonce,
            net: quote.amount.net,
            arrivesAtMs: Date.now() + quote.timing.expectedArrivalMs,
          });
          return;
        }
        if (outcome.kind === "rejected_locally") {
          setPhase({ kind: "rejected", message: outcome.error.message });
          return;
        }
        if (outcome.kind === "rejected_by_server") {
          setPhase({ kind: "rejected", message: outcome.reason });
          return;
        }
        setPhase({ kind: "unknown", message: outcome.error.message });
      } catch (caught) {
        const error: HlError = toHlError(caught);
        logger.warn("withdraw.submit_failed", { error });
        // Reached only before `withdraw3` — a refused confirmation or a wallet
        // that would not sign. Nothing moved.
        setPhase({ kind: "rejected", message: error.message });
      }
    },
    [quote, session]
  );

  return {
    quote,
    isChecking: checking !== null && checking === wire,
    phase,
    submit,
    reset: useCallback(() => setPhase({ kind: "idle" }), []),
    refreshQuote: refresh,
  };
}

/**
 * The quote, or `null` when the amount is not yet a number.
 *
 * `canonicalAmount` throws on empty and on garbage, which is right for a signing
 * path and wrong for a field being typed into. A malformed *destination*, by
 * contrast, is passed straight through: `buildWithdrawalQuote` turns it into a
 * blocker, and a blocker is exactly what the screen should show.
 *
 * Exported because it is the whole substance of this hook, and the only way to
 * assert that `inFlightSince` is really wired without rendering — rendering
 * heroui under Jest pulls in Reanimated, Worklets and Skia and fails.
 */
export function buildQuote(
  state: SessionState | null,
  inputs: WithdrawInputs,
  probe: DestinationProbeResult | null,
  /**
   * The instant to stamp the quote's TTL against, and to read the journal at.
   * REQUIRED, and a value rather than a clock read inside: see `useQuoteBasis`
   * — a `Date.now()` in here is invisible to the compiler's memo key, which is
   * what froze this quote at the last keystroke.
   */
  basisMs: number
): WithdrawalQuote | null {
  if (!state || inputs.available === null) return null;

  let amount;
  let available;
  try {
    amount = canonicalAmount(inputs.amount);
    available = canonicalAmount(inputs.available);
  } catch {
    return null;
  }

  return buildWithdrawalQuote({
    now: () => basisMs,
    identity: state.identity,
    env: state.config.env,
    signerAddress: state.signer.address,
    ownerAddress: state.identity.address,
    destinationInput: inputs.destinationInput,
    amount,
    // The server's own figure. `accountValue - marginUsed` ignores resting-order
    // reservations and was wrong by $67k in Phase 6.
    available,
    confidence: "authoritative",
    ...(probe ? { destinationProbe: probe } : {}),
    // Never a withdrawal target: an agent address holds nothing.
    agentAddresses: state.agent.registeredAgents.map((a) => a.address),
    // The half that was missing. Scoped by identity, so another account's
    // outstanding withdrawal cannot block this one.
    inFlightSince: lastUnsettledAt(identityKey(state.identity)),
  });
}
