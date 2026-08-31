/**
 * A market's identity and its price — split across the native header and the
 * page (2026-08-31).
 *
 * These were one in-page row. Once the market screen became an ordinary push
 * it grew a platform header too, and the two said the same thing: a nav bar
 * reading "ETH" directly above a line reading "ETH-USDC · Perpetual". So the
 * IDENTITY moved up into the bar — {@link MarketHeaderTitle} as the title,
 * {@link MarketHeaderStar} as the right item — and the page kept only the
 * numbers, as {@link MarketPriceHero}.
 *
 * **The split follows what ticks.** The bar's contents are fixed for a given
 * market, so they are set once through `setOptions` and never again; the price
 * changes several times a second and stays in the page, where a re-render is
 * ordinary React rather than a trip across to a native navigation item.
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

/** Sized for a navigation bar, which is ~44pt tall in total. */
const TITLE_BADGE_PX = 26;
const STAR_PX = 22;

/** What the instrument IS, in the venue's own words. */
const KIND_LABEL = {
  perp: "Perpetual",
  spot: "Spot",
  prediction: "Prediction",
} as const;

/** The navigation bar's title: artwork, pair, and what the instrument is. */
export function MarketHeaderTitle({
  wireCoin,
  symbol,
  kind,
}: {
  /** Wire spelling — what the icon resolves from. */
  wireCoin: string;
  /** Display symbol: `BTC`, `HYPE`, or a prediction's question. */
  symbol: string;
  kind: "perp" | "spot" | "prediction";
}): JSX.Element {
  return (
    <View className="flex-row items-center gap-2">
      <CoinBadge
        coin={wireCoin}
        monogram={kind === "prediction" ? symbol : undefined}
        size={TITLE_BADGE_PX}
      />
      <View>
        {/* A prediction is a question, not a pair, so it is never suffixed.
            One line, truncated: a nav bar's title area is narrow and a
            question can be long. */}
        <Typography.Paragraph className="text-base font-semibold" numberOfLines={1}>
          {kind === "prediction" ? symbol : `${symbol}-USDC`}
        </Typography.Paragraph>
        <Typography.Paragraph className="text-xs text-muted font-normal">
          {KIND_LABEL[kind]}
        </Typography.Paragraph>
      </View>
    </View>
  );
}

/** The navigation bar's right item: pin this market. */
export function MarketHeaderStar({
  wireCoin,
  symbol,
}: {
  wireCoin: string;
  symbol: string;
}): JSX.Element {
  const [accent, muted] = useThemeColor(["accent", "muted"]);
  const favorites = useStoreValue(favoritesStore, (s) => s.read());
  const favorited = favorites.has(wireCoin);

  return (
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
  );
}

/** The page's own line: what the market is doing, and how fresh that is. */
export function MarketPriceHero({
  kind,
  price,
  isStale,
  changeLabel,
  trend,
}: {
  kind: "perp" | "spot" | "prediction";
  price: string | null;
  isStale: boolean;
  changeLabel: string | null;
  trend: "up" | "down" | "neutral" | null;
}): JSX.Element {
  return (
    <View className="flex-row items-center gap-2">
      {price === null ? (
        <Skeleton className="h-8 w-36 rounded-lg" />
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
            fontSize={28}
            weight="bold"
            rolling
          />
        </View>
      )}
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
  );
}
