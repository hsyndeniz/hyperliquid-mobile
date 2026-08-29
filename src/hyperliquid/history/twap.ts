/**
 * Seeing a TWAP.
 *
 * This client has been able to **place** a TWAP since Phase 3
 * (`orders/exchange.ts` `placeTwapOrder`) and to cancel one by `twapId`, with no
 * way to see one. That is the gap this closes.
 *
 * Nothing else shows them: a TWAP and its child slices are **absent from
 * `historicalOrders` entirely**, and its slice fills appear in no ordinary fill
 * feed — `api/account.ts` already records 0 of 1,159 slices overlapping
 * `userFillsByTime`. So `twapStates` and `userTwapSliceFills` are the only
 * sources, and a user running a TWAP otherwise watches their position move with
 * nothing on screen to explain it.
 *
 * ## The dex trap
 *
 * **`twapStates` is dex-scoped and answers an empty array for the wrong dex.**
 * Measured: the same account, same 30-second window — `{user}` with no dex
 * returned 0 TWAPs across 9 events, while `{user, dex:"xyz"}` returned the 2 that
 * were actually running. No error, no warning, just nothing.
 *
 * This is the same failure `state/channels.ts` already documents for
 * `clearinghouseState` ("a real-but-wrong dex answers 200 with a well-formed
 * empty account"), and it has the same consequence: a user running a TWAP on a
 * builder dex sees an empty TWAP panel and no reason why.
 *
 * ## It is a heartbeat, not an event feed
 *
 * The channel re-sends the **entire active set** on a fixed cadence even when it
 * is empty, carries no `isSnapshot` flag anywhere (0 of 279 raw frames contained
 * the string), and delivers `[twapId, TwapState][]` tuples whose progress mutates
 * in place. So a store must **replace**, never append — and "no frame yet" is
 * genuinely different from "no TWAPs running", which is why {@link TwapStore}
 * starts at `null`.
 */

import { BigNumber } from "bignumber.js";

import { log } from "@/hyperliquid/core/logger";
import type { Hex } from "@/hyperliquid/types/domain";

const logger = log.child("history.twap");

/** One running TWAP, as the heartbeat reports it. */
export interface TwapState {
  twapId: number;
  coin: string;
  /** True for a buy. The wire spells it `side`, `"B"`/`"A"`. */
  isBuy: boolean;
  /** Total size to work, as a string. */
  size: string;
  /** Worked so far. */
  executedSize: string;
  /** Notional worked so far, in USDC. */
  executedNotional: string;
  durationMinutes: number;
  reduceOnly: boolean;
  randomize: boolean;
  startedAt: number;
}

/**
 * Fraction complete, as a decimal string in `[0,1]`, or `null` when unknowable.
 *
 * `null` rather than `0` when the total is zero or unparseable: a progress bar
 * sitting at 0% is a claim that nothing has executed, which is a different
 * statement from "we cannot tell".
 */
export function twapProgress(state: TwapState): string | null {
  const total = new BigNumber(state.size);
  if (!total.isFinite() || total.lte(0)) return null;
  const done = new BigNumber(state.executedSize);
  if (!done.isFinite()) return null;
  return BigNumber.min(done.dividedBy(total), 1).toFixed();
}

/** Average price actually achieved, or `null` before anything has executed. */
export function twapAveragePrice(state: TwapState): string | null {
  const done = new BigNumber(state.executedSize);
  if (!done.isFinite() || done.lte(0)) return null;
  return new BigNumber(state.executedNotional).dividedBy(done).toFixed();
}

function parseState(id: unknown, raw: unknown): TwapState | null {
  if (typeof id !== "number" || typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.coin !== "string") return null;
  return {
    twapId: id,
    coin: s.coin,
    isBuy: s.side === "B",
    size: typeof s.sz === "string" ? s.sz : "0",
    executedSize: typeof s.executedSz === "string" ? s.executedSz : "0",
    executedNotional: typeof s.executedNtl === "string" ? s.executedNtl : "0",
    durationMinutes: typeof s.minutes === "number" ? s.minutes : 0,
    reduceOnly: s.reduceOnly === true,
    randomize: s.randomize === true,
    startedAt: typeof s.timestamp === "number" ? s.timestamp : 0,
  };
}

/**
 * Parse a `twapStates` frame — an array of `[twapId, state]` tuples.
 *
 * An empty array is a real, frequent answer meaning "nothing running", not a
 * parse failure. It is also what a **wrong dex** returns, which is why the store
 * records the dex a frame arrived for.
 */
export function parseTwapStates(payload: unknown): TwapState[] {
  const states = (payload as { states?: unknown })?.states ?? payload;
  if (!Array.isArray(states)) return [];
  const parsed: TwapState[] = [];
  for (const entry of states) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const state = parseState(entry[0], entry[1]);
    if (state) parsed.push(state);
  }
  return parsed;
}

type Listener = () => void;

/**
 * The live TWAP set for one dex.
 *
 * Whole-value replacement, because the feed is a full-set heartbeat. Holds `null`
 * until the first frame so a panel can distinguish "not connected yet" from "no
 * TWAPs running" — the two look identical otherwise, and one of them warrants a
 * spinner while the other warrants an empty state.
 */
export class TwapStore {
  private states: TwapState[] | null = null;
  private dex: string | null = null;
  private receivedAt = 0;
  private readonly listeners = new Set<Listener>();

  /**
   * @param dex the dex this store is scoped to. `""` is the default perp dex and
   *   a legitimate value — passing the wrong one yields a permanently empty
   *   store with no error, so it is recorded and exposed rather than implied.
   */
  setDex(dex: string): void {
    if (this.dex === dex) return;
    this.dex = dex;
    this.states = null;
    this.emit();
  }

  currentDex(): string | null {
    return this.dex;
  }

  apply(payload: unknown, now: number = Date.now()): void {
    this.states = parseTwapStates(payload);
    this.receivedAt = now;
    this.emit();
  }

  /** `null` before the first frame. Never conflate that with an empty array. */
  read(): TwapState[] | null {
    return this.states;
  }

  /** True once a frame has arrived, whatever it contained. */
  hasHeard(): boolean {
    return this.states !== null;
  }

  lastFrameAt(): number {
    return this.receivedAt;
  }

  clear(): void {
    this.states = null;
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
        logger.warn("twap.listener_failed", { error });
      }
    }
  }
}

export interface TwapHistoryProbe {
  twapHistory(params: { user: Hex }): Promise<unknown>;
}

/**
 * Past TWAPs.
 *
 * Not pageable — the endpoint accepts no time window, and silently discards any
 * unknown field it is sent (a bogus key still returns HTTP 200), so a caller
 * cannot tell a rejected parameter from an accepted one. Take what it gives.
 */
export async function fetchTwapHistory(params: {
  probe: TwapHistoryProbe;
  user: Hex;
}): Promise<{ time: number; state: TwapState | null; status: string }[]> {
  const raw = await params.probe.twapHistory({ user: params.user });
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as { time?: unknown; state?: unknown; status?: unknown };
    const status = row.status;
    return [
      {
        time: typeof row.time === "number" ? row.time : 0,
        // `twapId` is ABSENT from history rows (never null) — verified on 12,806
        // rows — so a history entry cannot be joined to a live one by id.
        state: parseState(-1, row.state),
        status:
          typeof status === "string"
            ? status
            : typeof (status as { status?: unknown })?.status === "string"
              ? (status as { status: string }).status
              : "unknown",
      },
    ];
  });
}
