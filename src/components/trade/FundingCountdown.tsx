/**
 * The funding readout above the order book:
 *
 *   Funding / Countdown          ← dashed, the reference's "has a caveat" rule
 *   0.0013%  58:14
 *
 * Hyperliquid pays funding hourly ON the hour (UTC), so the target is a pure
 * function of the clock: {@link msToNextHour}. The device clock is the anchor;
 * NTP drift is seconds against a 60-minute period, and the wire sends no
 * server timestamp on `activeAssetCtx` frames to anchor better with. What the
 * countdown must never do is show `00:00` frozen — on reaching zero it wraps
 * to the next boundary by construction.
 *
 * The 1 s ticker lives HERE, in the leaf, so neither the book nor the ticket
 * re-renders every second — the parent passes a string and forgets.
 */

import type { JSX } from "react";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Typography } from "heroui-native";

import { countdownLabel, fundingPercentLabel, msToNextHour } from "@/components/trade/tradeView";
import { toBigNumber } from "@/hyperliquid/core/precision";

export function FundingCountdown({ funding }: { funding: string | null }): JSX.Element {
  const [label, setLabel] = useState(() => countdownLabel(msToNextHour(Date.now())));

  useEffect(() => {
    const timer = setInterval(() => {
      setLabel(countdownLabel(msToNextHour(Date.now())));
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  const rate = fundingPercentLabel(funding);
  const negative = funding !== null && toBigNumber(funding).isNegative();

  return (
    <View className="gap-0.5">
      <View className="self-start border-b border-dashed border-border">
        <Typography.Paragraph className="text-xs text-muted font-normal" numberOfLines={1}>
          Funding / Countdown
        </Typography.Paragraph>
      </View>
      <View className="flex-row items-center gap-1.5">
        <Typography.Paragraph
          className={`text-xs tabular-nums font-medium ${negative ? "text-danger" : "text-success"}`}
        >
          {rate}
        </Typography.Paragraph>
        <Typography.Paragraph className="text-xs tabular-nums font-medium">
          {label}
        </Typography.Paragraph>
      </View>
    </View>
  );
}
