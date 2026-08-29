/**
 * The write actions a portfolio screen needs: cancel orders, close positions
 * — one at a time, or all at once.
 *
 * Everything here spends real money, so each rule below is a specific way a
 * naive version loses some.
 *
 * ## Cancelling
 *
 * `cancelOrders` has bulk semantics: if one oid is already filled the call
 * throws, but **the other cancels still took effect**. So a failed cancel is
 * never blind-retried — the caller re-reads open orders, which the websocket
 * does on its own. Cancelling one row at a time sidesteps the partial-batch
 * problem entirely, which is why these hooks do exactly that.
 *
 * ## Closing
 *
 * Hyperliquid has no market-order type. A close is an **IOC limit priced
 * through the book**, and three things must be right or it silently misbehaves:
 *
 * - **The reference price is fetched fresh, at the moment of the close.** Not
 *   from the screen's price cache: a 15-second-old mid on a market order is
 *   exactly the wrong input, and the cache exists to avoid re-reading history,
 *   not to price trades.
 * - **`reduceOnly: true`.** Without it a rounding error or a concurrent fill
 *   flips the position to the other side instead of flattening it.
 * - **Direction is the opposite of the position.** Closing a long is a SELL.
 *   Getting this backwards doubles the position at market.
 *
 * The size is the position's own `size`, which the domain type documents as
 * unsigned — `side` carries the direction.
 *
 * ## What is deliberately NOT here
 *
 * No partial close, no limit close, no slippage control. Those belong to an
 * order ticket on the Trade screen, where the user can see a book. This is the
 * "get me out" button, and it uses the module's default slippage.
 */

import { useCallback, useRef, useState } from "react";

import { getInfoClient } from "@/hyperliquid/api/clients";
import { actionBudget } from "@/hyperliquid/api/rateLimit";
import { weightBudget } from "@/hyperliquid/api/weightBudget";
import { resolveAssetSpec } from "@/hyperliquid/assets";
import { toHlError, type HlError } from "@/hyperliquid/core/errors";
import { actingRoute } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import { assetIndex } from "@/hyperliquid/hooks/assets";
import { buildLimitOrder, marketLimitPrice } from "@/hyperliquid/orders/build";
import { cancelOrders, updateIsolatedMargin } from "@/hyperliquid/orders/exchange";
import { positionTpslLegs } from "@/components/trade/ticketSubmit";
import { placeOrders } from "@/hyperliquid/orders/place";
import type { OrderResult } from "@/hyperliquid/orders/outcome";
import type { HyperliquidSession } from "@/hyperliquid/session";
import type { OpenOrderRow, Position } from "@/hyperliquid/types/domain";

const logger = log.child("hooks.actions");

/**
 * What an action reports back. Never a bare boolean — the reason matters.
 *
 * The three kinds are the module-wide `SubmitOutcome` rule in UI clothing, and
 * `unknown` is not optional decoration: a submit whose answer never arrived
 * MAY have landed, so a caller must neither claim success nor offer a retry —
 * the journal and the reconciler own that question.
 *
 * `unknown` used to be folded into `done` with an explanatory `note`, and no
 * screen rendered the note. A TP/SL replace that cancelled the old brackets and
 * then lost its reply closed the sheet exactly as on success, leaving a
 * position that had a stop with none and nothing on screen saying so.
 * (2026-08-29.)
 */
export type ActionResult =
  | { kind: "done"; note: string }
  /**
   * Sent; the answer never arrived. Show the note, keep the surface open, and
   * offer NO retry control — reconciliation resolves it.
   */
  | { kind: "unknown"; note: string }
  | { kind: "failed"; error: HlError };

/**
 * Which row an action is currently working on, so only that row shows a spinner.
 *
 * One slot, so only one action at a time shows as busy — and every completion
 * used to clear it UNCONDITIONALLY, which meant a finishing action wiped a
 * concurrent one's busy state. That defeated the only re-entrancy protection
 * these actions have: closing position Y while a TP/SL replace on X was between
 * its cancel and its place re-armed X's Apply button mid-flight, exactly inside
 * the window where a second apply stacks a bracket. Every clear is now
 * conditional on still owning the slot.
 */
export interface ActionState {
  /**
   * Every key currently in flight — `order:<oid>` for a cancel,
   * `position:<coin>` for a close, plus the two bulk keys.
   *
   * A SET, because it was one slot. Six actions shared it, so starting a
   * second action clobbered the first's key and finishing either cleared it
   * outright: a close on Y both stole and then released X's busy state while
   * X's TP/SL replace was still between its cancel and its place — re-arming
   * Apply inside the one window where a second apply stacks a bracket.
   *
   * Read it through `isBusy`; nothing outside this hook needs the membership.
   */
  busyKeys: readonly string[];
  lastError: HlError | null;
}

