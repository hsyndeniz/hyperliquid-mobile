/**
 * The app's single Hyperliquid session, provided to the React tree.
 *
 * App-level rather than inside `src/hyperliquid/`, for the same reason
 * `useHyperliquidAppState` is: this composes an app concern (React Native's
 * `AppState`) with a module concern (the session), and the module deliberately
 * imports nothing from react-native.
 *
 * Until this existed, `HyperliquidSession` had **zero production call sites**.
 * Every unit test and every e2e test drives it under Node; nothing had ever run
 * it inside Hermes on a device. That is the gap this closes, and it is why the
 * diagnostic screen exists alongside it.
 *
 * Three decisions worth keeping if this is rewritten:
 *
 * 1. **The session is a module-level singleton, not a `useRef`.** A ref is
 *    recreated whenever the provider remounts — which Fast Refresh does
 *    routinely — and a second `HyperliquidSession` means a second websocket and
 *    two identities racing on one transport, the exact leak `AccountSession`
 *    exists to prevent. The session's own docs say "single instance per app";
 *    this is where that is enforced.
 * 2. **Auto-start is silent, guarded, and once per launch.** A stored wallet
 *    means the user already signed in; making them visit Account to press the
 *    button again on every launch was friction with no safety in it. The
 *    guards are what keep the old rule's substance: no wallet → no attempt
 *    (a fresh install must not error at launch), `approveAgent` is NEVER
 *    passed (an agent gap reports `approval_required` instead of prompting
 *    for a signature), the attempt is delayed past first paint so its ~42
 *    request weight lands after the landing screen's own reads, and a
 *    module-level flag stops Fast Refresh from re-attempting.
 * 3. **Unmount does not stop the session.** The root provider unmounts on Fast
 *    Refresh and on teardown, and those are indistinguishable from here.
 *    Tearing down the socket on the first is far worse than leaking it on the
 *    second, which the OS reclaims anyway.
 */

import type { JSX, ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useHyperliquidAppState } from "@/hooks/useHyperliquidAppState";
import { transportGenerationOf } from "@/hyperliquid/api/clients";
import { toHlError, type HlError } from "@/hyperliquid/core/errors";
import { HyperliquidSession, type StartSessionParams } from "@/hyperliquid/session";
import { getHyperliquidSession } from "@/providers/hyperliquidSession";
import { walletState } from "@/hyperliquid/wallet/accounts";
import type { ResumeDecision } from "@/hyperliquid/state/appState";
import { marketFeed } from "@/hyperliquid/state/marketFeed";

/**
 * Where `start()` got to.
 *
 * Deliberately distinct from `session.state()`, which answers a different
 * question. A failed start on a *reconfiguring* path clears the session, so both
 * read as "nothing"; a failed start on a same-network restart leaves the previous
 * session live and perfectly usable. `status: "error"` with a non-null
 * `session.state()` is that second case, and a UI that collapses the two shows a
 * logged-out shell around a working session.
 */
export type SessionStatus = "idle" | "starting" | "ready" | "error";

export interface HyperliquidContextValue {
  session: HyperliquidSession;
  status: SessionStatus;
  /** The last start failure. Kept after recovery so a screen can still show it. */
  error: HlError | null;
  /**
   * What the app-state policy decided on the most recent return to foreground.
   *
   * Exposed because this is the one path that cannot be tested off a device,
   * and it was previously invisible: `onAppStateChange` returned a decision
   * nothing read. A surface can use it to explain a refresh; the diagnostic
   * screen uses it to prove the wiring fires at all.
   */
  lastResume: ResumeDecision | null;
  /**
   * Start a session. **Never rejects** — a failure is recorded in `status` and
   * `error` and *also returned*, so a caller can branch on the outcome inline.
   *
   * Returning it matters more than it looks. `status`/`error` are React state,
   * which has not re-rendered inside the callback that called `start()`, so a
   * caller awaiting this had no way to tell a refused start from a successful
   * one without polling. That gap produced a real false positive: a probe
   * wrapped `start()` in try/catch, the catch never ran because nothing is
   * thrown, and it reported a broken guard that was working perfectly.
   *
   * `null` means the session started.
   */
  start: (params?: StartSessionParams) => Promise<HlError | null>;
  stop: () => Promise<void>;
}

const HyperliquidContext = createContext<HyperliquidContextValue | null>(null);

/**
 * Whether this LAUNCH already tried to auto-start. Module-level for the same
 * reason the session is: the provider remounts on every Fast Refresh, and a
 * per-mount flag would re-run the start each save — each one spending ~42
 * request weight against the shared budget.
 */
let autoStartAttempted = false;

/**
 * How long past mount the auto-start waits. The landing screen's own reads
 * (market list, first sparklines) go out immediately; deferring the session's
 * ~42 weight past that burst keeps the opening seconds inside the budget and
 * the socket work off the first paint's frames.
 */
const AUTO_START_DELAY_MS = 1500;

