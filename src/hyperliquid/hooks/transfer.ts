/**
 * Moving money between an account's own buckets.
 *
 * Shape mirrors `hooks/actions.ts`: a `busyKey`, a `lastError`, and an
 * `ActionResult` rather than a bare boolean, because the reason matters to what
 * the screen says next.
 *
 * ## Two signers, and the choice is not cosmetic
 *
 * `moveWithinAccount` uses `agentSendAsset` — the L1 phantom-agent scheme — so
 * it signs **silently**. That is the right path and the one this hook takes
 * whenever `canTrade` is true.
 *
 * Without an agent, `session.exchangeClient()` **throws**, so the fallback is
 * `classTransfer`, which is master-signed and pops the wallet. `moveView.ts`
 * decides which applies; this hook only executes it. A read-only session — what
 * the Portfolio screen deliberately starts — is the common case for the
 * fallback, not an edge case.
 *
 * ## Why the token is resolved, not hardcoded
 *
 * `WireToken` is a branded type produced only by `TokenCatalogue.wireToken`,
 * and the id differs per network. `transfers/types.ts` records why: **every
 * `spotSend` example in the SDK's own doc comments uses the testnet USDC id.**
 * A literal here would be a type error, which is the point.
 */

import { useCallback, useState } from "react";

import { requireUserPresence } from "@/hyperliquid/wallet/signer";
import { getInfoClient } from "@/hyperliquid/api/clients";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import { requireDestination } from "@/hyperliquid/transfers/destination";
import { classTransfer, moveWithinAccount } from "@/hyperliquid/transfers/transfer";
import { loadTokenCatalogue, type SpotMetaProbe } from "@/hyperliquid/transfers/tokens";
import { HlError, toHlError } from "@/hyperliquid/core/errors";
import type { TransferOutcome } from "@/hyperliquid/transfers/types";
import { log } from "@/hyperliquid/core/logger";
import { routeFor, type MoveDirection } from "@/components/money/moveView";
import type { HyperliquidSession } from "@/hyperliquid/session";

const logger = log.child("hooks.transfer");

export type MoveResult = { kind: "done"; note: string } | { kind: "failed"; error: HlError };

export interface MoveState {
  isBusy: boolean;
  lastError: HlError | null;
  /** The last successful move, for a confirmation the screen can clear. */
  lastNote: string | null;
}

export function useAccountMove(session: HyperliquidSession): {
  state: MoveState;
  move: (params: {
    direction: MoveDirection;
    amount: string;
    canTrade: boolean;
  }) => Promise<MoveResult>;
  clear: () => void;
} {
  const [state, setState] = useState<MoveState>({
    isBusy: false,
    lastError: null,
    lastNote: null,
  });

  const move = useCallback(
    async (params: {
      direction: MoveDirection;
      amount: string;
      canTrade: boolean;
    }): Promise<MoveResult> => {
      setState({ isBusy: true, lastError: null, lastNote: null });
      try {
        const current = session.state();
        if (!current) throw new Error("no session");

        const amount = canonicalAmount(params.amount, "amount");
        const route = routeFor(params.direction);

        if (params.canTrade) {
          // Agent-signed: no prompt. `exchangeClient()` throws without an
          // agent, which is why the caller must pass `canTrade` rather than
          // letting this discover it.
          const { catalogue, deferred } = await loadTokenCatalogue({
            probe: getInfoClient() as unknown as SpotMetaProbe,
            env: current.identity.env,
          });
          // `null` is the weight budget declining, not "no such token". Moving
          // on a guessed id would sign the wrong asset — `WireToken` exists to
          // make that impossible, so refuse instead.
          if (catalogue === null) {
            throw new Error(
              deferred ? "rate limit — try again in a moment" : "could not read the token list"
            );
          }
          const outcome = await moveWithinAccount({
            signer: "agent",
            client: session.exchangeClient(),
            // Self-only. `effectiveAddress` so a sub-account moves its OWN
            // buckets rather than the master's.
            owner: requireDestination(current.identity.subAccount ?? current.identity.address).wire,
            ...(current.identity.subAccount ? { fromSubAccount: current.identity.subAccount } : {}),
            from: route.from,
            to: route.to,
            token: catalogue.wireToken("USDC"),
            amount,
          });
          return settle(outcome, params, setState);
        }

        // Master-signed fallback — and it can only ever move the MASTER's money.
        //
        // `usdClassTransfer` is a USER-SIGNED action (`executeUserSignedAction`
        // in the SDK), so like `withdraw3` it carries no `vaultAddress` and
        // whoever signs is whose buckets move. With a sub-account selected this
        // silently shifted the master's USDC between perp and spot while the
        // screen said it was acting as the sub-account — the agent path above
        // gets this right via `fromSubAccount`, and only this fallback does not.
        //
        // Refused rather than routed, because there is nothing to route: the
        // action has no field for it. This is the same shape as the
        // `vault_acts_on_master_account` blocker, and the same reasoning —
        // acting on the wrong account is worse than not acting.
        const blocker = masterFallbackBlocker(current.identity.subAccount ?? null);
        if (blocker) throw blocker;

        // Same gate, same reason: user-signed, master key, silent signer.
        await requireUserPresence("transfer", {
          reason: `Move ${params.amount} USDC`,
          allowWithoutBiometry: true,
        });

        const outcome = await classTransfer({
          signer: "master",
          client: session.masterClient(),
          amount,
          toPerp: params.direction === "toPerp",
        });
        return settle(outcome, params, setState);
      } catch (caught) {
        const error = toHlError(caught);
        logger.warn("transfer.move_failed", { context: { direction: params.direction }, error });
        setState({ isBusy: false, lastError: error, lastNote: null });
        return { kind: "failed", error };
      }
    },
    [session]
  );

  return { state, move, clear: () => setState((s) => ({ ...s, lastError: null, lastNote: null })) };
}

