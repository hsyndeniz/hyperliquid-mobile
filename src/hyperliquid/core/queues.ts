/**
 * Serialisation primitives for subscription lifecycle.
 *
 * These exist to close one specific class of bug, the costliest in the
 * reference implementation:
 *
 * > A user switches BTC → ETH → BTC quickly. Create and destroy operations for
 * > the same subscription overlap. A *stale create* completes after the newer
 * > destroy and writes its handle into the active map — so the app holds a
 * > subscription it believes is gone, and the book for the wrong coin keeps
 * > arriving.
 *
 * Two independent tools, deliberately kept separate:
 *
 * - {@link PerKeyMutationQueue} — operations on the **same key** never overlap;
 *   operations on different keys stay fully parallel. Subscribing to BTC must
 *   not wait behind ETH.
 * - {@link LatestWinsQueue} — for whole-state reconciliation, where only the
 *   most recent request matters and intermediate ones are pure waste.
 *
 * Both are pure and runtime-agnostic: no timers, no transport, no globals.
 */

/**
 * Runs operations one-at-a-time per key.
 *
 * Ordering is FIFO within a key. Failures are isolated: one rejected operation
 * neither poisons the key nor blocks those queued behind it, because a
 * subscription failing to open must not permanently wedge that market.
 */
export class PerKeyMutationQueue {
  /** Tail of the chain per key; absent means idle. */
  private readonly tails = new Map<string, Promise<unknown>>();

  /**
   * Queue `operation` behind anything already running for `key`.
   *
   * @returns the operation's own result — callers await their own work, not
   *   the queue's.
   */
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Swallow the predecessor's rejection so a failure does not cascade to
    // everything queued behind it.
    const result = previous.then(
      () => operation(),
      () => operation()
    );

    // The tail must never reject, or the next `.then` would take the rejected
    // branch for the wrong reason.
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);

    // Drop the entry once this is the last operation, so the map does not grow
    // without bound across a long session of symbol switches.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });

    return result;
  }

  /** Whether work is in flight or queued for a key. */
  isBusy(key: string): boolean {
    return this.tails.has(key);
  }

  /** Number of keys with outstanding work. Diagnostics only. */
  get activeKeyCount(): number {
    return this.tails.size;
  }
}

/**
 * Runs the newest request and discards superseded ones.
 *
 * For whole-state reconciliation: if three reconciles are requested while one
 * is running, only the last is worth doing — the earlier two would compute a
 * state that is already out of date. At most one run is in flight and at most
 * one is pending.
 */
export class LatestWinsQueue {
  private running: Promise<void> | null = null;
  private pending: (() => Promise<void>) | null = null;

  /**
   * Request a run.
   *
   * Resolves when the work settles — either this operation ran, or a newer one
   * superseded it and ran instead. Either way the caller can rely on the state
   * having been brought up to date at least as recently as its request.
   */
  async request(operation: () => Promise<void>): Promise<void> {
    if (this.running) {
      // Replace any earlier waiter: it is superseded by definition.
      this.pending = operation;
      await this.running;
      return;
    }

    this.running = this.drain(operation);
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  private async drain(first: () => Promise<void>): Promise<void> {
    let next: (() => Promise<void>) | null = first;
    while (next) {
      const current = next;
      this.pending = null;
      try {
        await current();
      } catch {
        // A failed reconcile must not strand the queue; the next request
        // starts cleanly.
      }
      next = this.pending;
    }
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }
}

/**
 * Monotonic generation counter for invalidating in-flight work.
 *
 * The queues serialise; this decides whether a completed operation is still
 * *relevant*. On a transport rebuild or identity switch, bump the generation —
 * anything that started earlier can then be discarded on arrival rather than
 * writing itself into current state.
 */
export class Generation {
  private value = 0;

  /** Snapshot to compare against later. */
  current(): number {
    return this.value;
  }

  /** Invalidate everything issued before now. */
  bump(): number {
    this.value += 1;
    return this.value;
  }

  /** Whether work started at `token` may still write its result. */
  isCurrent(token: number): boolean {
    return token === this.value;
  }
}
