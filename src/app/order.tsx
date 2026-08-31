/**
 * `/order` — order entry as a MODAL, not a page.
 *
 * The fourth take on this screen, and the one that stuck: three full trade
 * pages were built and none survived review, so the order ticket became what
 * it always was underneath — a decision sheet you open, commit, and dismiss.
 * The chart, book, and account sections stay on the screens that own them
 * (`OrderBookPanel` and `MarketAccountSection` live on the market page).
 *
 * ## Shape — the reference's margin-first sheet
 *
 * Long/Short segment → margin card (available, committed margin, slider) →
 * leverage card (slider, applied to the EXCHANGE on release — leverage is
 * per-asset account state on Hyperliquid, not an order parameter, so the
 * echo-gated `LeverageControl.apply` is the only honest write path) → the
 * order rows (live price, type, and whatever fields `fieldsFor` says this
 * type needs) → TP/SL rows → hold-to-commit.
 *
 * ## One money path
 *
 * Everything below the pixels is the proven stack: `orderForm` rules,
 * `orderBlockers` gating, `ticketToLegs`/`twapPayload` via `usePlaceTicket`.
 * The ticket's `size` stays in BASE units always — margin and notional are
 * derived spellings (`sizeFromMargin`, `sizeLine`) — because the submit path
 * takes `ticket.size` raw, and this skin never lets a quote string near it.
 *
 * ## Commit is a held press
 *
 * `ProgressButton` — the hold IS the confirmation. The sheet above it is the
 * echo (price, size, margin, liq estimate all visible at commit time), so a
 * second confirm dialog would re-ask a question the screen already answers.
 * `SubmitPhase` renders under the button: `rejected` re-arms the hold,
 * `settled` dismisses, `unknown` freezes it — the order may still land, and
 * a re-armed button would invite the double-submit the journal exists to
 * prevent.
 */

import type { JSX, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import {
  Checkbox as ExpoCheckbox,
  Host as ExpoHost,
  Picker as ExpoPicker,
  Row as ExpoRow,
  Slider as ExpoSlider,
} from "@expo/ui";
import { router, useNavigation } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BigNumber } from "bignumber.js";
import { Button, Chip, Slider, Typography, useThemeColor } from "heroui-native";
import { NumberValue, ProgressButton, Segment } from "heroui-native-pro";
import { NumberFlow } from "number-flow-react-native";
import { Pencil } from "lucide-react-native";

import { amountForFraction } from "@/components/money/amountEntry";
import { MarginModeControl } from "@/components/trade/MarginModeControl";
import { SideSegment } from "@/components/trade/SideSegment";
import { NumericEditorSheet } from "@/components/trade/NumericEditorSheet";
import {
  ORDER_TYPE_LABEL,
  fieldsFor,
  formatRuntime,
  fractionOfSize,
  maxSizeFor,
  orderBlockers,
  orderInfo,
  parseRuntimeMinutes,
  priceDecimalsOf,
  referencePriceOf,
  sizeDecimalsOf,
  sizeForFraction,
  ctaState,
  type OrderSide,
  type OrderType,
  type TicketState,
} from "@/components/trade/orderForm";
import {
  PRICE_CHIP_STEPS,
  chipPrice,
  liqDeltaPct,
  sizeFromMargin,
  sizeLine,
} from "@/components/trade/orderSheetView";
import { TpslEditor } from "@/components/trade/TpslEditor";
import { fundingPercentLabel, pairTitle } from "@/components/trade/tradeView";
import { usePlaceTicket } from "@/components/trade/usePlaceTicket";
import { CoinBadge } from "@/components/portfolio/primitives";
import type { LeverageControl } from "@/components/trade/leverageControl";
import type { Tif } from "@/hyperliquid/orders/build";
import { useTradeScreen } from "@/components/trade/useTradeScreen";
import { useHyperliquid } from "@/providers/HyperliquidProvider";

import type { EditorChip } from "@/components/trade/NumericEditorSheet";

/** Which sub-editor is open. One numeric sheet + one TP/SL sheet serve all. */
type EditorKey =
  "margin" | "price" | "trigger" | "scaleStart" | "scaleEnd" | "legs" | "runtime" | "tp" | "sl";

const EMPTY_TICKET: Omit<TicketState, "side"> = {
  type: "market",
  sizeUnit: "base",
  size: "",
  price: "",
  triggerPrice: "",
  scaleStart: "",
  scaleEnd: "",
  legCount: "2",
  runtime: "30m",
  tif: "Gtc",
  reduceOnly: false,
  randomize: false,
  tpEnabled: false,
  tpPrice: "",
  slEnabled: false,
  slPrice: "",
};

const TIF_OPTIONS: readonly Tif[] = ["Gtc", "Ioc", "Alo"];

/** Larger than a list row's mark: this sheet is about one market. */
const ORDER_BADGE_PX = 40;

