/**
 * Error types.
 *
 * Two rules drive the design:
 *
 * 1. **Never branch on message text.** Hyperliquid's (and any relay's) error
 *    strings are not a stable contract — they change without notice. Branch on
 *    `code`, and use messages for humans only. The same applies to crash
 *    reporting: fingerprint by `code`, so one renamed string does not split a
 *    known issue into a hundred new ones.
 * 2. **Failures in trading paths must be loud.** The SDK's lookups return
 *    `undefined` for unknown input; letting that flow into a signed payload
 *    turns a typo into an order on the wrong market. Wrappers throw instead.
 */

/** Stable, machine-readable discriminators. Add cases; never rename them. */
export type HlErrorCode =
  /** A symbol did not resolve to an asset ID or size decimals. */
  | "unknown_asset"
  /** A price or size could not be formatted to a valid wire value. */
  | "invalid_precision"
  /** Configuration is missing or malformed. */
  | "invalid_config"
  /** Trading was attempted before the account/agent gate passed. */
  | "not_authorized"
  /** The action budget for this identity is exhausted. */
  | "rate_limited"
  /** The Hyperliquid API returned an error response. */
  | "api_error"
  /** Network failure, non-2xx, or timeout below the API layer. */
  | "transport_error"
  /**
   * The network layer failed — most often no route to the host.
   *
   * **This does NOT mean "nothing was sent", and no money path may treat it
   * that way.** The entire discriminator is a substring match on React
   * Native's `TypeError: Network request failed` (`OFFLINE_MESSAGES` below),
   * and RN raises that identical message from `xhr.onerror` for any
   * network-layer failure: the socket never opening, and equally a connection
   * that opened, transmitted the request in full, and then reset before the
   * reply (iOS `NSURLErrorNetworkConnectionLost`, routine on a Wi-Fi ->
   * cellular handover, and prompt enough that no transport timeout sees it).
   *
   * The code earns its keep as MESSAGING — "you appear to be offline" is
   * better copy than a generic transport failure — and nothing more. It once
   * short-circuited order submission and transfers to a definite local
   * rejection; that invited a retry which placed a second real order. Signed,
   * irreversible actions must classify it as `unknown` (2026-08-29).
   *
   * Proving "nothing was sent" is possible only BEFORE dispatch: a reachability
   * check at the call site, refusing to attempt the action at all. There is no
   * such dependency in the app today.
   */
  | "offline"
  /** The server rejected us for rate limiting (HTTP 429). */
  | "server_rate_limited"
  /** A response did not match the shape the SDK expects. */
  | "validation_error"
  /**
   * The work was abandoned because something newer took precedence.
   *
   * Not a failure of the operation — nothing went wrong with it. It is the
   * answer to "I was told to stop before I finished", and a caller should
   * report nothing to the user for it.
   */
  | "superseded"
  /** Anything not yet given a specific code. */
  | "unknown";

export interface HlErrorOptions {
  code?: HlErrorCode;
  /** Structured detail for logs. Must not contain secrets — see `core/logger`. */
  context?: Record<string, unknown>;
  cause?: unknown;
}

export class HlError extends Error {
  readonly code: HlErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(message: string, options: HlErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "HlError";
    this.code = options.code ?? "unknown";
    this.context = options.context;
  }
}

/**
 * A symbol did not resolve. Thrown rather than returning `undefined` because
 * every caller is on a path that ends in a signed order.
 */
export class UnknownAssetError extends HlError {
  constructor(symbol: string, context?: Record<string, unknown>) {
    super(`Unknown Hyperliquid asset: "${symbol}"`, {
      code: "unknown_asset",
      context: { symbol, ...context },
    });
    this.name = "UnknownAssetError";
  }
}

/**
 * A price or size could not be represented on the wire. Wraps the SDK's
 * `FormatError`, which is thrown where a value truncates to zero or is not
 * finite.
 */
export class PrecisionError extends HlError {
  constructor(message: string, context?: Record<string, unknown>, cause?: unknown) {
    super(message, { code: "invalid_precision", context, cause });
    this.name = "PrecisionError";
  }
}

