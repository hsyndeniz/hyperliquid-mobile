/**
 * TP/SL editor — the reference app's "Take Profit / Stop Loss" editor.
 *
 * A thin skin over {@link NumericEditorSheet}: preset chips at ±5/10/25/50 %
 * of entry (aimed at the kind's own side — TP toward profit, SL toward loss),
 * and a live readout of what a fill at the draft price would realise, in both
 * ROI-on-margin and quote terms. The projection is a preview, not a promise:
 * the bracket fires as a market order, and the fill can slip.
 *
 * The chips AIM but do not police: a hand-typed price on the "wrong" side of
 * entry is accepted, because the exchange accepts it too — the readout goes
 * red, which is the honest warning (`tpslDirection` is intent, not
 * validation).
 */

import type { JSX } from "react";
import { View } from "react-native";
import { Typography } from "heroui-native";

import { NumericEditorSheet, type EditorChip } from "@/components/trade/NumericEditorSheet";
import {
  TPSL_PRESET_PCTS,
  offsetPctLabel,
  projectedPnl,
  roiOnMargin,
  tpslDirection,
  tpslPresetPrice,
} from "@/components/trade/orderSheetView";

import type { OrderSide } from "@/components/trade/orderForm";

export function TpslEditor({
  isOpen,
  onOpenChange,
  kind,
  side,
  symbol,
  entry,
  baseSize,
  margin,
  szDecimals,
  marketType,
  priceDecimals,
  value,
  onCommit,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "tp" | "sl";
  side: OrderSide;
  symbol: string;
  /** The price the projection measures from — the ticket's own entry. */
  entry: string | null;
  /** Ticket size in BASE units — sizes the PnL projection. */
  baseSize: string;
  /** The margin behind the ticket; the ROI denominator. `null` = unread. */
  margin: string | null;
  szDecimals: number | null;
  marketType: "perp" | "spot";
  priceDecimals: number;
  /** The committed trigger price — `""` when none is set yet. */
  value: string;
  /** `""` removes the bracket; anything else sets it. */
  onCommit: (price: string) => void;
}): JSX.Element {
  const direction = tpslDirection(kind, side);

  const chips: EditorChip[] = TPSL_PRESET_PCTS.map((pct) => ({
    label: `${direction === "above" ? "+" : "-"}${(pct * 100).toFixed(0)}%`,
    value: tpslPresetPrice(entry, pct, kind, side, szDecimals, marketType),
  }));

  return (
    <NumericEditorSheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={kind === "tp" ? "Take Profit" : "Stop Loss"}
      subtitle={entry === null ? symbol : `${symbol} · ${entry}`}
      decimals={priceDecimals}
      value={value}
      chips={chips}
      commitLabel={kind === "tp" ? "Set Take Profit" : "Set Stop Loss"}
      onCommit={onCommit}
      onClear={value === "" ? undefined : () => onCommit("")}
      renderReadout={(draft) => (
        <Readout
          kind={kind}
          side={side}
          entry={entry}
          draft={draft}
          baseSize={baseSize}
          margin={margin}
        />
      )}
    />
  );
}

function Readout({
  kind,
  side,
  entry,
  draft,
  baseSize,
  margin,
}: {
  kind: "tp" | "sl";
  side: OrderSide;
  entry: string | null;
  draft: string;
  baseSize: string;
  margin: string | null;
}): JSX.Element | null {
  if (draft === "") return null;

  const offset = offsetPctLabel(entry, draft);
  const pnl = projectedPnl(entry, draft, baseSize, side);
  const roi = roiOnMargin(margin, pnl);

  // Tone follows the PROJECTION's sign, not the sheet's kind: a stop typed
  // above a long's entry locks in profit and reads green, a "take profit"
  // dragged past entry reads red — the number tells the truth the label
  // cannot.
  const gains = pnl !== null && !pnl.startsWith("-");
  const tone = gains ? "text-success" : "text-danger";

  return (
    <View className="gap-2 rounded-2xl bg-surface p-4">
      <Row label={`Distance from entry`} value={offset ?? "--"} tone="text-foreground" />
      <Row label={gains ? "You gain (ROI)" : "You lose (ROI)"} value={roi ?? "--"} tone={tone} />
      <Row
        label={`${kind === "tp" ? "Take profit" : "Stop loss"} expected PnL`}
        value={pnl === null ? "--" : `${gains ? "+" : "-"}$${pnl.replace("-", "")}`}
        tone={tone}
      />
    </View>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone: string }): JSX.Element {
  return (
    <View className="flex-row items-center justify-between gap-4">
      <Typography.Paragraph className="text-sm text-muted font-normal">
        {label}
      </Typography.Paragraph>
      <Typography.Paragraph className={`text-sm tabular-nums font-semibold ${tone}`}>
        {value}
      </Typography.Paragraph>
    </View>
  );
}
