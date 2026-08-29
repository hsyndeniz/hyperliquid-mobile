/**
 * Perp account state — summary and positions.
 *
 * **One store, not two.** The `clearinghouseState` payload carries the margin
 * summaries, `withdrawable` and `assetPositions` in a single object. Splitting
 * it would create two writers for one payload and let the header balance and
 * the position list disagree by a tick, which is the shape of every "my numbers
 * don't add up" report.
 *
 * Three things differ from `BookStore`, each for a measured reason:
 *
 * 1. **No value-level TTL.** An empty book renders as *loading*; an empty
 *    account renders as *your money is gone*. The value is retained past its
 *    freshness window and staleness is reported separately, so a surface greys
 *    out rather than blanking.
 * 2. **Positions are replaced wholesale, never merged by coin.** A flat position
 *    is *removed* from the array rather than reported with a zero size, so a
 *    merging store keeps a closed position on screen forever.
 * 3. **Identical pushes do not notify.** This is a ~5 s heartbeat that re-sends
 *    the same object when nothing changed — 21 byte-identical snapshots in 95 s
 *    on one measurement. Without a content check the whole portfolio tree gets a
 *    new object identity every 5 s, in the background, forever. That trade would
 *    be wrong in `BookStore`, which ticks; here it is free.
 */

import { deviceInstantOf, isForTarget } from "@/hyperliquid/core/freshness";
import { effectiveAddress, subscriptionKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import type {
  AccountSnapshot,
  Position,
  Scoped,
  SubscriptionTarget,
} from "@/hyperliquid/types/domain";

const logger = log.child("state.account");

/**
 * Three missed 5 s heartbeats.
 *
 * Every account channel was measured at a 5,009–5,066 ms server cadence on an
 * idle account, an active account and a 154-position market maker, across both
 * networks. A quiet account still ticks, so silence past this window means the
 * feed died rather than that nothing happened.
 */
export const ACCOUNT_STALE_AFTER_MS = 15_000;

type Listener = () => void;

/** What an event must echo back for the store to accept it. */
export interface AccountEcho {
  /** wire `dex` — `""` is the main dex. */
  dex: string;
  /** wire `user`, lowercased by the SDK on the way out. */
  user: string;
}

export class AccountStore {
  private target: SubscriptionTarget | null = null;
  private scoped: Scoped<AccountSnapshot> | null = null;
  private byCoin = new Map<string, Position>();
  private signature: string | null = null;
  private staleOverride = false;
  private readonly listeners = new Set<Listener>();
  private droppedCount = 0;
  private rejectedCount = 0;

  /**
   * Point at a different account or dex.
   *
   * Clears immediately. `isForTarget` drops wrong-target *writes*, but it does
   * not clear what is already held — a store without this call site has the
   * guard and not the cure, and the previous account's balance stays on screen.
   */
  setTarget(target: SubscriptionTarget | null): void {
    const changed =
      !this.target || !target || subscriptionKey(this.target) !== subscriptionKey(target);
    this.target = target;
    if (changed) {
      this.scoped = null;
      this.byCoin.clear();
      this.signature = null;
      this.staleOverride = false;
      this.droppedCount = 0;
      this.rejectedCount = 0;
      this.emit();
    }
  }

  currentTarget(): SubscriptionTarget | null {
    return this.target;
  }

  /**
   * Apply a parsed snapshot.
   *
   * `echo` is the identity the server claims it answered for. Checking it is not
   * belt-and-braces: a real-but-wrong dex returns **HTTP 200 with a fully-formed
   * empty account** — `assetPositions: []`, `accountValue "0.0"` — for an address
   * holding live positions on the main dex. Without this check the user sees a
   * calm, plausible "no positions" screen while carrying real risk.
   */
  apply(event: Scoped<AccountSnapshot>, echo?: AccountEcho): boolean {
    if (!this.target || !isForTarget(event, this.target)) {
      this.droppedCount += 1;
      return false;
    }
    if (echo && !this.echoMatches(echo)) {
      this.rejectedCount += 1;
      logger.warn("account.echo_mismatch", {
        context: { expectedDex: this.target.identity.dex ?? "", receivedDex: echo.dex },
      });
      return false;
    }
    // Monotonicity on the SERVER clock. The websocket lags an HTTP fetch by
    // 2.8-4.4 s, so the first push after a REST seed is routinely older than the
    // seed and would otherwise walk the balance backwards.
    if (this.scoped && event.value.summary.serverTime < this.scoped.value.summary.serverTime) {
      this.droppedCount += 1;
      return false;
    }

    const signature = signatureOf(event.value);
    const unchanged = this.scoped !== null && signature === this.signature;

    // On an identical push, take the new timestamps but keep the OLD value
    // object. `read()` is a `getSnapshot`, so handing back a fresh object for
    // identical content re-renders the whole portfolio tree on every 5s
    // heartbeat — the precise cost this content check exists to avoid. Swapping
    // the value first and comparing afterwards would suppress the `emit` and
    // still leak a new identity to any consumer that renders for another reason.
    this.scoped = unchanged ? { ...event, value: this.scoped!.value } : event;
    this.staleOverride = false;

    if (unchanged) {
      // Freshness still advances — the feed is alive, it just had nothing new.
      return false;
    }
    this.signature = signature;
    this.byCoin = reindexPositions(this.byCoin, event.value.positions);
    this.emit();
    return true;
  }

  private echoMatches(echo: AccountEcho): boolean {
    if (!this.target) return false;
    const expectedDex = this.target.identity.dex ?? "";
    if (echo.dex !== expectedDex) return false;
    return echo.user.toLowerCase() === effectiveAddress(this.target.identity).toLowerCase();
  }

  /**
   * The snapshot, or `null` when nothing has arrived.
   *
   * Deliberately **not** gated on freshness, unlike `BookStore.read`. Stale
   * balances greyed out are useful; a blank portfolio is alarming and less true.
   */
  read(): AccountSnapshot | null {
    return this.target ? (this.scoped?.value ?? null) : null;
  }

  readScoped(): Scoped<AccountSnapshot> | null {
    return this.scoped;
  }

  /** One position, or `null`. Backed by an index rebuilt on each accepted apply. */
  positionByCoin(coin: string): Position | null {
    return this.byCoin.get(coin) ?? null;
  }

  isStale(now: number, maxAgeMs = ACCOUNT_STALE_AFTER_MS): boolean {
    if (this.staleOverride) return true;
    if (!this.scoped) return true;
    // `now` is the device's clock, so the frame's instant has to be put on the
    // same one. Subtracting the raw server stamp inverted this verdict under
    // skew: a slow phone reported a dead feed as live.
    return now - deviceInstantOf(this.scoped) > maxAgeMs;
  }

  /**
   * Mark the held value unusable without discarding it.
   *
   * Called on resume from background, before the async resubscribe completes.
   * A flag rather than zeroed timestamps, so the greyed-out render can still say
   * "as of 14:32".
   */
  markStale(): void {
    if (!this.scoped) return;
    this.staleOverride = true;
    this.emit();
  }

  /** Events discarded as belonging to another target or arriving out of order. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Events refused because the server echoed a different account or dex. */
  get rejected(): number {
    return this.rejectedCount;
  }

  clear(): void {
    this.scoped = null;
    this.byCoin.clear();
    this.signature = null;
    this.staleOverride = false;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        logger.warn("account.listener_failed", { error });
      }
    }
  }
}

