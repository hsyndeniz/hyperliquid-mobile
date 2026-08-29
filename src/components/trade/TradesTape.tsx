/**
 * The recent-prints tape — the book column's second view.
 *
 * Mounted only while visible: the panel's Segment toggle decides whether this
 * component (and therefore its subscription, via `useTradesTape(enabled)`)
 * exists. An invisible tape would be a per-frame Hermes parse with no reader.
 *
 * It fills the ladder box the panel measures, exactly as the book does, so the
 * Book/Trades toggle never resizes the panel.
 *
 * Rows follow the book's rules exactly — dense, memoised on primitives, plain
 * `Text` with an explicit `fontFamily` rather than heroui's three-component
 * `Typography.Paragraph` stack (measured: that stack dominated the book's
 * per-frame cost). Price is side-coloured, and staleness follows the book's
 * convention: held prints at 40% opacity with a chip, never a silent blank.
 */

import type { JSX } from "react";
import { memo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Chip, useThemeColor } from "heroui-native";

import { shortClock } from "@/components/trade/tradeView";
import { useTradesTape } from "@/hyperliquid/hooks/markets";
import type { HlEnv } from "@/hyperliquid/types/domain";

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 6,
  },
  px: { fontFamily: "SFProRounded-Medium", fontSize: 11, fontVariant: ["tabular-nums"] },
  sz: { fontFamily: "SFProRounded-Regular", fontSize: 11, fontVariant: ["tabular-nums"] },
  time: { fontFamily: "SFProRounded-Regular", fontSize: 10, fontVariant: ["tabular-nums"] },
  header: { fontFamily: "SFProRounded-Regular", fontSize: 10 },
  empty: { fontFamily: "SFProRounded-Regular", fontSize: 11 },
});

/** One print. Memoised: a new frame prepends rows, it does not rewrite them. */
const TapeRow = memo(function TapeRow({
  px,
  sz,
  time,
  tone,
  foreground,
  muted,
  height,
}: {
  px: string;
  sz: string;
  time: number;
  tone: string;
  /** The ordinary text colour. Every `Text` here needs one — see below. */
  foreground: string;
  muted: string;
  height: number;
}): JSX.Element {
  return (
    <View style={[styles.row, { height }]}>
      {/* Each cell carries its own colour, and the size cell is not an
          oversight fixed for tidiness: it had NONE, which renders black. The
          parent is a View so nothing inherits, Uniwind does not inherit text
          colour the way NativeWind v2 did, and there is no global `Text`
          default — so an uncoloured `Text` gets the platform default on a
          background that defaults to dark. Three levels, deliberately: price
          takes the side tone, size the plain foreground, time the muted step. */}
      <Text style={[styles.px, { color: tone }]}>{px}</Text>
      <Text style={[styles.sz, { color: foreground }]}>{sz}</Text>
      <Text style={[styles.time, { color: muted }]}>{shortClock(time)}</Text>
    </View>
  );
});

export function TradesTape({
  wireCoin,
  env,
  rowHeight,
}: {
  wireCoin: string;
  env: HlEnv;
  /** Matches the book's row height so the toggle keeps one rhythm. */
  rowHeight: number;
}): JSX.Element {
  const [success, danger, muted, foreground] = useThemeColor([
    "success",
    "danger",
    "muted",
    "foreground",
  ]);
  const feed = useTradesTape(wireCoin, true, env);

  return (
    <View className="flex-1 gap-1" style={{ opacity: feed.isStale ? 0.4 : 1 }}>
      <View className="flex-row items-center justify-between px-1.5">
        <Text style={[styles.header, { color: muted }]}>Price / Size / Time</Text>
        {feed.isStale ? (
          <Chip size="sm" color="warning" variant="soft">
            <Chip.Label className="font-medium">stale</Chip.Label>
          </Chip>
        ) : null}
      </View>
      {feed.trades.length === 0 ? (
        <View className="flex-1 items-center justify-center">
          <Text style={[styles.empty, { color: muted }]}>Waiting for prints…</Text>
        </View>
      ) : (
        <ScrollView className="flex-1">
          {feed.trades.map((trade) => (
            <TapeRow
              key={trade.tid}
              px={trade.px}
              sz={trade.sz}
              time={trade.time}
              tone={trade.side === "buy" ? success : danger}
              foreground={foreground}
              muted={muted}
              height={rowHeight}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}
