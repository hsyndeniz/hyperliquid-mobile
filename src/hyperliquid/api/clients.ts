/**
 * Transports and clients.
 *
 * All network wiring lives here so network choice (`isTestnet`) is made in one
 * place and cannot drift between call sites — signing the wrong
 * `hyperliquidChain` is derived purely from the transport's `isTestnet`, and
 * mixing them produces a validly-signed action against the wrong network with
 * no error.
 *
 * Lifecycle facts that shape this module (verified against 0.33.3):
 * - `WebSocketTransport` **connects eagerly in its constructor**, so it is
 *   created on first use, never at module scope, and never during import.
 * - `HttpTransport` has no `close()`; only the WS transport is disposable.
 * - `ExchangeClient` takes its wallet at **construction time only** — there is
 *   no per-call signer override — so exchange clients are per-identity.
 */

import {
  ExchangeClient,
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from "@nktkas/hyperliquid";

import { hlConfig } from "@/hyperliquid/config/env";
import type { HlConfig } from "@/hyperliquid/config/env";
import { serverNow } from "@/hyperliquid/core/clock";
import { log } from "@/hyperliquid/core/logger";
import type { IAbstractWallet } from "@/hyperliquid/types/sdk";

/**
 * Ping interval. Hyperliquid closes a connection silent for ~60s, so the
 * keep-alive must be comfortably inside that window.
 */
const WS_PING_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

let httpTransport: HttpTransport | null = null;
let wsTransport: WebSocketTransport | null = null;
let infoClient: InfoClient | null = null;
let subscriptionClient: SubscriptionClient | null = null;
let activeConfig: HlConfig = hlConfig;

/**
 * Bumped every time the websocket transport is actually torn down.
 *
 * A handle held against the old transport is worthless after this changes, and
 * ONLY after — which is the distinction the market feed needs. It used to
 * rebuild on every session publish, under a comment asserting that "a session
 * start/switch/stop rebuilds the websocket". That is false for a same-identity
 * restart: `startInternal` skips `configureClients` when the env is unchanged
 * and `switchTo` returns early on equal identity keys, yet `publish(state)`
 * still fires. Every such publish tore down and reopened live market
 * subscriptions for nothing.
 */
let transportGeneration = 0;

/** The current transport generation. Compare, never interpret. */
export function transportGenerationOf(): number {
  return transportGeneration;
}

/** HTTP transport for info and exchange requests. Cheap; no connection held. */
export function getHttpTransport(): HttpTransport {
  if (!httpTransport) {
    httpTransport = new HttpTransport({
      isTestnet: activeConfig.isTestnet,
      timeout: REQUEST_TIMEOUT_MS,
    });
    log.child("api").info("transport.http.created", {
      context: { isTestnet: activeConfig.isTestnet },
    });
  }
  return httpTransport;
}

/**
 * WebSocket transport for subscriptions.
 *
 * **Opens a socket immediately.** Only call this when a live feed is actually
 * wanted; calling it during startup means a socket before any screen mounts.
 *
 * Reconnection, keep-alive and re-subscription are the SDK's job — we configure
 * them rather than reimplementing them. What the SDK cannot do is application
 * concerns (which target is current, whether data is fresh); that belongs in
 * the subscription layer, not here.
 */
export function getWebSocketTransport(): WebSocketTransport {
  if (!wsTransport) {
    wsTransport = new WebSocketTransport({
      isTestnet: activeConfig.isTestnet,
      timeout: REQUEST_TIMEOUT_MS,
      keepAlive: { interval: WS_PING_INTERVAL_MS },
      resubscribe: true,
    });
    log.child("api").info("transport.ws.created", {
      context: { isTestnet: activeConfig.isTestnet },
    });
  }
  return wsTransport;
}

/** Shared read-only client. Info requests are exempt from action rate limits. */
export function getInfoClient(): InfoClient {
  if (!infoClient) {
    infoClient = new InfoClient({ transport: getHttpTransport() });
  }
  return infoClient;
}

/** Subscription client. Creating it opens the websocket — see `getWebSocketTransport`. */
export function getSubscriptionClient(): SubscriptionClient {
  if (!subscriptionClient) {
    subscriptionClient = new SubscriptionClient({ transport: getWebSocketTransport() });
  }
  return subscriptionClient;
}

/**
 * An exchange client bound to a wallet.
 *
 * Not cached here: the wallet is fixed at construction, so caching by anything
 * other than the exact wallet risks signing with a stale agent after rotation.
 * The auth layer owns that lifetime.
 *
 * `signatureChainId` is pinned rather than derived — a viem local account has
 * no chain, so the SDK would otherwise default it to `0x1`.
 */
export function createExchangeClient(wallet: IAbstractWallet): ExchangeClient {
  return new ExchangeClient({
    transport: getHttpTransport(),
    wallet,
    signatureChainId: activeConfig.signatureChainId,
    // Ours, so the nonce that gets SIGNED is a value this app can read back.
    // See `issueNonce`.
    nonceManager: issueNonce,
  });
}

/**
 * Rebuild everything against a different config (network switch, or tests).
 *
 * Closes the websocket first: an orphaned transport keeps reconnecting forever
 * by default, so dropping the reference without closing leaks a live socket.
 */
export function configureClients(config: HlConfig): void {
  closeClients();
  activeConfig = config;
}

/**
 * The SDK's nonce manager, except it remembers what it issued.
 *
 * ## Why this exists
 *
 * A withdrawal has no idempotency key and its response carries no handle —
 * `{status:"ok"}` and nothing else. The ledger row that appears minutes later is
 * keyed by the NONCE, so the nonce is the only way to answer "did it land?",
 * and `transfers/journal.ts` records it before sending so a crash mid-call is
 * still resolvable. That journal drives the duplicate guard.
 *
 * But the app never knew the nonce. `submitWithdrawal` took its own `Date.now()`
 * and journalled that, while the real one was generated later and independently
 * inside the SDK: `executeWithShell` does `await getWalletAddress(...)`, then
 * acquires a per-wallet lock, and only then calls the nonce manager — which
 * takes a SECOND `Date.now()`. The two agree only while that gap rounds under a
 * millisecond.
 *
 * And timing is not the only divergence. The SDK's rule is
 * `nonce = now > last ? now : last + 1`, so a second action in the same
 * millisecond gets a COUNTER, not a timestamp — at which point the journal's
 * `nonce / 1000` arithmetic is meaningless rather than merely off by one.
 *
 * `ledger.ts` calls the match "an identity, not a heuristic" on the evidence of
 * three withdrawals, all on a warm fast path. That is what a race that usually
 * wins looks like.
 *
 * ## What this changes
 *
 * Supplying the manager means the value is ours to read. `submitWithdrawal`
 * still journals before the call — the crash it guards against happens DURING
 * the call, so an entry written afterwards would never exist — and then
 * corrects the entry to the nonce that was actually signed. Monotonicity is
 * preserved exactly as the SDK's own manager does it, because the server
 * requires it.
 *
 * Keyed by address AND env: the master and agent wallets are different
 * addresses, and a testnet nonce must not constrain a mainnet one.
 */
const issuedNonces = new Map<string, number>();

function nonceKeyFor(address: string): string {
  return `${activeConfig.env}:${address.toLowerCase()}`;
}

export function issueNonce(address: string): number {
  const key = nonceKeyFor(address);
  // The exchange's clock, not the phone's — the same rule every `expiresAfter`
  // follows, for a sharper reason than it looks.
  //
  // A nonce must exceed the SMALLEST of this signer's 100 highest, and that
  // floor is a one-way ratchet: it never comes back down. A phone running fast
  // stamps its whole stored set ahead of real time, and then the moment the
  // clock is CORRECTED — NTP on network reattach, a reboot, "Set Automatically"
  // toggled — every later action falls under a floor the device itself raised.
  // The monotonic guard below hides that within a session and the map is
  // in-memory, so the symptom appears one restart later with nothing local to
  // explain it.
  //
  // Building the nonce on the exchange's clock means a wrong device clock never
  // enters the ratchet at all. The residual risk runs the other way — a
  // mis-measured offset would push the floor forward — but the offset is a
  // median of nine real exchange stamps, deadbanded and clamped, so it is a far
  // smaller exposure than the device clock it replaces.
  const now = serverNow();
  const last = issuedNonces.get(key) ?? 0;
  // The SDK's own rule, reproduced deliberately: the server rejects a nonce
  // that does not advance, so two actions inside one millisecond must still
  // differ.
  const nonce = now > last ? now : last + 1;
  issuedNonces.set(key, nonce);
  return nonce;
}

/**
 * The last nonce this app signed for `address`, or `null` if it has signed none.
 *
 * For a caller that journalled a nonce before the call and needs to correct it
 * to what was actually used.
 */
export function lastIssuedNonce(address: string): number | null {
  return issuedNonces.get(nonceKeyFor(address)) ?? null;
}

/** Tear down. Only the websocket transport holds a resource. */
export function closeClients(): void {
  // Bumped only when there was something to tear down. A no-op close must not
  // look like a rebuild, or the market feed churns on every one.
  if (wsTransport !== null || subscriptionClient !== null) transportGeneration += 1;
  if (wsTransport) {
    try {
      wsTransport.close();
    } catch (error) {
      log.child("api").warn("transport.ws.close_failed", { error });
    }
  }
  wsTransport = null;
  httpTransport = null;
  infoClient = null;
  subscriptionClient = null;
}

/**
 * Connection state.
 *
 * `idle` — no transport yet. `connecting` — opening, or **reconnecting**.
 * `open` — usable. `terminated` — permanently dead; it will not recover.
 */
export type ConnectionState = "idle" | "connecting" | "open" | "terminated";

/**
 * Derive the state from a socket.
 *
 * Pure and exported so it is testable without a live socket.
 *
 * `terminated` is checked **first**: the reconnecting-socket layer reports
 * `CONNECTING` throughout every retry, and reports `CLOSED` only after giving
 * up permanently. Reading `readyState` alone would therefore show "connecting"
 * forever during a total outage.
 */
export function deriveConnectionState(
  socket: { readyState: number; terminated: boolean } | null
): ConnectionState {
  if (!socket) return "idle";
  if (socket.terminated) return "terminated";
  switch (socket.readyState) {
    case 1:
      return "open";
    case 0:
    case 2:
      return "connecting";
    default:
      return "terminated";
  }
}

/**
 * Current connection state. Does **not** open the socket.
 *
 * Replaces the old `isWebSocketOpen()`, which reported only whether the
 * transport object existed — true from construction and still true after the
 * socket had permanently died, so any health check built on it reported healthy
 * during an outage.
 */
export function getConnectionState(): ConnectionState {
  if (!wsTransport) return "idle";
  const socket = (
    wsTransport as unknown as {
      socket?: { readyState?: number; terminationSignal?: { aborted?: boolean } };
    }
  ).socket;
  if (!socket || typeof socket.readyState !== "number") return "idle";
  return deriveConnectionState({
    readyState: socket.readyState,
    terminated: socket.terminationSignal?.aborted === true,
  });
}