export default function OrderScreen(): JSX.Element {
  const insets = useSafeAreaInsets();
  const mutedColor = useThemeColor("muted");
  const screen = useTradeScreen();
  const { session } = useHyperliquid();
  const place = usePlaceTicket(session);

  const [ticket, setTicket] = useState<TicketState>(() => ({
    ...EMPTY_TICKET,
    side: screen.side,
  }));
  const [editor, setEditor] = useState<EditorKey | null>(null);
  // The hold button's completion is CONTROLLED so a rejection can re-arm it.
  const [held, setHeld] = useState(false);

  // A new market is a NEW TICKET (the /trading key={coin} rule, recut as
  // render-phase adoption): the picker can retarget this mounted modal via
  // dismissTo params, and a BTC limit price surviving onto an ETH ticket is
  // the exact bug that rule exists to prevent.
  const [ticketCoin, setTicketCoin] = useState(screen.coin);
  if (ticketCoin !== screen.coin) {
    setTicketCoin(screen.coin);
    setTicket({ ...EMPTY_TICKET, side: ticket.side });
    setEditor(null);
    setHeld(false);
  }

  // The last editor that was OPEN keeps naming the dialog's content while it
  // animates closed — switching content on the same frame the close starts
  // re-titled a dismissing Stop Loss editor "Take Profit" mid-exit (review
  // finding). `editor` gates openness; `contentKey` gates content.
  const [lastOpen, setLastOpen] = useState<EditorKey | null>(null);
  if (editor !== null && editor !== lastOpen) setLastOpen(editor);
  const contentKey = editor ?? lastOpen;

  const ctx = screen.ticketCtx;
  const fields = fieldsFor(ticket.type, screen.kind);
  const sizeDecimals = sizeDecimalsOf(ctx.szDecimals);
  const priceDecimals = priceDecimalsOf(ctx.szDecimals, ctx.marketType);

  /**
   * The price everything margins against — the SAME reference the blockers
   * and `orderInfo` value the ticket at ({@link referencePriceOf}: typed
   * price for limit shapes, trigger for market triggers, ladder mean for
   * scale, mark-then-mid for market/TWAP). Falling back to mark keeps the
   * margin editor usable while a ticket is half-typed. Anchoring anywhere
   * else lets the slider's max disagree with the blocker's — a maxed slider
   * on a scale ladder produced an instant "Size exceeds the max".
   */
  const anchorRef = referencePriceOf(ticket, ctx);
  const anchorPrice = anchorRef !== null ? anchorRef.toFixed() : (ctx.markPx ?? ctx.midPx);

  const maxSize = maxSizeFor({
    available: ctx.available,
    price: anchorPrice,
    leverage: ctx.leverage,
    szDecimals: sizeDecimals,
    reduceOnly: ticket.reduceOnly,
    positionSize: ctx.positionSize,
  });
  const fraction = fractionOfSize(ticket.size, maxSize);
  const info = orderInfo(ticket, ctx);
  const blockers = orderBlockers(ticket, ctx);
  const cta = ctaState(blockers, ticket, ctx);
  const line = sizeLine(ticket, ctx);

  /**
   * Every edit updates the ticket, clears a stale submit verdict, AND disarms
   * the hold. The disarm is load-bearing: the ProgressButton's fill only
   * rewinds on an `isCompleted` true→false transition, so resetting the phase
   * without `held` left a fully-swept, enabled-looking button that could
   * never complete again (review finding — editing inside the settled
   * window's 900ms deadlocked the money path until remount).
   */
  const edit = (patch: Partial<TicketState>) => {
    setTicket((prev) => ({ ...prev, ...patch }));
    if (place.phase.kind === "rejected" || place.phase.kind === "settled") {
      place.reset();
      setHeld(false);
    }
  };

  const setSide = (side: OrderSide) => {
    if (side === ticket.side) return;
    screen.setSide(side); // ticketCtx.available is side-selected upstream
    // The brackets do NOT survive a flip: TP/SL prices are aimed at one side
    // of entry, and a long's +5% take-profit becomes a short's instantly-
    // triggering buy-back. "" is the sheet's own encoding for "no bracket" —
    // the rows revert to "Add" rather than guessing new levels.
    edit({ side, tpEnabled: false, tpPrice: "", slEnabled: false, slPrice: "" });
  };

  // A rejection — or a completion that BAILED (see onComplete) — re-arms the
  // hold; render-phase, so the frame that shows the verdict is the frame the
  // button is usable again. `idle`+`held` is unreachable any other way: a
  // real submit flips the phase to "submitting" synchronously before its
  // first await.
  if (held && (place.phase.kind === "rejected" || place.phase.kind === "idle")) setHeld(false);

  // Settled → the sheet's job is done; leave with the success note visible
  // for a beat. An effect with cleanup, because the modal can be swiped away
  // first.
  const settled = place.phase.kind === "settled";
  useEffect(() => {
    if (!settled) return;
    const timer = setTimeout(() => {
      if (router.canGoBack()) router.back();
    }, 900);
    return () => clearTimeout(timer);
  }, [settled]);

  const submitting = place.phase.kind === "submitting";

  // While an order is in flight the sheet cannot be swiped away.
  //
  // Set on THIS screen, which is the modal route itself since the `(market)`
  // group was dissolved (2026-08-31). It used to reach for
  // `navigation.getParent()` because the group's screen owned the
  // presentation; that indirection is gone, and with it the chance of
  // disabling the wrong route's gesture. `gestureEnabled: false` on a native
  // sheet is a hard off rather than the damped pull the old custom card gave,
  // which is the one thing the platform sheet does less gracefully.
  //
  // Not a correctness guard: `placeOrders` journals before it sends, so a
  // dismissed submit is still reconciled. It is there because swiping a
  // half-placed order off screen is a horrible thing to do to someone.
  const navigation = useNavigation();
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !submitting });
    // Restored on unmount, unconditionally. The effect only ever ran forward,
    // so a screen that unmounted while `submitting` was true — a Fast Refresh,
    // a programmatic dismiss, an error boundary — left swipe-to-dismiss off
    // with nothing left to re-enable it.
    return () => {
      navigation.setOptions({ gestureEnabled: true });
    };
  }, [navigation, submitting]);
  const frozen = place.phase.kind === "unknown" || settled;

  const entryForTpsl =
    fields.price && ticket.price !== "" ? ticket.price : (ctx.markPx ?? ctx.midPx);
  const margin = info.marginRequired === "--" ? null : info.marginRequired;

  // ---------------------------------------------------------- sub-editors --
  const priceChips = (anchor: string | null): EditorChip[] =>
    PRICE_CHIP_STEPS.map((step) => ({
      label: step.label,
      value: chipPrice(anchor, step.pct, ctx.szDecimals, ctx.marketType),
    }));

  // Quantized DOWN to the editor's 2dp — `amountForFraction` speaks 6dp
  // (USDC wire), and a 6dp draft in a 2dp editor was uneditable: every
  // keystroke including backspace proposed a string `acceptDecimalEdit`
  // rejects (review finding). ROUND_DOWN so Max can never exceed available.
  const marginChips: EditorChip[] = [0.25, 0.5, 0.75, 1].map((f) => {
    const raw = ctx.available === null ? "" : amountForFraction(ctx.available, f);
    const clamped = raw === "" ? null : new BigNumber(raw).decimalPlaces(2, BigNumber.ROUND_DOWN);
    return {
      label: f === 1 ? "Max" : `${f * 100}%`,
      value: clamped === null || clamped.lte(0) ? "" : clamped.toFixed(),
    };
  });

  const numericEditor = ((): {
    key: EditorKey;
    title: string;
    subtitle?: string;
    unit?: string;
    decimals: number;
    value: string;
    chips?: EditorChip[];
    commitLabel: string;
    onCommit: (value: string) => void;
  } | null => {
    switch (contentKey) {
      case "margin":
        return {
          key: "margin",
          title: "Margin",
          subtitle: ctx.available === null ? undefined : `${ctx.available} available`,
          unit: "USDC",
          decimals: 2,
          value: margin ?? "",
          chips: marginChips,
          commitLabel: "Set Margin",
          onCommit: (value) =>
            edit({ size: sizeFromMargin(value, ctx.leverage, anchorPrice, sizeDecimals) }),
        };
      case "price":
        return {
          key: "price",
          title: `Set Limit ${ticket.side === "long" ? "Buy" : "Sell"} Price`,
          subtitle:
            screen.price === null ? undefined : `${pairTitle(screen.symbol)} · ${screen.price}`,
          decimals: priceDecimals,
          value: ticket.price,
          chips: priceChips(ctx.midPx ?? ctx.markPx),
          commitLabel: "Set",
          onCommit: (value) => edit({ price: value }),
        };
      case "trigger":
        return {
          key: "trigger",
          title: "Set Trigger Price",
          subtitle:
            screen.price === null ? undefined : `${pairTitle(screen.symbol)} · ${screen.price}`,
          decimals: priceDecimals,
          value: ticket.triggerPrice,
          chips: priceChips(ctx.midPx ?? ctx.markPx),
          commitLabel: "Set",
          onCommit: (value) => edit({ triggerPrice: value }),
        };
      case "scaleStart":
        return {
          key: "scaleStart",
          title: "Scale Start Price",
          decimals: priceDecimals,
          value: ticket.scaleStart,
          chips: priceChips(ctx.midPx ?? ctx.markPx),
          commitLabel: "Set",
          onCommit: (value) => edit({ scaleStart: value }),
        };
      case "scaleEnd":
        return {
          key: "scaleEnd",
          title: "Scale End Price",
          decimals: priceDecimals,
          value: ticket.scaleEnd,
          chips: priceChips(ctx.midPx ?? ctx.markPx),
          commitLabel: "Set",
          onCommit: (value) => edit({ scaleEnd: value }),
        };
      case "legs":
        return {
          key: "legs",
          title: "Order Count",
          subtitle: "How many resting orders the ladder splits into",
          decimals: 0,
          value: ticket.legCount,
          commitLabel: "Set",
          onCommit: (value) => edit({ legCount: value }),
        };
      case "runtime": {
        const minutes = parseRuntimeMinutes(ticket.runtime);
        return {
          key: "runtime",
          title: "Runtime",
          subtitle: "Minutes — one suborder every 30 seconds",
          unit: "min",
          decimals: 0,
          value: minutes === null ? "" : String(minutes),
          commitLabel: "Set",
          onCommit: (value) => edit({ runtime: `${value}m` }),
        };
      }
      default:
        return null;
    }
  })();

  // ------------------------------------------------------------- readouts --
  const phaseNote =
    place.phase.kind === "idle" || place.phase.kind === "submitting" ? cta.note : place.phase.note;
  const phaseTone = settled
    ? "text-success"
    : place.phase.kind === "rejected"
      ? "text-danger"
      : place.phase.kind === "unknown"
        ? "text-warning"
        : "text-muted";

  const holdLabel = submitting
    ? "Placing…"
    : settled
      ? "Placed"
      : place.phase.kind === "unknown"
        ? "Submitted"
        : `Hold to ${cta.label}`;

  return (
    <View className="flex-1 bg-background">
      {/* A PLAIN ScrollView, again: the native sheet's dismiss gesture is
          UIKit's and cooperates with scrolled content on its own, so the
          transition-aware wrapper this used to need is gone with the library.
          Values are the resolved Tailwind steps — gap-4, px-5, pt-4. */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          gap: 16,
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* ------------------------------------------------------ header -- */}
        {/* The market's own mark, above its name. This sheet commits money to
            ONE market, and the icon is what makes that unmistakable at a
            glance — the same identity the market screen leads with, so
            arriving here from there is visibly continuous. */}
        <View className="items-center gap-2 pt-1">
          <CoinBadge coin={screen.coin} size={ORDER_BADGE_PX} />
          <View className="items-center gap-1">
            <Typography.Heading className="text-xl font-bold">
              {`Open ${screen.symbol} Position`}
            </Typography.Heading>
            {/* The freshness signal this screen was missing entirely. Every
                other price surface in the app dims and chips a stale figure —
                the market hero, the markets header, the portfolio hero — and
                the order book goes as far as refusing to let one be tapped.
                This is the screen that COMMITS the money against it, and it
                showed a minutes-old number as fact. Two ordinary triggers:
                resume from background, and a declined weight budget (`pollMids`
                skips the write precisely so a stale chip appears instead of a
                silently frozen price — a chip that did not exist here). */}
            <View className="flex-row items-center gap-1.5">
              <Typography.Paragraph className="text-sm text-muted tabular-nums font-normal">
                {`${pairTitle(screen.symbol)}${screen.price === null ? "" : ` · ${screen.price}`}`}
              </Typography.Paragraph>
              {screen.isStale ? (
                <Chip size="sm" color="warning" variant="soft">
                  <Chip.Label className="font-medium">stale</Chip.Label>
                </Chip>
              ) : null}
            </View>
          </View>
        </View>

        {/* -------------------------------------------------------- side -- */}
        {/* A real UIKit segmented control — see `SideSegment`. */}
        <SideSegment
          value={ticket.side}
          longLabel={screen.kind === "spot" ? "Buy" : "Long"}
          shortLabel={screen.kind === "spot" ? "Sell" : "Short"}
          onChange={setSide}
        />

        {/* ---------------------------------------- position sizing card -- */}
        {/* Margin and leverage are ONE decision — how big is this position —
            so they share one surface, parted by a hairline, instead of two
            cards claiming to be separate concerns. Fewer surfaces, and the
            slider pair reads as the two halves of the same control. */}
        <View className="rounded-3xl bg-surface">
          <View className="gap-3 p-4">
            <View className="flex-row items-center justify-between">
              <Typography.Paragraph className="text-base font-semibold">
                {screen.kind === "perp" ? "Margin" : "Amount"}
                <Typography.Paragraph className="text-sm text-muted font-normal">
                  {" "}
                  (USDC)
                </Typography.Paragraph>
              </Typography.Paragraph>
              {screen.kind === "perp" ? <MarginModeControl lev={screen.lev} /> : null}
            </View>
            {/* The available balance is a REFERENCE and the margin is the
              control, and this row used to say the opposite. `available` was
              set solid at `text-lg font-semibold` on the left while the input
              was a ghost button — no container, no fill — whose value is
              usually "--" before you type. So the eye landed on the number you
              cannot change and skipped the one you must. Available is now
              muted supporting text, and the input wears a recessed field. */}
            <View className="flex-row items-center justify-between gap-4">
              <View className="gap-0.5">
                {(() => {
                  const avail = displayValue(ctx.available);
                  return avail === null ? (
                    <Typography.Paragraph className="text-sm text-muted tabular-nums font-normal">
                      --
                    </Typography.Paragraph>
                  ) : (
                    <StaticNumber
                      value={avail}
                      fractionDigits={2}
                      className="text-sm text-muted tabular-nums font-normal"
                    />
                  );
                })()}
                <Typography.Paragraph className="text-xs text-muted font-normal">
                  available
                </Typography.Paragraph>
              </View>
              {/* `bg-background` inside a `bg-surface` card — the subdued step
                the design system reserves for a field on an elevated surface,
                which is what makes an empty one still read as tappable. */}
              {/* A Pressable, not a `Button size="sm"`. The sized button clamps
                its own height, and this label is `text-2xl` — 24pt of bold
                numerals in a box built for a small one, which clipped the
                figure on device. The same trap this file already records for
                the order-type trigger's `h-9`. Sizing to content is the fix;
                the padding here is what the button was drawing anyway. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit margin"
                onPress={() => setEditor("margin")}
                className="flex-row items-center gap-1.5 rounded-2xl bg-background px-3 py-2"
              >
                {/* "--", never "0": a limit ticket with no price yet has an
                  UNKNOWN margin, and a zero would claim the committed size is
                  free. Muted while empty so the dashes read as a placeholder
                  rather than a value someone chose. */}
                <Typography.Paragraph
                  className={`text-2xl tabular-nums font-bold ${margin === null ? "text-muted" : ""}`}
                >
                  {margin ?? "--"}
                </Typography.Paragraph>
                <Pencil size={14} color={mutedColor} />
              </Pressable>
            </View>
            {/* The slider says what it is doing, in its own unit.
              
              Two full-width sliders sit one card apart here with identical
              tracks and thumbs, and nothing on the margin one said what it
              measured — you dragged and watched a number elsewhere change. The
              percentage names the unit (% of available) against the leverage
              card's `x`, which is the difference between two controls that
              merely look alike and two that read alike. */}
            <View className="flex-row items-center justify-between gap-3">
              <Typography.Paragraph className="text-xs text-muted font-normal">
                Size
              </Typography.Paragraph>
              <Typography.Paragraph className="text-xs text-muted tabular-nums font-medium">
                {maxSize === null ? "--" : `${Math.round(fraction * 100)}% of available`}
              </Typography.Paragraph>
            </View>
            {/* The platform's slider, not a drawn one. `Host matchContents`
              keeps it inline in this card rather than opening a native
              container the card's drag would have to negotiate with — and the
              native control reports a single number, so the array-or-scalar
              unwrap the heroui one needed is gone. */}
            <ExpoHost matchContents={{ vertical: true }} style={{ width: "100%" }}>
              <ExpoSlider
                value={fraction}
                min={0}
                max={1}
                step={0.01}
                disabled={maxSize === null}
                onValueChange={(value) => {
                  edit({ size: sizeForFraction(maxSize, value, sizeDecimals) });
                }}
              />
            </ExpoHost>
          </View>

          {screen.kind === "perp" ? (
            <View className="border-t border-separator">
              <LeverageCard lev={screen.lev} maxLeverage={screen.row?.maxLeverage ?? null} />
            </View>
          ) : null}
        </View>

        {/* -------------------------------------------------- order rows -- */}
        <View className="gap-3 rounded-3xl bg-surface p-4">
          <InfoLine
            label="Current Price"
            value={(() => {
              const px = displayValue(screen.price);
              if (px === null) return "--";
              const live = <LiveNumber value={px} fractionDigits={priceDecimals} />;
              // Named here as well as chipped in the header, because this is
              // the row the size slider's cap and the liquidation estimate are
              // both computed from — dimming alone would say "old" without
              // saying what else is therefore old.
              return screen.isStale ? (
                <View className="flex-row items-center gap-1.5">
                  <View className="opacity-50">{live}</View>
                  <Chip size="sm" color="warning" variant="soft">
                    <Chip.Label className="font-medium">stale</Chip.Label>
                  </Chip>
                </View>
              ) : (
                live
              );
            })()}
          />

          {/* Order type: the platform's own menu picker. It replaced a
              compound `Select` whose `Value` tracked its selection internally
              and kept rendering the placeholder after a pick — the label had
              to be rendered by hand from the ticket to work around it. A
              native picker takes the selection as a prop and has no second
              source of truth to disagree with. */}
          <View className="flex-row items-center justify-between gap-4">
            <Typography.Paragraph className="text-sm text-muted font-normal">
              Order Type
            </Typography.Paragraph>
            <ExpoHost matchContents>
              <ExpoPicker
                selectedValue={ticket.type}
                onValueChange={(value) => edit({ type: value as OrderType })}
                appearance="menu"
              >
                {Object.keys(ORDER_TYPE_LABEL).map((type) => (
                  <ExpoPicker.Item
                    key={type}
                    label={ORDER_TYPE_LABEL[type as OrderType]}
                    value={type}
                  />
                ))}
              </ExpoPicker>
            </ExpoHost>
          </View>

          {fields.price ? (
            <EditRow
              label="Limit Price"
              value={ticket.price === "" ? "Set price" : `@ ${ticket.price}`}
              onPress={() => setEditor("price")}
            />
          ) : null}

          {fields.triggerPrice ? (
            <EditRow
              label="Trigger Price"
              value={ticket.triggerPrice === "" ? "Set price" : `@ ${ticket.triggerPrice}`}
              onPress={() => setEditor("trigger")}
            />
          ) : null}

          {fields.scaleRange ? (
            <>
              <EditRow
                label="Start Price"
                value={ticket.scaleStart === "" ? "Set price" : `@ ${ticket.scaleStart}`}
                onPress={() => setEditor("scaleStart")}
              />
              <EditRow
                label="End Price"
                value={ticket.scaleEnd === "" ? "Set price" : `@ ${ticket.scaleEnd}`}
                onPress={() => setEditor("scaleEnd")}
              />
              <EditRow
                label="Order Count"
                value={ticket.legCount === "" ? "Set" : ticket.legCount}
                onPress={() => setEditor("legs")}
              />
            </>
          ) : null}

          {fields.runtime ? (
            <EditRow
              label="Runtime"
              value={(() => {
                const minutes = parseRuntimeMinutes(ticket.runtime);
                return minutes === null ? "Set runtime" : formatRuntime(minutes);
              })()}
              onPress={() => setEditor("runtime")}
            />
          ) : null}

          {fields.tif ? (
            <View className="flex-row items-center justify-between gap-4">
              <Typography.Paragraph className="text-sm text-muted font-normal">
                Time in Force
              </Typography.Paragraph>
              <View className="w-44">
                <Segment
                  size="sm"
                  value={ticket.tif}
                  onValueChange={(value) => edit({ tif: value as Tif })}
                >
                  <Segment.Group>
                    <Segment.Indicator />
                    {TIF_OPTIONS.map((tif) => (
                      <Segment.Item key={tif} value={tif} className="flex-1">
                        <Segment.Label className="font-medium">{tif.toUpperCase()}</Segment.Label>
                      </Segment.Item>
                    ))}
                  </Segment.Group>
                </Segment>
              </View>
            </View>
          ) : null}

          {fields.slippage && info.slippage !== null ? (
            <InfoLine label="Max Slippage" value={info.slippage} />
          ) : null}

          {line !== null ? (
            <InfoLine
              label="Size"
              value={(() => {
                const notional = displayValue(line.notional);
                if (notional === null) return `$${line.notional} = ${line.base}`;
                return (
                  // `flex-1` + `justify-end`: without a bound the row grew past
                  // the card and clipped its own tail (seen on device).
                  <View className="flex-1 flex-row items-center justify-end gap-1">
                    <StaticNumber
                      value={notional}
                      fractionDigits={2}
                      currency
                      className="text-sm tabular-nums font-semibold"
                    />
                    <Typography.Paragraph
                      className="shrink text-sm text-muted font-normal"
                      numberOfLines={1}
                    >
                      {`= ${line.base}`}
                    </Typography.Paragraph>
                  </View>
                );
              })()}
            />
          ) : null}

          {fields.runtime && info.sizePerSuborder !== "--" ? (
            <InfoLine label="Per Suborder" value={info.sizePerSuborder ?? "--"} />
          ) : null}

          {/* `Checkbox`, which SwiftUI renders as a TOGGLE on iOS — the box
              form is macOS-only, so this reads as a switch on device whatever
              the component is called. Named accurately here so nobody "fixes"
              it to `Switch` expecting a different control. */}
          {fields.reduceOnly || fields.randomize ? (
            <ExpoHost matchContents={{ vertical: true }} style={{ width: "100%" }}>
              <ExpoRow spacing={24}>
                {fields.reduceOnly ? (
                  <ExpoCheckbox
                    label="Reduce Only"
                    value={ticket.reduceOnly}
                    onValueChange={(next) => edit({ reduceOnly: next })}
                  />
                ) : null}
                {fields.randomize ? (
                  <ExpoCheckbox
                    label="Randomize"
                    value={ticket.randomize}
                    onValueChange={(next) => edit({ randomize: next })}
                  />
                ) : null}
              </ExpoRow>
            </ExpoHost>
          ) : null}
        </View>

        {/* ------------------------------------------------- liq readout -- */}
        {info.liquidationPrice !== "--" ? (
          <View className="gap-0.5 px-1">
            <View className="flex-row items-center gap-1">
              <Typography.Paragraph className="text-sm font-medium">
                Liquidated at
              </Typography.Paragraph>
              {(() => {
                const liq = displayValue(info.liquidationPrice);
                return liq === null ? (
                  <Typography.Paragraph className="text-sm tabular-nums font-medium">
                    {info.liquidationPrice}
                  </Typography.Paragraph>
                ) : (
                  <StaticNumber
                    value={liq}
                    fractionDigits={priceDecimals}
                    className="text-sm tabular-nums font-medium"
                  />
                );
              })()}
            </View>
            <Typography.Paragraph className="text-xs text-danger tabular-nums font-normal">
              {(() => {
                const delta = liqDeltaPct(info.liquidationPrice, screen.price);
                return delta === null ? "estimate" : `${delta} from current price · estimate`;
              })()}
            </Typography.Paragraph>
          </View>
        ) : null}

        {/* -------------------------------------------------- TP/SL rows -- */}
        {fields.tpslAttach ? (
          <View className="gap-3 rounded-3xl bg-surface p-4">
            <EditRow
              label="Take Profit"
              value={ticket.tpPrice === "" ? "Add" : `@ ${ticket.tpPrice}`}
              onPress={() => setEditor("tp")}
            />
            <EditRow
              label="Stop Loss"
              value={ticket.slPrice === "" ? "Add" : `@ ${ticket.slPrice}`}
              onPress={() => setEditor("sl")}
            />
          </View>
        ) : null}

        {/* ----------------------------------------------------- details -- */}
        <View className="gap-2 px-1 pb-2">
          {screen.kind === "perp" ? (
            <InfoLine
              label="Funding / hr"
              value={fundingPercentLabel(screen.ctx?.funding ?? null)}
              muted
            />
          ) : null}
          <InfoLine label="Fees (taker / maker)" value={info.fees} muted />
        </View>
      </ScrollView>

      {/* ------------------------------------------------------ commit -- */}
      <View className="gap-2 px-5 pt-2" style={{ paddingBottom: insets.bottom || 16 }}>
        {phaseNote === null ? null : (
          <Typography.Paragraph
            className={`text-sm text-center font-normal ${phaseTone}`}
            numberOfLines={2}
          >
            {phaseNote}
          </Typography.Paragraph>
        )}

        {!ctx.isSignedIn || !ctx.canTrade ? (
          <Button
            variant="primary"
            size="lg"
            onPress={() => {
              router.back();
              router.push("/account");
            }}
          >
            <Button.Label className="font-semibold">{cta.label}</Button.Label>
          </Button>
        ) : (
          <ProgressButton
            variant={ticket.side === "long" ? "success" : "danger"}
            holdDuration={1200}
            isDisabled={cta.isDisabled || submitting || frozen}
            isCompleted={held}
            onCompleteChange={setHeld}
            onComplete={() => {
              // Re-check at fire time: the gate is LIVE (a price tick can
              // shrink max size mid-hold), and the library's fill completes
              // regardless of a mid-press `isDisabled` flip. A bail leaves
              // phase "idle" + held true, which the render-phase re-arm
              // above turns back into an armed button.
              if (cta.isDisabled || submitting || frozen) return;
              void place.submit(ticket, ctx, screen.coin);
            }}
            accessibilityLabel={holdLabel}
          >
            <ProgressButton.Label className="font-semibold">{holdLabel}</ProgressButton.Label>
            <ProgressButton.Overlay>
              <ProgressButton.MaskLabel className="font-semibold">
                {holdLabel}
              </ProgressButton.MaskLabel>
            </ProgressButton.Overlay>
          </ProgressButton>
        )}
      </View>

      {/* -------------------------------------------------- sub-editors -- */}
      <NumericEditorSheet
        // Open-state gates on the LIVE editor key — `numericEditor` derives
        // from `contentKey`, which deliberately never returns to null (it
        // keeps the closing editor's content intact), so using it here held
        // the dialog open forever (seen on device).
        isOpen={editor !== null && editor !== "tp" && editor !== "sl"}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        title={numericEditor?.title ?? ""}
        subtitle={numericEditor?.subtitle}
        unit={numericEditor?.unit}
        decimals={numericEditor?.decimals ?? 2}
        value={numericEditor?.value ?? ""}
        chips={numericEditor?.chips}
        commitLabel={numericEditor?.commitLabel ?? "Set"}
        onCommit={(value) => numericEditor?.onCommit(value)}
      />

      <TpslEditor
        isOpen={editor === "tp" || editor === "sl"}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        kind={contentKey === "sl" ? "sl" : "tp"}
        side={ticket.side}
        symbol={screen.symbol}
        entry={entryForTpsl}
        baseSize={ticket.size}
        margin={margin}
        szDecimals={ctx.szDecimals}
        marketType={ctx.marketType}
        priceDecimals={priceDecimals}
        value={contentKey === "sl" ? ticket.slPrice : ticket.tpPrice}
        onCommit={(price) => {
          if (contentKey === "sl") edit({ slEnabled: price !== "", slPrice: price });
          else edit({ tpEnabled: price !== "", tpPrice: price });
        }}
      />
    </View>
  );
}

