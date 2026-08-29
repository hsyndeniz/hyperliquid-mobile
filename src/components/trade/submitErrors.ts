/**
 * The copy a rejected order shows.
 *
 * Pure and native-free on purpose: `usePlaceTicket` imports `react-native-pulsar`
 * for haptics, which needs a native binary, so nothing in that file can be
 * exercised under Jest. This is the half worth testing.
 */

import { readSignedActionRefusal, toHlError, type HlError } from "@/hyperliquid/core/errors";

/**
 * A submit error as one human sentence.
 *
 * The exchange's reject strings are prose already, but a few arrive as codes
 * or as internals the user cannot act on — those get translated; the rest
 * pass through trimmed, because the server's own words ("Order must have
 * minimum value of $10") are frequently the best copy available.
 */
export function describeSubmitError(caught: unknown): string {
  const error: HlError = toHlError(caught);
  const message = error.message ?? "";

  // Before the generic table: these three are ACTION-level refusals that arrive
  // as a bare string outside the order pipeline, and two of them are not about
  // the order at all. "Invalid nonce: nonce too low" and "Action already
  // expired" on a phone almost always mean the device clock is wrong — a fix
  // that lives in Settings, not in the ticket. Left to the fallback they render
  // as raw exchange jargon and send the user hunting for a bad price.
  const refusal = readSignedActionRefusal(caught);
  if (refusal === "clock_behind" || refusal === "action_expired") {
    return "Device clock looks wrong — set date & time to update automatically.";
  }
  if (refusal === "duplicate_nonce") {
    // Same-millisecond collision. It clears itself; do not send anyone to
    // Settings for it.
    return "Two actions collided — try again.";
  }

  const TRANSLATIONS: readonly { match: RegExp; copy: string }[] = [
    { match: /insufficient margin|margin/i, copy: "Not enough margin for this order." },
    { match: /minimum value/i, copy: "Below the exchange minimum of $10." },
    { match: /reduce.?only/i, copy: "Reduce-only would increase the position." },
    { match: /tick|px must be/i, copy: "Price is off the tick grid." },
    { match: /rate limit|429/i, copy: "Rate limited — wait a moment and try again." },
    { match: /not_authorized|approved agent/i, copy: "Trading approval needed — see Account." },
    { match: /post.?only|alo/i, copy: "Post-only would cross the book." },
    { match: /no session/i, copy: "Connect a wallet first." },
  ];
  for (const { match, copy } of TRANSLATIONS) {
    if (match.test(message)) return copy;
  }
  const trimmed = message.trim();
  return trimmed.length > 0 && trimmed.length <= 120 ? trimmed : "Order rejected.";
}
