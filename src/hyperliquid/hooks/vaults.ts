/**
 * Vault hooks — the composition edge for the Vaults screens.
 *
 * Three reads with three different economics, and the hooks keep them apart:
 *
 * - **The directory** is a CDN blob priced in bandwidth (14.2 MB mainnet /
 *   2.7 MB testnet, un-gzipped), not request weight. It lives in a module
 *   store so its TTL gates *refetching*, never *rendering* — the last
 *   snapshot stays up with an age while a refresh runs, and a failed refresh
 *   never blanks a working list. One in-flight download is shared by every
 *   consumer; an env switch aborts it, an unmount deliberately does not
 *   (cancelling a 90%-done download to redo it later is the worst cellular
 *   outcome). It is fetched on first FOCUS, never at app start.
 * - **The detail** costs 60 weight and the server throttles it at about one
 *   call per second — retrying inside the penalty prolongs it, so a deferral
 *   renders a Retry button and nothing ever retries on a timer. "Not a
 *   vault" is a `null` FACT worth caching, so the cached value is a wrapper.
 * - **Positions** are `useVaultEquity`, reused as-is (weight 20); the join to
 *   directory names is garnish that never blocks them.
 *
 * Transfers are AGENT-signed (`session.exchangeClient()`, proven by a live $5
 * probe) — the opposite of withdrawals, whose master-signature requirement is
 * documented in `hooks/withdraw.ts`.
 */

import { useCallback, useEffect, useState } from "react";
import { useFocusEffect } from "expo-router";

import { getInfoClient } from "@/hyperliquid/api/clients";
import { restCache, restCacheKey, readThrough } from "@/hyperliquid/api/restCache";
import { toHlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { hlConfig } from "@/hyperliquid/config/env";
import { useAccountSummary } from "@/hyperliquid/hooks/account";
import { useVaultEquity, type Fetched } from "@/hyperliquid/hooks/history";
import { useQuoteBasis } from "@/hyperliquid/hooks/quoteBasis";
import { useSessionAddress, useSessionState } from "@/hyperliquid/hooks/session";
import { useStoreValue } from "@/hyperliquid/hooks/useStore";
import { VaultDirectoryStore } from "@/hyperliquid/state/vaultDirectory";
import { canonicalAmount, toMicroUsd } from "@/hyperliquid/transfers/amount";
import type { HyperliquidSession } from "@/hyperliquid/session";
import type { Fill, HlEnv, Hex, OpenOrderRow } from "@/hyperliquid/types/domain";
import type { WireAmount } from "@/hyperliquid/transfers/types";
import {
  buildVaultDirectory,
  joinPositionNames,
  type NamedVaultPosition,
} from "@/hyperliquid/vaults/directory";
import { fetchFillsPage, fetchOpenOrders, fetchTwapSliceFills } from "@/hyperliquid/api/account";
import { fetchUserFunding, type FundingLedgerRow } from "@/hyperliquid/api/accountMeta";
import { fetchLedgerPage, type LedgerRow } from "@/hyperliquid/history/ledger";
import { fetchOrderHistory, type OrderLifecycle } from "@/hyperliquid/history/orders";
import { fetchTwapHistory } from "@/hyperliquid/history/twap";
import type { TwapView } from "@/components/vaults/feedFilters";
import { weightBudget } from "@/hyperliquid/api/weightBudget";
import { fanOutFamily, type ActivityKind, type Sourced } from "@/hyperliquid/vaults/activity";
import { fetchVaultDetails, type VaultDetailsProbe } from "@/hyperliquid/vaults/details";
import {
  aggregateFamily,
  familyAccountValue,
  familyAddresses,
  fetchFamily,
  type FamilyPosition,
  type FamilyMember,
  type FamilyProbe,
} from "@/hyperliquid/vaults/family";
import { positionIn } from "@/hyperliquid/vaults/equities";
import { fetchVaultList, normaliseVaultName } from "@/hyperliquid/vaults/list";
import {
  buildDepositQuote,
  buildWithdrawQuote,
  confirmVaultTransfer,
  type VaultEcho,
  type VaultQuote,
} from "@/hyperliquid/vaults/preflight";
import {
  depositToVault,
  MIN_VAULT_DEPOSIT_USDC,
  withdrawFromVault,
  type VaultTransferClient,
} from "@/hyperliquid/vaults/transfer";
import type {
  FollowerRow,
  VaultDetail,
  VaultPosition,
  VaultSummary,
} from "@/hyperliquid/vaults/types";

const logger = log.child("hooks.vaults");

/**
 * How long a directory snapshot satisfies a focus before a refetch.
 *
 * Priced in bandwidth, not freshness: the row set churns over hours and
 * TVL/APR on a list row are display-grade, so the TTL's job is to bound a
 * browsing session to roughly one download.
 */
export const VAULT_LIST_TTL_MS = 15 * 60_000;

/** Pull-to-refresh floor — a refresh inside this window is a no-op. */
export const VAULT_LIST_REFRESH_FLOOR_MS = 30_000;

/**
 * How long the directory download may run before it is abandoned.
 *
 * The single-flight latch is what makes this necessary: while `inFlightList`
 * is set, every later caller returns that same promise instead of starting its
 * own. That is right for a 14 MB CDN blob — and it means a download that never
 * settles wedges the vault list for the WHOLE SESSION, with no retry path and
 * a spinner that never stops, because nothing else ever clears the latch.
 *
 * Generous rather than tight: this really can be a slow, large transfer on a
 * poor connection, and aborting a download that would have finished is its own
 * failure. The bound exists to guarantee the latch always clears, not to
 * police throughput.
 */
export const VAULT_LIST_STALL_MS = 60_000;

/** Matches `REST_CACHE_TTL_MS` deliberately: same remount-refetch failure. */
export const VAULT_DETAIL_TTL_MS = 60_000;

/** The measured ~1 call/second server throttle, with margin. */
export const VAULT_DETAIL_MIN_GAP_MS = 1_100;

/** Shared across screens — the directory is the exchange's, not an account's. */
export const vaultDirectory = new VaultDirectoryStore();

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

let inFlightList: { env: HlEnv; controller: AbortController; promise: Promise<void> } | null = null;

/** Read through a call so TS does not narrow the module `let` inside closures. */
function currentListFlight(): typeof inFlightList {
  return inFlightList;
}

/** Single-flight download coordinator. See the module header for the rules. */
async function ensureDirectory(env: HlEnv, force: boolean): Promise<void> {
  const held = vaultDirectory.read();
  const now = Date.now();
  if (held?.env === env) {
    const age = now - held.fetchedAtMs;
    if (!force && age < VAULT_LIST_TTL_MS) return;
    if (force && age < VAULT_LIST_REFRESH_FLOOR_MS) return;
  }
  if (inFlightList !== null) {
    if (inFlightList.env === env) return inFlightList.promise;
    // An env switch is the one thing that aborts: the old download's bytes
    // can never be rendered under the new network's header.
    inFlightList.controller.abort();
    inFlightList = null;
  }

  const controller = new AbortController();
  // Abandon a download that never settles, so the latch below cannot hold the
  // vault list hostage for the rest of the session. Cleared in `finally`
  // whatever happens, including the abort path.
  let stall: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    stall = null;
    logger.warn("vaults.list_stalled", { context: { env, afterMs: VAULT_LIST_STALL_MS } });
    controller.abort();
  }, VAULT_LIST_STALL_MS);
  const promise = (async () => {
    vaultDirectory.setFetchState({ isFetching: true, lastFailure: null });
    try {
      const all = await fetchVaultList({ env, signal: controller.signal });
      vaultDirectory.set(buildVaultDirectory(env, all, Date.now()));
      vaultDirectory.setFetchState({ isFetching: false, lastFailure: null });
    } catch (caught) {
      if (controller.signal.aborted) {
        // Two ways to land here. An env switch is not a failure — the bytes
        // were simply for the wrong network. A STALL is: recording it is what
        // lets the screen offer a retry rather than showing an empty list as
        // though the directory were genuinely empty. `stall === null` means the
        // timer is the one that fired.
        const stalled = stall === null;
        vaultDirectory.setFetchState({
          isFetching: false,
          lastFailure: stalled
            ? { env, message: "The vault list took too long to load.", atMs: Date.now() }
            : null,
        });
        return;
      }
      const error = toHlError(caught);
      logger.warn("vaults.list_failed", { error, context: { env } });
      vaultDirectory.setFetchState({
        isFetching: false,
        lastFailure: { env, message: error.message, atMs: Date.now() },
      });
    } finally {
      if (stall !== null) clearTimeout(stall);
      if (currentListFlight()?.controller === controller) inFlightList = null;
    }
  })();
  inFlightList = { env, controller, promise };
  return promise;
}

