/**
 * The market screen's fact list, on heroui's `ListGroup`.
 *
 * One grouped surface, iOS-Settings anatomy: a glyph, a Title Case label, a
 * right-aligned value — and, for the sections that hold more than a value, a
 * disclosure row whose chevron turns and whose body opens INLINE beneath it.
 * This replaced an `Accordion` (user call, 2026-08-29): two stacked accordion
 * items read as two competing cards, where one settled list reads as one
 * subject — the market's facts, of which the order book is simply the
 * largest.
 *
 * The one rule that must survive any restyle lives here unchanged:
 *
 * **A closed disclosure's content is NOT MOUNTED.** The order book is a live
 * subscription, and a book nobody opened must not run a feed. The controlled
 * `open` set is the mount gate — the chevron animates, this decides
 * existence.
 */

import type { JSX, ReactNode } from "react";
import { Fragment } from "react";
import { View } from "react-native";
import { ListGroup, Typography, useThemeColor } from "heroui-native";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react-native";

const ICON_PX = 18;
const CHEVRON_PX = 16;

const TONE_CLASS = {
  up: "text-success",
  down: "text-danger",
  neutral: "text-foreground",
} as const;

/** A row that opens: the book, a prediction's question. */
export interface DetailDisclosure {
  value: string;
  icon: LucideIcon;
  label: string;
  /** Rendered ONLY while open — see the mount rule above. */
  content: ReactNode;
}

/** A row that states: mark, funding, an About fact. */
export interface DetailRow {
  /** Omitted for facts with no stable glyph (a spot token's About lines). */
  icon?: LucideIcon;
  label: string;
  /** `null` renders the dash — "not read yet", never a zero. */
  value: string | null;
  tone?: "up" | "down" | "neutral";
  /** Sits after the value, for a clock the value cannot carry. */
  suffix?: ReactNode;
}

export function DetailSections({
  disclosures = [],
  rows = [],
  open,
  onOpenChange,
  stale = false,
}: {
  disclosures?: readonly DetailDisclosure[];
  rows?: readonly DetailRow[];
  /** Controlled open set — owned by the screen so it survives kind branches. */
  open: string[];
  onOpenChange: (open: string[]) => void;
  /** Dims the whole card the way the old Info card dimmed. */
  stale?: boolean;
}): JSX.Element {
  const mutedColor = useThemeColor("muted");

  return (
    <ListGroup className={stale ? "opacity-50" : ""}>
      {disclosures.map(({ value, icon: Icon, label, content }) => {
        const isOpen = open.includes(value);
        return (
          <Fragment key={value}>
            <ListGroup.Item
              accessibilityRole="button"
              accessibilityState={{ expanded: isOpen }}
              onPress={() =>
                onOpenChange(isOpen ? open.filter((held) => held !== value) : [...open, value])
              }
            >
              <ListGroup.ItemPrefix>
                <Icon size={ICON_PX} color={mutedColor} strokeWidth={1.8} />
              </ListGroup.ItemPrefix>
              <ListGroup.ItemContent>
                <ListGroup.ItemTitle className="font-medium">{label}</ListGroup.ItemTitle>
              </ListGroup.ItemContent>
              {/* Own chevron, not the suffix default: the default names a PUSH
                  (rightward), and this row opens DOWNWARD in place. */}
              <ListGroup.ItemSuffix>
                {isOpen ? (
                  <ChevronDown size={CHEVRON_PX} color={mutedColor} />
                ) : (
                  <ChevronRight size={CHEVRON_PX} color={mutedColor} />
                )}
              </ListGroup.ItemSuffix>
            </ListGroup.Item>
            {isOpen ? <View>{content}</View> : null}
          </Fragment>
        );
      })}

      {rows.map(({ icon: Icon, label, value, tone, suffix }) => (
        <ListGroup.Item
          key={label}
          disabled
          accessible
          accessibilityLabel={`${label}, ${value ?? "unknown"}`}
        >
          {Icon === undefined ? null : (
            <ListGroup.ItemPrefix>
              <Icon size={ICON_PX} color={mutedColor} strokeWidth={1.8} />
            </ListGroup.ItemPrefix>
          )}
          <ListGroup.ItemContent>
            <ListGroup.ItemTitle className="font-normal">{label}</ListGroup.ItemTitle>
          </ListGroup.ItemContent>
          <ListGroup.ItemSuffix>
            <View className="flex-row items-center gap-1.5">
              <Typography.Paragraph
                className={`text-base tabular-nums font-normal ${tone ? TONE_CLASS[tone] : "text-foreground"}`}
                numberOfLines={1}
              >
                {value ?? "--"}
              </Typography.Paragraph>
              {suffix}
            </View>
          </ListGroup.ItemSuffix>
        </ListGroup.Item>
      ))}
    </ListGroup>
  );
}