/**
 * Rebuild the by-coin index, **preserving object identity for unchanged positions**.
 *
 * Every push is freshly parsed, so a naive rebuild hands back a new object for
 * every coin even when only one moved. A per-coin subscriber compares its slice
 * with `Object.is`, so without this every position row on the screen re-renders
 * on every 5s heartbeat — which is precisely the "broad store reads" regression
 * this module's design notes call the reference codebase's most repeated
 * performance problem.
 *
 * The comparison is a JSON round-trip rather than a hand-written field-by-field
 * check: a position has eighteen fields, and a check that silently misses one
 * would pin a stale value on screen — the expensive failure, against a cheap
 * string compare on an object this small.
 */
function reindexPositions(
  previous: ReadonlyMap<string, Position>,
  incoming: readonly Position[]
): Map<string, Position> {
  const next = new Map<string, Position>();
  for (const position of incoming) {
    const held = previous.get(position.coin);
    const unchanged = held !== undefined && JSON.stringify(held) === JSON.stringify(position);
    next.set(position.coin, unchanged ? held : position);
  }
  return next;
}

/**
 * Content signature, excluding the server timestamp.
 *
 * The timestamp changes on every heartbeat; including it would make every
 * snapshot look new and defeat the whole check.
 */
function signatureOf(snapshot: AccountSnapshot): string {
  const { serverTime: _ignored, ...summary } = snapshot.summary;
  return JSON.stringify([summary, snapshot.positions]);
}