/**
 * `useFocusEffect` comes straight from React Navigation rather than from
 * the router.
 *
 * This is a headless-module file; the router is the UI layer's navigator,
 * and a hook that only asks "is my screen focused?" does not need it. It used
 * to be a lazy `require` because expo-router dragged in `standard-navigation`,
 * whose untranspiled ESM Jest could not load — `@react-navigation/*` is
 * allowlisted in `transformIgnorePatterns`, so a plain import is fine now.
 */

export interface VaultList {
  /** `dir.top` when the snapshot matches the env. Never `idle` or `deferred`. */
  state: Fetched<readonly VaultSummary[]>;
  /** Pull-to-refresh. Joins an in-flight download; floored at 30 s. */
  refresh: () => void;
  /** When the rendered snapshot was fetched. `null` before the first one. */
  fetchedAtMs: number | null;
  /** A refresh that failed while an older snapshot is still shown. */
  lastError: string | null;
}

/** The directory's rendered slice. Kicks the download on first focus. */
export function useVaultList(env: HlEnv = hlConfig.env): VaultList {
  const directory = useStoreValue(vaultDirectory, (store) => store.read());
  const fetchState = useStoreValue(vaultDirectory, (store) => store.fetchState());

  useFocusEffect(
    useCallback(() => {
      void ensureDirectory(env, false);
      return undefined;
    }, [env])
  );

  const matches = directory?.env === env;
  const failure = fetchState.lastFailure?.env === env ? fetchState.lastFailure : null;
  const state: Fetched<readonly VaultSummary[]> = matches
    ? { kind: "ready", value: directory.top }
    : failure !== null
      ? { kind: "error", message: failure.message }
      : { kind: "loading" };

  return {
    state,
    refresh: useCallback(() => void ensureDirectory(env, true), [env]),
    fetchedAtMs: matches ? directory.fetchedAtMs : null,
    lastError: matches && failure !== null ? failure.message : null,
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

/**
 * The cached shape. A wrapper, because `restCache` never stores bare `null`
 * (that spelling means "budget declined" and is deliberately uncacheable) —
 * while "this address is not a vault" is a fact worth 60 weight exactly once.
 */
interface DetailWrapper {
  detail: VaultDetail | null;
}

/** The last time a `vaultDetails` request actually left the app. */
let lastDetailSentAtMs = 0;

function detailScope(env: HlEnv, address: string, user: Hex | null): string {
  return `${env}:${address}:${user ?? "anon"}`;
}

/**
 * One vault's detail, cached and throttle-aware.
 *
 * `ready(null)` means the address is NOT a vault — a fact, distinct from
 * `deferred` (budget declined; Retry button) and `error` (transport). The
 * gap gate serialises stacked detail screens against the measured server
 * throttle; it delays once, it never retries.
 */
export function useVaultDetail(
  address: Hex | null,
  user: Hex | null,
  env: HlEnv = hlConfig.env
): { state: Fetched<VaultDetail | null>; refresh: () => void } {
  const key =
    address === null ? null : restCacheKey("vaultDetails", detailScope(env, address, user));

  const [entry, setEntry] = useState<{ key: string | null; state: Fetched<VaultDetail | null> }>(
    () => {
      if (key === null) return { key: null, state: { kind: "idle" } };
      const hit = restCache.read<DetailWrapper>(key, Date.now(), VAULT_DETAIL_TTL_MS);
      return hit === undefined
        ? { key: null, state: { kind: "idle" } }
        : { key, state: { kind: "ready", value: hit.detail } };
    }
  );

  const state: Fetched<VaultDetail | null> =
    key === null ? { kind: "idle" } : entry.key === key ? entry.state : { kind: "loading" };

  const run = useCallback(
    async (force: boolean) => {
      if (key === null || address === null) return;
      try {
        const { value } = await readThrough<DetailWrapper>({
          key,
          ttlMs: force ? 0 : VAULT_DETAIL_TTL_MS,
          now: Date.now(),
          fetch: async () => {
            // The gap gate: wait out the remainder of the server's window
            // once, then send. A delay, never a retry loop.
            const wait = lastDetailSentAtMs + VAULT_DETAIL_MIN_GAP_MS - Date.now();
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
            lastDetailSentAtMs = Date.now();
            const result = await fetchVaultDetails({
              probe: getInfoClient() as unknown as VaultDetailsProbe,
              vaultAddress: address,
              ...(user === null ? {} : { user }),
            });
            if (result.deferred) return null;
            return { detail: result.value };
          },
        });
        setEntry({
          key,
          state: value === null ? { kind: "deferred" } : { kind: "ready", value: value.detail },
        });
        if (value?.detail) {
          // Teach the directory this vault's name: a HELD vault can be absent
          // from the CDN list (measured: testnet HLP), and this names its
          // position row permanently, for free.
          vaultDirectory.upsertIndex(address, {
            name: value.detail.name,
            isClosed: value.detail.isClosed,
          });
        }
      } catch (caught) {
        const error = toHlError(caught);
        logger.warn("vaults.detail_failed", { error });
        setEntry({ key, state: { kind: "error", message: error.message } });
      }
    },
    // `user` is inside `key`; `address` rides for the closure.

    [key, address, user]
  );

  useEffect(() => {
    if (key === null) return;
    const timer = setTimeout(() => void run(false), 0);
    return () => clearTimeout(timer);
  }, [key, run]);

  return { state, refresh: useCallback(() => void run(true), [run]) };
}

/**
 * Forget a vault's cached detail — both the anonymous and the user-scoped
 * variants. Called after a transfer settles (or lands `unknown`): the lockup
 * and followerState changed server-side, and the next mount must re-read
 * rather than replay a snapshot from before the money moved.
 */
export function invalidateVaultDetail(env: HlEnv, address: string): void {
  restCache.invalidate(`vaultDetails:${env}:${address.toLowerCase()}`);
}

// ---------------------------------------------------------------------------
// Positions, named
// ---------------------------------------------------------------------------

/**
 * The user's positions joined to directory names.
 *
 * `now` comes from the caller — screens hold a ticking clock for the lockup
 * countdowns, and deriving `Date.now()` here would be an impure render read
 * for React Compiler to freeze.
 */
export function useNamedVaultPositions(
  user: Hex | null,
  now: number
): { state: Fetched<readonly NamedVaultPosition[]>; refresh: () => void } {
  const equity = useVaultEquity(user);
  const directory = useStoreValue(vaultDirectory, (store) => store.read());

  const state: Fetched<readonly NamedVaultPosition[]> =
    equity.state.kind === "ready"
      ? {
          kind: "ready",
          value: joinPositionNames(equity.state.value, directory?.index ?? null, now),
        }
      : equity.state;

  return { state, refresh: equity.refresh };
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

export interface VaultTransferParams {
  kind: "deposit" | "withdraw";
  /**
   * Detail-grade facts — `allowDeposits`/`alwaysCloseOnWithdraw` exist only on
   * `VaultDetail`. `null` (detail still loading) means no quote yet; the sheet
   * launches from the detail screen, which has already paid the 60.
   */
  vault: VaultDetail | null;
  /** Raw field text. */
  amount: string;
}

export type VaultTransferPhase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; note: string }
  /** Nothing moved — a corrected re-attempt is legitimate. */
  | { kind: "rejected"; message: string }
  /** May have landed. NO retry, ever — a resend is a second transfer. */
  | { kind: "unknown"; message: string };

export interface UseVaultTransfer {
  quote: VaultQuote | null;
  phase: VaultTransferPhase;
  /** This vault's equities row — the withdraw max and re-lock disclosure. */
  position: VaultPosition | null;
  /** The server's `withdrawable` — the deposit max. `null` before a frame. */
  available: string | null;
  submit: (echo: Omit<VaultEcho, "acknowledged">) => Promise<void>;
  reset: () => void;
  /**
   * Restamp the quote's TTL. Call it on an amount edit and when the sheet
   * opens — see `useQuoteBasis` for what freezes without it.
   */
  refreshQuote: () => void;
}

/**
 * Quote a vault transfer from real facts, or refuse with `null`.
 *
 * The null gates are correctness rules, not conveniences: a deposit quoted
 * while equities are merely deferred would pass `existingPosition: null` and
 * show the friendly first-deposit disclosure on what is actually a
 * whole-balance re-lock. Exported for Jest — the substance of the hook.
 */
export function buildVaultTransferQuote(args: {
  kind: "deposit" | "withdraw";
  vault: VaultDetail | null;
  amount: string;
  available: string | null;
  positions: Fetched<readonly VaultPosition[]>;
  /** The directory's collision groups, or `null` before it loads. */
  collisions: ReadonlyMap<string, readonly VaultSummary[]> | null;
  /** The sub-account being acted as, or `null` for the main account. */
  actingSubAccount: string | null;
  /**
   * The instant to stamp the quote's TTL against. REQUIRED, and a value rather
   * than a clock read inside: the compiler memoises this call against what it
   * can see it read, and a `Date.now()` in the builder is invisible to it. See
   * `hooks/quoteBasis.ts` — the withdrawal quote froze the same way.
   */
  basisMs: number;
}): VaultQuote | null {
  const vault = args.vault;
  if (vault === null) return null;
  if (args.positions.kind !== "ready") return null;

  let amount: WireAmount;
  try {
    amount = canonicalAmount(args.amount);
  } catch {
    return null;
  }

  const position = positionIn(args.positions.value, vault.address);

  if (args.kind === "deposit") {
    if (args.available === null) return null;
    let available: WireAmount;
    try {
      available = canonicalAmount(args.available);
    } catch {
      return null;
    }
    return buildDepositQuote({
      now: () => args.basisMs,
      vault: {
        address: vault.address,
        name: vault.name,
        isClosed: vault.isClosed,
        allowDeposits: vault.allowDeposits,
      },
      amount,
      available,
      actingSubAccount: args.actingSubAccount,
      existingPosition: position
        ? { equity: position.equity, lockedUntilMs: position.lockedUntilMs }
        : null,
      // Omitted (not empty) when the directory has not loaded: an empty list
      // would claim "checked, no collisions" — `name_not_checked` is honest.
      ...(args.collisions === null
        ? {}
        : { known: args.collisions.get(normaliseVaultName(vault.name)) ?? [] }),
      minimumDeposit: MIN_VAULT_DEPOSIT_USDC,
    });
  }

  if (position === null) return null;
  return buildWithdrawQuote({
    now: () => args.basisMs,
    vault: {
      address: vault.address,
      name: vault.name,
      alwaysCloseOnWithdraw: vault.alwaysCloseOnWithdraw,
    },
    amount,
    actingSubAccount: args.actingSubAccount,
    position: { equity: position.equity, lockedUntilMs: position.lockedUntilMs },
  });
}

export function useVaultTransfer(
  session: HyperliquidSession,
  params: VaultTransferParams
): UseVaultTransfer {
  const [phase, setPhase] = useState<VaultTransferPhase>({ kind: "idle" });

  const sessionState = useSessionState(session);
  const env = sessionState?.config.env ?? hlConfig.env;
  const address = useSessionAddress(session);
  const summary = useAccountSummary(session.stores.account);
  const equities = useVaultEquity(address);
  const directory = useStoreValue(vaultDirectory, (store) => store.read());

  const available = summary?.withdrawable ?? null;
  const { basisMs, refresh } = useQuoteBasis();
  const quote = buildVaultTransferQuote({
    basisMs,
    kind: params.kind,
    vault: params.vault,
    amount: params.amount,
    available,
    positions: equities.state,
    collisions: directory?.env === env ? directory.collisions : null,
    // From the SESSION, not the screen: a vault transfer is signed on behalf
    // of the master whatever the screen shows, so this is the one value that
    // decides whether the quote can be trusted at all.
    actingSubAccount: sessionState?.identity.subAccount ?? null,
  });
  const position =
    equities.state.kind === "ready" && params.vault !== null
      ? positionIn(equities.state.value, params.vault.address)
      : null;

  const refreshAfterOutcome = useCallback(
    (vaultAddress: string) => {
      // The remedy for BOTH settled and unknown is a re-read, never a resend:
      // equities (20 weight) carry the two facts that changed — equity and
      // lockedUntil — and the detail cache is invalidated rather than
      // refetched, so the next mount pays the 60 only if it happens.
      // Invalidate rather than refresh THIS instance: the screen mounts three
      // readers of the same equity (the position row and both transfer sheets),
      // and refreshing one left the other two rendering pre-transfer equity and
      // an expired lockup — with the withdraw quote built from it. Every reader
      // of the key now wakes, and `readThrough` collapses them to one request.
      restCache.invalidate("userVaultEquities");
      invalidateVaultDetail(env, vaultAddress);
      restCache.invalidate("userNonFundingLedgerUpdates");
    },
    [env]
  );

  const submit = useCallback(
    async (echo: Omit<VaultEcho, "acknowledged">): Promise<void> => {
      if (quote === null || params.vault === null) return;
      setPhase({ kind: "sending" });
      try {
        // Throws unless every displayed value matches — the reason the sheet
        // must render the checksummed address and the verbatim name.
        const ticket = confirmVaultTransfer(quote, {
          ...echo,
          acknowledged: quote.warnings.map((warning) => warning.code),
        });

        // AGENT-signed — settled by the live $5 probe. No wallet prompt.
        const client = session.exchangeClient() as unknown as VaultTransferClient;
        const usd = toMicroUsd(ticket.quote.amount);

        const outcome =
          quote.kind === "deposit"
            ? await depositToVault({ signer: "agent", client, vault: quote.vault.wire, usd })
            : await withdrawFromVault({
                signer: "agent",
                client,
                vault: quote.vault.wire,
                usd,
                lockup: quote.lockup,
              });

        if (outcome.kind === "settled") {
          setPhase({
            kind: "sent",
            note:
              quote.kind === "deposit"
                ? "Deposited. The whole vault balance is now locked — up to 24 h, 96 h for HLP."
                : "Withdrawal submitted. The credited amount is an estimate until it settles.",
          });
          refreshAfterOutcome(params.vault.address);
          return;
        }
        if (outcome.kind === "rejected_locally") {
          setPhase({ kind: "rejected", message: outcome.error.message });
          return;
        }
        if (outcome.kind === "rejected_by_server") {
          setPhase({ kind: "rejected", message: outcome.reason });
          return;
        }
        setPhase({ kind: "unknown", message: outcome.error.message });
        refreshAfterOutcome(params.vault.address);
      } catch (caught) {
        // Reached only before the wire — a refused confirmation or a missing
        // agent. Nothing moved.
        const error = toHlError(caught);
        logger.warn("vaults.transfer_failed", { error });
        setPhase({ kind: "rejected", message: error.message });
      }
    },
    [quote, params.vault, session, refreshAfterOutcome]
  );

  return {
    quote,
    phase,
    position,
    available,
    submit,
    reset: useCallback(() => setPhase({ kind: "idle" }), []),
    refreshQuote: refresh,
  };
}

// ---------------------------------------------------------------------------
// Family positions
// ---------------------------------------------------------------------------

/**
 * How long a family book stays fresh. Shorter than the detail's 60 s because
 * positions move continuously while a description does not — and at 2 weight
 * per member the refresh is cheap enough to mean it.
 */
export const VAULT_FAMILY_TTL_MS = 30_000;

export interface VaultFamilyView {
  positions: readonly FamilyPosition[];
  /** Sum of every member's account value — the family's money on the books. */
  accountValue: string;
  /** Members whose read was declined; non-empty means the book is partial. */
  missing: readonly Hex[];
  /** The members actually read — 1 for a plain vault, 8 for mainnet HLP. */
  members: readonly FamilyMember[];
}

/**
 * The vault family's book.
 *
 * Runs only once the DETAIL has landed, because the child addresses come from
 * `relationship` — a parent read alone reports an empty book (measured on HLP,
 * where all 175 coins live in the children). Costs `2 × members`: 2 for a plain
 * vault, 16 for HLP.
 */
export function useVaultFamily(
  detail: VaultDetail | null,
  env: HlEnv = hlConfig.env
): { state: Fetched<VaultFamilyView>; refresh: () => void } {
  const address = detail?.address ?? null;
  const key = address === null ? null : restCacheKey("vaultFamily", `${env}:${address}`);

  const [entry, setEntry] = useState<{ key: string | null; state: Fetched<VaultFamilyView> }>({
    key: null,
    state: { kind: "idle" },
  });

  const state: Fetched<VaultFamilyView> =
    key === null ? { kind: "idle" } : entry.key === key ? entry.state : { kind: "loading" };

  const run = useCallback(
    async (force: boolean) => {
      if (key === null || detail === null) return;
      try {
        const { value } = await readThrough<VaultFamilyView>({
          key,
          ttlMs: force ? 0 : VAULT_FAMILY_TTL_MS,
          now: Date.now(),
          fetch: async () => {
            const addresses = familyAddresses(detail);
            const { members, missing } = await fetchFamily({
              probe: getInfoClient() as unknown as FamilyProbe,
              addresses,
            });
            // Every member declined: that is a deferral, not an empty vault.
            // `readThrough` reads `null` as "do not cache", which is right —
            // the next mount must ask again rather than replay a blank book.
            if (members.length === 0 && missing.length > 0) return null;
            return {
              positions: aggregateFamily(members),
              accountValue: familyAccountValue(members),
              missing,
              members,
            };
          },
        });
        setEntry({ key, state: value === null ? { kind: "deferred" } : { kind: "ready", value } });
      } catch (caught) {
        const error = toHlError(caught);
        logger.warn("vaults.family_failed", { error });
        setEntry({ key, state: { kind: "error", message: error.message } });
      }
    },
    [key, detail]
  );

  useEffect(() => {
    if (key === null) return;
    const timer = setTimeout(() => void run(false), 0);
    return () => clearTimeout(timer);
  }, [key, run]);

  return { state, refresh: useCallback(() => void run(true), [run]) };
}

// ---------------------------------------------------------------------------
// Family activity feeds
// ---------------------------------------------------------------------------

/** Feeds are volatile; a tab reopened inside this window does not re-spend. */
export const VAULT_ACTIVITY_TTL_MS = 45_000;

/** One family member's cash position, derived from the family snapshot. */
export interface VaultBalanceRow {
  address: Hex;
  accountValue: string;
  withdrawable: string;
  positions: number;
}

/**
 * The selected feed's rows, typed per kind.
 *
 * A union rather than a normalised row: each feed has genuinely different
 * fields, and flattening them here would move formatting decisions out of the
 * display layer and into the fetch.
 */
export type VaultActivityRows =
  | { kind: "balances"; rows: readonly VaultBalanceRow[] }
  | { kind: "positions"; rows: readonly FamilyPosition[] }
  | { kind: "depositors"; rows: readonly FollowerRow[] }
  | { kind: "openOrders"; rows: readonly Sourced<OpenOrderRow>[] }
  | { kind: "trades"; rows: readonly Sourced<Fill>[] }
  | { kind: "funding"; rows: readonly Sourced<FundingLedgerRow>[] }
  | { kind: "orderHistory"; rows: readonly Sourced<OrderLifecycle>[] }
  | { kind: "twap"; rows: readonly Sourced<VaultTwapRow>[] }
  | { kind: "ledger"; rows: readonly Sourced<LedgerRow>[] };

/** One TWAP row, from either the order history or the slice fills. */
export interface VaultTwapRow {
  time: number;
  status: string;
  coin: string;
  /** Absent on a slice-fill row, which has no parent order state attached. */
  size: string | null;
  executedSize: string | null;
  executedNotional: string | null;
  durationMinutes: number | null;
  reduceOnly: boolean | null;
  isBuy: boolean | null;
}

/**
 * The feeds `readActivity` actually time-bounds.
 *
 * Everything else calls its probe with no `startTime`, so the History window is
 * inert for them — and must not appear in their cache key, or a control that
 * cannot change their answer still pays to re-fetch it.
 */
export const WINDOWED_KINDS: ReadonlySet<string> = new Set(["trades", "funding", "ledger"]);

/**
 * The cache identity of one family activity feed.
 *
 * Extracted so the window rule is testable: it decides whether a control
 * respends the family's request weight, and on mainnet HLP that is 320 per
 * toggle. Window and aggregation ARE part of a feed's identity — the same tab
 * at 30 days is a different answer from the same tab at 24 hours — but only
 * where the feed reads them. `readActivity` applies `since` to trades, funding
 * and ledger alone, so keying the other six on the window made an inert control
 * invalidate a perfectly good cache.
 */
export function activityCacheKey(
  env: HlEnv,
  address: string,
  kind: string,
  options: { windowMs: number; aggregate: boolean; twapView: string }
): string {
  const windowPart = WINDOWED_KINDS.has(kind) ? options.windowMs : "-";
  return restCacheKey(
    "vaultActivity",
    `${env}:${address}:${kind}:${windowPart}:${options.aggregate ? "agg" : "raw"}:${options.twapView}`
  );
}

export interface VaultActivityView {
  data: VaultActivityRows;
  /** Members whose page was declined — the feed is partial when non-empty. */
  missing: readonly Hex[];
  /**
   * True when at least one member returned a FULL page, so the exchange holds
   * more rows than are shown.
   *
   * Distinct from `missing`, which is "we could not read this member at all".
   * This is "we read it and there was more" — and it was being thrown away:
   * `fetchOpenOrders` reports `truncated`, the seed carried it, and this hook
   * dropped it on the floor while the card told the reader the feed was
   * complete. A vault with more open orders than one page silently showed a
   * subset as though it were everything.
   */
  truncated: boolean;
}

/**
 * One family activity feed, fetched ONLY when its tab is open.
 *
 * `kind: null` fetches nothing — the screen passes null until a tab is
 * selected, because every feed here is 20 weight per member (160 for HLP) and
 * loading seven of them on mount would spend most of the minute's allowance
 * before the user asked for anything.
 *
 * `balances` never fetches at all: it is derived from the family snapshot the
 * positions view already holds.
 */
export interface VaultActivityOptions {
  /** How far back the time-windowed feeds reach. */
  windowMs: number;
  /** Trades only: merge partial fills of one order at one instant. */
  aggregate: boolean;
  /**
   * TWAP only: which of the three sub-tabs.
   *
   * `fills` reads a DIFFERENT endpoint (`userTwapSliceFills`) — slice
   * executions appear in no other feed, so this is a real second request
   * rather than a filter over the same rows.
   */
  twapView: TwapView;
}

const DEFAULT_ACTIVITY_OPTIONS: VaultActivityOptions = {
  windowMs: 7 * 24 * 60 * 60 * 1000,
  aggregate: false,
  twapView: "active",
};

export function useVaultActivity(
  detail: VaultDetail | null,
  kind: ActivityKind | null,
  family: VaultFamilyView | null,
  env: HlEnv = hlConfig.env,
  options: VaultActivityOptions = DEFAULT_ACTIVITY_OPTIONS
): { state: Fetched<VaultActivityView>; refresh: () => void } {
  const address = detail?.address ?? null;
  // Window and aggregation are part of the IDENTITY of a cached feed: the
  // same tab at 30 days is a different answer from the same tab at 24 hours,
  // and reusing one for the other would silently show the wrong span.
  //
  // But only for the feeds that HAVE a span. `readActivity` applies
  // `since = now - windowMs` to `trades`, `funding` and `ledger` alone; the
  // others call their probes with no time bound at all. Keying those on the
  // window made a control that changes nothing about their result invalidate
  // their cache anyway — on mainnet HLP's 8 members, one toggle of the Open
  // Orders window respent `ACTIVITY_WEIGHT.openOrders` 40 x 8 = 320 weight to
  // fetch identical rows, and three taps is 960 of the enforced 1000 a minute.
  const key =
    address === null || kind === null ? null : activityCacheKey(env, address, kind, options);

  const [entry, setEntry] = useState<{ key: string | null; state: Fetched<VaultActivityView> }>({
    key: null,
    state: { kind: "idle" },
  });

  // Balances are synchronous from the family snapshot — no request, no state
  // machine, and no chance of a spinner for data already in memory.
  // Three feeds never fetch: two come off the family snapshot and one off the
  // `vaultDetails` call that filled the header. Resolving them synchronously
  // keeps a spinner off data that is already in memory.
  const derived: Fetched<VaultActivityView> | null =
    kind === "balances" && family !== null
      ? {
          kind: "ready",
          value: {
            data: { kind: "balances", rows: balanceRows(family) },
            missing: family.missing,
            // Synchronous, off the family snapshot already in memory — there
            // is no page to be truncated.
            truncated: false,
          },
        }
      : kind === "positions" && family !== null
        ? {
            kind: "ready",
            value: {
              data: { kind: "positions", rows: family.positions },
              missing: family.missing,
              truncated: false,
            },
          }
        : kind === "depositors" && detail !== null
          ? {
              kind: "ready",
              value: {
                data: { kind: "depositors", rows: detail.followers.rows },
                missing: [],
                // The follower page IS capped and the detail read says so —
                // this is the one derived feed that can be short.
                truncated: detail.followers.truncated,
              },
            }
          : null;

  const state: Fetched<VaultActivityView> =
    derived ??
    (key === null ? { kind: "idle" } : entry.key === key ? entry.state : { kind: "loading" });

  const run = useCallback(
    async (force: boolean) => {
      if (key === null || detail === null || kind === null || isDerived(kind)) return;
      try {
        const { value } = await readThrough<VaultActivityView>({
          key,
          ttlMs: force ? 0 : VAULT_ACTIVITY_TTL_MS,
          now: Date.now(),
          fetch: async () => {
            const view = await readActivity(detail, kind, options);
            // `null` is the contract `readThrough` uses for "the budget
            // declined" — it is the ONE value it refuses to cache, because
            // caching a deferral turns one into a minute of them.
            //
            // `readActivity` never returns null: `fanOutFamily` turns every
            // declined member into an entry in `missing` and hands back
            // `{rows: [], missing: [...]}`. So a fan-out where the budget
            // declined EVERY member was written to the cache as a legitimate
            // empty answer and held for the full TTL — the card showed
            // "8 strategies could not be read" over "nothing in the strategies
            // we could read", and backing out and returning replayed the same
            // empty view from cache instead of retrying.
            // Compared against the REAL member count, not row emptiness: a
            // family where seven members legitimately have no rows and one was
            // declined is a partial answer worth showing, not a deferral.
            const members = familyAddresses(detail).length;
            return members > 0 && view.missing.length === members ? null : view;
          },
        });
        setEntry({ key, state: value === null ? { kind: "deferred" } : { kind: "ready", value } });
      } catch (caught) {
        const error = toHlError(caught);
        logger.warn("vaults.activity_failed", { error, context: { kind } });
        setEntry({ key, state: { kind: "error", message: error.message } });
      }
    },
    [key, detail, kind, options]
  );

  useEffect(() => {
    if (key === null || kind === null || isDerived(kind)) return;
    const timer = setTimeout(() => void run(false), 0);
    return () => clearTimeout(timer);
  }, [key, kind, run]);

  return { state, refresh: useCallback(() => void run(true), [run]) };
}

/** Feeds resolved from data already in memory — never fetched. */
function isDerived(kind: ActivityKind): boolean {
  return kind === "balances" || kind === "positions" || kind === "depositors";
}

function balanceRows(family: VaultFamilyView): readonly VaultBalanceRow[] {
  return family.members.map((member) => ({
    address: member.address,
    accountValue: member.accountValue,
    withdrawable: member.withdrawable,
    positions: member.positions.length,
  }));
}

/** Fans one feed out across the family. Weight is charged per member. */
async function readActivity(
  detail: VaultDetail,
  kind: ActivityKind,
  options: VaultActivityOptions
): Promise<VaultActivityView> {
  const addresses = familyAddresses(detail);
  const since = Date.now() - options.windowMs;
  const client = getInfoClient();
  // Set by any member whose page came back full. Collected out here rather
  // than threaded through `fanOutFamily`, whose contract is deliberately just
  // "rows or null" — the flag is per-feed, not per-row.
  let truncated = false;

  switch (kind) {
    case "openOrders": {
      const { rows, missing } = await fanOutFamily<OpenOrderRow>(
        addresses,
        async (address) => {
          const seed = await fetchOpenOrders({
            probe: client as unknown as Parameters<typeof fetchOpenOrders>[0]["probe"],
            user: address,
          });
          if (seed.value?.truncated === true) truncated = true;
          return seed.deferred ? null : (seed.value?.rows ?? []);
        },
        (row) => row.placedAt
      );
      return { data: { kind: "openOrders", rows }, missing, truncated };
    }
    case "trades": {
      const { rows, missing } = await fanOutFamily<Fill>(
        addresses,
        async (address) => {
          // ONE page per member, never `fetchFillHistory`'s 20-page walk:
          // that is up to 400 weight per member, 3,200 for this family.
          const seed = await fetchFillsPage({
            probe: client as unknown as Parameters<typeof fetchFillsPage>[0]["probe"],
            user: address,
            startTime: since,
            aggregateByTime: options.aggregate,
          });
          if (seed.value?.hasMore === true) truncated = true;
          return seed.deferred ? null : (seed.value?.fills ?? []);
        },
        (row) => row.time
      );
      return { data: { kind: "trades", rows }, missing, truncated };
    }
    case "funding": {
      const { rows, missing } = await fanOutFamily<FundingLedgerRow>(
        addresses,
        async (address) => {
          const result = await fetchUserFunding({
            probe: client as unknown as Parameters<typeof fetchUserFunding>[0]["probe"],
            user: address,
            startTime: since,
          });
          return result.deferred ? null : (result.value ?? []);
        },
        (row) => row.time
      );
      return { data: { kind: "funding", rows }, missing, truncated };
    }
    case "orderHistory": {
      const { rows, missing } = await fanOutFamily<OrderLifecycle>(
        addresses,
        async (address) =>
          // Budgeted here rather than inside `history/`, which is deliberately
          // budget-agnostic — `hooks/history.ts` wraps it at the same edge. Left
          // bare, a family fan-out spent 20 weight PER MEMBER with the tracker
          // recording none of it: opening three tabs on an 8-member family burnt
          // 480 real weight while `remaining()` still reported full headroom,
          // which is precisely the drift the 1000/1200 margin exists to absorb.
          // A deferral returns null and lands in `missing`, which the sheet
          // already renders as a partial picture.
          weightBudget.tryRun("historicalOrders", async () => {
            const history = await fetchOrderHistory({
              probe: client as unknown as Parameters<typeof fetchOrderHistory>[0]["probe"],
              user: address,
            });
            return history.orders;
          }),
        (row) => row.lastAt
      );
      return { data: { kind: "orderHistory", rows }, missing, truncated };
    }
    case "twap": {
      // Fill History is a different endpoint — slice executions appear in no
      // other feed (0 of 1,159 overlapped `userFillsByTime`), so this is a
      // real second read rather than a filter over the same rows.
      if (options.twapView === "fills") {
        const { rows, missing } = await fanOutFamily<VaultTwapRow>(
          addresses,
          async (address) => {
            const seed = await fetchTwapSliceFills({
              probe: client as unknown as Parameters<typeof fetchTwapSliceFills>[0]["probe"],
              user: address,
            });
            if (seed.deferred) return null;
            return (seed.value ?? []).map((fill) => ({
              time: fill.time,
              status: "fill",
              coin: fill.coin,
              size: fill.sz,
              executedSize: fill.sz,
              executedNotional: null,
              durationMinutes: null,
              reduceOnly: null,
              isBuy: fill.side === "buy",
            }));
          },
          (row) => row.time
        );
        return { data: { kind: "twap", rows }, missing, truncated };
      }

      const { rows, missing } = await fanOutFamily<VaultTwapRow>(
        addresses,
        async (address) => {
          const history: Awaited<ReturnType<typeof fetchTwapHistory>> | null =
            await weightBudget.tryRun("twapHistory", () =>
              fetchTwapHistory({
                probe: client as unknown as Parameters<typeof fetchTwapHistory>[0]["probe"],
                user: address,
              })
            );
          // Deferred: this member is `missing`, not empty.
          if (history === null) return null;
          return (
            history
              // "Active" is a running order; "History" is everything terminal.
              .filter((row) =>
                options.twapView === "active"
                  ? row.status === "activated"
                  : row.status !== "activated"
              )
              .map((row) => ({
                time: row.time,
                status: row.status,
                coin: row.state?.coin ?? "—",
                size: row.state?.size ?? null,
                executedSize: row.state?.executedSize ?? null,
                executedNotional: row.state?.executedNotional ?? null,
                durationMinutes: row.state?.durationMinutes ?? null,
                reduceOnly: row.state?.reduceOnly ?? null,
                isBuy: row.state?.isBuy ?? null,
              }))
          );
        },
        (row) => row.time
      );
      return { data: { kind: "twap", rows }, missing, truncated };
    }
    case "ledger": {
      const { rows, missing } = await fanOutFamily<LedgerRow>(
        addresses,
        async (address) =>
          weightBudget.tryRun("userNonFundingLedgerUpdates", async () => {
            const page = await fetchLedgerPage({
              probe: client as unknown as Parameters<typeof fetchLedgerPage>[0]["probe"],
              user: address,
              startTime: since,
            });
            // The ledger endpoint reports its own page cap; a full page means
            // the exchange holds more than this window is showing.
            if (page.hasMore) truncated = true;
            return page.rows;
          }),
        (row) => row.time
      );
      return { data: { kind: "ledger", rows }, missing, truncated };
    }
    case "balances":
    case "positions":
    case "depositors":
      // Derived in the hook; unreachable, and an empty feed is the safe answer
      // rather than a thrown error inside a cache fill.
      return { data: { kind: "balances", rows: [] }, missing: [], truncated: false };
  }
}
