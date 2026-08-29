/**
 * The builder-fee approval prompt.
 *
 * **Deliberately undesigned.** Plain HeroUI Native primitives, no layout
 * opinions, no copywriting beyond what is legally necessary to say. It exists so
 * the approval can actually be given — without it the feature is unreachable —
 * and it is meant to be replaced wholesale once there is a design.
 *
 * What it must not lose in that replacement:
 *
 * - **The rate is shown before the signature.** The user is agreeing to a fee on
 *   every future order; a prompt that does not name the number is not consent.
 * - **`unknown` never offers to sign again.** The approval may have landed, and a
 *   second prompt asks the user to approve something they may already have.
 *   Re-reading is the only safe move, so that branch offers only a re-check.
 * - **Nothing renders when the status is `disabled` or `approved`.** A prompt
 *   that lingers after approval trains people to dismiss it.
 */

import type { JSX } from "react";
import { View } from "react-native";
import { Button, Card, Typography } from "heroui-native";

import type { BuilderFeeState } from "@/hyperliquid/hooks/builderFee";

export interface BuilderFeeApprovalProps {
  state: BuilderFeeState;
}

export function BuilderFeeApproval({ state }: BuilderFeeApprovalProps): JSX.Element | null {
  const { status, rate, approve, refresh } = state;

  if (status === "disabled" || status === "approved" || status === "loading") return null;

  if (status === "unknown") {
    return (
      <Card className="gap-3">
        <Typography.Paragraph className="font-normal">
          Your approval was sent but we could not confirm it. Check again rather than approving
          twice.
        </Typography.Paragraph>
        <Button onPress={() => void refresh()}>
          <Button.Label className="font-medium">Check again</Button.Label>
        </Button>
      </Card>
    );
  }

  return (
    <Card className="gap-3">
      <Typography.Paragraph className="font-normal">
        This app charges a {rate} fee on each order. Approving lets it be applied; you can trade
        without approving.
      </Typography.Paragraph>
      {status === "declined" ? (
        <Typography.Paragraph className="text-danger font-normal">
          Not approved.
        </Typography.Paragraph>
      ) : null}
      <View className="flex-row gap-2">
        <Button onPress={() => void approve()} isDisabled={status === "approving"}>
          <Button.Label className="font-medium">
            {status === "approving" ? "Waiting for signature…" : `Approve ${rate}`}
          </Button.Label>
        </Button>
      </View>
    </Card>
  );
}