export function isHlError(error: unknown): error is HlError {
  return error instanceof HlError;
}

/**
 * Every error class `@nktkas/hyperliquid` throws that means **the request never
 * left the device**.
 *
 * Enumerated from the SDK's source rather than guessed — `grep 'this.name ='`
 * over `esm/` returns exactly nine classes, and these are the local ones:
 *
 * | Class | Thrown by | When |
 * | --- | --- | --- |
 * | `ValidationError` | `_base.js` `parse()` | request params fail the schema |
 * | `FormatError` | `utils` | a price or size cannot be represented |
 * | `CanonicalizeError` | `signing/_canonicalize.js` | the action cannot be canonicalised |
 * | `AbstractWalletError` | `signing/_abstractWallet.js` | the wallet cannot sign, or returns a malformed signature |
 * | `HyperliquidError` | `exchange/_base/execute.js` | EIP-712 types carry no nonce field |
 *
 * All five are raised while the payload is still being built, strictly before
 * `transport.request` is called. That makes them **safe to correct and retry**,
 * which is the opposite of what a transport failure means.
 *
 * The four that were missing until this was audited all fell through to
 * `"unknown"`, and `"unknown"` on a money path means "it may have landed; watch,
 * never retry". So a wallet that failed to sign a withdrawal told the user their
 * money might be in flight for fifteen minutes.
 */
const NEVER_SENT = new Set([
  "ValidationError",
  "FormatError",
  "CanonicalizeError",
  "AbstractWalletError",
  "HyperliquidError",
]);

/**
 * How a fetch that never opened a connection presents itself.
 *
 * React Native raises a bare `TypeError: Network request failed` when there is
 * no route to the host — no status, no response, nothing to key on but the
 * message. Matching a `TypeError` by NAME alone would swallow real programming
 * errors, so the message is the discriminator.
 *
 * A timeout is deliberately NOT here: an aborted request may well have reached
 * the exchange and had its reply lost, which is genuinely unknown. Only the
 * failure to connect at all is provably "nothing was sent".
 */
const OFFLINE_MESSAGES = ["network request failed", "failed to fetch", "network error"];

/**
 * Is this failure "the device never got out to the network"?
 *
 * **Walks the cause chain, and must.** RN's `fetch` rejects with a bare
 * `TypeError: Network request failed`, but nothing in this app ever sees that
 * shape: `HttpTransport.request`'s catch-all wraps every throw as
 * `new HttpRequestError({ cause: error, request: payload })`
 * (`transport/http/mod.js:182`). Reading only the top-level `name` therefore
 * matched a shape that does not occur in production, and the whole `offline`
 * classification was dead code — measured, not reasoned:
 *
 *     bare TypeError      -> "offline"          (what the test constructed)
 *     SDK-wrapped (real)  -> "transport_error"  (what actually arrives)
 *
 * `transport_error` falls through to `unknown`, which on a money path means
 * "it may have landed, never retry" — the single worst answer to give someone
 * in airplane mode, where nothing was sent and retrying is the only cure.
 *
 * A response present anywhere in the chain would mean the request DID reach a
 * server, but that cannot coexist with an offline cause, so the name/message
 * test at each level is sufficient on its own.
 */
