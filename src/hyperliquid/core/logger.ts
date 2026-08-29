/**
 * Structured logging.
 *
 * Three properties matter more than features here:
 *
 * 1. **Redaction is central.** Private keys, signatures and raw signed payloads
 *    are stripped inside the logger, not at call sites. A call site that forgets
 *    is the normal case; this makes forgetting harmless.
 * 2. **Disabled levels are free.** L2/BBO/allMids handlers run at tick rate —
 *    logging in them is a known source of visible latency, so a suppressed call
 *    must not build a string or walk an object.
 * 3. **Transports are pluggable.** Sentry (or anything else) is added by
 *    registering a sink; no call site changes.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * A structured log record.
 *
 * `event` is a stable, machine-readable name (`order.submit.failed`), not a
 * sentence. Crash reporters group by it, so renaming one splits its history.
 */
export interface LogEvent {
  scope: string;
  event: string;
  level: LogLevel;
  context?: Record<string, unknown>;
  /** Serialized summary — never the raw thrown value. See {@link serializeError}. */
  error?: Record<string, unknown>;
  durationMs?: number;
}

export interface LogSink {
  capture(event: LogEvent): void;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Keys whose values never reach a sink, at any depth.
 *
 * Matched case-insensitively on substrings, so `agentPrivateKey` and
 * `privateKey` are both caught.
 */
const SECRET_KEY_PATTERNS = [
  "privatekey",
  "secret",
  "mnemonic",
  // Substring-matched, so this one term covers `phrase`, `recoveryPhrase` and
  // `passphrase` — and this codebase says "phrase" far more often than
  // "mnemonic" in its own APIs (`revealRecoveryPhrase`, `importMnemonic(phrase)`).
  "phrase",
  "recovery",
  "seed",
  "password",
  "signature",
  "signeddata",
  "signedpayload",
  "credential",
  "token",
  "apikey",
  "authorization",
];

const REDACTED = "[redacted]";
const MAX_REDACT_DEPTH = 6;

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** `0x1234…cdef` — enough to correlate, not enough to be a full identifier. */
export function truncateAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{6,}$/.test(address)) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * An address ANYWHERE in a string, not only a string that is entirely one.
 *
 * The anchored form this replaced was the leak: this codebase's scoping keys
 * are composites — `identityKey` is `env|accountId|0xADDRESS|dex|subAccount`
 * and `subscriptionKey` wraps that again — and eleven call sites log one. None
 * is *equal* to an address, so every one shipped the full address to the sink.
 *
 * The negative lookahead is what keeps this from corrupting the longer hex
 * strings that are legitimately logged whole: a 32-byte tx hash is `0x` + 64
 * hex, and without the guard its first 40 characters would be truncated in
 * place, turning a valid hash into an unusable one. A cloid (`0x` + 32) is
 * shorter than the run and never matches — which is right, since a cloid is a
 * reconciliation handle, not an identifier of a person.
 */
const ADDRESS_ANYWHERE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/**
 * A hex run too long to be an identifier — a signature, or a whole signed
 * transaction.
 *
 * viem embeds one in the MESSAGE, not a field: `errors/transaction.js:102`
 * writes ``Serialized Transaction: "${serializedTransaction}"`` into the text of
 * `InvalidSerializedTransactionError`, and `serializeError` allowlists
 * `message`. So a deposit that failed locally could put its signed, unbroadcast
 * transaction into Sentry verbatim — and anyone who can read it can broadcast
 * it. The address scrubber does not help: a raw transaction is one continuous
 * hex run with no internal `0x`, so nothing matches.
 *
 * **65 hex characters, not 64.** A 32-byte transaction hash is exactly 64 and
 * is deliberately kept whole — it is the one long hex string a reader can
 * actually use, and truncating it would break the paste-into-a-block-explorer
 * path. Everything longer is a payload: a signature is 130, a serialized
 * transaction hundreds. Shorter identifiers are handled above (an address at
 * 40, a cloid at 32) or are not sensitive.
 */
const LONG_HEX_PAYLOAD = /0x[0-9a-fA-F]{65,}/g;

/** Shorten every address embedded in a string, composite keys included. */
function scrubAddresses(text: string): string {
  // `includes("0x")` first: the overwhelming majority of logged strings have no
  // address in them, and this skips the regex entirely for those.
  if (!text.includes("0x")) return text;
  // Payloads first: an address inside a signed blob must not be truncated in
  // place, leaving the rest of the blob intact and usable.
  return text
    .replace(LONG_HEX_PAYLOAD, "[signed payload]")
    .replace(ADDRESS_ANYWHERE, truncateAddress);
}

/**
 * Strip secrets and shorten addresses.
 *
 * Depth-limited and cycle-safe: log payloads come from API responses, which may
 * be deep or self-referential, and logging must never be the thing that throws.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? scrubAddresses(value) : value;
  }
  if (depth >= MAX_REDACT_DEPTH) return "[depth limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // The key is scrubbed as well as the value: a map keyed BY address (a
    // per-account cache, a balances-by-owner record) puts the identifier in
    // the position redaction historically never looked at.
    out[scrubAddresses(key)] = isSecretKey(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}

/**
 * Reduce a thrown value to a safe, structured summary.
 *
 * An **allowlist**, not a denylist. SDK errors carry the originating request on
 * them — `ApiRequestError` holds the signed action and its signature — so
 * passing an error object through to a sink leaks exactly what this module
 * exists to protect. Only the diagnostic fields survive, and a future SDK
 * property cannot leak by default because it is simply never copied.
 */
