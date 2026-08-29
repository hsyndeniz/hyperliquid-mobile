/**
 * The address, entered as one string — displayed the way it is read.
 *
 * ## One field, bold ends
 *
 * The address renders as a single continuous run with the first and last four
 * characters bold — the parts a human actually compares, the same emphasis
 * `AddressText` uses everywhere else. A hidden `TextInput` carries focus and
 * the keyboard; the styled run is the display, so entry looks exactly like
 * every other rendering of an address in the app.
 *
 * ## Clipboard first
 *
 * Nearly every send starts with a copy in another app, so on open the editor
 * reads the clipboard once and — only if it holds a valid address — offers it
 * as a one-tap card. Arbitrary clipboard text is never shown: the offer exists
 * for addresses, not for whatever else was copied (`clipboardCandidate` stays
 * silent for anything that does not validate).
 *
 * ## One status line
 *
 * Progress, verdict and error share a single line under the field: a count
 * while typing, "Checksum verified" in success tone, the caution for a
 * lowercase paste, the specific reason on failure. The line is the state.
 */

import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Typography, useThemeColor } from "heroui-native";

import { AddressText } from "@/components/money/AddressText";
import {
  clipboardCandidate,
  entryStatus,
  normalizeAddressInput,
} from "@/components/money/addressEntry";

export function AddressEditor({
  value,
  onChange,
  isDisabled,
}: {
  value: string;
  onChange: (value: string) => void;
  isDisabled?: boolean;
}): JSX.Element {
  const inputRef = useRef<TextInput>(null);
  const [candidate, setCandidate] = useState<{ display: string } | null>(null);
  // Set when an on-demand paste found nothing address-shaped; cleared by the
  // next edit. Overrides the status line so the tap visibly did something.
  const [pasteMiss, setPasteMiss] = useState(false);
  const accent = useThemeColor("accent");

  useEffect(() => {
    // Once, on open. Watching the clipboard would be surveillance; reading it
    // at the moment the user opened an address editor is anticipation.
    let cancelled = false;
    void Clipboard.getStringAsync().then((text) => {
      if (!cancelled) setCandidate(clipboardCandidate(text));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const status = entryStatus(value);
  // The offer disappears as soon as typing starts — it answers "how do I begin",
  // not "what should replace what I typed".
  const offer = candidate !== null && value.length === 0 ? candidate : null;

  return (
    <View className="gap-4">
      {offer !== null ? (
        <Pressable
          onPress={() => onChange(normalizeAddressInput(offer.display))}
          disabled={isDisabled}
          className="gap-2 rounded-2xl bg-surface p-4"
        >
          <View className="flex-row items-center justify-between gap-3">
            <Typography.Paragraph className="text-xs font-semibold text-accent">
              In your clipboard
            </Typography.Paragraph>
            <Typography.Paragraph className="text-xs text-accent font-normal">
              Tap to use
            </Typography.Paragraph>
          </View>
          <AddressText
            address={offer.display}
            truncated
            className="text-sm tabular-nums font-normal"
          />
        </Pressable>
      ) : null}

      {/* The styled run IS the field: tapping it focuses the hidden input. The
          Paste chip lives INSIDE the field, where the missing text would go —
          the clipboard card above covers copy-before-open; this covers
          copy-after-open, on demand. */}
      <Pressable onPress={() => inputRef.current?.focus()} disabled={isDisabled} className="gap-2">
        <View className="min-h-20 flex-row items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-3">
          <View className="flex-1">
            {value.length === 0 ? (
              <Typography.Paragraph className="text-base text-muted font-normal">
                0x…
              </Typography.Paragraph>
            ) : (
              <AddressText address={value} className="text-base tabular-nums font-normal" />
            )}
          </View>
          {value.length === 0 ? (
            <Pressable
              disabled={isDisabled}
              onPress={() => {
                void Clipboard.getStringAsync().then((text) => {
                  const normalized = normalizeAddressInput(text);
                  if (normalized.length > 0) {
                    setPasteMiss(false);
                    onChange(normalized);
                  } else {
                    setPasteMiss(true);
                  }
                });
              }}
              className="rounded-full bg-accent/15 px-4 py-2"
            >
              <Typography.Paragraph className="text-sm font-semibold text-accent">
                Paste
              </Typography.Paragraph>
            </Pressable>
          ) : null}
        </View>

        {pasteMiss && value.length === 0 ? (
          <Typography.Paragraph className="text-xs text-warning font-normal">
            Nothing address-shaped in the clipboard — copy the address first.
          </Typography.Paragraph>
        ) : (
          <StatusLine status={status} />
        )}
      </Pressable>

      {/* Focus + keyboard live here; the run above is the rendering. Kept 1pt
          tall rather than display:none so iOS still shows the keyboard. */}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={(text) => {
          setPasteMiss(false);
          onChange(normalizeAddressInput(text));
        }}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        editable={isDisabled !== true}
        selectionColor={accent}
        style={{ height: 1, opacity: 0 }}
      />
    </View>
  );
}

function StatusLine({ status }: { status: ReturnType<typeof entryStatus> }): JSX.Element {
  switch (status.kind) {
    case "empty":
      return (
        <Typography.Paragraph className="text-xs text-muted font-normal">
          Type, or paste in any form — spaces and a missing 0x are fine.
        </Typography.Paragraph>
      );
    case "typing":
      return (
        <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
          {status.count} of 40
        </Typography.Paragraph>
      );
    case "verified":
      return (
        <Typography.Paragraph className="text-xs font-semibold text-success">
          Checksum verified
        </Typography.Paragraph>
      );
    case "unverified":
      return (
        <Typography.Paragraph className="text-xs text-warning font-normal">
          Well-formed, but lowercase carries no checksum — compare the bold ends yourself.
        </Typography.Paragraph>
      );
    case "invalid":
      return (
        <Typography.Paragraph className="text-xs text-danger font-normal">
          {status.reason}
        </Typography.Paragraph>
      );
  }
}
