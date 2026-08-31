/**
 * The REST-backed history reads, as a screen needs them.
 *
 * Ledger, order history and TWAP history are all one-shot `InfoClient` calls
 * rather than subscriptions — nothing pushes them — so each needs the same four
 * states, and getting any of them wrong is a specific lie:
 *
 * | State | What a naive version renders instead | Why that is wrong |
 * | --- | --- | --- |
 * | `idle` | an empty list | there is no session; nothing was asked |
 * | `loading` | an empty list | "no transfers yet" for an account with 400 |
 * | `deferred` | an empty list | the weight budget declined; retry works |
 * | `error` | an empty list | a failed read is not an empty account |
 *
 * That table is why `Fetched` is a tagged union and not `T | null`. The four
 * cases are visually distinct on screen and only one of them is "empty".
 *
 * ## Truncation is a state too
 *
 * Both `historicalOrders` and the ledger cap their responses, and only the
 * ledger gives a cursor. `history/orders.ts` says it plainly: older history is
 * unreachable, so a UI "must say 'showing recent activity', never 'all
 * orders'". These hooks pass that flag through rather than dropping it, because
 * a silently-truncated list looks exactly like a complete one.
 *
 * ## Why the weight budget wraps the call here and not in `history/`
 *
 * The `history/` modules take a probe and are budget-agnostic, which keeps them
 * testable without a clock. The budget is a property of *this app making this
 * call on this device*, so it belongs at the composition edge — the same place
 * `api/accountMeta.ts` puts it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getInfoClient } from "@/hyperliquid/api/clients";
import {
  readThrough,
  restCache,
  restCacheKey,
  REST_CACHE_TTL_MS,
} from "@/hyperliquid/api/restCache";
import { weightBudget, type WeightedRequest } from "@/hyperliquid/api/weightBudget";
import {
  fetchDelegatorSummary,
  fetchUserFees,
  parseFundingRow,
  type DelegatorSummary,
  type FundingLedgerRow,
  type MetaProbe,
  type UserFeeRates,
} from "@/hyperliquid/api/accountMeta";
import { log } from "@/hyperliquid/core/logger";
import {
  fetchFillHistory,
  type FillHistory,
  type FillHistoryProbe,
} from "@/hyperliquid/history/fills";
import {
  fetchLedgerPage,
  ledgerPageWindow,
  mergeLedger,
  seedLedger,
  type LedgerProbe,
  type LedgerRow,
} from "@/hyperliquid/history/ledger";
import {
  fetchOrderHistory,
  type OrderHistoryProbe,
  type OrderLifecycle,
} from "@/hyperliquid/history/orders";
import {
  fetchTwapHistory,
  type TwapHistoryProbe,
  type TwapState,
} from "@/hyperliquid/history/twap";
import type { Hex } from "@/hyperliquid/types/domain";
import { fetchVaultPositions, type VaultEquitiesProbe } from "@/hyperliquid/vaults/equities";
import type { VaultPosition } from "@/hyperliquid/vaults/types";

const logger = log.child("hooks.history");

/** A one-shot read, in every state it can actually be in. */
export type Fetched<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "deferred" }
  | { kind: "error"; message: string }
  | { kind: "ready"; value: T };

/**
 * Run a user-scoped read through the weight budget, into a `Fetched`.
 *
 * Not exported as a hook because every caller wants its own parsed shape; this
 * is the shared plumbing, and the exported hooks below are the API.
 */
