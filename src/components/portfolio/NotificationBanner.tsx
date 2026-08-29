/**
 * The exchange's own messages to the user, at the top of the screen.
 *
 * This channel carries **liquidation warnings**, so it is not decoration: it is
 * the one push the exchange makes that a user cannot get by looking at their
 * own numbers. It renders above everything else for that reason.
 *
 * ## Why it acknowledges a specific seq, not "all"
 *
 * `acknowledge(seq)` marks up to and including the message the user was
 * actually shown. Acknowledging "everything" would swallow a warning that
 * arrived in the moment between render and tap — the exact moment a liquidation
 * warning is most likely to arrive.
 *
 * ## Why the text is rendered verbatim
 *
 * The payload is a bare string with no id, no severity and no timestamp — the
 * SDK declares `{ notification: string }` and nothing more. There is no
 * severity to style on, so every message gets the same weight, and none is
 * summarised or truncated: a message the exchange bothered to send is shown as
 * sent.
 *
 * The device clock is the only timestamp available, which is why `receivedAt`
 * is labelled as *received* rather than as when the event occurred.
 */

import type { JSX } from "react";
import { View } from "react-native";
import { Button, Card, Typography } from "heroui-native";

import { shortTime, useNowHourly } from "@/components/common/display";
import { useUnacknowledged } from "@/hyperliquid/hooks/notifications";
import type { NotificationStore } from "@/hyperliquid/state/notifications";

export function NotificationBanner({ store }: { store: NotificationStore }): JSX.Element | null {
  const { pending, acknowledge } = useUnacknowledged(store);
  // Before the early return: hooks cannot sit behind a conditional.
  const now = useNowHourly();
  if (pending.length === 0) return null;

  // The newest is what "dismiss" acknowledges through. Anything arriving after
  // this render carries a higher seq and survives the dismissal.
  const newest = pending[pending.length - 1];
  if (newest === undefined) return null;

  return (
    <Card className="gap-2 border-warning/40 bg-warning/10">
      <View className="flex-row items-start justify-between gap-3">
        <Typography.Paragraph className="flex-1 text-sm font-semibold">
          {pending.length === 1 ? "Message from Hyperliquid" : `${pending.length} messages`}
        </Typography.Paragraph>
        <Button size="sm" variant="ghost" onPress={() => acknowledge(newest.seq)}>
          <Button.Label className="font-medium">Dismiss</Button.Label>
        </Button>
      </View>
      {pending.map((entry) => (
        <View key={entry.seq} className="gap-0.5">
          {/* Verbatim: no severity to style on, nothing safe to summarise. */}
          <Typography.Paragraph className="text-sm font-normal">{entry.text}</Typography.Paragraph>
          <Typography.Paragraph className="text-xs text-muted font-normal">
            received {shortTime(entry.receivedAt, now)}
          </Typography.Paragraph>
        </View>
      ))}
    </Card>
  );
}
