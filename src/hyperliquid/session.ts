/**
 * The composition root.
 *
 * Every module below this one is deliberately unaware of the others: stores take
 * targets, the order path takes a client, the wallet returns a signer, and none
 * of them reach for a singleton. That keeps them testable and it is why they
 * were each verifiable in isolation — but it also means **nothing runs together
 * until something wires it up**, and this is that something.
 *
 * Before this file existed, `configureClients`, `createExchangeClient`,
 * `ensureAgentReady` and `actionBudget.forget` all had zero production call
 * sites. That was not four separate oversights; it was one missing seam.
 * (`clearPending` still has none, deliberately: the order journal is
 * identity-tagged and must survive a switch, so nothing here wipes it.)
 *
 * The sequence a session goes through:
 *
 * ```
 * wallet signer -> identity -> transports+clients -> agent gate -> stores+subscriptions -> reconcile
 * ```
 *
 * Order matters at two points, both learned the hard way:
 *
 * 1. **The transport is rebuilt per identity, before anything subscribes.**
 *    `orderUpdates` and `userEvents` frames carry no user field, so two accounts
 *    on one transport is not a leak that can be filtered downstream — measured,
 *    each listener received the other's complete 4,815-update stream.
 * 2. **Startup reconciliation runs with an explicit identity, after the client
 *    exists.** Called without one it sweeps every journalled account, and its
 *    `landed` verdicts can carry a null `oid` — which is how a phantom order
 *    belonging to a different account gets adopted.
 */

