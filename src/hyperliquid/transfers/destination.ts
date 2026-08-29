/**
 * Destination address validation.
 *
 * The single most consequential module in the phase, because **nothing else in
 * the stack protects the user**. Verified end to end:
 *
 * - The SDK **lowercases the address before validating it**, so by the time it
 *   looks, a mistyped character is indistinguishable from a real one. It then
 *   checks only that there are 42 hex characters.
 * - The server accepts any well-formed address. Sending to a wrong-but-valid one
 *   is normal usage, not an error: 16 of 48 sampled real mainnet withdrawals
 *   went to an address other than the signer's.
 * - There is no cloid, no cancel and no recall.
 *
 * So EIP-55 has to be enforced **here, before the SDK sees the string**. A
 * checksummed address encodes its own typo detection in the letter casing; that
 * information is destroyed the moment anything lowercases it.
 *
 * Testnet cannot exercise any of this — a wrong-but-valid address succeeds on
 * testnet exactly as it does on mainnet. That is precisely why the protection is
 * type-level rather than procedural.
 */

import { getAddress, isAddress } from "viem";

import { HlError } from "@/hyperliquid/core/errors";
import type { Hex } from "@/hyperliquid/types/domain";
import type { ValidatedAddress } from "@/hyperliquid/transfers/types";

/**
 * Addresses no withdrawal may target.
 *
 * Not paranoia — `preTransferCheck` reports every one of these as an existing,
 * unsanctioned account, so its green light is worthless against them.
 */
const BLACK_HOLES = new Set<string>([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0xffffffffffffffffffffffffffffffffffffffff",
]);

export type DestinationRejection =
  | "malformed"
  /** 42 hex characters, but the EIP-55 casing does not check out — a likely typo. */
  | "checksum_failed"
  | "blacklisted";

export interface DestinationResult {
  /** Lowercase — exactly what will be signed. */
  wire: ValidatedAddress;
  /** EIP-55 checksummed — what a human verifies against their other screen. */
  display: Hex;
  /** Four-character groups. Eyeballing 40 undifferentiated hex characters does not work. */
  chunks: string[];
}

/**
 * Validate a destination.
 *
 * Mixed-case input is checksum-verified. An all-lowercase or all-uppercase
 * address carries **no checksum information at all**, so it cannot be verified
 * and is accepted as merely well-formed — the caller is told via `checksummed`
 * so it can insist on a stronger form for a large withdrawal.
 */
export function validateDestination(input: string):
  | { ok: true; value: DestinationResult; checksummed: boolean }
  | {
      ok: false;
      reason: DestinationRejection;
    } {
  const trimmed = input.trim();

  if (!isAddress(trimmed, { strict: false })) return { ok: false, reason: "malformed" };

  const lower = trimmed.toLowerCase();
  if (BLACK_HOLES.has(lower)) return { ok: false, reason: "blacklisted" };

  // A single-case address encodes no checksum, so there is nothing to verify;
  // only a mixed-case one makes a claim that can be wrong.
  const hasCase = /[a-f]/.test(trimmed) && /[A-F]/.test(trimmed);
  if (hasCase) {
    let canonical: string;
    try {
      canonical = getAddress(lower);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (canonical !== trimmed) return { ok: false, reason: "checksum_failed" };
  }

  const display = getAddress(lower) as Hex;
  return {
    ok: true,
    checksummed: hasCase,
    value: {
      wire: lower as ValidatedAddress,
      display,
      chunks: chunkAddress(display),
    },
  };
}

/**
 * As above, but throws.
 *
 * For call sites that have already surfaced the failure to a user and are past
 * the point of offering a choice.
 */
export function requireDestination(input: string): DestinationResult {
  const result = validateDestination(input);
  if (!result.ok) {
    throw new HlError(`withdrawal destination ${result.reason}`, {
      code: "validation_error",
      context: { reason: result.reason },
    });
  }
  return result.value;
}

/**
 * Break an address into four-character groups.
 *
 * A human asked to compare 40 undifferentiated hex characters does not actually
 * compare them. Chunking is the difference between a check and the appearance of
 * one, and this is the last point at which a typo can still be caught.
 */
export function chunkAddress(address: string): string[] {
  const body = address.startsWith("0x") ? address.slice(2) : address;
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += 4) groups.push(body.slice(i, i + 4));
  return groups;
}

/** Case-insensitive address comparison, for "is this me?" checks. */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** True when the address is one of the known black holes. */
export function isBlackHole(address: string): boolean {
  return BLACK_HOLES.has(address.toLowerCase());
}
