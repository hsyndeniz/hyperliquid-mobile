/**
 * Move USDC between the perps and spot balances of one account.
 *
 * ## Seventh design: one route card, then one amount
 *
 * The two ends stopped being two stacked surfaces and became **one card with
 * two columns**, the way every exchange's transfer sheet draws it: `From` over
 * `Spot` over its balance, the swap control in the middle, `To` over `Perps`
 * over its balance. Stacked full-width surfaces spent a third of a dialog
 * saying something a 40pt row says better, and the vertical arrow between them
 * read as "scroll", not "swap".
 *
 * Below the card there is one question — how much — asked once, as a labelled
 * field with a decorative `USDC` suffix and a percentage slider under it. Then
 * the single caption, then the button.
 *
 * ## Why a swap button and not two selectors
 *
 * `DexBucket` has exactly two inhabitants here, so a pair of From/To dropdowns
 * would draw an N×N matrix the router cannot express — three of its four cells
 * are `same_bucket`. One control that exchanges the ends is the whole choice.
 *
 * ## What survives from the previous design
 *
 * The caption's strict priority still lives in `moveCaption` (pure, tested),
 * and the after-preview survives there because a wrong direction *succeeds
 * silently* — `After: perps 2.89 · spot 0.25` is the check that catches it.
 * `--`, never `0`, for a balance still in flight.
 */

import type { JSX } from "react";
import { useState } from "react";
import { View } from "react-native";
import { ArrowLeftRight } from "lucide-react-native";
import { Button, InputGroup, Slider, Surface, Typography } from "heroui-native";

import { acceptEdit, amountForFraction, fractionOf } from "@/components/money/amountEntry";
import {
  blockersFor,
  flip,
  labelFor,
  moveCaption,
  signerFor,
  type MoveDirection,
} from "@/components/money/moveView";
import { useAccountMove } from "@/hyperliquid/hooks/transfer";
import type { HyperliquidSession } from "@/hyperliquid/session";

const CAPTION_TONE = {
  muted: "text-muted",
  danger: "text-danger",
  success: "text-success",
} as const;

/**
 * The two ends of the route, spelled out whole.
 *
 * Uniwind discovers classes by scanning the source for STRING LITERALS, so
 * `items-${side}` compiles to no style at all. A complete-literal lookup is the
 * only safe way to vary a class by data.
 */
const ROUTE_END = {
  From: { column: "flex-1 items-start gap-1", align: "start" },
  To: { column: "flex-1 items-end gap-1", align: "end" },
} as const;

/**
 * Where the slider's tick dots sit.
 *
 * The thumb's LEFT edge travels `0 → trackWidth - thumbWidth` (heroui offsets
 * it by `percent * (trackSize - thumbSize)`), so its CENTRE travels
 * `thumbWidth/2 → trackWidth - thumbWidth/2`. Ticks laid out flush to the track
 * ends would therefore sit 14pt outside the positions they claim to mark. Inset
 * by half the thumb less the dot's own radius and the dot centres land exactly
 * on the thumb's real travel.
 *
 * `w-7` on `slider__thumb-container--orientation-horizontal` is the 28.
 */
const THUMB_WIDTH = 28;
const TICK_SIZE = 4;
const TICK_INSET = THUMB_WIDTH / 2 - TICK_SIZE / 2;
const TICKS = [0, 0.25, 0.5, 0.75, 1];

/** One end of the route: what it is, which bucket, and what it holds. */
function RouteEnd({
  role,
  name,
  available,
}: {
  role: "From" | "To";
  name: string;
  available: string | null;
}): JSX.Element {
  const layout = ROUTE_END[role];

  return (
    <View className={layout.column}>
      <Typography.Paragraph className="text-xs text-muted font-normal" align={layout.align}>
        {role}
      </Typography.Paragraph>
      {/* One line each. Inside a dialog these columns are ~108pt wide, and a
          balance that wraps makes the two ends different heights — which reads
          as one of them being in an error state. */}
      <Typography.Paragraph
        className="text-base font-semibold"
        align={layout.align}
        numberOfLines={1}
      >
        {name}
      </Typography.Paragraph>
      <Typography.Paragraph
        className="text-xs text-muted tabular-nums font-normal"
        align={layout.align}
        numberOfLines={1}
      >
        {/* `--`, never 0: a balance still in flight is unknown, not empty. */}
        {available === null ? "--" : `${available} USDC`}
      </Typography.Paragraph>
    </View>
  );
}

