/**
 * The wall-clock instant a render-time quote is stamped against.
 *
 * Both preflight builders are impure in the same two ways: each stamps
 * `expiresAt = now + TTL` and reads the unsettled-transfer journal. Calling
 * one during render is fine on its own — but this app compiles with the React
 * Compiler, which memoises the call against the values it can SEE the call
 * read. `Date.now()` is not one of them, and neither is a journal lookup. The
 * quote therefore freezes at the moment its last visible input changed, which
 * for a withdrawal is the last keystroke.
 *
 * That freeze produces dead ends rather than merely stale numbers. A quote
 * stamped at the last keystroke expires 60 s later; the user reads the echo
 * sheet, ticks the acknowledgements — none of which change an input — confirms,
 * and is refused for an expired quote. Tapping Review again replays the very
 * same frozen quote and is refused again, forever, until the amount is edited
 * or the screen is left. The `withdrawal_in_flight` blocker freezes the same
 * way: once shown it cannot clear, and the button it disables can no longer be
 * the thing that refreshes it.
 *
 * Passing the instant in as a VALUE is what makes the memo honest — the
 * compiler can see it, so a new basis genuinely rebuilds the quote. Advancing
 * it is deliberate rather than a timer: the TTL exists so that what the user
 * acknowledged is what gets signed, and restamping under an open confirmation
 * would move the numbers being read.
 *
 * Call `refresh()` at both ends of that window:
 * - when an input changes, so a quote is never older than the last edit (free —
 *   React batches it with the state update in the same handler); and
 * - when the confirmation opens, so the TTL runs from when the user starts
 *   reading and the journal is re-read immediately before signing.
 *
 * @see `hooks/withdraw.ts`, `hooks/vaults.ts` — the two call sites.
 */

import { useCallback, useState } from "react";

export interface QuoteBasis {
  /** Pass to the quote builder as its `now`. Changing it rebuilds the quote. */
  basisMs: number;
  /** Restamp to the present. Safe to call inside an existing event handler. */
  refresh: () => void;
}

export function useQuoteBasis(): QuoteBasis {
  const [basisMs, setBasisMs] = useState(() => Date.now());
  const refresh = useCallback(() => setBasisMs(Date.now()), []);
  return { basisMs, refresh };
}
