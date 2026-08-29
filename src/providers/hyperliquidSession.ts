/**
 * The one session.
 *
 * Lazily created so importing this module opens nothing — the session's
 * constructor is cheap, but keeping the rule makes it safe to import from a
 * test or a script.
 *
 * It lives here rather than beside the provider because a component file that
 * also exports plain functions cannot keep component state across a Fast
 * Refresh — and the provider is the one component that must survive a reload
 * cleanly. The session being module-level is the point: see the provider's
 * header for why a `useRef` would open a second websocket.
 */

import { HyperliquidSession } from "@/hyperliquid/session";

let singleton: HyperliquidSession | null = null;

export function getHyperliquidSession(): HyperliquidSession {
  singleton ??= new HyperliquidSession();
  return singleton;
}