/**
 * The numeric font, as a style OBJECT.
 *
 * `NumberFlow` renders its digit stacks outside the className pipeline, so
 * the family has to be named explicitly or the figure silently falls back to
 * the system font — the same reason `FlashPrice` styles with an object.
 */
const NUMERIC_FONT_FAMILY = "SFProRounded-Semibold";

/**
 * A wire string as a display number, or `null` when it is not one.
 *
 * `Number()` at a display leaf is the house exception — nothing downstream of
 * here re-enters the money path. `"--"` (this app's spelling for unknown) and
 * `""` both come back `null`, so a caller renders its own dash rather than a
 * zero.
 */
function displayValue(text: string | null): number | null {
  if (text === null || text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A formatted figure, via Pro's `NumberValue`.
 *
 * `NumberValue` is a FORMATTER, not an animation — its own types say it "has
 * no intrinsic animation of its own". It earns its place by giving every
 * number on this sheet one locale-aware formatter with explicit fraction
 * digits, instead of a scatter of `toFixed` calls.
 */
function StaticNumber({
  value,
  fractionDigits,
  className,
  currency = false,
}: {
  value: number;
  fractionDigits: number;
  className: string;
  /** Formats as USD. `NumberValue`'s own currency style, not a "$" glued on
      the front — the symbol's placement is the locale's business. */
  currency?: boolean;
}): JSX.Element {
  return (
    <NumberValue
      value={value}
      minimumFractionDigits={fractionDigits}
      maximumFractionDigits={fractionDigits}
      {...(currency ? ({ numberStyle: "currency", currency: "USD" } as const) : {})}
    >
      <NumberValue.Value className={className} numberOfLines={1} />
    </NumberValue>
  );
}

/**
 * The one figure on this sheet that moves on its own — rolling digits.
 *
 * Fraction digits are PINNED by the caller, never derived per value: the wire
 * trims trailing zeros (`69.10` arrives as `69.1`), and a format that follows
 * each spelling changes the width mid-roll, which clips NumberFlow's
 * rightmost digit. That rule is `FlashPrice`'s, restated because it is the
 * failure this component invites.
 *
 * One instance only. Profiled previously on the Markets tab, NumberFlow costs
 * ~150 components per figure — it is right for a hero, wrong for a list.
 */
function LiveNumber({
  value,
  fractionDigits,
}: {
  value: number;
  fractionDigits: number;
}): JSX.Element {
  const color = useThemeColor("foreground");

  return (
    <NumberFlow
      value={value}
      format={{ minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }}
      respectMotionPreference
      style={{
        fontFamily: NUMERIC_FONT_FAMILY,
        fontSize: 14,
        color,
        fontVariant: ["tabular-nums" as const],
      }}
    />
  );
}

/** A quiet label/value line. */
function InfoLine({
  label,
  value,
  muted = false,
}: {
  label: string;
  /** A string is wrapped for you; a node renders as-is (numeric rows). */
  value: ReactNode;
  muted?: boolean;
}): JSX.Element {
  return (
    <View className="flex-row items-center justify-between gap-4">
      <Typography.Paragraph className="text-sm text-muted font-normal">
        {label}
      </Typography.Paragraph>
      {typeof value === "string" ? (
        <Typography.Paragraph
          className={`text-sm tabular-nums ${muted ? "text-muted font-normal" : "font-semibold"}`}
          numberOfLines={1}
        >
          {value}
        </Typography.Paragraph>
      ) : (
        value
      )}
    </View>
  );
}

/** A label with a tappable value chip — the reference's "@ $77,345 ✏️" rows. */
function EditRow({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress: () => void;
}): JSX.Element {
  const mutedColor = useThemeColor("muted");
  return (
    <View className="flex-row items-center justify-between gap-4">
      <Typography.Paragraph className="text-sm text-muted font-normal">
        {label}
      </Typography.Paragraph>
      <Button
        variant="tertiary"
        size="sm"
        accessibilityLabel={`${label}, ${value}`}
        onPress={onPress}
      >
        <Button.Label className="text-sm tabular-nums font-medium">{value}</Button.Label>
        <Pencil size={12} color={mutedColor} />
      </Button>
    </View>
  );
}

/**
 * The leverage card. The slider PROPOSES; releasing it writes the pair to the
 * exchange through the echo-gated apply — leverage is account state, not an
 * order field, and a preview computed against an unconfirmed multiple would
 * misprice every margin figure on this sheet. The draft snaps back to the
 * server's answer on failure.
 */
function LeverageCard({
  lev,
  maxLeverage,
}: {
  lev: LeverageControl;
  maxLeverage: number | null;
}): JSX.Element {
  const [draft, setDraft] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confirmed = lev.value?.leverage ?? null;
  const shown = draft ?? confirmed ?? 1;

  return (
    // No surface of its own: it renders into the position-sizing card, under
    // the hairline that parts it from the margin half.
    <View className="gap-3 p-4">
      <View className="flex-row items-end justify-between gap-4">
        <View className="gap-0.5">
          <Typography.Paragraph className="text-base font-semibold">Leverage</Typography.Paragraph>
          <Typography.Paragraph className="text-xs text-muted font-normal">
            {maxLeverage === null ? "up to --" : `up to ${maxLeverage}x`}
            {lev.applying ? " · applying…" : ""}
          </Typography.Paragraph>
        </View>
        <Typography.Paragraph className="text-2xl tabular-nums font-bold">
          {`${shown}x`}
        </Typography.Paragraph>
      </View>
      <Slider
        value={shown}
        minValue={1}
        maxValue={maxLeverage ?? 1}
        step={1}
        // `applying` included (the MarginModeChip already does): apply is
        // fire-once with no queue, so a release during the in-flight window
        // was silently discarded — the thumb snapped back and the account
        // kept a leverage the user had visibly dragged away from.
        isDisabled={confirmed === null || maxLeverage === null || lev.applying}
        onChange={(value) => {
          setDraft(Array.isArray(value) ? (value[0] ?? 1) : value);
        }}
        onChangeEnd={(value) => {
          const next = Array.isArray(value) ? (value[0] ?? 1) : value;
          const current = lev.value;
          if (current === null || lev.applying || next === current.leverage) {
            setDraft(null);
            return;
          }
          setError(null);
          void lev.apply({ leverage: next, isCross: current.isCross }).then((result) => {
            setDraft(null);
            if (result.kind === "failed") setError(result.error.message);
          });
        }}
      >
        <Slider.Track>
          <Slider.Fill />
          <Slider.Thumb />
        </Slider.Track>
      </Slider>
      {error === null ? null : (
        <Typography.Paragraph className="text-xs text-danger font-normal" numberOfLines={2}>
          {error}
        </Typography.Paragraph>
      )}
    </View>
  );
}