function useFetch<T>(
  user: Hex | null,
  request: WeightedRequest,
  read: (user: Hex) => Promise<T>
): { state: Fetched<T>; refresh: () => void } {
  // The result is stored WITH the user it belongs to, and the visible state is
  // derived from that. Two things fall out of it:
  //
  // - An account switch reads as `loading` on the very first render, with no
  //   setState in an effect and therefore no cascading render. Resetting in an
  //   effect instead would leave the previous account's transfers on screen for
  //   a frame, under the new account's header.
  // - A response that arrives after a switch is dropped by the same check that
  //   produced the reset, rather than by a separate guard that could drift.
  //
  // The initial state is seeded FROM THE CACHE, lazily. That is what makes a
  // remount free: without it, every tab switch renders a skeleton and spends
  // weight re-asking for data that has not changed.
  const [entry, setEntry] = useState<{ user: Hex | null; state: Fetched<T> }>(() => {
    if (user === null) return { user: null, state: { kind: "idle" } };
    const hit = restCache.read<T>(restCacheKey(request, user), Date.now(), REST_CACHE_TTL_MS);
    return hit === undefined
      ? { user: null, state: { kind: "idle" } }
      : { user, state: { kind: "ready", value: hit } };
  });

  const state: Fetched<T> =
    user === null ? { kind: "idle" } : entry.user === user ? entry.state : { kind: "loading" };

  const run = useCallback(
    async (force: boolean) => {
      if (user === null) return;
      try {
        const { value } = await readThrough<T>({
          key: restCacheKey(request, user),
          // A forced refresh must reach the exchange: "I just made a transfer and
          // want to see it" cannot be answered from a cache.
          ttlMs: force ? 0 : REST_CACHE_TTL_MS,
          now: Date.now(),
          fetch: () => weightBudget.tryRun(request, () => read(user)),
        });
        // `null` is the budget declining, NOT an empty result — the reads below
        // all return an array, and an empty array is a distinct, valid value.
        setEntry({
          user,
          state: value === null ? { kind: "deferred" } : { kind: "ready", value },
        });
      } catch (error) {
        logger.warn("history.read_failed", { context: { request }, error });
        setEntry({
          user,
          state: { kind: "error", message: error instanceof Error ? error.message : "failed" },
        });
      }
      // `read` is intentionally not a dependency: callers pass an inline arrow,
      // which is a new function every render, and depending on it would refetch
      // in a loop. `user` and `request` are what actually identify the read.
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, request]
  );

  useEffect(() => {
    if (user === null) return;
    // Deferred a tick so nothing writes state synchronously from the effect.
    // `run` consults the cache first, so a remount inside the TTL costs nothing.
    const timer = setTimeout(() => void run(false), 0);
    return () => clearTimeout(timer);
  }, [user, run]);

  useEffect(() => {
    if (user === null) return;
    // Every reader of this key re-reads when anyone drops it, not just the one
    // that asked. Several screens mount the same read more than once — the
    // vault screen holds three `useVaultEquity` — and before this, a refresh
    // after a settled transfer reached only the instance that submitted, so the
    // rest kept rendering pre-transfer equity and quoting from it.
    //
    // `run(false)` rather than a forced read: the entry has just been deleted,
    // so this misses the cache and fetches anyway, and any reader that shares
    // the key gets the one in-flight request through `readThrough`.
    return restCache.onInvalidate(restCacheKey(request, user), () => {
      void run(false);
    });
  }, [user, request, run]);

  const refresh = useCallback(() => {
    // Clearing to `loading` first would be a synchronous setState from an event
    // handler, which is fine — but it is also unnecessary: `run` overwrites the
    // entry when it settles, and until then the previous rows stay readable.
    void run(true);
  }, [run]);

  return { state, refresh };
}

/** Deposits, withdrawals and transfers — everything except funding. */
export interface LedgerView {
  rows: readonly LedgerRow[];
  /** The response was capped. There IS a cursor, so this is pageable. */
  hasMore: boolean;
}

/**
 * The ledger, with "load older".
 *
 * The seed is the NEWEST 2,000 rows (the omitted-`startTime` form). Older
 * history can only be read ascending from epoch — `history/ledger.ts` measured
 * the two windows as disjoint — so `loadOlder` walks pages FORWARD from a
 * cursor toward the seed's oldest row, and the visible list is the merge of
 * both ends. `hasMore` stays true until the walk meets the seed (a short page
 * with the window pinned at the seed's oldest row), at which point every row
 * the endpoint will ever give is held.
 *
 * The walk lives outside `useFetch` because it APPENDS — the cache holds the
 * seed only, which keeps a remount cheap without persisting an unbounded list.
 */