export function PerpSpotMove({
  session,
  canTrade,
  initialDirection,
  availableSpot,
  availablePerp,
}: {
  session: HyperliquidSession;
  /** Agent present. Decides which signer, and whether a prompt is coming. */
  canTrade: boolean;
  /** Pre-orient towards what the screen above needs. */
  initialDirection: MoveDirection;
  /** `null` means not read yet — NOT zero. */
  availableSpot: string | null;
  availablePerp: string | null;
}): JSX.Element {
  const [direction, setDirection] = useState<MoveDirection>(initialDirection);
  const [amount, setAmount] = useState("");
  const { state, move } = useAccountMove(session);

  const source = direction === "toPerp" ? availableSpot : availablePerp;
  const dest = direction === "toPerp" ? availablePerp : availableSpot;
  const labels = labelFor(direction);

  const blockers = blockersFor({ direction, amount, available: source });
  const isBusy = state.isBusy;
  const share = fractionOf(amount, source);
  const caption = moveCaption({
    direction,
    amount,
    sourceAvailable: source,
    destAvailable: dest,
    prompts: signerFor(canTrade).prompts,
    error: state.lastError === null ? null : `${state.lastError.code}: ${state.lastError.message}`,
    note: state.lastNote,
  });

  return (
    <View className="gap-4">
      <Surface variant="secondary" className="flex-row items-center gap-3 rounded-2xl px-4 py-3">
        <RouteEnd role="From" name={labels.from} available={source} />
        <Button
          isIconOnly
          size="sm"
          variant="outline"
          // The icon is the only thing here, so the control is unlabelled to a
          // screen reader without this — and it is the ONLY way the direction
          // gets chosen.
          accessibilityLabel={`Swap direction, currently ${labels.from} to ${labels.to}`}
          isDisabled={isBusy}
          onPress={() => {
            setDirection(flip(direction));
            // The amount was a share of the OLD source's balance; carrying it
            // across can silently overdraw the new one.
            setAmount("");
          }}
        >
          <ArrowLeftRight size={14} />
        </Button>
        <RouteEnd role="To" name={labels.to} available={dest} />
      </Surface>

      <View className="gap-2">
        <Typography.Paragraph className="text-xs text-muted font-normal">
          Amount
        </Typography.Paragraph>
        <InputGroup isDisabled={isBusy}>
          <InputGroup.Input
            value={amount}
            // Filtered, not raw: `canonicalAmount` THROWS at press time on
            // "1.2.3" or a seventh decimal, and a system decimal-pad happily
            // emits both. A rejected edit leaves the value untouched, so the
            // keystroke is inert rather than an error to dismiss.
            onChangeText={(next) => {
              const accepted = acceptEdit(next);
              if (accepted !== null) setAmount(accepted);
            }}
            placeholder="0.00"
            keyboardType="decimal-pad"
            inputMode="decimal"
          />
          <InputGroup.Suffix isDecorative>
            <Typography.Paragraph className="text-sm text-muted font-normal">
              USDC
            </Typography.Paragraph>
          </InputGroup.Suffix>
        </InputGroup>
      </View>

      <View className="gap-2">
        <View className="flex-row items-center justify-between gap-3">
          <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
            {source === null
              ? "Balance loading…"
              : `${Math.round(share * 100)}% of ${labels.from.toLowerCase()}`}
          </Typography.Paragraph>
          <Button
            size="sm"
            variant="outline"
            isDisabled={isBusy || source === null}
            // The balance verbatim, via the same wire-safe converter the
            // slider uses — never a float round of it. Which is also why
            // dragging to the right edge produces this exact string.
            onPress={() => setAmount(amountForFraction(source, 1))}
          >
            <Button.Label className="font-medium">Max</Button.Label>
          </Button>
        </View>

        {/* The slider and the field stay in lockstep: typing moves the thumb
            through `fractionOf`, dragging writes the amount through
            `amountForFraction`. The float exists only as the gesture — money
            re-enters as a BigNumber string rounded DOWN to wire precision, so
            no thumb position can produce an amount the signature rejects. */}
        <Slider
          value={share}
          minValue={0}
          maxValue={1}
          step={0.01}
          isDisabled={isBusy || source === null}
          onChange={(value) => {
            const fraction = Array.isArray(value) ? value[0] : value;
            setAmount(amountForFraction(source, fraction));
          }}
        >
          <Slider.Track>
            {/* Quarter marks, UNDER the fill deliberately: no single colour
                reads against both the `bg-default` track and the `bg-accent`
                fill in both themes, so the dots you have passed are swallowed
                by the fill rather than rendered in a colour that disappears
                on one of the two. `pointerEvents` off — the track's own tap
                handler owns every point on it. */}
            <View
              pointerEvents="none"
              // `top-0 bottom-0`, not `inset-y-0`: Tailwind v4 compiles the
              // latter to the logical shorthand `inset-block`, which Uniwind
              // does not translate — the row would collapse to zero height.
              className="absolute top-0 bottom-0 flex-row items-center justify-between"
              style={{ left: TICK_INSET, right: TICK_INSET }}
            >
              {TICKS.map((tick) => (
                <View key={tick} className="size-1 rounded-full bg-muted" />
              ))}
            </View>
            <Slider.Fill />
            <Slider.Thumb />
          </Slider.Track>
        </Slider>
      </View>

      {/* The one caption. Priority lives in `moveCaption`, not in JSX. */}
      <Typography.Paragraph
        className={`text-xs tabular-nums font-normal ${CAPTION_TONE[caption.tone]}`}
      >
        {caption.text}
      </Typography.Paragraph>

      <Button
        isDisabled={blockers.length > 0 || isBusy}
        onPress={() => {
          void move({ direction, amount, canTrade }).then((result) => {
            // Clear only on success: a failed amount is usually one the user
            // wants to correct, not retype.
            if (result.kind === "done") setAmount("");
          });
        }}
      >
        <Button.Label className="font-medium">
          {isBusy ? "Moving…" : `Move to ${labels.to.toLowerCase()}`}
        </Button.Label>
      </Button>
    </View>
  );
}