function keyOfOrder(row: OpenOrderRow): string {
  return `order:${row.oid}`;
}

function keyOfPosition(position: Position): string {
  return `position:${position.coin}`;
}

/** What the hook returns — named so a component can take it as a prop. */
export interface OrderActions {
  state: ActionState;
  isBusy: (key: string) => boolean;
  orderKey: (row: OpenOrderRow) => string;
  positionKey: (position: Position) => string;
  cancelOrder: (row: OpenOrderRow) => Promise<ActionResult>;
  cancelAll: (rows: readonly OpenOrderRow[]) => Promise<ActionResult>;
  closePosition: (position: Position) => Promise<ActionResult>;
  closeAll: (positions: readonly Position[]) => Promise<ActionResult>;
  /** Attach whole-position TP/SL. Empty string on either price means "none". */
  setPositionTpsl: (
    position: Position,
    prices: { takeProfitPrice: string; stopLossPrice: string }
  ) => Promise<ActionResult>;
  /** Add (positive) or remove (negative) margin on an ISOLATED position. */
  adjustIsolatedMargin: (position: Position, amountUsd: string) => Promise<ActionResult>;
}

/**
 * The settled-outcome honesty check every close shares.
 *
 * "Settled" means the exchange ANSWERED — not that anything was placed. A
 * top-level refusal, an all-legs-rejected batch, and a truncated statuses
 * array all settle with `anyAccepted: false`, and collapsing them into "done"
 * leaves a user believing they are flat while every position stays open (the
 * adversarial review caught exactly that, 2026-08-18). A definite refusal is
 * retry-SAFE, so throwing here is honest in both directions — unlike
 * `unknown`, which must never be reported as failure.
 *
 * Returns the honest partial note, or null for full success; THROWS on a
 * settled refusal so the caller's catch sets lastError.
 */
function settledCloseNote(result: OrderResult, what: string): string | null {
  if (!result.anyAccepted) {
    const legError = result.legs.find((leg) => leg.kind === "rejected");
    throw new Error(
      result.serverError ??
        (legError && "error" in legError ? legError.error : `${what} refused by the exchange`)
    );
  }
  return result.isPartial ? `some ${what} legs were refused — check Positions` : null;
}

/**
 * How long a just-placed whole-position bracket blocks the next apply for that
 * coin while it is invisible to `openOrders.rows`.
 *
 * The snapshot normally catches up in a second or two; the ceiling exists so a
 * placement that never appears cannot wedge the sheet forever.
 */
const TPSL_CONFIRM_WINDOW_MS = 15_000;

