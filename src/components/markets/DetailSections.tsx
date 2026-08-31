/**
 * The market screen's openable rows: the order book, a prediction's question.
 *
 * A full-width row with a chevron that opens its content INLINE beneath it.
 * Not a tile, because these are not values — they are surfaces with content,
 * and a tile cannot hold one.
 *
 * **Facts do not live here.** Mark, oracle, volume, funding and the rest are
 * `StatTileGrid` — the Portfolio screen's tile anatomy, two to a row. This
 * component briefly owned them too, as heroui `ListGroup` rows (an
 * iOS-Settings list: glyph, label left, value right). That read correctly and
 * was wrong for the screen: a market's stats are peers to be scanned, and a
 * vertical list made the eye travel the full width for each one while spot and
 * prediction were already using tiles beside it. Perp was the odd one out; now
 * all three are tiles and this holds only what opens. (User call, 2026-08-30.)
 *
 * The one rule that must survive any restyle:
 *
 * **A closed disclosure's content is NOT MOUNTED.** The order book is a live
 * subscription, and a book nobody opened must not run a feed. The controlled
 * `open` set is the mount gate — the chevron animates, this decides existence.
 */

import type { JSX, ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Card, Typography, useThemeColor } from "heroui-native";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react-native";

const ICON_PX = 18;
const CHEVRON_PX = 16;

/** A row that opens: the book, a prediction's question. */
export interface DetailDisclosure {
  value: string;
  icon: LucideIcon;
  label: string;
  /** Rendered ONLY while open — see the mount rule above. */
  content: ReactNode;
}

export function DetailSections({
  disclosures,
  open,
  onOpenChange,
}: {
  disclosures: readonly DetailDisclosure[];
  /** Controlled open set — owned by the screen so it survives kind branches. */
  open: string[];
  onOpenChange: (open: string[]) => void;
}): JSX.Element {
  const mutedColor = useThemeColor("muted");

  return (
    <View className="gap-3">
      {disclosures.map(({ value, icon: Icon, label, content }) => {
        const isOpen = open.includes(value);
        return (
          <Card key={value} className="overflow-hidden p-0">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ expanded: isOpen }}
              className="flex-row items-center gap-3 px-4 py-3"
              onPress={() =>
                onOpenChange(isOpen ? open.filter((held) => held !== value) : [...open, value])
              }
            >
              <Icon size={ICON_PX} color={mutedColor} strokeWidth={1.8} />
              <Typography.Paragraph className="flex-1 font-medium">{label}</Typography.Paragraph>
              {/* Down while open, right while closed: the chevron names the
                  direction this opens, and it opens in place rather than
                  pushing a screen. */}
              {isOpen ? (
                <ChevronDown size={CHEVRON_PX} color={mutedColor} />
              ) : (
                <ChevronRight size={CHEVRON_PX} color={mutedColor} />
              )}
            </Pressable>
            {isOpen ? <View>{content}</View> : null}
          </Card>
        );
      })}
    </View>
  );
}
