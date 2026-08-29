/**
 * The full wire record behind a row.
 *
 * A modal rather than `@gorhom/bottom-sheet`: the sheet library needs a
 * provider at the app root and its own gesture wiring, and this content is a
 * scrolling list of label/value pairs that gains nothing from a draggable
 * handle. When a screen needs a genuine sheet — an order ticket, say — that is
 * the moment to add the provider, not before.
 *
 * ## One list, not a card per fact
 *
 * A stack of cards gives every fact the visual weight of a screen section, and
 * ten facts become ten sections — the sheet reads as furniture rather than
 * information. Here it is a single card of divided rows: label left, value
 * right, a hairline between rows. A value too long for half a line (a hash,
 * a raw record) drops below its label at full width instead of squeezing.
 *
 * The content comes from `rowDetail.ts` as data, which is where the rules live
 * and where they are tested. This file is markup.
 *
 * Caveats render **under** their row rather than as a tooltip, because on this
 * screen the caveat is often the load-bearing half: a fill's hash is not
 * unique, `closedPnl` is gross of fees, and an order's non-terminal status
 * means the history ended rather than that the order is live.
 */

import type { JSX } from "react";
import { Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, Typography } from "heroui-native";

import type { DetailField, RowDetail } from "@/components/portfolio/rowDetail";

/** Past this, a value squeezed next to its label stops being readable. */
const INLINE_VALUE_MAX = 26;

export function RowDetailSheet({
  detail,
  onClose,
}: {
  /** `null` closes it. */
  detail: RowDetail | null;
  onClose: () => void;
}): JSX.Element | null {
  const insets = useSafeAreaInsets();
  if (detail === null) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/40">
        <View
          className="max-h-[85%] rounded-t-3xl bg-background px-4"
          style={{ paddingTop: 16, paddingBottom: insets.bottom + 16 }}
        >
          <View className="flex-row items-center justify-between gap-3 pb-4">
            <View className="shrink gap-0.5">
              <Typography.Heading className="font-bold" numberOfLines={1}>
                {detail.title}
              </Typography.Heading>
              <Typography.Paragraph className="text-xs text-muted font-normal" numberOfLines={1}>
                {detail.subtitle}
              </Typography.Paragraph>
            </View>
            <Button size="sm" variant="tertiary" onPress={onClose}>
              <Button.Label className="font-medium">Close</Button.Label>
            </Button>
          </View>

          <ScrollView contentContainerClassName="pb-4">
            <Card className="gap-0 py-1">
              {detail.fields.map((field, index) => (
                <FieldRow key={field.label} field={field} isFirst={index === 0} />
              ))}
            </Card>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function FieldRow({ field, isFirst }: { field: DetailField; isFirst: boolean }): JSX.Element {
  // A hash or a raw record squeezed into half a row is unreadable; it gets the
  // full width under its label instead. Multiline values always stack.
  const stacked = field.value.length > INLINE_VALUE_MAX || field.value.includes("\n");

  return (
    <View className={isFirst ? "gap-1 py-3" : "gap-1 border-t border-border py-3"}>
      {stacked ? (
        <View className="gap-1">
          <Typography.Paragraph className="text-xs text-muted font-normal">
            {field.label}
          </Typography.Paragraph>
          <Typography.Paragraph className="text-sm tabular-nums font-normal">
            {field.value}
          </Typography.Paragraph>
        </View>
      ) : (
        <View className="flex-row items-center justify-between gap-4">
          <Typography.Paragraph className="text-sm text-muted font-normal">
            {field.label}
          </Typography.Paragraph>
          <Typography.Paragraph className="flex-1 text-right text-sm tabular-nums font-normal">
            {field.value}
          </Typography.Paragraph>
        </View>
      )}
      {field.caveat === undefined ? null : (
        // Under the row, not hidden behind a tap: for several of these the
        // caveat is the load-bearing half.
        <Typography.Paragraph className="text-xs text-warning font-normal">
          {field.caveat}
        </Typography.Paragraph>
      )}
    </View>
  );
}
