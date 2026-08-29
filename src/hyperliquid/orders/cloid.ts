/**
 * Client order IDs.
 *
 * A cloid is the only stable handle on an order that exists *before* the
 * exchange assigns an `oid`. That makes it the sole idempotency mechanism for
 * the failure this module exists to prevent:
 *
 * > A submit that times out means the **response** was lost — not that the order
 * > failed. Hyperliquid only responds once the action is in a committed block,
 * > so it may still land after the client gives up. Re-signing the same request
 * > places a **second real order**; replaying the same nonce is rejected
 * > outright. Only a cloid lets us ask "did that one land?".
 *
 * Format: exactly 34 characters — `0x` plus 32 hex digits (128 bits).
 */

import { HlError } from "@/hyperliquid/core/errors";

/** `0x` + 32 hex digits. */
export type Cloid = `0x${string}`;

const CLOID_HEX_DIGITS = 32;
const CLOID_LENGTH = 2 + CLOID_HEX_DIGITS;
const CLOID_PATTERN = /^0x[0-9a-f]{32}$/;

/**
 * Minimum value a generated cloid may take.
 *
 * `orderStatus` accepts `oid: UnsignedInteger | Cloid` and tries the integer
 * branch **first**. Because `Number("0x…")` happily parses hex, any cloid whose
 * 128-bit value fits in a JS safe integer is coerced into an *order id* and
 * queries an unrelated order. Random 128-bit values are astronomically unlikely
 * to fall in that range, but a counter- or timestamp-derived id would land there
 * every time — so the invariant is enforced rather than assumed.
 */
const MIN_SAFE_CLOID_VALUE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Generate a cloid from 128 bits of CSPRNG output.
 *
 * @throws {HlError} if no CSPRNG is available — a predictable cloid would let
 *   two submits collide and misattribute a fill.
 */
export function generateCloid(): Cloid {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new HlError(
      "No CSPRNG available — src/polyfills.ts must be imported before generating a cloid",
      { code: "not_authorized" }
    );
  }
  globalThis.crypto.getRandomValues(bytes);

  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  const cloid = `0x${hex}` as Cloid;
  // Vanishingly improbable from a CSPRNG, but cheap to exclude and catastrophic
  // to miss: regenerate rather than emit an id that reads as an integer oid.
  return isIntegerAmbiguous(cloid) ? generateCloid() : cloid;
}

/**
 * Whether a cloid could be misread as a numeric order id by `orderStatus`.
 *
 * Exported for tests and for validating externally supplied ids.
 */
export function isIntegerAmbiguous(cloid: string): boolean {
  try {
    return BigInt(cloid) <= MIN_SAFE_CLOID_VALUE;
  } catch {
    return false;
  }
}

/**
 * Normalise to the canonical form the exchange echoes back.
 *
 * The SDK's schema silently lowercases, so a pending-order map keyed on a
 * mixed-case cloid would never match the value returned by `orderStatus` or
 * `historicalOrders`, and every reconciliation lookup would miss.
 */
export function normalizeCloid(cloid: string): Cloid {
  return cloid.toLowerCase() as Cloid;
}

export function isValidCloid(value: unknown): value is Cloid {
  return (
    typeof value === "string" &&
    value.length === CLOID_LENGTH &&
    CLOID_PATTERN.test(value.toLowerCase())
  );
}

/**
 * Validate and normalise, or throw.
 *
 * @throws {HlError} if the value is not a well-formed cloid.
 */
export function assertCloid(value: unknown): Cloid {
  if (!isValidCloid(value)) {
    throw new HlError(`Invalid client order id: ${String(value)}`, {
      code: "invalid_config",
      context: { expected: `${CLOID_LENGTH}-character hex string`, received: String(value) },
    });
  }
  return normalizeCloid(value);
}

/**
 * Read a cloid off a value that may use either of Hyperliquid's two shapes.
 *
 * `orderStatus` and `historicalOrders` return `cloid: string | null`, while
 * `openOrders` and the `orderUpdates` subscription return `cloid?: string`.
 * A single accessor written against one shape silently drops the other.
 */
export function readCloid(value: { cloid?: string | null }): Cloid | null {
  const raw = value.cloid;
  return raw ? normalizeCloid(raw) : null;
}
