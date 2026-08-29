/**
 * One collapsible section of the Account screen, with its state on the lid.
 *
 * The screen used to be five stacked cards, each ~200pt tall and each mostly
 * detail — a wall you scrolled past rather than read. As an accordion the
 * whole screen fits one viewport, but that trade only works if collapsing
 * hides *detail* and never *status*: a section you must open to discover
 * something is wrong is a section nobody opens.
 *
 * So the trigger carries a measure — a `StatusLine` the pure view layer
 * computes (`connectionMeasure`, `walletMeasure`, `sessionPhase`) — with its
 * dot and its tone. Closed, the screen reads as a status list; open, it is the
 * old card body unchanged.
 */

import type { JSX, ReactNode } from "react";
import { View } from "react-native";
import { Accordion, Typography } from "heroui-native";

import type { StatusLine } from "@/components/account/accountView";
import { StatusDot } from "@/components/account/primitives";
import { TONE_TEXT } from "@/components/account/accountView";

export function AccountSection({
  value,
  title,
  measure,
  children,
}: {
  /** Accordion identity — must be unique within the screen's Accordion. */
  value: string;
  title: string;
  /** The one fact worth seeing without opening the section. */
  measure: StatusLine;
  children: ReactNode;
}): JSX.Element {
  return (
    <Accordion.Item value={value}>
      {/* The trigger is already `flex-row justify-between` with the indicator
          as its last child, so this wrapper takes the remaining width and
          spreads title against measure inside it. */}
      <Accordion.Trigger>
        <View className="flex-1 flex-row items-center justify-between gap-3">
          <Typography.Paragraph className="font-semibold">{title}</Typography.Paragraph>
          <View className="flex-row items-center gap-2">
            <StatusDot tone={measure.tone} />
            <Typography.Paragraph
              className={`text-sm tabular-nums font-medium ${TONE_TEXT[measure.tone]}`}
              numberOfLines={1}
            >
              {measure.label}
            </Typography.Paragraph>
          </View>
        </View>
        <Accordion.Indicator />
      </Accordion.Trigger>

      <Accordion.Content>
        <View className="gap-3">{children}</View>
      </Accordion.Content>
    </Accordion.Item>
  );
}
