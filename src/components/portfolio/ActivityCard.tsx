/**
 * The account's numbers, one card: position state on top, trading activity
 * under it.
 *
 * Unrealized P&L and open positions used to live in their own two-column card
 * above this one — two cards carrying six numbers between them, each aligned
 * its own way. Merged, every figure is a uniform `Surface` tile in a two-column
 * grid: label top-left, value under it, identical padding. Alignment comes from
 * the tiles being the same shape, not from per-cell tweaks.
 *
 * Two things are stated on screen rather than left implied, because both would
 * otherwise be read as claims the data does not support:
 *
 * - **The scope.** "over N fills", not "all time". The fills store holds what
 *   the websocket pushed plus a REST seed; an account with years of history has
 *   far more than this.
 * - **Fees in other tokens.** The dollar figure is USDC only. When a fee was
 *   charged in something else — an outcome fill on this project's own account
 *   paid in `+102251` shares — the tokens are named, so `$0.10` never reads as
 *   the whole cost.
 *
 * A `null` win rate renders "--". It means nothing has been closed, which is
 * not the same as losing every trade, and 0% would say the latter.
 */

import type { JSX } from "react";
import { View } from "react-native";
import { Card, Chip, Surface, Typography } from "heroui-native";
import { TrendChip } from "heroui-native-pro";

import { UsdLabel } from "@/components/portfolio/primitives";
import { signColor, trendOf } from "@/components/common/display";
import type { ActivitySummary, CoinRealized } from "@/hyperliquid/hooks/activity";

/**
 * One tile: label on top, value under it, always left-aligned. Uniformity IS
 * the alignment — no cell gets its own layout.
 */
function Stat({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <Surface variant="secondary" className="flex-1 gap-1 rounded-xl px-3 py-3">
      <Typography.Paragraph className="text-xs text-muted font-normal">
        {label}
      </Typography.Paragraph>
      {children}
    </Surface>
  );
}

/** The default value rendering; tiles with chips or colour provide their own. */
function StatValue({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Typography.Paragraph className="text-sm font-semibold tabular-nums">
      {children}
    </Typography.Paragraph>
  );
}

export function ActivityCard({
  activity,
  scope,
  byCoin,
  unrealizedPnl,
  openPositions,
}: {
  activity: ActivitySummary;
  /**
   * What these numbers cover, stated by the caller who knows the source —
   * "all history · N fills" from a complete REST walk, "over N fills" from
   * the live store. `null` renders nothing (no fills to scope).
   */
  scope: string | null;
  /** Realised P&L per coin; `null` when only the windowed store is available. */
  byCoin: readonly CoinRealized[] | null;
  /** BigNumber-summed upstream; this component only displays. */
  unrealizedPnl: string;
  openPositions: number;
}): JSX.Element {
  const hasFills = activity.fillCount > 0;

  return (
    <Card className="gap-2">
      <View className="flex-row items-center justify-between">
        <Typography.Paragraph className="text-xs text-muted font-normal">
          Activity
        </Typography.Paragraph>
        {/* The scope, stated. Not "all time" unless it truly is. */}
        {scope !== null ? (
          <Typography.Paragraph className="text-xs text-muted font-normal">
            {scope}
          </Typography.Paragraph>
        ) : null}
      </View>

      <View className="flex-row gap-2">
        <Stat label="Unrealized P&L">
          <TrendChip trend={trendOf(unrealizedPnl)} variant="secondary" size="sm">
            <TrendChip.Indicator />
            <TrendChip.Value className="font-medium">
              {/* `UsdLabel`, not `Usd`: the chip already provides the text
                  node, and a nested one does not share its centring. */}
              <UsdLabel value={unrealizedPnl} signed />
            </TrendChip.Value>
          </TrendChip>
        </Stat>
        <Stat label="Open positions">
          <StatValue>{openPositions}</StatValue>
        </Stat>
      </View>

      {/* Nothing traded yet is not a zero-filled grid — the position row above
          still stands, and these four appear with the first fill. */}
      {hasFills ? (
        <>
          <View className="flex-row gap-2">
            <Stat label="Volume">
              <StatValue>
                <UsdLabel value={activity.volumeUsd} />
              </StatValue>
            </Stat>
            <Stat label="Fees">
              {/* Signed: a maker rebate is money earned and shows as negative. */}
              <StatValue>
                <UsdLabel value={activity.feesUsdc} signed />
              </StatValue>
            </Stat>
          </View>

          <View className="flex-row gap-2">
            <Stat label="Win rate">
              <StatValue>
                {activity.winRate === null
                  ? "--"
                  : `${(Number(activity.winRate) * 100).toFixed(0)}% · ${activity.wins}/${activity.closedCount}`}
              </StatValue>
            </Stat>
            <Stat label="Realised P&L">
              <Typography.Paragraph
                className={`text-sm font-semibold tabular-nums ${signColor(activity.realizedPnl)}`}
              >
                <UsdLabel value={activity.realizedPnl} signed />
              </Typography.Paragraph>
            </Stat>
          </View>
        </>
      ) : null}

      {byCoin !== null && byCoin.length > 0 ? (
        <View className="gap-1 pt-1">
          <Typography.Paragraph className="text-xs text-muted font-normal">
            Realised P&L by coin
          </Typography.Paragraph>
          {byCoin.map((row) => (
            <View key={row.coin} className="flex-row items-center justify-between">
              <Typography.Paragraph className="text-sm font-normal">
                {row.coin}
                <Typography.Paragraph className="text-xs text-muted font-normal">
                  {"  "}
                  {row.closedCount} close{row.closedCount === 1 ? "" : "s"}
                </Typography.Paragraph>
              </Typography.Paragraph>
              <Typography.Paragraph
                className={`text-sm tabular-nums font-medium ${signColor(row.pnl)}`}
              >
                <UsdLabel value={row.pnl} signed />
              </Typography.Paragraph>
            </View>
          ))}
        </View>
      ) : null}

      {activity.otherFeeTokens.length > 0 ? (
        <Chip size="sm" variant="soft" className="self-start">
          {/* Without this the USDC figure reads as the whole cost. */}
          <Chip.Label className="font-medium">
            fees also paid in {activity.otherFeeTokens.join(", ")} — not in the total
          </Chip.Label>
        </Chip>
      ) : null}
    </Card>
  );
}