/**
 * Why the master-signed fallback cannot serve a sub-account.
 *
 * `usdClassTransfer` is a USER-SIGNED action (`executeUserSignedAction` in the
 * SDK), so like `withdraw3` it carries no `vaultAddress` field at all and
 * whoever signs is whose buckets move. There is no routing to add — the wire
 * has nowhere to put it.
 *
 * Which makes silently proceeding the bug: with a sub-account selected the
 * fallback moved the MASTER's USDC between perp and spot while the screen said
 * it was acting as the sub-account. The agent-signed path above gets this right
 * through `fromSubAccount`; only the no-agent fallback did not.
 *
 * Refusing is the same call as the `vault_acts_on_master_account` blocker, for
 * the same reason: acting on the wrong account is worse than not acting. The
 * way out is real — approve trading for the sub-account and the agent path
 * handles it.
 *
 * Exported for Jest: the decision lives in a hook that cannot be mounted here.
 */
export function masterFallbackBlocker(subAccount: string | null): HlError | null {
  if (subAccount === null) return null;
  return new HlError(
    "Moving a sub-account's USDC needs trading approval — enable trading for this account first.",
    { code: "not_authorized" }
  );
}

/**
 * Turn a `TransferOutcome` into what the screen should say.
 *
 * Typed as the union itself, deliberately. The parameter used to be widened to
 * `{ kind: string; error?: unknown }`, which defeated the discriminant and let
 * a whole variant be handled wrongly with no type error: `rejected_by_server`
 * carries `reason`, NOT `error`, so `outcome.error ?? new Error(outcome.kind)`
 * fabricated an error out of the variant's own name, `classifySdkError` labelled
 * the plain Error `"unknown"`, and the danger caption read literally
 * "unknown: rejected_by_server" where the exchange's own sentence belonged.
 *
 * The fabricated code made it worse than losing the words: `unknown` is this
 * module's reserved term for "it may have landed, never retry", and it was
 * being shown on the one branch where nothing moved and a corrected retry is
 * safe. Three sibling hooks (`send.ts`, `withdraw.ts`, `vaults.ts`) all read
 * `outcome.reason`; this was the only one that did not.
 *
 * Exported for Jest — the substance of the hook.
 */
export function settle(
  outcome: TransferOutcome,
  params: { direction: MoveDirection; amount: string },
  setState: (state: MoveState) => void
): MoveResult {
  if (outcome.kind === "settled") {
    const note = `Moved ${params.amount} to ${params.direction === "toPerp" ? "perps" : "spot"}`;
    setState({ isBusy: false, lastError: null, lastNote: note });
    return { kind: "done", note };
  }

  if (outcome.kind === "unknown") {
    // Not a failure. The move may well have landed, and re-sending is a second
    // move rather than a retry — the same rule the withdrawal path documents.
    const note = "Not confirmed — check your balances before moving again";
    setState({ isBusy: false, lastError: null, lastNote: note });
    return { kind: "done", note };
  }

  // `rejected_locally` / `rejected_by_server`: nothing moved, so a corrected
  // re-attempt is legitimate here in a way it is not for `unknown`.
  //
  // `reason` is the only field the server-rejection variant carries, and it is
  // the exchange's own sentence — better copy than anything written here, and
  // the thing the user needs in order to correct the amount.
  const error =
    outcome.kind === "rejected_by_server"
      ? new HlError(outcome.reason, { code: "api_error" })
      : toHlError(outcome.error);
  setState({ isBusy: false, lastError: error, lastNote: null });
  return { kind: "failed", error };
}
