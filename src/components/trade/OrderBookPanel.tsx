/**
 * The live order book — the trade screen's custom centerpiece.
 *
 * ## Shape
 *
 * The ladder FILLS the space the screen gives it, and the row count is
 * measured from that space ({@link fittedRowCount}) rather than fixed — a
 * taller phone shows a deeper book instead of the same ten rows with padding
 * underneath. The panel's height comes from its container, never from its
 * contents, so switching views never resizes it.
 *
 * - **Stacked** (the phone shape): asks above, bids below, the mid between,
 *   the fitted rows split in half. Hiding a side gives the other ALL of them,
 *   so the switch buys depth rather than whitespace.
 * - **Columns** (wide panels): bids left, asks right, prices meeting in the
 *   middle, depth growing outward, the mid spanning beneath. BOTH sides get
 *   the full count here — twice the stacked depth in the same height, which is the
 *   whole reason the layout exists. Auto-selected once the panel measures at
 *   least {@link COLUMNS_MIN_WIDTH}, and switchable from there.
 *
 * ## Where the levels come from
 *
 * Two subscriptions, one market. Measured on the wire, `fast: true` gives 5
 * levels a side every ~0.5 s and `fast: false` gives 20 every ~5 s — so
 * neither one alone can fill a tall ladder with numbers worth trading on.
 * The panel runs both: the fast feed owns the touch and the four levels
 * behind it, the deep feed fills the tail, and {@link mergeBookSide} keeps
 * only deep levels lying strictly beyond the fast edge so nothing appears
 * twice. Both are websocket pushes — the second feed costs no request weight.
 *
 * The deep feed opens only when the measured ladder has rows the fast feed
 * cannot fill, and past ITS freshness gate it contributes nothing: the ladder
 * shortens back to five a side rather than showing a five-second-old tail as
 * though it were live. Staleness of the PANEL is the fast feed's alone.
 * Rows with no level are not drawn, and no empty row is dressed up as a price.
 *
 * ## Customisation
 *
 * Everything that is taste rather than protocol lives in one resolved
 * {@link OrderBookAppearance}: row height and gap, whether depth bars, the
 * spread row, the ratio bar, the tape toggle and the control row are drawn,
 * a hard row cap, which grouping/sides the book opens on, and a forced
 * layout. Pass a partial and the rest comes from {@link BOOK_APPEARANCE}, so
 * a second book elsewhere — a position's market, a watchlist preview — can be
 * denser or chrome-free without forking this component.
 *
 * Rows are dense and separated by a hairline (`rowGap`, 1pt by default): a
 * book is read as a shape, and a wide gap breaks the depth column that shape
 * lives in — but butted-together rows are harder to track across.
 *
 * ## Honesty
 *
 * Every number rendered here is either FRESH (≤10 s) or visibly dead: past
 * the gate the panel drops to 40% opacity, shows a "stale" chip, and every
 * row tap is DISABLED — `onPickPrice` only ever fires with a price the store
 * still vouches for. A coin or grouping switch clears instantly (the store's
 * `setTarget` contract), so the previous market's book cannot flash under the
 * new label even for a frame.
 *
 * ## Performance contract
 *
 * The book subscription lives in {@link LiveBook} and nowhere else, so the
 * panel's own chrome (toggle, grouping menu, stale chip) is outside the
 * per-frame blast radius — measured: halved the tick cost. Inside it, rows
 * are memoised on primitives and render PLAIN `Text`: heroui's
 * `Typography.Paragraph` is three components per cell, and at 20 cells a
 * frame that stack was the single largest cost in the profile. Explicit
 * `fontFamily` is the sanctioned way to keep the house font off the
 * `className` path (the `FlashPrice` precedent).
 */

