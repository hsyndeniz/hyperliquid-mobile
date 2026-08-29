/**
 * The account's HYPE staking position — rendered ONLY when something is
 * non-zero.
 *
 * An account that has never staked reports genuine zeros (measured live), and
 * a card of zeros asserts nothing — so the gate is `stakingIsEmpty`, applied
 * by the caller, and this component trusts it was. Amounts are **HYPE**, the
 * native token, never dollars: valuing them needs a price this card has no
 * business fetching, and a `$` prefix on a HYPE amount would be wrong by the
 * token's whole price.
 */

import type { JSX } from "react";
import { View } from "react-native";
import { Card, Surface, Typography } from "heroui-native";

import type { DelegatorSummary } from "@/hyperliquid/api/accountMeta";

function Tile({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Surface variant="secondary" className="flex-1 gap-1 rounded-xl px-3 py-3">
      <Typography.Paragraph className="text-xs text-muted font-normal">
        {label}
      </Typography.Paragraph>
      <Typography.Paragraph className="text-sm font-semibold tabular-nums">
        {value}
      </Typography.Paragraph>
    </Surface>
  );
}

export function StakingCard({ summary }: { summary: DelegatorSummary }): JSX.Element {
  return (
    <Card className="gap-2">
      <View className="flex-row items-center justify-between">
        <Typography.Paragraph className="text-xs text-muted font-normal">
          Staking
        </Typography.Paragraph>
        <Typography.Paragraph className="text-xs text-muted font-normal">
          amounts in HYPE
        </Typography.Paragraph>
      </View>
      <View className="flex-row gap-2">
        <Tile label="Staked" value={summary.delegated} />
        <Tile label="Undelegated" value={summary.undelegated} />
      </View>
      {summary.pendingWithdrawalCount > 0 ? (
        <View className="flex-row gap-2">
          <Tile
            label={`Pending withdrawal · ${summary.pendingWithdrawalCount}`}
            value={summary.pendingWithdrawal}
          />
        </View>
      ) : null}
    </Card>
  );
}
