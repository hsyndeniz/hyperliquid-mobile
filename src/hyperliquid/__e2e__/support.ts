/**
 * Shared helpers for the live e2e suites.
 *
 * Named `support.ts` rather than `*.e2e.ts` on purpose: the config's `testMatch`
 * is `**\/*.e2e.ts`, so anything ending in `.e2e.ts` is collected as a test file
 * and a helper module would be reported as a suite with no tests.
 */

/**
 * Retry a live call through Hyperliquid's per-IP rate limit.
 *
 * The whole suite drives ONE testnet account from ONE IP, and the eight files
 * run back to back. Hyperliquid's REST allowance is 1200 weight per minute per
 * IP, and a single `session.start()` alone spends 42 of it (`subAccounts2` 20 +
 * `leadingVaults` 20 + `userRateLimit` 2) before any test has run. Two full
 * passes inside a minute reliably trips it.
 *
 * Without this, a 429 in a `beforeAll` fails **every test in the file** — and
 * Jest attributes the error to each one individually, so tests literally named
 * "without touching the transport" report an HTTP failure. That reads as a code
 * defect and sends the next reader somewhere there is no bug.
 *
 * Retries only on rate limiting. Everything else rethrows immediately: a
 * blanket retry would paper over exactly the failures this suite exists to find.
 */
export async function withRateLimitRetry<T>(
  label: string,
  run: () => Promise<T>,
  attempts = 4
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isRateLimited(error)) throw error;
      lastError = error;
      // Hyperliquid's window is a rolling minute, so back off in multiples of a
      // meaningful fraction of it rather than the usual few hundred ms.
      const waitMs = 15_000 * (attempt + 1);
      console.warn(
        `e2e: ${label} rate-limited, waiting ${waitMs / 1000}s (attempt ${attempt + 1})`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}

/**
 * Whether a thrown value is Hyperliquid refusing us for rate limiting.
 *
 * Matched on the HTTP status where the SDK exposes one, and on the message only
 * as a fallback — the same rule `core/errors` follows, because the strings are
 * not a contract.
 */
export function isRateLimited(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { response?: { status?: unknown } }).response?.status;
  if (status === 429) return true;
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && /429|too many requests/i.test(message)) return true;

  // The agent gate deliberately does NOT surface the underlying 429: a failed
  // info read is reported as `account_status_unreadable` with a transport code,
  // precisely so it is retryable rather than presenting as a permanent refusal.
  // That is the retryable shape, so it belongs here.
  const context = (error as { context?: { reason?: unknown } }).context;
  return context?.reason === "account_status_unreadable";
}
