/**
 * A market's identity, price and 24h move, on one line each.
 *
 * The layout is the point. A market screen answers two questions before any
 * other — *which market is this* and *what is it doing* — so identity sits on
 * the left (artwork, pair, what kind of instrument it is) and the numbers sit
 * on the right, right-aligned so the digits line up as they tick.
 *
 * The pair name carries the quote asset (`BTC-USDC`) rather than the bare
 * ticker: on a venue that lists the same base against different quotes, and
 * alongside prediction markets that are not pairs at all, `BTC` alone does not
 * say what is being priced.
 */

import type { JSX } from "react";
import { Pressable, View } from "react-native";
import { Chip, Skeleton, Typography, useThemeColor } from "heroui-native";
import { TrendChip } from "heroui-native-pro";
import { Star } from "lucide-react-native";

import { CoinBadge } from "@/components/portfolio/primitives";
import { FlashPrice } from "@/components/markets/FlashPrice";
import { favoritesStore } from "@/components/markets/favorites";
import { useStoreValue } from "@/hyperliquid/hooks/useStore";

/** Larger than a list row's mark — this is the screen's subject, not an item in it. */
const DETAIL_BADGE_PX = 44;
const STAR_PX = 22;

/** What the instrument IS, in the venue's own words. */
const KIND_LABEL = {
  perp: "Perpetual",
  spot: "Spot",
  prediction: "Prediction",
} as const;

export interface MarketDetailHeaderProps {
  /** Wire spelling — what favourites are keyed on, and what the icon resolves from. */
  wireCoin: string;
  /** Display symbol: `BTC`, `HYPE`, or a prediction's question. */
  symbol: string;
  kind: "perp" | "spot" | "prediction";
  price: string | null;
  isStale: boolean;
  changeLabel: string | null;
  trend: "up" | "down" | "neutral" | null;
}

export function MarketDetailHeader({
  wireCoin,
  symbol,
  kind,
  price,
  isStale,
  changeLabel,
  trend,
}: MarketDetailHeaderProps): JSX.Element {
  const [accent, muted] = useThemeColor(["accent", "muted"]);
  const favorites = useStoreValue(favoritesStore, (s) => s.read());
  const favorited = favorites.has(wireCoin);

  return (
    <View className="flex-row items-center gap-3">
      <CoinBadge
        coin={wireCoin}
        monogram={kind === "prediction" ? symbol : undefined}
        size={DETAIL_BADGE_PX}
      />

      <View className="flex-1 gap-0.5">
        <Typography.Paragraph className="text-lg font-semibold" numberOfLines={1}>
          {/* A prediction is a question, not a pair, so it is never suffixed. */}
          {kind === "prediction" ? symbol : `${symbol}-USDC`}
        </Typography.Paragraph>
        <Typography.Paragraph className="text-sm text-muted font-normal">
          {KIND_LABEL[kind]}
        </Typography.Paragraph>
      </View>

      <View className="items-end gap-0.5">
        {price === null ? (
          <Skeleton className="h-7 w-28 rounded-lg" />
        ) : (
          <View className={isStale ? "opacity-50" : ""}>
            {/* `rolling` — the one place NumberFlow earns its cost: a single
                hero price, on a screen the user is looking AT. List rows and the
                Markets tab render the cheap text variant, which is where the
                digit strips were actually hurting. Measured here at ~33 ms a
                commit in dev (~11 ms production), so it fits a frame — see
                `FlashPrice` for the numbers and the quantisation that keeps it
                from animating changes nobody can see. */}
            <FlashPrice
              value={price}
              isStale={isStale}
              asProbability={kind === "prediction"}
              fontSize={22}
              weight="bold"
              rolling
            />
          </View>
        )}
        <View className="flex-row items-center gap-1.5">
          {isStale ? (
            <Chip size="sm" color="warning" variant="soft">
              <Chip.Label className="font-medium">stale</Chip.Label>
            </Chip>
          ) : null}
          {changeLabel === null ? (
            <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
              --
            </Typography.Paragraph>
          ) : (
            <TrendChip size="sm" variant="soft" trend={trend ?? "neutral"}>
              <TrendChip.Value className="font-medium">{changeLabel}</TrendChip.Value>
            </TrendChip>
          )}
        </View>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${favorited ? "Unpin" : "Pin"} ${symbol}`}
        hitSlop={10}
        onPress={() => favoritesStore.toggle(wireCoin)}
      >
        <Star
          size={STAR_PX}
          color={favorited ? accent : muted}
          fill={favorited ? accent : "transparent"}
        />
      </Pressable>
    </View>
  );
}
