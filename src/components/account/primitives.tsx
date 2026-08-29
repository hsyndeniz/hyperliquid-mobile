/**
 * The Account screen's tiny shared parts.
 */

import type { JSX } from "react";
import { View } from "react-native";
import { Typography } from "heroui-native";

import { TONE_DOT, TONE_TEXT, type Tone } from "@/components/account/accountView";

/**
 * A status dot — the tone made visible without words.
 *
 * **Nothing at all when the tone is `muted`.** The dot exists to colour-code a
 * state; a colourless one codes nothing, and it was being drawn beside labels
 * that are not states at all — `Appearance · Light` and `About · 1.0.0` each
 * carried a grey dot, which reads as a status indicator and dilutes the three
 * rows whose dots mean something. `appearanceMeasure` had already reasoned its
 * way here in its own docstring ("colouring it would spend a signal the screen
 * needs elsewhere") without the view acting on it.
 *
 * The rows this also quiets — `Signed out`, `Checking…`, `None` — lose nothing:
 * each says its state in the label, so the grey circle beside it was a second,
 * less specific copy. Every tone that carries information keeps its dot.
 */
export function StatusDot({ tone }: { tone: Tone }): JSX.Element | null {
  if (tone === "muted") return null;
  return <View className={`h-2 w-2 rounded-full ${TONE_DOT[tone]}`} />;
}

/** A label/value row, portfolio-style: quiet label left, answer right. */
export function InfoRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: Tone;
}): JSX.Element {
  return (
    <View className="flex-row items-start justify-between gap-4">
      <Typography.Paragraph className="text-sm text-muted font-normal">
        {label}
      </Typography.Paragraph>
      <Typography.Paragraph
        className={`flex-1 text-right text-sm tabular-nums font-normal ${
          tone === undefined ? "" : TONE_TEXT[tone]
        }`}
      >
        {value}
      </Typography.Paragraph>
    </View>
  );
}
