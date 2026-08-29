/**
 * Background / foreground policy for the realtime layer.
 *
 * The mobile-specific problem. iOS suspends a backgrounded app's JS and will
 * silently drop its socket; Android may keep it briefly. Neither tells us. The
 * naive responses are both wrong:
 *
 * - **Closing the transport on background is unrecoverable.** `close()` on the
 *   SDK transport is *permanent* — it does not reconnect afterwards — so the
 *   app would return to the foreground with a dead socket and no path back
 *   short of rebuilding everything.
 * - **Doing nothing** leaves the app rendering a book that stopped updating
 *   while it was away, with no signal that it is stale. That is the worst
 *   outcome for a trading screen: numbers that look live and are not.
 *
 * The policy instead: keep the transport, mark the data stale on the way out,
 * and on return decide from *elapsed time* whether a resubscribe is needed —
 * a brief switch away should not tear down a healthy connection, but a long
 * suspension almost certainly killed it.
 */

import { log } from "@/hyperliquid/core/logger";

const logger = log.child("ws.appstate");

/**
 * Below this, a healthy socket is assumed to have survived and is only
 * verified; beyond it, subscriptions are rebuilt.
 *
 * Chosen against Hyperliquid's own behaviour: it closes a connection silent for
 * roughly 60s, so anything past that has very likely been dropped server-side
 * regardless of what the client believes.
 */
export const RESUBSCRIBE_AFTER_BACKGROUND_MS = 45_000;

export type AppPhase = "active" | "background";

/**
 * HOW to resubscribe, which depends entirely on what the transport can do.
 *
 * - `live` — the socket is open. Unsubscribe cleanly, then re-add. Both halves
 *   reach the server, so nothing is orphaned and nothing is lost.
 * - `rebuild` — terminated or absent. The SDK has already failed every
 *   subscription and will not replay, so the transport itself must be replaced
 *   before re-adding.
 * - `none` — either nothing changed, or the socket is mid-reconnect and the
 *   SDK's own replay is strictly better than anything we can do. See
 *   `decideOnResume`.
 */
export type ResubscribeMode = "none" | "live" | "rebuild";

export interface ResumeDecision {
  /** How long the app was away. */
  awayMs: number;
  /** Rebuild every subscription — the connection probably did not survive. */
  shouldResubscribe: boolean;
  /** Treat displayed data as stale until fresh values arrive. */
  shouldMarkStale: boolean;
  /** Which rebuild is appropriate. `none` whenever `shouldResubscribe` is false. */
  mode: ResubscribeMode;
}

/**
 * What to do on returning to the foreground.
 *
 * Pure, so the policy is testable without a device — the part that needs a
 * device is whether the socket actually survived, which is exactly why the
 * decision is time-based rather than trusting a connection flag.
 */
export function decideOnResume(params: {
  awayMs: number;
  connectionState: "idle" | "connecting" | "open" | "terminated";
  threshold?: number;
}): ResumeDecision {
  const threshold = params.threshold ?? RESUBSCRIBE_AFTER_BACKGROUND_MS;

  // A terminated socket is conclusive regardless of how brief the absence was.
  // `idle` likewise has no transport to preserve. Both need one built.
  if (params.connectionState === "terminated" || params.connectionState === "idle") {
    return {
      awayMs: params.awayMs,
      shouldResubscribe: true,
      shouldMarkStale: true,
      mode: "rebuild",
    };
  }

  // MID-RECONNECT: hands off, and that is the whole point of this branch.
  //
  // A resubscribe here destroys the recovery instead of performing it. The SDK
  // keeps its `_subscriptions` map across a non-terminal close precisely so
  // `_handleOpen` can replay every channel with its ORIGINAL listener — but our
  // release path unsubscribes, and the SDK's unsubscribe deletes from that same
  // map. So we would erase the replay set, and the re-subscribe frames that
  // follow cannot land on a socket that is not open: the dispatcher rejects the
  // whole queue on the next failed reconnect attempt. The result is an account
  // with no live channels and nothing left to re-drive them — positions, orders
  // and liquidation warnings silently dead, while market feeds (which are not
  // on this path) keep ticking and hide it.
  if (params.connectionState === "connecting") {
    return { awayMs: params.awayMs, shouldResubscribe: false, shouldMarkStale: true, mode: "none" };
  }

  const longAbsence = params.awayMs >= threshold;
  return {
    awayMs: params.awayMs,
    shouldResubscribe: longAbsence,
    // Even a short absence produced a gap in the stream, so nothing on screen
    // can be trusted until a fresh value confirms it.
    shouldMarkStale: true,
    mode: longAbsence ? "live" : "none",
  };
}

export interface AppStatePolicyOptions {
  /** Rebuild subscriptions. Called only when the decision says so. */
  resubscribe: (mode: ResubscribeMode) => Promise<void>;
  /** Mark surfaces stale so nothing renders as live until confirmed. */
  markStale: () => void;
  /**
   * Drop any cached secret material on backgrounding.
   *
   * Optional so the policy stays testable without a vault, but wired in
   * production — see `session.ts`.
   */
  lockSecrets?: () => void;
  /** Reads the live connection state; never opens a socket. */
  connectionState: () => "idle" | "connecting" | "open" | "terminated";
  threshold?: number;
  now?: () => number;
}

/**
 * Tracks foreground/background transitions and applies the policy.
 *
 * Deliberately not bound to React Native's `AppState` — the caller subscribes
 * and forwards transitions. That keeps this testable, and keeps the module
 * importable outside the app runtime.
 */
export class AppStatePolicy {
  private phase: AppPhase = "active";
  private backgroundedAt: number | null = null;

  constructor(private readonly options: AppStatePolicyOptions) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Feed a transition. Repeat transitions to the same phase are ignored. */
  async onPhaseChange(phase: AppPhase): Promise<ResumeDecision | null> {
    if (phase === this.phase) return null;
    this.phase = phase;

    if (phase === "background") {
      this.backgroundedAt = this.now;
      // The transport is deliberately left open: closing it is permanent.
      //
      // The vault's master key is NOT. `lockVault` exists for exactly this
      // transition — its docstring says "for lock-on-background" — and had no
      // call site, so the AES key that decrypts the recovery phrase stayed in
      // the JS heap for the whole time the app was suspended, which is the
      // window where a memory capture is plausible at all. Re-reading it costs
      // one Keychain access on the next secret, and the device is unlocked by
      // definition whenever that happens.
      this.options.lockSecrets?.();
      logger.info("appstate.backgrounded", {});
      return null;
    }

    const awayMs = this.backgroundedAt === null ? 0 : this.now - this.backgroundedAt;
    this.backgroundedAt = null;

    const decision = decideOnResume({
      awayMs,
      connectionState: this.options.connectionState(),
      threshold: this.options.threshold,
    });

    logger.info("appstate.resumed", {
      context: { awayMs, resubscribe: decision.shouldResubscribe },
    });

    // Marked stale first: a resubscribe is asynchronous, and until it delivers
    // there is nothing trustworthy on screen.
    if (decision.shouldMarkStale) this.options.markStale();
    if (decision.shouldResubscribe) {
      try {
        await this.options.resubscribe(decision.mode);
      } catch (error) {
        // A failed rebuild leaves the surfaces stale, which is the safe state.
        logger.warn("appstate.resubscribe_failed", { error });
      }
    }
    return decision;
  }

  get currentPhase(): AppPhase {
    return this.phase;
  }
}
