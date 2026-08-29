/**
 * Sending a spot token to another Hyperliquid account.
 *
 * ## Master-signed, and the screen must say so
 *
 * `spotSend` is a user-signed action — the agent scheme cannot carry it — so
 * this hook uses `session.masterClient()`. That signs SILENTLY — every signer
 * this app builds is `localSigner`, i.e. `kind: "silent"` — so the presence
 * gate in `submit` is what stands in front of it. `signerFor` in
 * `moveView.ts` records the standing rule: a control that silently prompts is
 * worse than one that warns it will.
 *
 * ## The token id is resolved, never assembled
 *
 * The wire wants `NAME:tokenId`, and every `spotSend` example in the SDK's own
 * docs uses the *testnet* USDC id — copying one onto mainnet signs a different
 * token. `TokenCatalogue.wireToken` is the only producer of the branded
 * `WireToken`, and refusing when the catalogue could not load is the designed
 * outcome: a guessed id validates cleanly and moves the wrong asset.
 *
 * ## `unknown` is not a failure and offers no retry
 *
 * Same rule as every transfer in this codebase: a send has no idempotency key,
 * so re-sending an unconfirmed one is a second send. The phase carries the
 * distinction so the screen cannot flatten it into "failed — try again".
 */

import { useCallback, useState } from "react";

import { requireUserPresence } from "@/hyperliquid/wallet/signer";
import { getInfoClient } from "@/hyperliquid/api/clients";
import { toHlError, type HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import { requireDestination } from "@/hyperliquid/transfers/destination";
import { sendSpotToAccount, type TransferClient } from "@/hyperliquid/transfers/transfer";
import { loadTokenCatalogue, type SpotMetaProbe } from "@/hyperliquid/transfers/tokens";
import type { HyperliquidSession } from "@/hyperliquid/session";

const logger = log.child("hooks.send");

export type SendPhase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; token: string; amount: string; destinationTail: string }
  /** Nothing moved; a corrected re-attempt is legitimate here, and only here. */
  | { kind: "rejected"; message: string }
  /** The signature may have landed. No retry — re-sending is a SECOND send. */
  | { kind: "unknown"; message: string };

export function useSend(session: HyperliquidSession): {
  phase: SendPhase;
  send: (params: { tokenName: string; amount: string; destination: string }) => Promise<void>;
  reset: () => void;
} {
  const [phase, setPhase] = useState<SendPhase>({ kind: "idle" });

  const send = useCallback(
    async (params: { tokenName: string; amount: string; destination: string }): Promise<void> => {
      setPhase({ kind: "sending" });
      try {
        const current = session.state();
        if (!current) throw new Error("no session");

        const amount = canonicalAmount(params.amount);
        const destination = requireDestination(params.destination);

        const { catalogue, deferred } = await loadTokenCatalogue({
          probe: getInfoClient() as unknown as SpotMetaProbe,
          env: current.identity.env,
        });
        // `null` is the weight budget declining, not "no such token". A guessed
        // id would sign the wrong asset, so refuse instead.
        if (catalogue === null) {
          throw new Error(
            deferred ? "rate limit — try again in a moment" : "could not read the token list"
          );
        }

        // The gate `GatedOperation` has always declared and nothing ever
        // called. `spotSend` is user-signed with the in-vault master key and
        // `localSigner` is `kind: "silent"`, so until now money left the
        // account with no authentication at all. See `hooks/withdraw.ts`.
        await requireUserPresence("transfer", {
          reason: `Send ${params.amount} ${params.tokenName}`,
          allowWithoutBiometry: true,
        });

        const outcome = await sendSpotToAccount({
          signer: "master",
          // MASTER: `spotSend` is user-signed; the agent cannot carry it.
          client: session.masterClient() as unknown as TransferClient,
          destination: destination.wire,
          token: catalogue.wireToken(params.tokenName),
          amount,
        });

        if (outcome.kind === "settled") {
          setPhase({
            kind: "sent",
            token: params.tokenName,
            amount: params.amount,
            destinationTail: destination.display.slice(-6),
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
        logger.warn("send.failed", { error });
        // Reached only before `spotSend` — validation or a wallet that would
        // not sign. Nothing moved.
        setPhase({ kind: "rejected", message: error.message });
      }
    },
    [session]
  );

  return { phase, send, reset: useCallback(() => setPhase({ kind: "idle" }), []) };
}
