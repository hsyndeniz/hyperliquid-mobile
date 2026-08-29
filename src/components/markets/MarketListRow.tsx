/**
 * One market in the list — the `PositionItem` anatomy re-used: badge, title
 * line with an aligned chip, muted metrics subtitle, right-hand live column.
 *
 * The row subscribes to its OWN mid through the `useMid` string-primitive
 * selector, so a 15 s mids poll re-renders only the rows whose price string
 * actually changed — with up to 1,309 rows mounted, re-rendering the list per
 * poll was the failure the selector exists to prevent. The snapshot `px`
 * (mid ?? mark at build time) is the fallback while a coin is missing from
 * the poll — never 0, never blank.
 *
 * The subtitle states the metric the LIST is ordered by (`rowMetric`), not a
 * fixed field: a sort the rows do not name is a sequence the user has to
 * reverse-engineer. It is plain text — `NumberFlow` is banned from list rows
 * (~150 components per price, 1.4 s commits measured) and `NumberValue`'s Intl
 * pass buys nothing once the metric arrives formatted.
 *
 * The 24h chip renders ONLY when its label exists: `change24hPct` refuses a
 * fresh listing's `prevDayPx === "0.0"` (dividing by it claims an infinite
 * rally), and the honest render for "unknowable" is a muted `--` with no
 * chip colour around it. Predictions state their move in POINTS
 * (`formatProbabilityChangePts`): a 2%→4% drift is "+2.0 pts", not a
 * "+100%" doubling.
 */

import type { JSX } from "react";
import { Pressable, View } from "react-native";
import { Typography } from "heroui-native";
import { TrendChip } from "heroui-native-pro";

import { FlashPrice } from "@/components/markets/FlashPrice";
import { RowSparkline } from "@/components/markets/RowSparkline";
import {
  changeTrend,
  formatChangePct,
  formatProbabilityChangePts,
  rowMetric,
} from "@/components/markets/marketsView";
import { TokenMark } from "@/components/markets/TokenMark";
import { tokenColor } from "@/theme/tokenColor";
import { useMid, useSparkline } from "@/hyperliquid/hooks/markets";
import { change24hPct, type MarketRow, type MarketSortMode } from "@/hyperliquid/markets/rows";

/**
 * The numbers column.
 *
 * Wide enough for the longest price these lists show — a six-figure perp
 * (`78.645,5`) and an eight-place micro-cap (`0,092767`) both fit — so the
 * column never resizes and the column of digits stays a straight line down the
 * screen.
 */
const PRICE_COLUMN_WIDTH = 92;