import { HlError, toHlError } from "@/hyperliquid/core/errors";
import { createIdentity, effectiveAddress, identityKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import { actionBudget } from "@/hyperliquid/api/rateLimit";
import {
  closeClients,
  configureClients,
  createExchangeClient,
  getConnectionState,
  getInfoClient,
  getSubscriptionClient,
} from "@/hyperliquid/api/clients";
import { resolveHlConfig, type HlConfig } from "@/hyperliquid/config/env";
import { AccountStore } from "@/hyperliquid/state/account";
import { AccountSession, type BoundStore } from "@/hyperliquid/state/accountSession";
import { AppStatePolicy, type AppPhase, type ResumeDecision } from "@/hyperliquid/state/appState";
import { createSubscribeFn, type SubscriptionApi } from "@/hyperliquid/state/channels";
import { FillsStore } from "@/hyperliquid/state/fills";
import { OpenOrdersStore } from "@/hyperliquid/state/openOrders";
import { SubscriptionRegistry } from "@/hyperliquid/state/registry";
import { NotificationStore } from "@/hyperliquid/state/notifications";
import { SpotBalanceStore } from "@/hyperliquid/state/spot";
import { reconcilePendingSubmits } from "@/hyperliquid/orders/startupReconcile";
import { reconcileWithdrawals } from "@/hyperliquid/transfers/reconcileWithdrawals";
import { ensureAgentReady, type AgentReadiness } from "@/hyperliquid/auth/session";
import { lockVault } from "@/hyperliquid/wallet/vault";
import { canSignUnattended, type MasterSigner } from "@/hyperliquid/wallet/signer";
import { signerFor } from "@/hyperliquid/wallet/accounts";
import { createDispatcher, type RoutingCounters } from "@/hyperliquid/sessionRouting";
import { fetchUserRateLimit, type MetaProbe } from "@/hyperliquid/api/accountMeta";
import { assertOwnedSubAccount, fetchSubAccounts } from "@/hyperliquid/subaccounts/list";
import type { SubAccountSummary } from "@/hyperliquid/subaccounts/types";
import {
  fetchLeadingVaults,
  type LeadingVaultsProbe,
  type LedVault,
} from "@/hyperliquid/vaults/manage";
import type { SubAccountProbe } from "@/hyperliquid/subaccounts/list";
import type { Hex, HlEnv, HlIdentity, Scoped } from "@/hyperliquid/types/domain";

const logger = log.child("session");

/** The stores a session owns. Handed to the UI; never rebuilt on a switch. */
export interface SessionStores {
  account: AccountStore;
  openOrders: OpenOrdersStore;
  fills: FillsStore;
  spot: SpotBalanceStore;
  /** Free-text messages from the exchange, including liquidation warnings. */
  notifications: NotificationStore;
}

export interface SessionState {
  identity: HlIdentity;
  signer: MasterSigner;
  /** Result of the agent gate. Trading is refused unless this is `ready`. */
  agent: AgentReadiness;
  config: HlConfig;
  /**
   * The master's sub-accounts, as of the last start.
   *
   * `null` when they could not be read — a deferred weight budget or a failed
   * call — which is deliberately distinct from `[]`. Nothing may treat the two
   * the same: "we do not know" must not render as "you have none".
   */
  subAccounts: SubAccountSummary[] | null;
  /**
   * The vaults this wallet **leads**, as of the last start.
   *
   * Sourced from `leadingVaults` and nowhere else: a vault never appears in its
   * leader's `subAccounts2`, and `userRole` on a vault answers a bare
   * `{"role":"vault"}` with no pointer back to its leader — so ownership only
   * resolves leader → vaults.
   *
   * **Open vaults only.** `leadingVaults` omits closed ones, so an empty list
   * does not mean this wallet has never led a vault.
   *
   * `null` when it could not be read, deliberately distinct from `[]`. Vaults a
   * user merely *follows* are not here: those are positions, read through
   * `vaults/equities.ts`, not an identity.
   */
  ledVaults: LedVault[] | null;
}

export interface StartSessionParams {
  env?: HlEnv;
  /** Which account of the wallet. Defaults to the first. */
  accountIndex?: number;
  /** Names the identity for scoping. Defaults to the address. */
  accountId?: string;
  dex?: string | null;
  subAccount?: string | null;
  /**
   * Approve an agent if none is usable.
   *
   * Omitted, the session still starts and reports `approval_required` — a caller
   * may not want to prompt at launch, and read-only surfaces need no agent.
   */
  approveAgent?: boolean;
  /**
   * Name for a newly approved agent. Defaults to `"hl"` downstream.
   *
   * Naming matters more than a label usually does: Hyperliquid allows **1
   * unnamed agent plus up to 3 named ones**, and approving with a name that
   * MATCHES an existing agent deregisters that agent and replaces it. So a
   * caller at the named limit can rotate by reusing a name, where a fresh name
   * would be refused — and an accidental name collision silently kills whatever
   * agent held it.
   */
  agentLabel?: string;
  /** Overrides for tests. */
  now?: () => number;
}

/**
 * Owns one logged-in session.
 *
 * Single instance per app. The stores it exposes outlive any identity switch, so
 * a React tree can subscribe once at mount and never re-bind.
 */
export class HyperliquidSession {
  readonly stores: SessionStores;
  private readonly registry: SubscriptionRegistry;
  private readonly accountSession: AccountSession;
  private current: SessionState | null = null;
  /**
   * Serialises `start`.
   *
   * Two overlapping calls would interleave teardown and setup and could leave
   * two identities subscribed on one transport — the exact leak D31 exists to
   * prevent, and one that cannot be filtered downstream because `orderUpdates`
   * frames carry no user field.
   */
  private inFlight: Promise<SessionState> | null = null;

  /**
   * Bumped by `stop()`. A start carries the value it was REQUESTED at, and
   * abandons itself if this has moved on since.
   *
   * `inFlight` chains start-to-start only, so before this existed a `stop()`
   * had no way to reach a start already in progress: the start ran to
   * completion afterwards and re-published a session the user had just torn
   * down — holding the signer resolved before the teardown. Replacing the
   * wallet mid-start therefore left the app signing withdrawals with the OLD
   * key while the screen confirmed the new one.
   *
   * Captured at request time rather than at run time, so a start that was
   * queued behind another and only begins after the `stop()` is cancelled too.
   */
  private epoch = 0;

  constructor() {
    this.stores = {
      account: new AccountStore(),
      openOrders: new OpenOrdersStore(),
      fills: new FillsStore(),
      spot: new SpotBalanceStore(),
      notifications: new NotificationStore(),
    };

    this.registry = new SubscriptionRegistry((target) =>
      createSubscribeFn({
        api: getSubscriptionClient() as unknown as SubscriptionApi,
        sink: (event) => this.route(event),
        onError: (failed, error) => {
          logger.warn("session.channel_error", {
            context: { channel: failed.channel },
            error,
          });
          // Evict, or the registry keeps a key the SDK has already destroyed
          // and `add()` short-circuits every future reconcile for it.
          this.registry.onFailed(failed);
        },
      })(target)
    );

    // Each store paired with the channel it serves. Getting this wrong is
    // silent: the store simply drops every event it is handed.
    const stores: BoundStore[] = [
      { store: this.stores.account, channel: "clearinghouseState" },
      { store: this.stores.openOrders, channel: "openOrders" },
      { store: this.stores.fills, channel: "userFills" },
      { store: this.stores.spot, channel: "spotState" },
      { store: this.stores.notifications, channel: "notification" },
    ];

    this.accountSession = new AccountSession({
      registry: this.registry,
      stores,
      budget: actionBudget,
      // Per identity, not per app. See the module note.
      rebuildTransport: () => closeClients(),
    });

    // Background/foreground. The policy was written in Phase 4 and had no
    // counterpart for `resubscribe` until now, so nothing ever drove it: an app
    // returning after ten minutes rendered a book that had stopped updating,
    // with no staleness marker and no rebuild. iOS suspends JS and drops the
    // socket without telling anyone.
    this.appState = new AppStatePolicy({
      resubscribe: (mode) => this.accountSession.resubscribe(mode),
      markStale: () => this.markStale(),
      // `lockVault` shipped with the comment "for lock-on-background" and no
      // caller, so nothing ever dropped the key while the app was suspended.
      lockSecrets: () => lockVault(),
      connectionState: () => getConnectionState(),
    });

    // Payload shapes live in their own module; this file owns lifecycle.
    this.dispatch = createDispatcher(this.stores, this.routingCounters);
  }

  /**
   * The live session, or `null` before `start`.
   *
   * Referentially stable between changes — the field is only ever reassigned
   * wholesale, never mutated in place — which is what lets it serve as a
   * `getSnapshot` for {@link subscribe}. Mutating `current` in place would
   * satisfy the type and break every subscriber silently, since React compares
   * successive snapshots with `Object.is`.
   */
  state(): SessionState | null {
    return this.current;
  }

  /**
   * Observe session changes: start, switch, stop, and a failed start.
   *
   * The same `subscribe`/`getSnapshot` contract the stores use, so a React tree
   * binds to it through `useStoreValue` exactly like any other store. Without
   * it the session was readable but not *watchable* — `state()` was a plain
   * getter, so a screen could not re-render when the agent gate finally passed,
   * and "you can trade now" could only be discovered by polling.
   *
   * Fires on the *identity* of the state changing, not on data inside it: the
   * per-account feeds are the stores' job, and duplicating them here would wake
   * every session subscriber on every heartbeat.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Publish a new session state.
   *
   * Every assignment to `current` goes through here. A direct assignment
   * typechecks and leaves subscribers on the previous value — the failure mode
   * is a screen that renders a logged-out shell around a live session, or the
   * reverse.
   */
  private publish(next: SessionState | null): void {
    this.current = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        // One bad subscriber must not stop the others from learning, and must
        // not fail the start that triggered it.
        logger.warn("session.listener_failed", { error: toHlError(error) });
      }
    }
  }

  /**
   * Whether an order may be placed right now.
   *
   * `rotation_due` counts as tradeable. That agent is **still valid** — the
   * status exists to say "rotate this soon", and `ensureAgentReady` documents
   * that it deliberately returns one as-is to avoid prompting mid-trade. Gating
   * on `ready` alone inverted that intent and locked the user out of trading for
   * the agent's final 24 hours, which is the opposite of what the rotation
   * threshold is for. Prompt from a quiet moment via `needsAgentRotation()`.
   */
  canTrade(): boolean {
    const kind = this.current?.agent.status.kind;
    return kind === "ready" || kind === "rotation_due";
  }

  /**
   * True when the agent is usable but approaching expiry.
   *
   * A cue to offer rotation from somewhere calm — never a reason to block an
   * order.
   */
  needsAgentRotation(): boolean {
    return this.current?.agent.status.kind === "rotation_due";
  }

  /**
   * An exchange client signed by the **agent**, for orders.
   *
   * @throws {HlError} unless the agent gate passed — the alternative is signing
   *   with a key the exchange will not accept, which fails opaquely.
   */
  exchangeClient(): ReturnType<typeof createExchangeClient> {
    const state = this.current;
    if (!state) throw new HlError("No session", { code: "not_authorized" });
    const status = state.agent.status;
    // Both carry a usable agent key; `rotation_due` is valid, just ageing.
    if (status.kind !== "ready" && status.kind !== "rotation_due") {
      throw new HlError("Agent is not approved for this account", {
        code: "not_authorized",
        context: { status: status.kind },
      });
    }
    return createExchangeClient(status.account);
  }

  /**
   * An exchange client signed by the **master wallet**, for transfers.
   *
   * Separate from `exchangeClient()` on purpose: `withdraw3`, `usdSend`,
   * `spotSend`, `sendAsset` and `usdClassTransfer` carry no `user` field, so an
   * agent signature would act on the agent's own address. Two accessors make the
   * choice visible at the call site rather than buried in a parameter.
   */
  masterClient(): ReturnType<typeof createExchangeClient> {
    const state = this.current;
    if (!state) throw new HlError("No session", { code: "not_authorized" });
    return createExchangeClient(state.signer.account);
  }

  /** Whether unattended work (startup reconciliation, timers) may sign. */
  canWorkUnattended(): boolean {
    return this.current !== null && canSignUnattended(this.current.signer);
  }

  /**
   * Start a session for one wallet account.
   *
   * Safe to call again to switch accounts: the previous identity is torn down
   * first, in the order `AccountSession` enforces.
   */
  async start(params: StartSessionParams = {}): Promise<SessionState> {
    const epoch = this.epoch;
    // Queue behind any in-flight start rather than racing it.
    const run = (this.inFlight ?? Promise.resolve()).then(
      () => this.startInternal(params, epoch),
      () => this.startInternal(params, epoch)
    );
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async startInternal(params: StartSessionParams, epoch: number): Promise<SessionState> {
    const config = resolveHlConfig(params.env ? { env: params.env } : {});

    // `configureClients` CLOSES the websocket, and `switchTo` deliberately does
    // nothing when the identity is unchanged — a documented, tested no-op. So
    // reconfiguring on a same-identity restart tears the socket down with
    // nothing left to re-open it: every feed freezes at its last value and the
    // registry still holds `active` entries pointing at a dead socket, which
    // makes `add()` a no-op and the state unrecoverable without `stop()`.
    //
    // The trigger is the flow this class invites: start read-only at launch,
    // then start again with `approveAgent` once the user opts into trading.
    //
    // `env` is part of `identityKey`, so a network change is always also an
    // identity change and still gets the full rebuild inside `switchTo`.
    const reconfigured = !this.current || this.current.config.env !== config.env;
    if (reconfigured) {
      configureClients(config);
    }

    try {
      return await this.buildSession(config, params, epoch);
    } catch (error) {
      // Only the reconfiguring path needs unwinding. `configureClients` closes
      // every client and rebinds the module-global config BEFORE the two
      // fallible awaits below, so a failure after it leaves the old session
      // published against clients that no longer exist — the accessors would
      // report a live session on a network nothing is bound to.
      //
      // Failing closed rather than restoring the previous session: reviving it
      // would mean reconfiguring back and resubscribing, and a half-restored
      // session that *looks* healthy is the more dangerous outcome. "No session"
      // is at least honest, and `start()` is idempotent from there.
      if (reconfigured) {
        await this.accountSession.switchTo(null).catch(() => undefined);
        closeClients();
        this.publish(null);
      }
      throw error;
    }
  }

  private async buildSession(
    config: HlConfig,
    params: StartSessionParams,
    epoch: number
  ): Promise<SessionState> {
    const signer = await signerFor(params.accountIndex ?? 0);
    const identity = createIdentity({
      env: config.env,
      accountId: params.accountId ?? signer.address,
      address: signer.address,
      dex: params.dex ?? null,
      subAccount: params.subAccount ?? null,
    });

    logger.info("session.starting", {
      context: { identity: identityKey(identity), signer: signer.kind },
    });

    // BEFORE anything is pointed at it. A foreign or mistyped address passes
    // `createIdentity` untouched, and the stores' echo guard compares against
    // that *same* wrong address — so it agrees, and the user gets a calm,
    // well-formed, entirely empty portfolio belonging to a stranger.
    //
    // Raced rather than sequenced: two independent info reads, neither of which
    // consumes the other's result, cost a full extra round trip on every start
    // (measured on testnet: 765ms sequential vs 265ms together). The guard is
    // not weakened by racing them — `resolveLedVaults` reads
    // `identity.address`, the master wallet we already own, never the
    // unverified sub-account, and it opens no subscription and touches no
    // store. It also cannot reject (it catches and degrades to `null`), so a
    // fatal sub-account refusal is still the only thing that rejects here.
    const [subAccounts, ledVaults] = await Promise.all([
      this.resolveSubAccounts(identity),
      this.resolveLedVaults(identity),
    ]);

    // The agent gate. `approveAgent` is opt-in because approving prompts the
    // user's real wallet, which is not something to do unbidden at launch.
    //
    // **Sequenced after the guard above, and it must stay that way.** This is
    // the one await on this path that is not a read: with `approveAgent` set it
    // asks the user to sign `approveAgent` with their real wallet and registers
    // an agent on-chain, irreversibly. Folding it into the `Promise.all` would
    // put that prompt in front of the user *before* `resolveSubAccounts` has
    // established the selected sub-account is even theirs — so a refused
    // identity would still have cost a real signature. A linter that sees two
    // adjacent independent awaits here is reading the data flow correctly and
    // the ordering constraint not at all.
    const agent = await ensureAgentReady({
      identity,
      info: getInfoClient() as unknown as Parameters<typeof ensureAgentReady>[0]["info"],
      approver: params.approveAgent
        ? (createExchangeClient(signer.account) as unknown as Parameters<
            typeof ensureAgentReady
          >[0]["approver"])
        : undefined,
      label: params.agentLabel,
      now: params.now,
    });

    // Stores and subscriptions FIRST, then publish. Setting `this.current`
    // before the stores are re-scoped would make the session report identity B
    // while every store still holds A's numbers — and a render in that window
    // shows one account's balance under the other's address.
    // Before opening anything: `switchTo` subscribes every account channel, and
    // doing that for a session the user has already stopped is how the torn-down
    // identity came back to life.
    this.assertCurrent(epoch);
    await this.accountSession.switchTo(identity);
    // And again after, because `switchTo` awaits — a `stop()` landing inside it
    // would otherwise still reach `publish`.
    this.assertCurrent(epoch);
    const state: SessionState = { identity, signer, agent, config, subAccounts, ledVaults };
    this.publish(state);

    // AFTER the switch, which forgets the previous identity's budget. Seeding
    // before it would be erased. Hyperliquid rate-limits a sub-account as a
    // **separate user**, so it gets its own allowance rather than inheriting the
    // master's — an unseeded identity is otherwise assumed new and throttled to
    // the floor.
    await this.seedBudget(identity);

    // Only now, and always WITH the identity — see the module note.
    await this.reconcile();

    logger.info("session.started", {
      context: {
        identity: identityKey(identity),
        agent: agent.status.kind,
        activated: agent.activated,
      },
    });
    return state;
  }

  /**
   * Read the master's sub-accounts, and refuse an address that is not one.
   *
   * The list is worth having even when no sub-account is selected: it is what
   * `isInternalCounterparty` needs to tell an internal move from a real send, and
   * what a picker renders.
   *
   * A failure to *read* is not a failure to start — the session degrades to
   * `subAccounts: null` and carries on. A failure to *verify a selected one* is
   * fatal, and deliberately so: continuing would subscribe to a stranger's
   * address, and every guard downstream would agree with it.
   */
  private async resolveSubAccounts(identity: HlIdentity): Promise<SubAccountSummary[] | null> {
    let listed: SubAccountSummary[] | null = null;
    try {
      const result = await fetchSubAccounts({
        probe: getInfoClient() as unknown as SubAccountProbe,
        // The MASTER. A sub-account has none of its own — `subAccounts2` on one
        // returned null on 21 of 21 sampled.
        master: identity.address,
      });
      listed = result.value;
    } catch (error) {
      logger.warn("session.subaccounts_unavailable", { error: toHlError(error) });
    }

    if (!identity.subAccount) return listed;

    if (listed === null) {
      // Unverifiable, so refuse. Selecting a sub-account is an explicit act and
      // proceeding on an unchecked address is the one outcome with no symptom.
      throw new HlError("Cannot verify that sub-account right now", {
        code: "not_authorized",
        context: { reason: "subaccounts_unreadable" },
      });
    }
    assertOwnedSubAccount(listed, identity.subAccount);
    return listed;
  }

  /**
   * Read the vaults this wallet leads.
   *
   * Never fatal, and never gating: unlike a sub-account, a vault is not something
   * the session can be *switched to* by these parameters, so an unreadable list
   * costs a leader screen rather than correctness. It is read at start anyway
   * because it is the only ownership source, and every leader-only action needs
   * it before it signs.
   */
  private async resolveLedVaults(identity: HlIdentity): Promise<LedVault[] | null> {
    try {
      const { value } = await fetchLeadingVaults({
        probe: getInfoClient() as unknown as LeadingVaultsProbe,
        // The wallet, not `effectiveAddress` — a sub-account leads nothing.
        user: identity.address,
      });
      return value;
    } catch (error) {
      logger.warn("session.led_vaults_unavailable", { error: toHlError(error) });
      return null;
    }
  }

  /**
   * Seed the action budget from the server's own view of this identity.
   *
   * Best-effort: an unseeded identity is assumed new rather than unlimited, so a
   * failure here throttles rather than over-permits, and a session must still
   * start when the info endpoint is unreachable.
   */
  private async seedBudget(identity: HlIdentity): Promise<void> {
    try {
      const { value } = await fetchUserRateLimit({
        probe: getInfoClient() as unknown as MetaProbe,
        // The address actually rate-limited — the sub-account when one is
        // selected, which is the whole reason this runs on every switch.
        user: effectiveAddress(identity),
      });
      if (!value) return;
      actionBudget.seed(identity, {
        limit: value.nRequestsCap,
        used: value.nRequestsUsed,
      });
    } catch (error) {
      logger.warn("session.budget_seed_failed", { error: toHlError(error) });
    }
  }

  /**
   * Resolve journalled submits whose outcome was never learned.
   *
   * Failure is logged and swallowed: a session must start even when the
   * reconciler cannot reach the API, and the journal is durable, so the work is
   * merely deferred rather than lost.
   *
   * Two journals, not one. Orders and withdrawals both record before sending
   * and both need a sweep on start — and the withdrawal one is the more
   * consequential to skip: an unsettled entry is read by the withdrawal
   * preflight as the `withdrawal_in_flight` **blocker**, so a successful
   * withdrawal that is never reconciled locks the next one out for the whole
   * settlement floor and shows a permanently "in progress" row.
   */
  async reconcile(now?: () => number): Promise<void> {
    const state = this.current;
    if (!state) return;
    await this.reconcileWithdrawalJournal();
    try {
      const result = await reconcilePendingSubmits({
        probe: getInfoClient() as unknown as Parameters<typeof reconcilePendingSubmits>[0]["probe"],
        // Never omitted. Without it the sweep covers every journalled account.
        identity: state.identity,
      });
      // Landed verdicts go to the UNCONFIRMED OVERLAY, never to the
      // authoritative order map. Two reasons, both from Phase 6: a verdict can
      // carry a null `oid`, and an oid-keyed store fed one gets a permanent
      // phantom the user cannot cancel. The `openOrders` feed remains the sole
      // authority for a row, and the overlay is evicted the moment the real one
      // appears.
      const at = (now ?? Date.now)();
      // `landed` is typed as the full CloidVerdict union, so narrow rather than
      // assume — only that variant carries an `oid`.
      for (const verdict of result.landed) {
        if (verdict.kind !== "landed") continue;
        this.stores.openOrders.addUnconfirmed({
          cloid: verdict.cloid,
          oid: verdict.oid,
          label: null,
          submittedAt: at,
          // Already past its window — that is why it was probed at all — so the
          // overlay's eviction rules may drop it as soon as a snapshot disagrees.
          expiresAt: at,
        });
      }

      if (result.landed.length > 0 || result.deferred > 0) {
        logger.info("session.reconciled", {
          context: {
            landed: result.landed.length,
            notLanded: result.notLanded.length,
            unresolved: result.unresolved.length,
            deferred: result.deferred,
          },
        });
      }
    } catch (error) {
      logger.warn("session.reconcile_failed", { error: toHlError(error) });
    }
  }

  /**
   * Settle withdrawal journal entries whose ledger row has since appeared.
   *
   * Separate from the order sweep and separately caught: one failing must not
   * stop the other, and neither may stop a session from starting.
   *
   * It **never clears an unresolved entry**. A withdrawal has no cancel and no
   * status endpoint, so absence past the floor means "check the destination
   * chain", not "it failed" — and the entry that blocks a duplicate stays
   * exactly where it is.
   */
  private async reconcileWithdrawalJournal(): Promise<void> {
    const state = this.current;
    if (!state) return;
    try {
      const result = await reconcileWithdrawals({
        probe: getInfoClient() as unknown as Parameters<typeof reconcileWithdrawals>[0]["probe"],
        user: effectiveAddress(state.identity),
        // Never omitted, for the same reason as the order sweep: without it
        // this settles entries belonging to every account ever journalled.
        identityKey: identityKey(state.identity),
      });

      if (result.settled.length > 0 || result.unresolved.length > 0 || result.deferred) {
        logger.info("session.withdrawals_reconciled", {
          context: {
            settled: result.settled.length,
            pending: result.pending.length,
            unresolved: result.unresolved.length,
            deferred: result.deferred,
          },
        });
      }
    } catch (error) {
      logger.warn("session.withdrawal_reconcile_failed", { error: toHlError(error) });
    }
  }

  /**
   * Feed a foreground/background transition.
   *
   * The app owns the listener — React Native's `AppState` does not belong
   * inside a headless module — and forwards transitions here. Repeat
   * transitions to the same phase are ignored, and the decision is time-based:
   * a brief switch away must not tear down a healthy socket, but anything past
   * Hyperliquid's own ~60s idle timeout very likely lost it.
   */
  async onAppStateChange(phase: AppPhase): Promise<ResumeDecision | null> {
    const decision = await this.appState.onPhaseChange(phase);

    // Sweep the journals on every RESUME, not only at session start.
    //
    // `reconcile()` had exactly one production caller — `buildSession` — so
    // within a single app session a completed withdrawal was never settled.
    // The withdrawal preflight reads an unsettled entry as the
    // `withdrawal_in_flight` blocker, so a withdrawal that actually arrived in
    // four minutes still refused the next one for the full fifteen-minute
    // settlement floor, and the row stayed "in progress" until the app was
    // restarted. A resume is the natural moment: the user has been away, which
    // is exactly when a pending withdrawal is most likely to have landed.
    //
    // Cheap by construction: `reconcileWithdrawals` returns immediately when
    // nothing is outstanding, and its ledger read goes through the weight
    // budget like every other. Failures are swallowed inside `reconcile`.
    if (phase === "active" && this.current) {
      void this.reconcile();
    }

    return decision;
  }

  /**
   * Per-channel counts of events rejected by the parser.
   *
   * Readable, unlike before: the dispatcher accumulated these into a Map with
   * no accessor, and `record()` logs only the FIRST rejection per channel — so
   * a channel whose wire shape changed logged once and then went silent with
   * the count unreachable. This is how a caller notices that.
   */
  rejectedEvents(): ReadonlyMap<string, number> {
    return this.routingCounters.rejected;
  }

  /** Mark every store stale on resume, before the resubscribe completes. */
  markStale(): void {
    this.accountSession.markAllStale();
  }

  /**
   * Throw if this start has been superseded by a `stop()`.
   *
   * Deliberately a throw rather than a quiet return: the caller's contract is
   * `Promise<SessionState>`, and inventing a state for a session nobody wants
   * is exactly the failure being prevented. `startInternal`'s catch already
   * unwinds a reconfigured transport, and `stop()` has established the "no
   * session" end state, so there is nothing further to undo.
   */
  private assertCurrent(epoch: number): void {
    if (this.epoch === epoch) return;
    logger.info("session.start_superseded");
    throw new HlError("Session start superseded by stop", { code: "superseded" });
  }

  /** End the session and release everything. */
  async stop(): Promise<void> {
    // First, so a start already running abandons itself at its next checkpoint
    // rather than completing and republishing what this is tearing down.
    this.epoch += 1;
    await this.accountSession.switchTo(null);
    await this.registry.closeAll();
    closeClients();
    this.publish(null);
    logger.info("session.stopped");
  }

  /**
   * Fan an inbound event out to whichever store owns its channel.
   *
   * Parsing lives here rather than in the stores so the wire shapes stay in one
   * place, and so a store never has to know which channel produced its value.
   */
  private route(event: Scoped<unknown>): void {
    this.dispatch(event);
  }

  /** Payload routing, built once in the constructor. */
  private readonly dispatch: (event: Scoped<unknown>) => void;

  /** Background/foreground policy. Driven by {@link onAppStateChange}. */
  private readonly appState: AppStatePolicy;

  /** Rejection tallies, exposed through {@link rejectedEvents}. */
  private readonly routingCounters: RoutingCounters = { rejected: new Map() };

  /** Session-change subscribers. See {@link subscribe}. */
  private readonly listeners = new Set<() => void>();

  /** The address this session acts as — the sub-account when one is set. */
  address(): Hex | null {
    // `Hex`, not `string`: `effectiveAddress` returns one, and widening here
    // forced every caller that feeds a user-scoped read to cast back.
    return this.current ? effectiveAddress(this.current.identity) : null;
  }
}
