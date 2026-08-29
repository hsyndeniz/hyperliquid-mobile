/**
 * The destination, as one line — with the cell-grid editor a tap away.
 *
 * ## Why the address is collapsed
 *
 * A 42-character field and its verification block are the tallest thing on a
 * transfer screen and, once filled, the least often changed. Collapsed to its
 * last two groups it costs one line, and the full checksummed form is still read
 * twice: in the editor while it is being entered, and again in the confirmation
 * sheet, which is the reading that actually gates the signature.
 *
 * ## Never a silent default
 *
 * An empty destination reads "Choose", not a pre-filled address. A transfer
 * screen that arrives pre-addressed invites confirming a destination nobody
 * chose; `deposits/preflight.ts` makes the same point about the bridge address
 * from the other direction.
 */

import type { JSX } from "react";
import { useState } from "react";
import { View } from "react-native";
import { Button, Dialog, PressableFeedback, Typography } from "heroui-native";

import { AddressEditor } from "@/components/money/AddressEditor";
import { AddressText } from "@/components/money/AddressText";
import { entryStatus } from "@/components/money/addressEntry";
import { validateDestination } from "@/hyperliquid/transfers/destination";

export function DestinationRow({
  value,
  onChange,
  isDisabled,
  /**
   * What the editor dialog says under its title. Caller-supplied because the
   * finality differs by flow: a withdrawal leaves for Arbitrum, a spot send
   * stays on Hyperliquid — one sentence claiming both would be wrong somewhere.
   */
  editorNote,
}: {
  value: string;
  onChange: (value: string) => void;
  isDisabled?: boolean;
  editorNote: string;
}): JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  // The draft lives here, committed on "Use". Cancelling an edit must not leave
  // a half-typed address armed on the screen behind the dialog.
  const [draft, setDraft] = useState(value);
  const result = validateDestination(value);
  const draftStatus = entryStatus(draft);
  const draftUsable = draftStatus.kind === "verified" || draftStatus.kind === "unverified";

  return (
    <>
      <PressableFeedback
        onPress={() => {
          setDraft(value);
          setIsEditing(true);
        }}
        isDisabled={isDisabled}
        className="flex-row items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-3"
      >
        <Typography.Paragraph className="text-sm text-muted font-normal">To</Typography.Paragraph>
        <View className="flex-row items-center gap-2">
          {result.ok ? (
            <AddressText address={result.value.display} truncated />
          ) : (
            <Typography.Paragraph className="text-sm text-muted font-normal">
              {value.trim().length === 0 ? "Choose" : "Not valid"}
            </Typography.Paragraph>
          )}
          <Typography.Paragraph className="text-sm text-muted font-normal">›</Typography.Paragraph>
        </View>
      </PressableFeedback>

      <Dialog isOpen={isEditing} onOpenChange={setIsEditing}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="gap-5 bg-background">
            <Dialog.ContentBackground className="bg-surface" />
            <View className="gap-1">
              <Dialog.Title className="font-semibold">Send to</Dialog.Title>
              <Dialog.Description className="font-normal">{editorNote}</Dialog.Description>
            </View>

            <AddressEditor value={draft} onChange={setDraft} isDisabled={isDisabled} />

            <View className="flex-row gap-3">
              <View className="flex-1">
                <Button variant="tertiary" onPress={() => setIsEditing(false)}>
                  <Button.Label className="font-medium">Cancel</Button.Label>
                </Button>
              </View>
              <View className="flex-1">
                <Button
                  isDisabled={!draftUsable}
                  onPress={() => {
                    onChange(draft);
                    setIsEditing(false);
                  }}
                >
                  <Button.Label className="font-medium">Use</Button.Label>
                </Button>
              </View>
            </View>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </>
  );
}