export function useOrderActions(session: HyperliquidSession): OrderActions {
  const [state, setState] = useState<ActionState>({ busyKeys: [], lastError: null });

  /** Mark a key in flight. */
  const beginAction = useCallback((key: string) => {
    setState((prev) => ({
      busyKeys: prev.busyKeys.includes(key) ? prev.busyKeys : [...prev.busyKeys, key],
      lastError: null,
    }));
  }, []);

  /** Release only THIS key, leaving any concurrent action's alone. */
  const endAction = useCallback((key: string, error: HlError | null) => {
    setState((prev) => ({
      busyKeys: prev.busyKeys.filter((entry) => entry !== key),
      lastError: error ?? prev.lastError,
    }));
  }, []);
  /**
   * coin -> when a whole-position bracket was last submitted for it.
   *
   * A ref, not state: this gates an imperative action and must never trigger a
   * render. Cleared as soon as the exchange confirms the bracket (it then shows
   * up in `rows` and gets cancelled normally) or the window above lapses.
   */
  const pendingTpsl = useRef(new Map<string, number>());

  const cancelOrder = useCallback(
    async (row: OpenOrderRow): Promise<ActionResult> => {
      const key = keyOfOrder(row);
      beginAction(key);
      try {
        const current = session.state();
        if (!current) throw new Error("no session");

        // The coin is a WIRE coin, not a ticker — `xyz:BTC`, `@107`, `#102251`
        // all appear here — and `resolveAssetSpec` is the only thing that maps
        // it to the id a cancel needs.
        const spec = resolveAssetSpec(await assetIndex(), row.coin);

        const result = await cancelOrders({
          client: session.exchangeClient(),
          cancels: [{ assetId: spec.assetId, oid: row.oid }],
          // The bug this line fixes: placeOrders routes to the acting
          // sub-account, so the order LIVES there — a cancel without the same
          // routing lands on the master, where the oid does not exist, and
          // the order becomes uncancellable from the app.
          ...actingRoute(current.identity),
          onSpend: (n) => actionBudget.spend(current.identity, "cancel", n),
        });
        if (!result.ok) throw result.error ?? new Error("cancel refused");

        endAction(key, null);
        return { kind: "done", note: `cancelled ${row.coin}` };
      } catch (caught) {
        const error = toHlError(caught);
        logger.warn("action.cancel_failed", { context: { oid: row.oid }, error });
        endAction(key, error);
        return { kind: "failed", error };
      }
    },
    [session, beginAction, endAction]
  );

  const closePosition = useCallback(
    async (position: Position): Promise<ActionResult> => {
      const key = keyOfPosition(position);
      beginAction(key);
      try {
        const current = session.state();
        if (!current) throw new Error("no session");

        const spec = resolveAssetSpec(await assetIndex(), position.coin);

        // Fresh, not cached — see the header. A market order priced off a
        // stale mid is the one place this app must not reuse a value.
        const mids = await weightBudget.tryRun("allMids", () => getInfoClient().allMids());
        if (mids === null) {
          throw new Error("rate limit — try again in a moment");
        }
        const reference = (mids as Record<string, string>)[position.coin];
        if (typeof reference !== "string") {
          // Refusing beats guessing: without a reference there is no honest
          // price for an IOC, and a wrong one crosses the book at any cost.
          throw new Error(`no live price for ${position.coin}`);
        }

        // Closing a LONG is a SELL. This is the line that doubles a position
        // if it is written backwards.
        const isBuy = position.side === "short";
        const price = marketLimitPrice({ referencePrice: reference, isBuy, asset: spec });

        const outcome = await placeOrders({
          client: session.exchangeClient(),
          identity: current.identity,
          agentStatus: current.agent.status,
          budget: actionBudget,
          orders: [
            buildLimitOrder({
              asset: spec,
              isBuy,
              price,
              // Unsigned by contract — `side` carries the direction.
              size: position.size,
              tif: "Ioc",
              // Without this a rounding error or a concurrent fill opens the
              // opposite position rather than flattening this one.
              reduceOnly: true,
            }),
          ],
        });

        if (outcome.kind === "rejected_locally") {
          // Nothing left the device — the journal entry is already resolved,
          // so no reconciler will ever act on this. A definite failure the
          // user must SEE, and one that is safe to retry after fixing.
          throw outcome.error;
        }
        if (outcome.kind === "unknown") {
          // Not an error: the order may well have landed. The journal holds
          // the cloid and the startup reconciler will resolve it — saying
          // "failed" here would invite a double close.
          endAction(key, null);
          return { kind: "unknown", note: "Outcome unknown — check open orders before retrying." };
        }

        // Settled ≠ placed — a refusal throws, a partial gets an honest note.
        settledCloseNote(outcome.result, "close");
        endAction(key, null);
        return { kind: "done", note: `closing ${position.size} ${position.coin}` };
      } catch (caught) {
        const error = toHlError(caught);
        logger.warn("action.close_failed", { context: { coin: position.coin }, error });
        endAction(key, error);
        return { kind: "failed", error };
      }
    },
    [session, beginAction, endAction]
  );

  const cancelAll = useCallback(
    async (rows: readonly OpenOrderRow[]): Promise<ActionResult> => {
      if (rows.length === 0) return { kind: "done", note: "nothing to cancel" };
      const key = "cancel-all";
      beginAction(key);
      try {
        const current = session.state();
        if (!current) throw new Error("no session");

        const index = await assetIndex();
        const cancels = rows.map((row) => ({
          assetId: resolveAssetSpec(index, row.coin).assetId,
          oid: row.oid,
        }));

        // ONE bulk call, deliberately: cancels have partial-batch semantics
        // (a filled oid throws while the rest took effect), and for "cancel
        // everything" partial success is the acceptable outcome — the
        // websocket re-reads open orders either way, so what remains is
        // visibly what survived.
        const result = await cancelOrders({
          client: session.exchangeClient(),
          cancels,
          ...actingRoute(current.identity),
          onSpend: (n) => actionBudget.spend(current.identity, "cancel", n),
        });
        if (!result.ok) throw result.error ?? new Error("cancel refused");

        endAction(key, null);
        return { kind: "done", note: `cancelled ${cancels.length} orders` };
      } catch (caught) {
        const error = toHlError(caught);
        logger.warn("action.cancel_all_failed", { context: { count: rows.length }, error });
        endAction(key, error);
        // Partial-batch honesty: some cancels may have landed before the
        // throw. The open-orders store shows what is really left.
        return { kind: "failed", error };
      }
    },
    [session, beginAction, endAction]
  );

  const closeAll = useCallback(
    async (positions: readonly Position[]): Promise<ActionResult> => {
      if (positions.length === 0) return { kind: "done", note: "nothing to close" };
      const key = "close-all";
      beginAction(key);
      try {
        const current = session.state();
        if (!current) throw new Error("no session");

        const index = await assetIndex();

        // ONE fresh read prices every leg — closePosition's rule, batch-wide:
        // a market order priced off a stale mid is the one place this app must
        // not reuse a value, and N reads for one tap would be N-1 wasted.
        const mids = await weightBudget.tryRun("allMids", () => getInfoClient().allMids());
        if (mids === null) {
          throw new Error("rate limit — try again in a moment");
        }

        const legs = positions.map((position) => {
          const spec = resolveAssetSpec(index, position.coin);
          const reference = (mids as Record<string, string>)[position.coin];
          if (typeof reference !== "string") {
            // Refuse the WHOLE batch: "close all" that silently closes a
            // subset leaves the user believing they are flat when they are
            // not. The thrown coin names what blocked it.
            throw new Error(`no live price for ${position.coin} — nothing closed`);
          }
          // Closing a LONG is a SELL — same line, same warning as
          // closePosition: written backwards it doubles every position.
          const isBuy = position.side === "short";
          const price = marketLimitPrice({ referencePrice: reference, isBuy, asset: spec });
          return buildLimitOrder({
            asset: spec,
            isBuy,
            price,
            // Unsigned by contract — `side` carries the direction.
            size: position.size,
            tif: "Ioc",
            // Without this a rounding error or a concurrent fill opens the
            // opposite position rather than flattening it.
            reduceOnly: true,
          });
        });

        const outcome = await placeOrders({
          client: session.exchangeClient(),
          identity: current.identity,
          agentStatus: current.agent.status,
          budget: actionBudget,
          orders: legs,
        });

        if (outcome.kind === "rejected_locally") {
          // Definite, retry-safe failure — see closePosition.
          throw outcome.error;
        }
        if (outcome.kind === "unknown") {
          // Not an error: the orders may well have landed. Saying "failed"
          // here would invite a double close — see closePosition.
          endAction(key, null);
          return { kind: "unknown", note: "Outcome unknown — check open orders before retrying." };
        }

        const partialNote = settledCloseNote(outcome.result, "close-all");
        endAction(key, null);
        return {
          kind: "done",
          note: partialNote ?? `closing ${positions.length} positions`,
        };
      } catch (caught) {
        const error = toHlError(caught);
        logger.warn("action.close_all_failed", { context: { count: positions.length }, error });
        endAction(key, error);
        return { kind: "failed", error };
      }
    },
    [session, beginAction, endAction]
  );

  const setPositionTpsl = useCallback(
    async (
      position: Position,
      prices: { takeProfitPrice: string; stopLossPrice: string }
    ): Promise<ActionResult> => {
      const key = keyOfPosition(position);
      beginAction(key);
      try {
        const current = session.state();
        if (!current) throw new Error("no session");
        const spec = resolveAssetSpec(await assetIndex(), position.coin);

        // Whole-position brackets: size "0" under `positionTpsl`, so they
        // track the position instead of stranding at today's size.
        const { legs, grouping } = positionTpslLegs({
          asset: spec,
          side: position.side,
          takeProfitPrice: prices.takeProfitPrice,
          stopLossPrice: prices.stopLossPrice,
        });

        // REPLACE, never stack. Measured live: submitting a second bracket
        // adds to the first rather than superseding it, so a user nudging
        // their stop would end up holding two. Scoped to this coin's
        // WHOLE-POSITION brackets (`isPositionTpsl`) — a hand-placed stop
        // limit is the user's own order and is not this sheet's to cancel.
        const stale = session.stores.openOrders
          .read()
          .rows.filter((row) => row.coin === position.coin && row.isTrigger && row.isPositionTpsl);

        // The cancel above can only see brackets the exchange has already
        // reported. A bracket placed seconds ago is not in `rows` yet — the
        // snapshot lags by a few seconds, and `addUnconfirmed` is written only
        // by the startup reconciler, so nothing else covers the gap either. A
        // second apply inside that window therefore finds nothing to cancel
        // and STACKS, which is the exact outcome the cancel exists to prevent.
        //
        // So a placement is remembered per coin and the next apply refuses
        // until the exchange confirms it. Refusing is right rather than
        // over-cautious: the alternative is silently holding two whole-position
        // brackets, and the wait is bounded by the snapshot, not by a guess.
        const pendingSince = pendingTpsl.current.get(position.coin);
        if (pendingSince !== undefined) {
          if (stale.length > 0 || Date.now() - pendingSince > TPSL_CONFIRM_WINDOW_MS) {
            // Either it arrived (and is now in `stale`, so it will be
            // cancelled) or it never will — stop blocking on it.
            pendingTpsl.current.delete(position.coin);
          } else {
            throw new Error(
              "Your last TP/SL is still confirming — wait for it to appear before changing it."
            );
          }
        }
        if (stale.length > 0) {
          const cancelled = await cancelOrders({
            client: session.exchangeClient(),
            cancels: stale.map((row) => ({ assetId: spec.assetId, oid: row.oid })),
            ...actingRoute(current.identity),
            onSpend: (n) => actionBudget.spend(current.identity, "cancel", n),
          });
          // Refusing here is the safe direction: pressing on would leave the
          // old bracket beside the new one, which is the very thing this
          // cancel exists to prevent.
          if (!cancelled.ok) throw cancelled.error ?? new Error("could not clear the old TP/SL");
        }

        // An empty ticket after the cancel is a deliberate CLEAR, not an
        // error — the sheet's "leave a field empty to skip it" has to mean
        // something when both are empty.
        if (legs.length === 0) {
          endAction(key, null);
          return {
            kind: "done",
            note: stale.length > 0 ? `TP/SL cleared on ${position.coin}` : "nothing to change",
          };
        }

        const outcome = await placeOrders({
          client: session.exchangeClient(),
          identity: current.identity,
          agentStatus: current.agent.status,
          budget: actionBudget,
          orders: legs,
          grouping,
        });

        if (outcome.kind === "rejected_locally") throw outcome.error;
        if (outcome.kind === "unknown") {
          // It may have landed, so it blocks the next apply exactly as a
          // confirmed placement does — that is the whole point of `unknown`.
          pendingTpsl.current.set(position.coin, Date.now());
          endAction(key, null);
          return { kind: "unknown", note: "Outcome unknown — check open orders before retrying." };
        }
        // Settled ≠ placed — the same honesty rule the closes follow, and a
        // half-accepted pair must say so rather than claim both legs rest.
        const partialNote = settledCloseNote(outcome.result, "TP/SL");
        // Placed. Block the next apply for this coin until the exchange
        // reports it (see the note above the guard).
        pendingTpsl.current.set(position.coin, Date.now());
        endAction(key, null);
        return { kind: "done", note: partialNote ?? `TP/SL set on ${position.coin}` };
      } catch (caught) {
        const error = toHlError(caught);
        logger.warn("action.position_tpsl_failed", { context: { coin: position.coin }, error });
        endAction(key, error);
        return { kind: "failed", error };
      }
    },
    [session, beginAction, endAction]
  );

  const adjustIsolatedMargin = useCallback(
    async (position: Position, amountUsd: string): Promise<ActionResult> => {
      const key = keyOfPosition(position);
      beginAction(key);
      try {
        const current = session.state();
        if (!current) throw new Error("no session");
        const spec = resolveAssetSpec(await assetIndex(), position.coin);

        const result = await updateIsolatedMargin({
          client: session.exchangeClient(),
          assetId: spec.assetId,
          // The POSITION's side, not the direction of the money.
          isLong: position.side === "long",
          amountUsd,
          ...actingRoute(current.identity),
          onSpend: (n) => actionBudget.spend(current.identity, "other", n),
        });
        if (!result.ok) throw result.error ?? new Error("margin change refused");

        endAction(key, null);
        // Never claims the new margin figure — the account channel pushes what
        // the server actually applied, and this note must not pre-empt it.
        return { kind: "done", note: `margin updated on ${position.coin}` };
      } catch (caught) {
        const error = toHlError(caught);
        logger.warn("action.isolated_margin_failed", { context: { coin: position.coin }, error });
        endAction(key, error);
        return { kind: "failed", error };
      }
    },
    [session, beginAction, endAction]
  );

  return {
    state,
    isBusy: (key: string) => state.busyKeys.includes(key),
    orderKey: keyOfOrder,
    positionKey: keyOfPosition,
    cancelOrder,
    cancelAll,
    closePosition,
    closeAll,
    setPositionTpsl,
    adjustIsolatedMargin,
  };
}
