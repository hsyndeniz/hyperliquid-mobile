/**
 * Session hooks — the module's public API for anything gated on *who is logged
 * in* rather than on market or account data.
 *
 * Same shape as the account hooks: each takes the session explicitly, so the
 * module stays headless and every hook is testable without a React context. The
 * app decides where the session lives (see `src/providers/HyperliquidProvider`).
 *
 * These exist because `session.state()` used to be a plain getter. A screen
 * could read it, but nothing told the screen to read it *again* — so the agent
 * gate passing, an account switch, or a session ending were all invisible to
 * React, and "you can trade now" was reachable only by polling. `subscribe()`
 * closed that, and these are the binding.
 *
 * **They deliberately do not re-render on market or portfolio ticks.** The
 * session notifies on identity changes only; balances and books come from their
 * own stores. A hook here that woke on every heartbeat would drag the whole
 * logged-in shell through a re-render 20 times a second.
 */

import { useCallback } from "react";

import { useStoreValue } from "@/hyperliquid/hooks/useStore";
import type { HyperliquidSession, SessionState } from "@/hyperliquid/session";
import type { Hex } from "@/hyperliquid/types/domain";

/** The live session, or `null` before `start` and after `stop`. */
export function useSessionState(session: HyperliquidSession): SessionState | null {
  return useStoreValue(
    session,
    useCallback((s: HyperliquidSession) => s.state(), [])
  );
}

/**
 * Whether an order may be placed right now.
 *
 * Includes `rotation_due` — that agent is still valid. Gate an order button on
 * this; prompt for rotation from {@link useNeedsAgentRotation} somewhere calm.
 */
export function useCanTrade(session: HyperliquidSession): boolean {
  return useStoreValue(
    session,
    useCallback((s: HyperliquidSession) => s.canTrade(), [])
  );
}

/** A cue to offer agent rotation. Never a reason to block an order. */
export function useNeedsAgentRotation(session: HyperliquidSession): boolean {
  return useStoreValue(
    session,
    useCallback((s: HyperliquidSession) => s.needsAgentRotation(), [])
  );
}

/**
 * The address this session acts as — the sub-account when one is selected.
 *
 * Not `state()?.identity.address`, which is always the *master*. A header
 * showing that while the portfolio below it shows a sub-account's balances is
 * the confusion this accessor exists to prevent.
 *
 * **Never call `session.address()` directly from a component.** It is a plain
 * method on a stable object, so React Compiler treats it as a pure call it may
 * memoise for the life of the component — and it does. Measured on device: a
 * screen that read it once while signed out kept returning `null` after the
 * session started, so `session.state()` said "signed in" and `session.address()`
 * said "nobody" in the same render. Subscribing through `useStoreValue` is what
 * makes the read re-run; `screenGuards.test.ts` enforces it.
 */
export function useSessionAddress(session: HyperliquidSession): Hex | null {
  return useStoreValue(
    session,
    useCallback((s: HyperliquidSession) => s.address(), [])
  );
}
