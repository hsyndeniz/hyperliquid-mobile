/**
 * Address entry and display, the plain way.
 *
 * ## The idea
 *
 * An address is one string, and the parts a human actually compares are its
 * ends — every wallet's truncation ("0x1234…cdef") already says so. So display
 * bolds the first and last four characters and leaves the middle quiet
 * (`addressParts`), and entry is a single continuous field.
 *
 * ## Forgiving in, canonical out
 *
 * Addresses arrive from clipboards in every dress: `0x`-prefixed or bare,
 * lowercase or checksummed, space-grouped (our own chunked rendering!), with
 * stray newlines. `normalizeAddressInput` accepts all of that and keeps only
 * what matters — the hex. Strictness stays where it belongs: nothing here
 * weakens `validateDestination`, which still has the only vote on validity.
 */

import { validateDestination } from "@/hyperliquid/transfers/destination";

const HEX_LENGTH = 40;

/**
 * Clean a typed or pasted candidate into `0x` + hex, dropping the noise.
 *
 * Whitespace goes (pasting our own "5Bf8 287B …" rendering must work), a
 * missing `0x` on a full 40-hex string is supplied, and characters beyond the
 * address length are cut so a paste of surrounding text cannot overflow the
 * field. Case is preserved — it carries the checksum.
 */
export function normalizeAddressInput(raw: string): string {
  const dense = raw.replace(/\s+/g, "");
  const body = dense.startsWith("0x") || dense.startsWith("0X") ? dense.slice(2) : dense;
  const hex = body.replace(/[^0-9a-fA-F]/g, "").slice(0, HEX_LENGTH);
  return hex.length === 0 ? "" : `0x${hex}`;
}

/**
 * An address split for emphasis: `0x` + the first four, the middle, the last
 * four. The ends are what a human actually compares — every truncated rendering
 * ("0x1234…cdef") already implies it — so the display bolds exactly those and
 * leaves the middle quiet, rather than chopping the string into groups.
 */
export interface AddressParts {
  prefix: "0x" | "";
  head: string;
  middle: string;
  tail: string;
}

export function addressParts(address: string): AddressParts {
  const hasPrefix = address.startsWith("0x") || address.startsWith("0X");
  const body = hasPrefix ? address.slice(2) : address;
  if (body.length <= 8) return { prefix: hasPrefix ? "0x" : "", head: body, middle: "", tail: "" };
  return {
    prefix: hasPrefix ? "0x" : "",
    head: body.slice(0, 4),
    middle: body.slice(4, -4),
    tail: body.slice(-4),
  };
}

export type EntryStatus =
  | { kind: "empty" }
  /** Mid-entry: `count` of 40 hex characters present. */
  | { kind: "typing"; count: number }
  /** Full length, checksum verified. The strongest state there is. */
  | { kind: "verified"; display: string }
  /** Full length, all one case — well-formed but carrying no checksum to check. */
  | { kind: "unverified"; display: string }
  | { kind: "invalid"; reason: string };

/**
 * What the status line under the cells should say.
 *
 * The distinction between `verified` and `unverified` is the point of the whole
 * surface: a mixed-case address that validates has survived a real check; an
 * all-lowercase one has merely failed to be malformed, and saying "valid" for
 * both would launder the second into the first.
 */
export function entryStatus(input: string): EntryStatus {
  if (input.length === 0) return { kind: "empty" };

  const body = input.startsWith("0x") ? input.slice(2) : input;
  if (body.length < HEX_LENGTH) return { kind: "typing", count: body.length };

  const result = validateDestination(input);
  if (!result.ok) {
    return {
      kind: "invalid",
      reason:
        result.reason === "blacklisted"
          ? "Nothing sent to this address can ever be recovered."
          : result.reason === "checksum_failed"
            ? "A character is wrong — the checksum does not match. Paste it fresh."
            : "This is not a valid address.",
    };
  }
  return result.checksummed
    ? { kind: "verified", display: result.value.display }
    : { kind: "unverified", display: result.value.display };
}

/**
 * A clipboard candidate worth offering, or `null` for silence.
 *
 * Most sends start with a copy from another app, so an address already sitting
 * in the clipboard is the likeliest destination and deserves one-tap entry. But
 * only a candidate that survives `validateDestination` is offered — surfacing
 * clipboard *text* would put arbitrary copied content on screen, and this reads
 * the clipboard to shortcut the paste, not to display it.
 */
export function clipboardCandidate(
  text: string
): { display: string; chunks: readonly string[] } | null {
  const normalized = normalizeAddressInput(text);
  if (normalized.length !== HEX_LENGTH + 2) return null;
  const result = validateDestination(normalized);
  if (!result.ok) return null;
  return { display: result.value.display, chunks: result.value.chunks };
}
