/**
 * The display leaves the portfolio screens share.
 *
 * Two rules hold across everything here, and both come from the module's own
 * conventions rather than from taste:
 *
 * - **`Number()` happens HERE and nowhere upstream.** Wire prices and sizes stay
 *   strings through every derivation; this file is the display leaf where they
 *   become numbers for `NumberValue` and chart points.
 * - **A wire coin is not a ticker.** `CoinBadge` goes through `theme/tokenIcon`,
 *   which knows about `xyz:BTC`, `@107`, `kPEPE` and `+102251`. Passing a raw
 *   coin to an icon lookup misses on every non-trivial market.
 */

import type { JSX } from "react";
import { View } from "react-native";
import { SvgAst } from "react-native-svg";
import { Avatar, Card, Skeleton, Typography } from "heroui-native";
import { EmptyState, NumberValue } from "heroui-native-pro";

import { displayNumber } from "@/components/common/display";
import { tokenIconAst, tokenMonogram } from "@/theme/tokenIcon";

/**
 * USD, standalone — renders its own text node.
 *
 * Use {@link UsdLabel} instead whenever this sits INSIDE a component that
 * already provides a text container (`TrendChip.Value`, `Chip.Label`,
 * `Typography.Paragraph`). With no children, `NumberValue` auto-renders its own
 * value node, so nesting it produces a text-inside-text whose inner line box
 * does not share the host's vertical centring — which is exactly why the P&L
 * figure sat off-centre in its chip.
 */
export function Usd({ value, signed = false }: { value: string; signed?: boolean }): JSX.Element {
  return (
    <NumberValue
      value={displayNumber(value)}
      numberStyle="currency"
      currency="USD"
      {...(signed ? { signDisplay: "exceptZero" as const } : {})}
    />
  );
}

/**
 * The same figure as a bare string, for use inside a host text container.
 *
 * `NumberValue`'s render-function form is documented as rendering **no wrapping
 * container**, so the host — the chip, the label — styles and centres the text
 * itself. That is the whole difference from {@link Usd}.
 */
export function UsdLabel({
  value,
  signed = false,
}: {
  value: string;
  signed?: boolean;
}): JSX.Element {
  return (
    <NumberValue
      value={displayNumber(value)}
      numberStyle="currency"
      currency="USD"
      {...(signed ? { signDisplay: "exceptZero" as const } : {})}
    >
      {(formatted) => formatted}
    </NumberValue>
  );
}

/**
 * Coin identity for a row: the token's own artwork, or a monogram.
 *
 * The fallback is not an error path — measured against live mainnet metadata,
 * only about half of Hyperliquid's perps have artwork in the icon set at all
 * (109 of 232 are simply absent). So the monogram has to sit beside a real
 * logo and look deliberate, which is why it is a themed `Avatar.Fallback`
 * rather than a broken-image slot.
 *
 * `SvgXml` takes the raw SVG string the package ships, so no Metro svg
 * transformer is involved on this path.
 *
 * `monogram` overrides the letters for a coin whose own spelling has none worth
 * showing: an outcome share is `+102251`, and "102" beside a holding is noise
 * where the side's initials ("NC" for *No Change*) at least identify the bet.
 */
/**
 * One size for BOTH branches of {@link CoinBadge}.
 *
 * They used to disagree: the SVG path was a hard 32px while the fallback used
 * `Avatar size="sm"`, which `avatar.css` defines as `--spacing * 10` = **40px**.
 * So a row with artwork and a row without sat 8px apart, and every column after
 * the badge inherited the misalignment.
 *
 * Declared here rather than as a class on each branch so the two cannot drift
 * again — a size is a property of the badge, not of which branch rendered.
 */
export const COIN_BADGE_PX = 32;

/**
 * Monogram size as a fraction of the badge — the ratio `text-xs` had at the
 * default, kept so a larger badge reads the same rather than smaller.
 */
const MONOGRAM_SCALE = 12 / COIN_BADGE_PX;

export function CoinBadge({
  coin,
  monogram,
  /**
   * Overrides the list size. A market's own screen leads with its identity and
   * wants a larger mark than a row does — the size is a property of the place
   * it is rendered, not of which branch below draws it.
   */
  size = COIN_BADGE_PX,
}: {
  coin: string;
  monogram?: string;
  size?: number;
}): JSX.Element {
  // Parsed once per icon and shared — `SvgXml` would re-parse the string on
  // every recycled mount. See `tokenIconAst`.
  const ast = tokenIconAst(coin);
  if (ast !== null) {
    return (
      <View className="overflow-hidden rounded-full" style={{ width: size, height: size }}>
        <SvgAst ast={ast} override={{ width: size, height: size }} />
      </View>
    );
  }
  // Initials of a multi-word override ("No Change" -> "NC"); otherwise its
  // first two letters, matching what `tokenMonogram` does for a ticker.
  const letters = monogram
    ? monogram
        .split(/\s+/)
        .map((word) => word[0] ?? "")
        .join("")
        .slice(0, 2)
        .toUpperCase() || tokenMonogram(coin)
    : tokenMonogram(coin);

  return (
    // Sized from `size`, the SAME binding the artwork branch uses — not from
    // `COIN_BADGE_PX`, and not from `size="sm"` (which is its own 40px). Both
    // mistakes have been made here: the literal left every caller that passes a
    // size rendering a 32px monogram beside a 44px logo, and the bare `sm` made
    // this branch 8px taller than the artwork. Roughly half of every list is a
    // fallback, so a mismatch is not an edge case — it is every other row.
    <Avatar size="sm" alt={monogram ?? coin} style={{ width: size, height: size }}>
      <Avatar.Fallback>
        {/* The letters scale with the badge too. A fixed `text-xs` is right at
            the default and lost inside a 44px circle. */}
        <Typography.Paragraph
          className="font-semibold"
          style={{ fontSize: Math.round(size * MONOGRAM_SCALE) }}
        >
          {letters}
        </Typography.Paragraph>
      </Avatar.Fallback>
    </Avatar>
  );
}

export function Empty({ title, description }: { title: string; description: string }): JSX.Element {
  return (
    <EmptyState className="py-8">
      <EmptyState.Header>
        <EmptyState.Title className="font-semibold">{title}</EmptyState.Title>
        <EmptyState.Description className="font-normal">{description}</EmptyState.Description>
      </EmptyState.Header>
    </EmptyState>
  );
}

/** Header-sized skeleton lines while the first frame is in flight. */
export function LoadingCard(): JSX.Element {
  return (
    <Card className="gap-3">
      <Skeleton className="h-8 w-40 rounded-lg" />
      <Skeleton className="h-4 w-28 rounded-lg" />
      <Skeleton className="h-4 w-full rounded-lg" />
    </Card>
  );
}

/** Row-shaped skeletons, for a list that is loading rather than a header. */
export function LoadingRows({ count = 3 }: { count?: number }): JSX.Element {
  return (
    <View className="gap-3 py-2">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} className="flex-row items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-full" />
          <View className="flex-1 gap-1.5">
            <Skeleton className="h-3.5 w-24 rounded" />
            <Skeleton className="h-3 w-16 rounded" />
          </View>
          <Skeleton className="h-3.5 w-16 rounded" />
        </View>
      ))}
    </View>
  );
}