import type { JSX } from "react";
import { memo, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { BigNumber } from "bignumber.js";

import { toBigNumber } from "@/hyperliquid/core/precision";
import { Chip, useThemeColor } from "heroui-native";
import { PanelBottom, PanelTop, Rows3 } from "lucide-react-native";

import { FilterMenu } from "@/components/common/FilterMenu";
import { TradesTape } from "@/components/trade/TradesTape";
import {
  BOOK_GROUPINGS,
  bookChromeHeight,
  bookGroupingOptions,
  bookRatio,
  bookRowsPerSide,
  cumulativeDepth,
  FAST_BOOK_LEVELS,
  fittedRowCount,
  localSpread,
  mergeBookSide,
  resolveBookAppearance,
  type BookGrouping,
  type BookSides,
  type OrderBookAppearance,
} from "@/components/trade/tradeView";
import { useOrderBook } from "@/hyperliquid/hooks/markets";
import { asksOf, bestAsk, bestBid, bidsOf, type BookLevel } from "@/hyperliquid/state/book";
import type { HlEnv } from "@/hyperliquid/types/domain";

/**
 * The control strip's height in points — a `Segment size="sm"` plus nothing.
 *
 * Fixed rather than emergent: it is a term in the screen's height budget, and
 * the strip is a horizontal ScrollView, which has no intrinsic height and will
 * otherwise grow to eat every spare point in the column.
 */
const CONTROL_STRIP_HEIGHT = 32;

const styles = StyleSheet.create({
  // Flush: no inset. Adjacent bars form one continuous depth column, which is
  // the shape a trader actually reads. Only the LEADING edge is rounded — the
  // trailing edge stays square against the panel edge so the column still
  // reads as one solid mass; the soft cap is on the side the depth GROWS
  // toward, which is the edge the eye actually tracks.
  bar: { position: "absolute", top: 0, bottom: 0, right: 0 },
  barCapLeft: { borderTopLeftRadius: 3, borderBottomLeftRadius: 3 },
  barCapRight: { borderTopRightRadius: 3, borderBottomRightRadius: 3 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 6,
  },
  price: { fontFamily: "SFProRounded-Medium", fontSize: 11, fontVariant: ["tabular-nums"] },
  size: { fontFamily: "SFProRounded-Regular", fontSize: 11, fontVariant: ["tabular-nums"] },
  label: { fontFamily: "SFProRounded-Regular", fontSize: 11 },
  pct: { fontFamily: "SFProRounded-Medium", fontSize: 10, fontVariant: ["tabular-nums"] },
  header: { fontFamily: "SFProRounded-Regular", fontSize: 10 },
  spread: { fontFamily: "SFProRounded-Medium", fontSize: 11, fontVariant: ["tabular-nums"] },
  // The reference's three columns: price takes the left rule, size and total
  // each take a right-aligned rule. Flex, not fixed widths, so the same row
  // works at any panel width.
  cellPrice: { flex: 1, textAlign: "left" },
  cellEnd: { flex: 1, textAlign: "right" },
});

/**
 * The `Price (USD) | Size (COIN)` header, stacked two lines per column the way
 * the reference does — at this column's width the pair does not fit on one
 * line and the units are what truncate first.
 *
 * Inside the MEASURED box, as the ladder's first child, so its height is
 * charged through `bookChromeHeight` like every other fixed element there.
 * `px-1.5` is 6pt — exactly `styles.row`'s `paddingHorizontal`, so the labels
 * sit over their own columns rather than near them.
 *
 * Which side carries which label still comes from `bookColumnHeader` (the
 * mirrored `columns` layout puts size on the outside); this reads its answer
 * rather than re-deriving the rule.
 */
function ColumnHeader({
  symbol,
  height,
  muted,
}: {
  symbol: string;
  height: number;
  muted: string;
}): JSX.Element {
  return (
    <View className="flex-row items-center px-1.5" style={{ height }}>
      <Text style={[styles.header, styles.cellPrice, { color: muted }]}>Price</Text>
      <Text style={[styles.header, styles.cellEnd, { color: muted }]}>{`Size (${symbol})`}</Text>
      <Text style={[styles.header, styles.cellEnd, { color: muted }]}>{`Total (${symbol})`}</Text>
    </View>
  );
}

/**
 * One level. Memoised on primitives ONLY — a book frame changes some levels
 * and leaves others identical, and the untouched rows must not re-render.
 *
 * `onPick` must be referentially stable at the call site for that to hold;
 * the screen owns it, so it is a plain prop rather than a per-row closure.
 */
const BookRow = memo(function BookRow({
  px,
  sz,
  total,
  fraction,
  tone,
  barColor,
  height,
  showDepth,
  side,
  disabled,
  onPick,
}: {
  px: string;
  sz: string;
  /** Cumulative size from the touch out to THIS level — the reference's
   *  third column, and what the depth bar behind the row draws. */
  total: string;
  fraction: number;
  tone: string;
  barColor: string;
  height: number;
  /** Off hides the cumulative-depth bar, leaving a plain price ladder. */
  showDepth: boolean;
  side: "bid" | "ask";
  disabled: boolean;
  onPick?: (px: string) => void;
}): JSX.Element {
  const width = `${Math.round(fraction * 100)}%` as const;
  return (
    <Pressable
      disabled={disabled || onPick === undefined}
      onPress={() => onPick?.(px)}
      accessibilityRole="button"
      accessibilityLabel={`${side === "bid" ? "Bid" : "Ask"} ${px}, size ${sz}, total ${total}`}
      style={{ height, justifyContent: "center" }}
    >
      {showDepth ? (
        <View
          style={[styles.bar, styles.barCapLeft, { width, backgroundColor: barColor }]}
          pointerEvents="none"
        />
      ) : null}
      <View style={styles.row}>
        <Text style={[styles.price, styles.cellPrice, { color: tone }]}>{px}</Text>
        <Text style={[styles.size, styles.cellEnd]}>{sz}</Text>
        <Text style={[styles.size, styles.cellEnd]}>{total}</Text>
      </View>
    </Pressable>
  );
});

/**
 * One side's rows.
 *
 * Totals are the running sum from the touch outward — BigNumber, because
 * sizes are wire strings and a book can stack hundreds of contracts against
 * fractions of one — formatted once per frame to the market's own szDecimals.
 * Asks render worst-first so the best price lands adjacent to the spread row
 * beneath them; bids render best-first for the same reason.
 */
function SideRows({
  levels,
  side,
  tone,
  barColor,
  szDecimals,
  appearance,
  interactive,
  onPickPrice,
}: {
  levels: readonly BookLevel[];
  side: "bid" | "ask";
  tone: string;
  barColor: string;
  szDecimals: number | null;
  appearance: OrderBookAppearance;
  interactive: boolean;
  onPickPrice?: (px: string) => void;
}): JSX.Element {
  const fractions = cumulativeDepth(levels.map((level) => level.sz));
  const decimals = szDecimals ?? 5;
  const totals: string[] = [];
  let running = new BigNumber(0);
  for (const level of levels) {
    running = running.plus(toBigNumber(level.sz));
    totals.push(running.toFixed(decimals));
  }
  const order = side === "ask" ? [...levels.keys()].reverse() : [...levels.keys()];

  // `gap`, not a margin on the row: the house rule, and it also keeps the
  // row a single fixed-height box for the fitted-count arithmetic.
  return (
    <View style={{ gap: appearance.rowGap }}>
      {order.map((index) => {
        const level = levels[index]!;
        return (
          <BookRow
            key={`${side}:${level.px}`}
            px={level.px}
            sz={level.sz}
            total={totals[index] ?? level.sz}
            fraction={fractions[index] ?? 0}
            tone={tone}
            barColor={barColor}
            height={appearance.rowHeight}
            showDepth={appearance.showDepth}
            side={side}
            disabled={!interactive}
            onPick={onPickPrice}
          />
        );
      })}
    </View>
  );
}

/**
 * Owns `useOrderBook` — the per-tick blast radius, and nothing else.
 *
 * Profiled before this split: the subscription lived in the panel, so every
 * 0.5 s frame re-rendered the Segment toggle, the grouping FilterMenu and its
 * Popovers alongside the rows. Only what a frame actually changes lives below
 * this component; the shell above renders on user action only.
 */
function LiveBook({
  wireCoin,
  symbol,
  szDecimals,
  aggregation,
  sides,
  fittedRows,
  appearance,
  env,
  onStaleChange,
  onPickPrice,
}: {
  wireCoin: string;
  /** Display symbol for the column headers — "HYPE", not "@107". */
  symbol: string;
  szDecimals: number | null;
  aggregation: BookGrouping | null;
  sides: BookSides;
  /** Rows the measured ladder can hold; 0 before the first layout pass. */
  fittedRows: number;
  appearance: OrderBookAppearance;
  env: HlEnv;
  /** The shell's stale chip rides this, so the chip isn't in the blast radius. */
  onStaleChange: (stale: boolean) => void;
  onPickPrice?: (px: string) => void;
}): JSX.Element {
  const [success, danger, muted] = useThemeColor(["success", "danger", "muted"]);
  const rowsPerSide = bookRowsPerSide(sides, "stacked", fittedRows);

  // TWO subscriptions on one market, and each vouches for what it is good at:
  // `fast` carries the touch and the four levels behind it twice a second,
  // `deep` carries the tail every five. The deep one opens only when the
  // ladder has rows the fast feed cannot fill — on a short book it would be a
  // channel nobody reads. Same aggregation for both: two price grids cannot
  // be stacked into one ladder.
  const feed = useOrderBook(wireCoin, aggregation, env);
  const wantsDepth = rowsPerSide > FAST_BOOK_LEVELS;
  const deepAggregation = useMemo(
    () => ({
      nSigFigs: aggregation?.nSigFigs ?? null,
      mantissa: aggregation?.mantissa ?? null,
      fast: false as const,
    }),
    [aggregation?.mantissa, aggregation?.nSigFigs]
  );
  const deepFeed = useOrderBook(wireCoin, deepAggregation, env, { enabled: wantsDepth });

  // Reported upward in an effect (not render — the parent must not set state
  // from a child's render). The parent re-renders when the FLAG flips, not on
  // every frame. Staleness is the FAST feed's alone: it owns the touch, and a
  // lagging tail is handled by dropping the tail, not by greying the price.
  useEffect(() => {
    onStaleChange(feed.isStale);
  }, [feed.isStale, onStaleChange]);

  // `held` is the display path once stale — old numbers, clearly labelled —
  // and `book` (the freshness authority) gates every interaction.
  const snapshot = feed.book ?? feed.held;
  // The tail is taken from the deep feed's FRESH read only: past its gate it
  // contributes nothing and the ladder simply gets shorter, which is honest.
  const allBids =
    snapshot === null
      ? []
      : mergeBookSide(
          bidsOf(snapshot),
          deepFeed.book === null ? [] : bidsOf(deepFeed.book),
          "bids"
        );
  const allAsks =
    snapshot === null
      ? []
      : mergeBookSide(
          asksOf(snapshot),
          deepFeed.book === null ? [] : asksOf(deepFeed.book),
          "asks"
        );
  const bids = allBids.slice(0, rowsPerSide);
  const asks = allAsks.slice(0, rowsPerSide);
  const interactive = feed.book !== null;

  // The spread, computed from the TOUCH — the band between the sides, stated
  // the way the reference states it: absolute tick and percent of mid.
  const spread =
    snapshot === null
      ? null
      : localSpread(bestBid(snapshot)?.px ?? null, bestAsk(snapshot)?.px ?? null);
  const ratio = appearance.showRatio
    ? bookRatio(
        allBids.map((level) => level.sz),
        allAsks.map((level) => level.sz)
      )
    : null;

  if (snapshot === null) {
    // No frame yet (cold open or just retargeted), or not measured yet. Fills
    // the same container either way, so nothing on the page moves when the
    // first frame lands.
    return (
      <View className="flex-1 items-center justify-center">
        <Text style={[styles.label, { color: muted }]}>Waiting for the book…</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 gap-1" style={{ opacity: feed.isStale ? 0.4 : 1 }}>
      {appearance.showColumnHeader ? (
        <ColumnHeader symbol={symbol} height={appearance.columnHeaderHeight} muted={muted} />
      ) : null}
      {/* Stacked, always — the reference's one shape. `justify-center` keeps
          a short side against the spread band rather than stranded at the
          top of the ladder. */}
      <View className="flex-1 justify-center">
        {sides === "bids" ? null : (
          <SideRows
            levels={asks}
            side="ask"
            tone={danger}
            barColor={`${danger}22`}
            szDecimals={szDecimals}
            appearance={appearance}
            interactive={interactive}
            onPickPrice={onPickPrice}
          />
        )}
        {appearance.showSpread ? (
          <SpreadRow spread={spread} height={appearance.spreadHeight} muted={muted} />
        ) : (
          <View style={{ height: appearance.spreadHeight }} />
        )}
        {sides === "asks" ? null : (
          <SideRows
            levels={bids}
            side="bid"
            tone={success}
            barColor={`${success}22`}
            szDecimals={szDecimals}
            appearance={appearance}
            interactive={interactive}
            onPickPrice={onPickPrice}
          />
        )}
      </View>
      {ratio === null ? null : <RatioBar buyPct={ratio.buyPct} success={success} danger={danger} />}
    </View>
  );
}

export function OrderBookPanel({
  wireCoin,
  symbol,
  szDecimals,
  marketType,
  anchorPx,
  env,
  onPickPrice,
  appearance: overrides,
}: {
  wireCoin: string;
  /** Display symbol for the size column — "HYPE", not the wire "@107". */
  symbol: string;
  /** The asset's size decimals; null on predictions, which have their own. */
  szDecimals: number | null;
  marketType: "perp" | "spot";
  /**
   * The price the grouping ticks are derived from — the SCREEN's price, which
   * moves on the mids cadence. Deliberately not the book's own touch: that
   * moves every 0.5 s frame and would rebuild the menu, re-rendering the
   * popover the LiveBook split exists to keep out of the per-frame path.
   */
  anchorPx: string | null;
  env: HlEnv;
  /** Fires with a FRESH price only — stale rows never call it. */
  onPickPrice?: (px: string) => void;
  /**
   * Partial look and defaults; the rest comes from {@link BOOK_APPEARANCE}.
   * Pass a MODULE-SCOPE object: a fresh literal here re-resolves the
   * appearance every render and churns the memoised row props.
   */
  appearance?: Partial<OrderBookAppearance>;
}): JSX.Element {
  const appearance = resolveBookAppearance(overrides);

  const mutedColor = useThemeColor("muted");
  const [groupingKey, setGroupingKey] = useState(appearance.defaultGrouping);
  const [view, setView] = useState<"book" | "trades">("book");
  const [stale, setStale] = useState(false);

  // The side filter is BACK (user call, 2026-08-29): the book now lives
  // full-width on the market screen, where the strip has room the old 35%
  // trade column never did. One cycling control rather than a three-item
  // Segment — set-and-forget, and the glyph names the CURRENT view.
  const [sides, setSides] = useState<BookSides>(appearance.defaultSides);

  // Measured, not guessed: only the panel's own box knows how many rows it
  // can hold. Zero until the first layout — `fittedRowCount(0, …)` is 0, so
  // the first frame draws the waiting state, which always fits. The count
  // re-derives whenever the box or the side filter changes, so a one-sided
  // ladder takes every row both sides shared a moment before.
  const [ladderHeight, setLadderHeight] = useState(0);

  const measuredRows = fittedRowCount(
    ladderHeight,
    appearance.rowHeight,
    // EVERY fixed element in the measured box, not just the touch row — the
    // ratio bar lives in here too, and its 26pt is a whole row pitch.
    bookChromeHeight(appearance),
    appearance.rowGap
  );
  const fittedRows =
    appearance.maxRows === null ? measuredRows : Math.min(measuredRows, appearance.maxRows);

  const grouping =
    BOOK_GROUPINGS.find((option) => option.key === groupingKey) ?? BOOK_GROUPINGS[0]!;

  // Labelled by the tick each grouping actually quotes on, the way the
  // official app does it — "0.001" says more than "5 figs". Memoised on the
  // anchor, which moves on the mids cadence: rebuilding this array per render
  // re-renders FilterMenu and its Popover pair, the exact cost the LiveBook
  // split was introduced to remove.
  const groupingOptions = useMemo(
    () => bookGroupingOptions(anchorPx, szDecimals, marketType),
    [anchorPx, szDecimals, marketType]
  );

  return (
    // Not a Card of its own: the screen wraps the header and both panels in
    // ONE Card, so a nested Card here doubled the padding and read as two long
    // panels welded together (2026-08-19). The hairline border is what still
    // separates the columns — on the RIGHT edge now, since the book moved to
    // the left of the ticket to match the reference.
    <View className="flex-1 gap-2 border-r border-border pr-2">
      {/* The ladder takes everything above the control strip, and reports it
          back: the row count is derived from THIS box, so the book is as deep
          as the screen allows rather than a fixed ten rows with padding
          underneath. The Book/Trades toggle used to sit above it and cost the
          ladder 40pt — 1.6 rows — for a control touched once a session. */}
      <View
        className="flex-1"
        onLayout={(event) => setLadderHeight(event.nativeEvent.layout.height)}
      >
        {view === "trades" && appearance.showTape ? (
          <TradesTape wireCoin={wireCoin} env={env} rowHeight={appearance.rowHeight} />
        ) : (
          <LiveBook
            wireCoin={wireCoin}
            symbol={symbol}
            szDecimals={szDecimals}
            aggregation={grouping.aggregation}
            sides={sides}
            fittedRows={fittedRows}
            appearance={appearance}
            env={env}
            onStaleChange={setStale}
            onPickPrice={onPickPrice}
          />
        )}
      </View>

      {!appearance.showControls ? null : (
        /* ONE control strip, below the ladder, holding everything: the
           grouping, the Book/Trades mode, the sides and the layout. They are
           all set-and-forget — a reader adjusts them once and then watches
           prices — so they belong out of the path between the eye and the
           ladder, and in the thumb's arc rather than under the chart.
           `flex-grow` keeps the content at least viewport-wide so the flex-1
           spacer can pin the side buttons to the right edge, the way the
           official strip lays them out; when a narrow embed overflows, the
           row still scrolls rather than truncating a control. */
        // Wrapped in a definite-height View rather than given `style={{height}}`
        // directly: a horizontal ScrollView still participates in the column's
        // flex as a growable child, and styling its own height does not stop
        // that — measured live, the ladder box came back 284pt when 460 was
        // available and the strip had eaten the rest. A plain View with a fixed
        // height is inert in the flex pass, and the ScrollView fills it.
        <View style={{ height: CONTROL_STRIP_HEIGHT }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="flex-grow flex-row items-center gap-1.5"
          >
            {view === "trades" ? null : (
              <FilterMenu
                label="Group"
                options={groupingOptions}
                selected={groupingKey}
                onSelect={setGroupingKey}
                alwaysShowSelection
              />
            )}

            {/* The mode toggle, compact: one pill naming the OTHER mode — the
                official app drops the tape entirely, so the control earns its
                place by shrinking to a destination label rather than a
                two-item Segment. */}
            {appearance.showTape ? (
              <Pressable
                onPress={() => setView(view === "book" ? "trades" : "book")}
                accessibilityRole="button"
                accessibilityLabel={view === "book" ? "Show trades" : "Show book"}
                className="h-6 items-center justify-center rounded-md bg-surface px-2"
              >
                <Text className="text-xs font-medium text-muted">
                  {view === "book" ? "Trades" : "Book"}
                </Text>
              </Pressable>
            ) : null}

            {stale ? (
              <Chip size="sm" color="warning" variant="soft">
                <Chip.Label className="font-medium">stale</Chip.Label>
              </Chip>
            ) : null}

            <View className="flex-1" />

            {/* The side cycle: both → asks → bids → both. The glyph shows the
                view you are IN (rows = both, top panel = asks, bottom = bids)
                — with three states a "next mode" icon would need decoding, so
                the label is the state and the tap means "next". Layout
                (stacked vs columns) stays automatic from the measured width:
                that one is genuinely a property of the room, not a taste. */}
            {view === "trades" ? null : (
              <Pressable
                onPress={() =>
                  setSides(sides === "both" ? "asks" : sides === "asks" ? "bids" : "both")
                }
                accessibilityRole="button"
                accessibilityLabel={
                  sides === "both"
                    ? "Showing both sides, switch to asks only"
                    : sides === "asks"
                      ? "Showing asks only, switch to bids only"
                      : "Showing bids only, switch to both sides"
                }
                className="h-6 w-8 items-center justify-center rounded-md bg-surface"
              >
                {sides === "both" ? (
                  <Rows3 size={13} color={mutedColor} />
                ) : sides === "asks" ? (
                  <PanelTop size={13} color={mutedColor} />
                ) : (
                  <PanelBottom size={13} color={mutedColor} />
                )}
              </Pressable>
            )}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

/**
 * The band between the sides — the reference's own anatomy: the word, the
 * absolute tick, the percent of mid, muted, on the same three rules as the
 * rows above and below it. Hidden by choice still costs its height: the
 * fitted-row arithmetic reserved it, and reclaiming it would reflow the
 * ladder by one row.
 */
function SpreadRow({
  spread,
  height,
  muted,
}: {
  spread: { abs: string; pct: string } | null;
  height: number;
  muted: string;
}): JSX.Element {
  return (
    <View
      className="flex-row items-center rounded-md bg-background px-1.5"
      style={{ height }}
      accessibilityLabel={
        spread === null ? "Spread unknown" : `Spread ${spread.abs}, ${spread.pct} percent`
      }
    >
      <Text style={[styles.spread, styles.cellPrice, { color: muted }]}>Spread</Text>
      <Text style={[styles.spread, styles.cellEnd, { color: muted }]}>
        {spread === null ? "--" : spread.abs}
      </Text>
      <Text style={[styles.spread, styles.cellEnd, { color: muted }]}>
        {spread === null ? "--" : `${spread.pct}%`}
      </Text>
    </View>
  );
}

/** Buy/sell pressure over the visible rows — the reference apps' ratio bar. */
function RatioBar({
  buyPct,
  success,
  danger,
}: {
  buyPct: number;
  success: string;
  danger: string;
}): JSX.Element {
  const buy = Math.round(buyPct);
  return (
    <View className="gap-1 pt-0.5">
      <View className="flex-row items-center justify-between px-1.5">
        <Text style={[styles.pct, { color: success }]}>{buy}%</Text>
        <Text style={[styles.pct, { color: danger }]}>{100 - buy}%</Text>
      </View>
      <View className="h-1 flex-row overflow-hidden rounded-full">
        <View style={{ width: `${buy}%`, backgroundColor: success }} />
        <View className="flex-1" style={{ backgroundColor: danger }} />
      </View>
    </View>
  );
}
