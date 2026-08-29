/**
 * The session — what is signed in, as what, and the controls that need a
 * choice. The body of the Account screen's Session section: `AccountSection`
 * supplies the surface, the title, and the collapsed phase measure, and the
 * plain sign-in/sign-out pair lives in the hero above, so what remains here is
 * the nuanced control — approving an agent, which costs a signature.
 *
 * Every value here follows the module's null discipline: `subAccounts` and
 * `ledVaults` arrive `null` when the read failed and render as an explicit
 * unknown; `activated: null` likewise. The temptation this card resists is a
 * tidy "0" — see `accountView.ts` for why each of those is a lie.
 *
 * "Acting as" shows the SESSION's address — the sub-account when one is
 * selected — which is exactly why it can differ from the identity card above
 * it. That difference being visible is a feature, not a glitch.
 */

import type { JSX } from "react";
import { View } from "react-native";
import { Alert, Button, Typography } from "heroui-native";

import { activatedLabel, agentLine, countLabel } from "@/components/account/accountView";
import { InfoRow } from "@/components/account/primitives";
import { AddressText } from "@/components/money/AddressText";
import type { HlError } from "@/hyperliquid/core/errors";
import type { SessionState } from "@/hyperliquid/session";
import type { Hex } from "@/hyperliquid/types/domain";

export function SessionCard({
  status,
  error,
  sessionState,
  actingAs,
  busy,
  onStartApprove,
}: {
  status: "idle" | "starting" | "ready" | "error";
  error: HlError | null;
  sessionState: SessionState | null;
  actingAs: Hex | null;
  busy: boolean;
  /** Starts (or re-gates) the session WITH an agent approval signature. */
  onStartApprove: () => void;
}): JSX.Element {
  const agent = agentLine(sessionState?.agent ?? null);
  const started = sessionState !== null;

  return (
    <View className="gap-3">
      <View className="gap-2">
        <View className="flex-row items-start justify-between gap-4">
          <Typography.Paragraph className="text-sm text-muted font-normal">
            Acting as
          </Typography.Paragraph>
          {actingAs === null ? (
            <Typography.Paragraph className="text-sm font-normal">—</Typography.Paragraph>
          ) : (
            <AddressText
              address={actingAs}
              truncated
              className="text-sm tabular-nums font-normal"
            />
          )}
        </View>
        <InfoRow label="Agent" value={agent.label} tone={agent.tone} />
        <InfoRow
          label="Account"
          value={started ? activatedLabel(sessionState.agent.activated) : "—"}
        />
        <InfoRow label="Sub-accounts" value={countLabel(sessionState?.subAccounts, started)} />
        <InfoRow label="Led vaults" value={countLabel(sessionState?.ledVaults, started)} />
      </View>

      {error === null ? null : (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title className="font-semibold">Last start failed</Alert.Title>
            <Alert.Description className="font-normal">
              {error.code}: {error.message}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {/* Only the agent gate lives here; plain sign-in/sign-out is a hero
          action. A live read-only session can still need the gate, so the
          button appears without making the user sign out first — and when the
          agent is already ready there is nothing left to offer. */}
      {status === "ready" ? (
        sessionState !== null && sessionState.agent.status.kind !== "ready" ? (
          <Button
            size="sm"
            variant="secondary"
            onPress={onStartApprove}
            isDisabled={busy}
            className="self-start"
          >
            <Button.Label className="font-medium">Approve agent</Button.Label>
          </Button>
        ) : null
      ) : (
        <Button
          size="sm"
          variant="secondary"
          onPress={onStartApprove}
          isDisabled={busy || status === "starting"}
          className="self-start"
        >
          <Button.Label className="font-medium">Sign in & approve agent</Button.Label>
        </Button>
      )}
    </View>
  );
}