export function MarketListRow({
  row,
  sortMode,
  suppressFlash = false,
  onPress,
}: {
  row: MarketRow;
  /** Which metric the list is ordered by — the subtitle states it. */
  sortMode: MarketSortMode;
  /** True while the mids poll is stale — a jump after a gap must not flash. */
  suppressFlash?: boolean;
  onPress: () => void;
}): JSX.Element {
  const mid = useMid(row.wireCoin);
  const px = mid ?? row.px;
  // Requested only after this row has held this coin past the dwell — a fling
  // asks for nothing. `null` covers unread, queued, declined and failed alike,
  // and every one of them draws no line.
  const spark = useSparkline(row.wireCoin);

  const trend = changeTrend(px, row.prevDayPx);
  const pct = change24hPct(px, row.prevDayPx);
  const changeLabel =
    row.kind === "prediction"
      ? trend === null
        ? null
        : formatProbabilityChangePts(px, row.prevDayPx)
      : pct === null
        ? null
        : formatChangePct(pct);

  return (
    <Pressable accessible={false} className="flex-row items-center gap-3 py-3" onPress={onPress}>
      <TokenMark
        coin={row.kind === "prediction" ? row.wireCoin : row.symbol}
        monogram={row.kind === "prediction" ? row.symbol : undefined}
        badge={row.kind === "perp" && row.maxLeverage !== null ? `${row.maxLeverage}x` : null}
      />

      {/* `minWidth: 0` is load-bearing. A flex child will not shrink below its
          own content by default, so a long subtitle ("$294.61K vol") pushed the
          price column rightward and each row landed on its own right margin —
          measured across six rows at 405.3pt to 424.0pt. Set as a style rather
          than a class so it cannot depend on which utilities are generated. */}
      <View className="flex-1" style={{ minWidth: 0 }}>
        {/* The symbol now owns its line. The leverage chip moved onto the
            mark (see `TokenMark`), which is what it describes — and what used
            to shrink long symbols to make room for it. */}
        <Typography.Paragraph className="font-medium leading-5" numberOfLines={1}>
          {row.symbol}
        </Typography.Paragraph>
        {/* The subtitle states the metric the list is ORDERED by, so a sort
            change is legible on every row rather than inferred from the
            sequence. Plain text, not `NumberValue`: that is a render-function
            wrapper whose Intl formatting this row no longer needs — the
            metric arrives already formatted, and the wrapper's inner text node
            does not share this label's line box. */}
        <Typography.Paragraph
          className="text-xs text-muted tabular-nums font-normal"
          numberOfLines={1}
        >
          {/* A prediction row prices ONE side; saying which is part of the
              number's meaning, not decoration. */}
          {row.sideName !== null
            ? `${row.sideName} · ${rowMetric(row, sortMode)}`
            : rowMetric(row, sortMode)}
        </Typography.Paragraph>
      </View>

      {/* A fixed slot whether or not a line exists: it fills in as the dwell
          request lands, and a slot that APPEARED with the data would shove the
          price column sideways on every arrival. Inert like every other
          non-target in the row. */}
      <View
        className="pointer-events-none"
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <RowSparkline points={spark} color={tokenColor(row.wireCoin)} />
      </View>

      {/* Fully inert like the leverage chip, and for the same two reasons:
          the TrendChip's inner Pressable steals finger taps, and its AX
          element swallows synthesized ones. */}
      <View
        // A FIXED width, not sized-to-content. Price and chip both right-align
        // inside it, so the two share an edge within a row and the same edge
        // across rows. Measured before this: six rows landed on six different
        // right margins, 405.3pt to 424.0pt, which is what made the negative
        // chips look misaligned against their neighbours.
        style={{ width: PRICE_COLUMN_WIDTH }}
        className="items-end gap-1 pointer-events-none"
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {/* Keyed by coin: FlashList RECYCLES this row for a different market,
            and an unkeyed NumberFlow animates the old coin's price into the
            new one — rolling digit soup during scroll (observed live). The
            key remounts it per coin, so only same-coin ticks animate; it also
            resets the pinned fraction width and the flash baseline, both of
            which are per-coin state. */}
        <FlashPrice
          key={row.wireCoin}
          value={px}
          isStale={suppressFlash}
          asProbability={row.kind === "prediction"}
        />
        {changeLabel === null ? (
          <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
            --
          </Typography.Paragraph>
        ) : (
          // `self-end` is REQUIRED, not decorative. heroui's `.chip__root`
          // hard-codes `align-self: flex-start`, and `align-self` on a child
          // always beats `align-items` on the parent — so the column's
          // `items-end` could never right-align this chip, no matter what the
          // column did. Every chip sat at the column's LEFT edge with a right
          // edge that moved with its own text width: measured on device, the
          // prices ended flush at 424pt while "+8.89%" ended at 391 and
          // "-0.51%" at 385. The `--` fallback below needs no such override —
          // it is a Text, which respects the parent.
          <TrendChip size="sm" variant="soft" trend={trend ?? "neutral"} className="self-end">
            <TrendChip.Value className="font-medium">{changeLabel}</TrendChip.Value>
          </TrendChip>
        )}
      </View>
    </Pressable>
  );
}
