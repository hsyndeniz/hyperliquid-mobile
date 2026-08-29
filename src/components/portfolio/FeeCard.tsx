/**
 * What trading costs this account, and how much it traded lately.
 *
 * The web app's Fees card, sized for a phone: perps taker/maker, spot
 * taker/maker, and the 14-day volume, as the same uniform Surface tiles the
 * Activity card uses. Rates are the **published forward-looking** ones —
 * `fetchUserFees` is explicit that they step as the volume window rolls, and
 * that a "fees paid" total must come from fills instead (that figure lives on
 * the Activity card, deliberately separate).
 *
 * ## Only rendered when `ready`
 *
 * A fee card of skeletons earns no place on the screen, and a deferred read
 * must never render as 0.00% — a zero fee rate is a *claim*, and the weight
 * budget declining is not evidence for it. `null` in, nothing out.
 *
 * ## The effective rate, when it differs
 *
 * `effectiveTakerRate` (referral applied) shows as a caption under the taker
 * tile only when it differs from the published rate — repeating the same
 * number twice adds noise, and on a sub-account the referral never applies.
 */

import type { JSX } from "react";
import { View } from "react-native";
import { BigNumber } from "bignumber.js";
import { Card, Surface, Typography } from "heroui-native";

import { ProgressBar } from "heroui-native-pro";

import { compactUsd, nextFeeTier, rateAsPercent } from "@/components/portfolio/fetchedView";
import { UsdLabel } from "@/components/portfolio/primitives";
import type { UserFeeRates } from "@/hyperliquid/api/accountMeta";

function Tile({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <Surface variant="secondary" className="flex-1 gap-1 rounded-xl px-3 py-3">
      <Typography.Paragraph className="text-xs text-muted font-normal">
        {label}
      </Typography.Paragraph>
      {children}
    </Surface>
  );
}

export function FeeCard({ fees }: { fees: UserFeeRates | null }): JSX.Element | null {
  if (fees === null) return null;

  const effectiveDiffers =
    fees.referralApplies && !new BigNumber(fees.effectiveTakerRate).isEqualTo(fees.crossRate);
  // `null` past the top tier or with no ladder — the row simply disappears
  // rather than drawing a bar to a level that does not exist.
  const nextTier = nextFeeTier(fees.volume14d, fees.tiers);

  return (
    <Card className="gap-2">
      <View className="flex-row items-center justify-between">
        <Typography.Paragraph className="text-xs text-muted font-normal">Fees</Typography.Paragraph>
        <Typography.Paragraph className="text-xs text-muted font-normal">
          {/* Forward-looking, and said so: these step as the volume window
              rolls. What was PAID lives on the Activity card, from fills. */}
          current rates
        </Typography.Paragraph>
      </View>

      <View className="flex-row gap-2">
        <Tile label="Perps taker">
          <Typography.Paragraph className="text-sm font-semibold tabular-nums">
            {rateAsPercent(fees.crossRate)}
          </Typography.Paragraph>
          {effectiveDiffers ? (
            <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
              ~{rateAsPercent(fees.effectiveTakerRate)} with referral
            </Typography.Paragraph>
          ) : null}
        </Tile>
        <Tile label="Perps maker">
          <Typography.Paragraph
            className={
              // A negative maker rate is a REBATE — money earned per fill.
              fees.addRate.startsWith("-")
                ? "text-sm font-semibold tabular-nums text-success"
                : "text-sm font-semibold tabular-nums"
            }
          >
            {rateAsPercent(fees.addRate)}
          </Typography.Paragraph>
        </Tile>
      </View>

      <View className="flex-row gap-2">
        <Tile label="Spot taker">
          <Typography.Paragraph className="text-sm font-semibold tabular-nums">
            {rateAsPercent(fees.spotCrossRate)}
          </Typography.Paragraph>
        </Tile>
        <Tile label="Spot maker">
          <Typography.Paragraph className="text-sm font-semibold tabular-nums">
            {rateAsPercent(fees.spotAddRate)}
          </Typography.Paragraph>
        </Tile>
      </View>

      <View className="flex-row gap-2">
        <Tile label="14-day volume">
          <Typography.Paragraph className="text-sm font-semibold tabular-nums">
            <UsdLabel value={fees.volume14d} />
          </Typography.Paragraph>
        </Tile>
      </View>

      {nextTier !== null ? (
        <Surface variant="secondary" className="gap-2 rounded-xl px-3 py-3">
          <View className="flex-row items-center justify-between">
            <Typography.Paragraph className="text-xs text-muted font-normal">
              Next fee tier
            </Typography.Paragraph>
            <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
              {/* What the rung offers and costs: the taker rate it grants,
                  at the 14-day volume it requires. */}
              {rateAsPercent(nextTier.cross)} taker at {compactUsd(nextTier.cutoff)}
            </Typography.Paragraph>
          </View>
          <ProgressBar value={Number(nextTier.progress) * 100} size="sm">
            <ProgressBar.Track>
              <ProgressBar.TrackBackground />
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        </Surface>
      ) : null}
    </Card>
  );
}