export function HyperliquidProvider({ children }: { children: ReactNode }): JSX.Element {
  const session = getHyperliquidSession();
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [error, setError] = useState<HlError | null>(null);
  const [lastResume, setLastResume] = useState<ResumeDecision | null>(null);

  // Only the most recent start/stop may write status. `session.start()` already
  // serialises overlapping calls, but their *resolutions* still race here: an
  // earlier start failing after a later one succeeded would otherwise repaint
  // a live session as an error.
  const generation = useRef(0);

  // Stable, so the AppState listener is not torn down and re-added per render.
  const onResume = useCallback((decision: ResumeDecision) => setLastResume(decision), []);
  useHyperliquidAppState(session, onResume);

  // Market feeds outlive any account, but their handles do not outlive the
  // TRANSPORT — when the websocket is rebuilt, every market subscription is
  // pointed at a socket that is gone, and `rebuild()` re-adds each listened
  // target on the client that exists now.
  //
  // Gated on the transport generation, NOT on the publish itself. The session
  // notifies on more than transport changes: `startInternal` skips
  // `configureClients` when the env is unchanged and `switchTo` returns early
  // on an equal identity key, yet `publish(state)` still fires — so a
  // same-identity restart (`start({approveAgent:true})` from the account
  // screen, or the auto-start race below) used to tear down and reopen every
  // live market subscription for nothing, with the market card on screen.
  // `subscribe` returns its own unsubscribe.
  const transportGeneration = useRef(transportGenerationOf());
  /**
   * Rebuild the market feeds if — and only if — the transport underneath them
   * has been replaced since the last check.
   *
   * Driven from BOTH triggers deliberately. A session publish is not the same
   * event as a transport rebuild: the background-resume path can replace the
   * transport and never publish, and when it did, every market subscription
   * (book, tape, asset context, live candles) stayed bound to a socket that no
   * longer existed, with nothing left to repair it. The symptom was a trade
   * screen that came back from the background with a book frozen at ten
   * seconds stale, permanently, until the app was restarted — while the
   * account channels beside it reconnected normally, which is what made it
   * look like a market-data bug rather than a transport one.
   *
   * The generation check is what keeps the extra trigger free: a resume that
   * kept its transport compares equal and does nothing.
   */
  const syncMarketFeeds = useCallback(() => {
    const current = transportGenerationOf();
    if (current === transportGeneration.current) return;
    transportGeneration.current = current;
    void marketFeed.rebuild();
  }, []);

  useEffect(() => session.subscribe(syncMarketFeeds), [session, syncMarketFeeds]);
  // `lastResume` changes only after `session.onAppStateChange("active")` has
  // settled, so the transport it reports on is the one that will be used.
  useEffect(syncMarketFeeds, [lastResume, syncMarketFeeds]);

  const start = useCallback(
    async (params: StartSessionParams = {}): Promise<HlError | null> => {
      const mine = ++generation.current;
      setStatus("starting");
      setError(null);
      try {
        await session.start(params);
        if (generation.current === mine) setStatus("ready");
        return null;
      } catch (caught) {
        const hl = toHlError(caught);
        // Returned even when a newer start superseded this one: the caller
        // asked about THIS attempt, and swallowing its outcome because another
        // began is how a failure disappears. Only the shared status/error —
        // which describe the current attempt — are left to the winner.
        if (generation.current === mine) {
          setError(hl);
          setStatus("error");
        }
        return hl;
      }
    },
    [session]
  );

  // Auto-start — see decision 2 in the header. One attempt per launch, only
  // when a wallet already exists, delayed past first paint, never approving
  // an agent. A failure lands in the same status/error the Account screen
  // already renders; there is nothing to retry that the user's own tap on
  // "Sign in" would not retry better.
  useEffect(() => {
    if (autoStartAttempted) return;
    autoStartAttempted = true;
    // The timeout is NOT cleared on unmount: Fast Refresh unmounts the
    // provider routinely, and cancelling there would make auto-start work
    // only in production builds — untestable in development, the worst
    // combination. The module flag already guarantees at most one attempt.
    setTimeout(() => {
      void (async () => {
        if (session.state() !== null) return;
        const wallet = await walletState();
        if (wallet.kind !== "ready") return;
        await start();
      })();
    }, AUTO_START_DELAY_MS);
    // Honest deps: both are stable in practice (the session is a module
    // singleton), and even a re-run is inert — the module flag already
    // guarantees a single attempt per launch.
  }, [session, start]);

  const stop = useCallback(async () => {
    const mine = ++generation.current;
    try {
      await session.stop();
    } finally {
      // `stop()` is best-effort teardown; reporting `error` for a failed close
      // would leave the UI unable to offer a fresh start. The session is gone
      // either way.
      if (generation.current === mine) setStatus("idle");
    }
  }, [session]);

  const value = useMemo<HyperliquidContextValue>(
    () => ({ session, status, error, lastResume, start, stop }),
    [session, status, error, lastResume, start, stop]
  );

  return <HyperliquidContext.Provider value={value}>{children}</HyperliquidContext.Provider>;
}

/**
 * The session and its lifecycle.
 *
 * Throws outside the provider rather than returning null: a screen that reads a
 * null session renders an empty portfolio, which is indistinguishable from a
 * real one belonging to an account with no positions.
 */
export function useHyperliquid(): HyperliquidContextValue {
  const value = useContext(HyperliquidContext);
  if (!value) {
    throw new Error("useHyperliquid must be used inside <HyperliquidProvider>");
  }
  return value;
}