export function useLedger(user: Hex | null): {
  state: Fetched<LedgerView>;
  refresh: () => void;
  loadOlder: () => void;
  isLoadingOlder: boolean;
} {
  const base = useFetch<LedgerView>(user, "userNonFundingLedgerUpdates", async (address) => {
    const page = await seedLedger({
      probe: getInfoClient() as unknown as LedgerProbe,
      user: address,
    });
    return { rows: page.rows, hasMore: page.hasMore };
  });

  const [older, setOlder] = useState<{
    user: Hex | null;
    rows: LedgerRow[];
    /** Next `startTime` for the ascending walk. */
    cursor: number;
    done: boolean;
    busy: boolean;
  }>({ user: null, rows: [], cursor: 0, done: false, busy: false });

  // An account switch resets the walk the same way `useFetch` resets the seed:
  // by deriving, not by an effect that leaves one stale render. Memoised so
  // `loadOlder`'s dependencies are stable across unrelated renders.
  const walk = useMemo(
    () => (older.user === user ? older : { user, rows: [], cursor: 0, done: false, busy: false }),
    [older, user]
  );

  const loadOlder = useCallback(() => {
    if (user === null || base.state.kind !== "ready" || walk.busy || walk.done) return;
    const seedRows = base.state.value.rows;
    // The SEED's oldest row, not the merged set's. The window's upper bound is
    // a constant of the whole walk: it is the point the seed already covers
    // down to. Taking it from `mergeLedger(walk.rows, seedRows)` moved it older
    // with every page, so from page two the bound sat BELOW `walk.cursor` and
    // `fetchLedgerPage` threw its own inverted-window error — after the budget
    // had already been charged 20 weight, and with `done` still false, so the
    // button stayed enabled and every further tap burned 20 more.
    const window = ledgerPageWindow({ cursor: walk.cursor, seedRows });
    if (window === null) {
      // Nothing left below the seed. Marking it done rather than leaving the
      // button live to fail on every tap.
      setOlder({ ...walk, user, done: true, busy: false });
      return;
    }

    setOlder({ ...walk, user, busy: true });
    void (async () => {
      try {
        // Budgeted at the composition edge, like every read in this file.
        const page = await weightBudget.tryRun("userNonFundingLedgerUpdates", () =>
          fetchLedgerPage({
            probe: getInfoClient() as unknown as LedgerProbe,
            user,
            startTime: window.startTime,
            // Inclusive bound at the seed's oldest row; the overlap row dedupes
            // through `ledgerKey` inside `mergeLedger`.
            endTime: window.endTime,
          })
        );
        if (page === null) {
          // Deferred by the budget — retryable, not done.
          setOlder({ ...walk, user, busy: false });
          return;
        }
        const merged = mergeLedger(walk.rows, page.rows);
        setOlder({
          user,
          rows: merged,
          cursor: page.nextStartTime ?? walk.cursor,
          // A short page means everything up to the seed is now held.
          //
          // The second clause is the termination guard for the cursor's
          // boundary-millisecond overlap: `nextStartTime` re-reads the last
          // row's own timestamp rather than skipping past it (so rows sharing
          // that millisecond are not silently dropped), which means a page can
          // legitimately return rows already held. If a whole page dedupes
          // away, the walk is not advancing and must stop rather than fetch
          // the same page forever.
          done: !page.hasMore || merged.length === walk.rows.length,
          busy: false,
        });
      } catch (error) {
        logger.warn("ledger.load_older_failed", { error });
        setOlder({ ...walk, user, busy: false });
      }
    })();
  }, [user, base.state, walk]);

  const state: Fetched<LedgerView> =
    base.state.kind === "ready"
      ? {
          kind: "ready",
          value: {
            rows: mergeLedger(walk.rows, base.state.value.rows),
            hasMore: base.state.value.hasMore && !walk.done,
          },
        }
      : base.state;

  return { state, refresh: base.refresh, loadOlder, isLoadingOlder: walk.busy };
}