export function serializeError(
  error: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): Record<string, unknown> | undefined {
  if (error === undefined || error === null) return undefined;
  // Scrubbed like the object path below. A thrown string or a stringified
  // object reaches a sink through this branch, and it was the one line of
  // `serializeError` that still copied text verbatim after the rest learned to
  // truncate addresses.
  if (typeof error !== "object") return { message: scrubAddresses(String(error)) };
  if (depth >= MAX_REDACT_DEPTH) return { message: "[depth limit]" };
  if (seen.has(error)) return { message: "[circular]" };
  seen.add(error);

  const source = error as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof source.name === "string") out.name = source.name;
  // Scrubbed, not copied. This is the path that reaches Sentry most often and
  // it never passed through `redact` — yet the exchange writes addresses into
  // its own prose ("User 0x… does not exist"), so the error message is one of
  // the likeliest places for a full address to leave the device.
  if (typeof source.message === "string") out.message = scrubAddresses(source.message);
  if (typeof source.code === "string" || typeof source.code === "number") out.code = source.code;

  // HTTP status is the one useful field on the nested response; the rest of
  // that object is the request/response body and must not be copied.
  const response = source.response;
  if (typeof response === "object" && response !== null) {
    const status = (response as { status?: unknown }).status;
    if (typeof status === "number") out.status = status;
  }

  const cause = serializeError(source.cause, depth + 1, seen);
  if (cause) out.cause = cause;
  return out;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const sinks: LogSink[] = [];

/**
 * `__DEV__` is injected by Metro and does not exist in a plain JS runtime
 * (`bun test`, a node script, a CI check). Referencing it bare throws a
 * ReferenceError there, so it is probed defensively — this module must be
 * importable outside the app runtime.
 */
function isDevBuild(): boolean {
  return typeof __DEV__ !== "undefined" && __DEV__;
}

let minLevel: LogLevel = isDevBuild() ? "debug" : "info";

/** Register a sink. Sentry integration is exactly this call. */
export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    const index = sinks.indexOf(sink);
    if (index >= 0) sinks.splice(index, 1);
  };
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

export interface LogOptions {
  context?: Record<string, unknown>;
  error?: unknown;
  durationMs?: number;
}

export interface ScopedLogger {
  readonly scope: string;
  debug(event: string, options?: LogOptions): void;
  info(event: string, options?: LogOptions): void;
  warn(event: string, options?: LogOptions): void;
  error(event: string, options?: LogOptions): void;
  /** Nest a scope, e.g. `hl.exchange` → `hl.exchange.twap`. */
  child(suffix: string): ScopedLogger;
  /**
   * Guard for hot paths: skip building an expensive context object when the
   * level is suppressed.
   *
   * ```ts
   * if (log.enabled("debug")) log.debug("l2.tick", { context: summarise(book) });
   * ```
   */
  enabled(level: LogLevel): boolean;
}

function emit(scope: string, level: LogLevel, event: string, options?: LogOptions): void {
  // Cheapest possible early-out — no allocation, no redaction, no string work.
  if (!isLevelEnabled(level) || sinks.length === 0) return;

  const record: LogEvent = {
    scope,
    event,
    level,
    context: options?.context ? (redact(options.context) as Record<string, unknown>) : undefined,
    // Serialized, never passed through: a raw SDK error carries the signed
    // action and its signature.
    error: serializeError(options?.error),
    durationMs: options?.durationMs,
  };

  for (const sink of sinks) {
    try {
      sink.capture(record);
    } catch {
      // A failing sink must never break the operation being logged.
    }
  }
}

export function createLogger(scope: string): ScopedLogger {
  return {
    scope,
    debug: (event, options) => emit(scope, "debug", event, options),
    info: (event, options) => emit(scope, "info", event, options),
    warn: (event, options) => emit(scope, "warn", event, options),
    error: (event, options) => emit(scope, "error", event, options),
    child: (suffix) => createLogger(`${scope}.${suffix}`),
    enabled: (level) => isLevelEnabled(level),
  };
}

/** Console sink, for development. */
export function createConsoleSink(): LogSink {
  return {
    capture(event) {
      const prefix = `[${event.scope}] ${event.event}`;
      const detail = {
        ...event.context,
        ...(event.durationMs !== undefined && { durationMs: event.durationMs }),
      };
      const hasDetail = Object.keys(detail).length > 0;
      if (event.level === "error") {
        console.error(prefix, hasDetail ? detail : "", event.error ?? "");
      } else if (event.level === "warn") {
        console.warn(prefix, hasDetail ? detail : "");
      } else {
        console.log(prefix, hasDetail ? detail : "");
      }
    },
  };
}

/** Root logger. Derive scopes with `.child()` rather than creating new roots. */
export const log = createLogger("hl");
