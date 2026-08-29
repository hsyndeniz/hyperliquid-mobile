/**
 * A labelled fact, as a row rather than a tile.
 *
 * The market screen used a two-column tile grid, which reads well for four
 * short figures and badly for what this screen actually shows: labels of very
 * different lengths ("Open interest", "Funding rate") against values of very
 * different shapes (`$4.6M`, `+0.1773% (00:16:23)`). A tile has to size for the
 * widest of both, so the grid was mostly whitespace and the eye had no single
 * column to run down.
 *
 * Rows fix the scan: label left, value right, one vertical rule of digits. It
 * is also the shape the venue's own app uses, which matters for a screen a user
 * cross-checks against it.
 *
 * The icon is not decoration. These facts are otherwise five lines of similar
 * grey text, and the glyph is what lets someone come back to "funding" without
 * reading the labels again.
 */

import type { JSX, ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Typography, useThemeColor } from "heroui-native";
import { ChevronRight, type LucideIcon } from "lucide-react-native";

const ICON_PX = 20;
const CHEVRON_PX = 18;

export interface InfoRowProps {
  icon: LucideIcon;
  label: string;
  /** `null` renders the dash — "not read yet", never a zero. */
  value?: string | null;
  /** Colours the value where its sign carries meaning. */
  tone?: "up" | "down" | "neutral";
  /** Makes the row a disclosure: a chevron appears and the whole row presses. */
  onPress?: () => void;
  /** Rotates the chevron when the row owns something expanded below it. */
  isExpanded?: boolean;
  /** Rendered under the row, inside the same card — for a disclosure's body. */
  children?: ReactNode;
  /** Sits after the value, for a unit or a clock the value cannot carry. */
  suffix?: ReactNode;
}

const TONE_CLASS = {
  up: "text-success",
  down: "text-danger",
  neutral: "text-foreground",
} as const;

export function InfoRow({
  icon: Icon,
  label,
  value = null,
  tone,
  onPress,
  isExpanded = false,
  children,
  suffix,
}: InfoRowProps): JSX.Element {
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);

  const body = (
    <View className="flex-row items-center gap-3 py-3.5">
      <Icon size={ICON_PX} color={muted} />
      <Typography.Paragraph className="flex-1 text-base font-normal">{label}</Typography.Paragraph>
      {value === null ? null : (
        <Typography.Paragraph
          className={`text-base tabular-nums font-normal ${tone ? TONE_CLASS[tone] : "text-muted"}`}
          numberOfLines={1}
        >
          {value}
        </Typography.Paragraph>
      )}
      {suffix}
      {onPress === undefined ? null : (
        <View style={{ transform: [{ rotate: isExpanded ? "90deg" : "0deg" }] }}>
          <ChevronRight size={CHEVRON_PX} color={foreground} />
        </View>
      )}
    </View>
  );

  return (
    <View>
      {onPress === undefined ? (
        body
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ expanded: isExpanded }}
          onPress={onPress}
        >
          {body}
        </Pressable>
      )}
      {children}
    </View>
  );
}

/**
 * The rows, separated.
 *
 * A hairline between rows and none at the edges — drawn per row rather than as
 * a border on the card, so a disclosure body can sit inside the list without a
 * rule cutting through it.
 */
export function InfoRowGroup({ children }: { children: ReactNode[] }): JSX.Element {
  return (
    <View>
      {children.map((child, index) => (
        <View
          // A fixed, ordered fact list — these rows never reorder, filter, or
          // carry state, so position IS their identity.
          key={index}
          className={index === 0 ? "" : "border-t border-border"}
        >
          {child}
        </View>
      ))}
    </View>
  );
}