/** Filled and cancelled orders, grouped into one row per order. */
export interface OrderHistoryView {
  orders: readonly OrderLifecycle[];
  /** Older history is UNREACHABLE past this — there is no cursor. */
  truncated: boolean;
}

export function useOrderHistory(user: Hex | null): {
  state: Fetched<OrderHistoryView>;
  refresh: () => void;
} {
  return useFetch(user, "historicalOrders", async (address) => {
    const history = await fetchOrderHistory({
      probe: getInfoClient() as unknown as OrderHistoryProbe,
      user: address,
    });
    return { orders: history.orders, truncated: history.truncated };
  });
}

/** One TWAP as history reports it. */
export interface TwapRow {
  time: number;
  /** `null` when the row's state could not be parsed. */
  state: TwapState | null;
  /** e.g. `"activated"`, `"finished"`, `"terminated"`. Rendered verbatim. */
  status: string;
}

/**
 * TWAP history, newest first.
 *
 * **Not joinable to a live TWAP.** `history/twap.ts` measured `twapId` absent
 * from every one of 12,806 history rows, so this cannot be merged with the
 * `userTwapSliceFills` feed by id — it is a separate list, presented as one.
 */
/**
 * A budget that admits everything, for reads that are ALREADY inside a
 * `weightBudget.tryRun` — the real accounting happened one frame up, and a
 * second pass would charge the same request twice.
 */
const PASSTHROUGH_BUDGET = {
  tryRun: async <T>(_request: string, fn: () => Promise<T>): Promise<T | null> => fn(),
} as unknown as typeof weightBudget;

/**
 * The account's current fee rates and 14-day volume.
 *
 * Unlike the other reads here, this one goes through `fetchUserFees` — which
 * budgets internally — so the `read` callback must NOT be wrapped in the
 * budget a second time. `useFetch` cannot know that, so this hook maps the
 * `MetaResult` itself and hands `useFetch` a read that never double-charges:
 * `fetchUserFees` is passed a no-op budget and the REAL budget is the one
 * `useFetch` applies. One charge, one code path for caching and states.
 */
export function useFeeRates(user: Hex | null): {
  state: Fetched<UserFeeRates>;
  refresh: () => void;
} {
  return useFetch(user, "userFees", async (address) => {
    const result = await fetchUserFees({
      probe: getInfoClient() as unknown as MetaProbe,
      user: address,
      // `useFetch` already ran `weightBudget.tryRun` around this callback;
      // letting `fetchUserFees` budget too would charge 20 weight twice.
      budget: PASSTHROUGH_BUDGET,
    });
    if (result.value === null) {
      // Only reachable if the inner call itself failed — surface as an error,
      // not as an empty fee sheet.
      throw new Error("userFees returned nothing");
    }
    return result.value;
  });
}

/**
 * The whole fill history, for activity stats that can honestly say "all
 * history" instead of "over your last N fills".
 *
 * Budget arithmetic: `useFetch` charges one `userFillsByTime` for the read,
 * which covers the walk's FIRST page; `fetchFillHistory` budgets per page, so
 * it gets a budget that admits the first call free and sends every later page
 * through the real budget. One charge per actual request, no double-count.
 */
export function useFillHistory(user: Hex | null): {
  state: Fetched<FillHistory>;
  refresh: () => void;
} {
  return useFetch(user, "userFillsByTime", async (address) => {
    let first = true;
    const pagedBudget = {
      tryRun: async <T>(
        request: string,
        fn: () => Promise<T>,
        opts?: { now?: () => number }
      ): Promise<T | null> => {
        if (first) {
          first = false;
          return fn();
        }
        return weightBudget.tryRun(request as WeightedRequest, fn, opts);
      },
    } as unknown as typeof weightBudget;
    return fetchFillHistory({
      probe: getInfoClient() as unknown as FillHistoryProbe,
      user: address,
      budget: pagedBudget,
    });
  });
}

/**
 * The user's vault positions, for the equity breakdown.
 *
 * `fetchVaultPositions` budgets internally, so it gets the no-op budget and
 * `useFetch` applies the real one — the same single-charge arrangement as
 * `useFeeRates`. `[]` is the endpoint's genuine "has none" (it never answers
 * `null` for that), so an empty array flows through as a ready value.
 */
