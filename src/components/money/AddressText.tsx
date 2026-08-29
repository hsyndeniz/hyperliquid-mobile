/**
 * The one way an address renders, everywhere.
 *
 * One continuous string — no group splitting — with the first and last four
 * characters **bold**, because those are the parts a human actually compares
 * and every wallet's truncation convention already says so. The middle stays
 * quiet in the muted tone so the ends read at a glance.
 *
 * `truncated` gives the compact rows form: `0x` + bold head + `…` + bold tail.
 * Nested `Text` keeps this a single wrapping run, so the full form breaks
 * wherever the line does without any layout of its own.
 */

import type { JSX } from "react";
import { Typography } from "heroui-native";

import { addressParts } from "@/components/money/addressEntry";

export function AddressText({
  address,
  truncated,
  className = "text-sm tabular-nums font-normal",
}: {
  /** Preferably the checksummed display form — this component does not convert. */
  address: string;
  /** Head…tail only, for one-line rows. */
  truncated?: boolean;
  /** Applied to the container run; the bold/muted spans are fixed. */
  className?: string;
}): JSX.Element {
  const parts = addressParts(address);

  if (truncated) {
    return (
      <Typography.Paragraph className={className}>
        <Typography.Paragraph className="font-bold">
          {parts.prefix}
          {parts.head}
        </Typography.Paragraph>
        {parts.middle.length > 0 ? "…" : ""}
        <Typography.Paragraph className="font-bold">{parts.tail}</Typography.Paragraph>
      </Typography.Paragraph>
    );
  }

  return (
    <Typography.Paragraph className={className}>
      <Typography.Paragraph className="font-bold">
        {parts.prefix}
        {parts.head}
      </Typography.Paragraph>
      <Typography.Paragraph className="text-muted font-normal">{parts.middle}</Typography.Paragraph>
      <Typography.Paragraph className="font-bold">{parts.tail}</Typography.Paragraph>
    </Typography.Paragraph>
  );
}