function looksOffline(error: object): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const name = (current as { name?: unknown }).name;
    const message = (current as { message?: unknown }).message;
    if (
      (name === "TypeError" || name === "Error") &&
      typeof message === "string" &&
      OFFLINE_MESSAGES.some((needle) => message.toLowerCase().includes(needle))
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Classify an SDK/network error into a stable code.
 *
 * The SDK does **not** retry and does **not** read `Retry-After`. The HTTP status
 * is only reachable via `error.response?.status`, so 429 is indistinguishable
 * from a timeout unless it is dug out here.
 *
 * Matched structurally rather than with `instanceof`: the SDK is ESM-only and a
 * duplicated module instance would break identity checks, and we must never
 * misclassify a rate-limit response as a generic failure.
 *
 * **The top-level `name` is the right thing to read here, and that is a fact
 * about this SDK rather than a general rule.** Verified against the source: every
 * class sets `this.name` in its own constructor, and both transports rethrow with
 * `if (error instanceof TransportError) throw error` rather than wrapping, while
 * `executeWithShell` does not catch at all. viem, by contrast, wraps *every*
 * `writeContract` failure in one outer class — `deposits/send.ts` has to walk the
 * cause chain for exactly that reason, and assuming the same shape here would be
 * as wrong as assuming viem's shape there.
 *
 * **Known gap: a 429 delivered over the websocket is invisible here.**
 * `WebSocketRequestError` carries `.request`, not `.response`, so it has no
 * status to read and classifies as `transport_error`. Low risk today because
 * `api/clients.ts` gives `InfoClient` and `ExchangeClient` an `HttpTransport` —
 * every request that can be rate-limited goes over HTTP, and the websocket
 * carries subscriptions. It would stop being true the day a client posts over
 * the socket.
 */
export function classifySdkError(error: unknown): HlErrorCode {
  if (isHlError(error)) return error.code;
  if (typeof error !== "object" || error === null) return "unknown";

  const name = (error as { name?: unknown }).name;
  // `HttpRequestError.response` is an HTTP `Response`, so `.status` is a number.
  // `ApiRequestError.response` is the raw JSON body, whose `status` is the string
  // `"err"` — hence the `typeof` guard, without which every API refusal would
  // read as a rate limit.
  const status = (error as { response?: { status?: unknown } }).response?.status;

  if (typeof status === "number" && status === 429) return "server_rate_limited";
  if (typeof name === "string" && NEVER_SENT.has(name)) return "validation_error";
  // Before the transport checks below: an offline failure can arrive wrapped,
  // and it must not be read as a request that went out and failed.
  if (looksOffline(error)) return "offline";
  if (name === "ApiRequestError") return "api_error";
  if (
    name === "HttpRequestError" ||
    name === "WebSocketRequestError" ||
    name === "TransportError"
  ) {
    return "transport_error";
  }
  return "unknown";
}

/**
 * What a signed action's refusal says about the device's clock, if anything.
 *
 * Three server refusals share one likely cause and no shared vocabulary, and
 * none of them is in the docs' "Error responses" table — that table covers
 * per-leg order outcomes, while these are ACTION-level refusals returned as
 * `{"status":"err","response":"<string>"}` before the order pipeline is
 * reached. A caller parsing the per-leg status vector never sees them.
 *
 * Naming them matters because the fix is not in this app. "Invalid nonce: nonce
 * too low" on a phone means the device clock is behind what this signer has
 * already used; "Action already expired" means the action was stamped with a
 * deadline that had passed before it landed. Both read as a generic failure and
 * send the user looking for a bug in their order.
 *
 * `duplicate nonce` is deliberately NOT clock-related: it is same-millisecond
 * concurrency, it self-resolves, and telling someone to check their clock for
 * it would be wrong.
 */
export type SignedActionRefusal = "clock_behind" | "action_expired" | "duplicate_nonce" | null;

export function readSignedActionRefusal(error: unknown): SignedActionRefusal {
  const message = messageOf(error).toLowerCase();
  if (message.includes("duplicate nonce")) return "duplicate_nonce";
  // "Invalid nonce: nonce too low <sent> < <minimum>" — observed verbatim in
  // production gateway logs, not documented.
  if (message.includes("nonce too low")) return "clock_behind";
  if (message.includes("action already expired")) return "action_expired";
  return null;
}

/** Every message in the chain — the refusal string can sit on a wrapped cause. */
function messageOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string") parts.push(message);
    const response = (current as { response?: unknown }).response;
    if (typeof response === "string") parts.push(response);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

/** Wrap any thrown value as an `HlError`, preserving the original as `cause`. */
export function toHlError(error: unknown, context?: Record<string, unknown>): HlError {
  if (isHlError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new HlError(message, { code: classifySdkError(error), context, cause: error });
}

/** Narrow by code without instanceof, for cross-realm safety. */
export function hasErrorCode(error: unknown, code: HlErrorCode): boolean {
  return isHlError(error) && error.code === code;
}