export function useVaultEquity(user: Hex | null): {
  state: Fetched<readonly VaultPosition[]>;
  refresh: () => void;
} {
  return useFetch(user, "userVaultEquities", async (address) => {
    const result = await fetchVaultPositions({
      probe: getInfoClient() as unknown as VaultEquitiesProbe,
      user: address,
      budget: PASSTHROUGH_BUDGET,
    });
    if (result.value === null) {
      // Unreachable with the passthrough budget — kept as a loud failure
      // rather than a silent empty portfolio if that ever changes.
      throw new Error("userVaultEquities returned nothing");
    }
    return result.value;
  });
}

/**
 * The account's staking position. Same single-charge arrangement as
 * `useFeeRates`: the fetcher budgets internally, so it gets the no-op budget
 * and `useFetch` applies the real one.
 */
export function useStaking(user: Hex | null): {
  state: Fetched<DelegatorSummary>;
  refresh: () => void;
} {
  return useFetch(user, "delegatorSummary", async (address) => {
    const result = await fetchDelegatorSummary({
      probe: getInfoClient() as unknown as MetaProbe,
      user: address,
      budget: PASSTHROUGH_BUDGET,
    });
    if (result.value === null) {
      throw new Error("delegatorSummary returned nothing");
    }
    return result.value;
  });
}

/** How far back the funding tab reads. Funding ticks hourly, so 30 days ≈ 720 rows max. */
const FUNDING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const FUNDING_WINDOW_STEP_MS = FUNDING_WINDOW_MS;

/**
 * Funding payments over the last 30 days, newest first.
 *
 * Calls the probe directly rather than `fetchUserFunding`: that helper applies
 * the weight budget itself, and `useFetch` already wraps the read in
 * `weightBudget.tryRun` — going through both would charge the 20-weight call
 * twice for one request.
 *
 * The `usdc` sign is the account's cash delta — negative paid, positive
 * received — verified by exact reconciliation against `cumFunding` (see
 * `FundingLedgerRow`), which is what lets the UI put words on it.
 */
export function useFunding(user: Hex | null): {
  state: Fetched<readonly FundingLedgerRow[]>;
  refresh: () => void;
  /** Widen the window by another 30 days and refetch. */
  loadOlder: () => void;
  /** The current window, for the "last N days" notice. */
  windowDays: number;
} {
  // A ref, not state, for the value the READ closes over: `useFetch` captures
  // its read callback once per (user, request) — a later render's closure is
  // never seen — so the read must consult something stable. The state mirror
  // exists only so the notice label re-renders.
  const windowRef = useRef(FUNDING_WINDOW_MS);
  const [windowDays, setWindowDays] = useState(FUNDING_WINDOW_MS / (24 * 60 * 60 * 1000));

  const fetched = useFetch<readonly FundingLedgerRow[]>(user, "userFunding", async (address) => {
    const raw = await (getInfoClient() as unknown as MetaProbe).userFunding({
      user: address,
      startTime: Date.now() - windowRef.current,
    });
    if (!Array.isArray(raw)) return [];
    return raw.map(parseFundingRow).sort((a, b) => b.time - a.time);
  });

  const loadOlder = useCallback(() => {
    windowRef.current += FUNDING_WINDOW_STEP_MS;
    setWindowDays(windowRef.current / (24 * 60 * 60 * 1000));
    fetched.refresh();
  }, [fetched]);

  return { state: fetched.state, refresh: fetched.refresh, loadOlder, windowDays };
}

export function useTwapHistory(user: Hex | null): {
  state: Fetched<readonly TwapRow[]>;
  refresh: () => void;
} {
  return useFetch(user, "twapHistory", async (address) => {
    const rows = await fetchTwapHistory({
      probe: getInfoClient() as unknown as TwapHistoryProbe,
      user: address,
    });
    return [...rows].sort((a, b) => b.time - a.time);
  });
}
