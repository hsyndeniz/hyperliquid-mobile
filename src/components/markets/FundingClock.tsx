/**
 * Time until the next funding payment, as a suffix.
 *
 * Hyperliquid pays funding hourly ON the hour (UTC), so the target is a pure
 * function of the clock — no wire field carries it. The rate alone answers
 * "how much"; this answers "when", which is the half that decides whether a
 * position is worth holding through the next hour.
 *
 * The 1 s ticker lives HERE, in the leaf. The market screen is already
 * re-rendering on a live price; adding a second-resolution clock to it would
 * make every row on the screen a per-second render for one changing label.
 */

import type { JSX } from "react";
import { useEffect, useState } from "react";
import { Typography } from "heroui-native";

import { countdownLabel, msToNextHour } from "@/components/trade/tradeView";

export function FundingClock(): JSX.Element {
  const [label, setLabel] = useState(() => countdownLabel(msToNextHour(Date.now())));

  useEffect(() => {
    const timer = setInterval(() => {
      setLabel(countdownLabel(msToNextHour(Date.now())));
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Typography.Paragraph className="text-base text-muted tabular-nums font-normal">
      {`(${label})`}
    </Typography.Paragraph>
  );
}
