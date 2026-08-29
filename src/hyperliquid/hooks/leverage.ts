/**
 * An asset's leverage setting — the server-side `{ isCross, leverage }` pair
 * the Margin Mode and Adjust Leverage sheets read and write.
 *
 * ## Why this is REST, not a websocket channel
 *
 * The `activeAssetData` subscription exists, but it opens under the account's
 * websocket identity and every distinct user counts toward the server's
 * 15-user cap per socket. The value here changes on exactly two events — the
 * user switches market, or the user applies a change in a sheet — both of
 * which are moments this hook already knows about. An event-driven REST read
 * (weight 2) matches the data's real cadence; a streaming channel would spend
 * a scarce slot to watch a value that only this app changes.
 *
 * ## Never optimistic
 *
 * `apply` submits and then RE-READS. The pair shown after a change is the
 * server's answer, not the slider's, because the exchange refuses changes the
 * UI cannot predict: lowering leverage below what an open position's margin
 * needs, or switching mode while a position or open orders exist. An
 * optimistic pill would mis-state the margin regime every subsequent order is
 * sized against.
 *
 * Perp-only: spot has no leverage, and the hook returns nulls there rather
 * than asking the exchange a question that has no answer.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { getInfoClient } from "@/hyperliquid/api/clients";
import { actionBudget } from "@/hyperliquid/api/rateLimit";
import { weightBudget } from "@/hyperliquid/api/weightBudget";
import { resolveAssetSpec } from "@/hyperliquid/assets";
import { toHlError, type HlError } from "@/hyperliquid/core/errors";
import { actingRoute } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import { assetIndex } from "@/hyperliquid/hooks/assets";
import { useSessionState } from "@/hyperliquid/hooks/session";
import { updateLeverage } from "@/hyperliquid/orders/exchange";
import type { HyperliquidSession } from "@/hyperliquid/session";

const logger = log.child("hooks.leverage");

/** The pair the exchange stores per asset per account. */
export interface AssetLeverageView {
  leverage: number;
  isCross: boolean;
}

/** What an apply reports back — the same shape the account actions use. */
export type LeverageResult = { kind: "done"; note: string } | { kind: "failed"; error: HlError };

/**
 * Parse an `activeAssetData` response defensively.
 *
 * Exported for tests. Returns null on any shape surprise — a wrong guess here
 * becomes a wrong margin figure on the ticket, so no partial credit.
 */
export function parseActiveAssetData(raw: unknown): AssetLeverageView | null {
  const leverage = (raw as { leverage?: unknown } | null)?.leverage as
    { type?: unknown; value?: unknown } | undefined;
  if (!leverage) return null;
  if (leverage.type !== "cross" && leverage.type !== "isolated") return null;
  if (typeof leverage.value !== "number" || !Number.isFinite(leverage.value)) return null;
  return { leverage: leverage.value, isCross: leverage.type === "cross" };
}

export function useAssetLeverage(
  session: HyperliquidSession,
  wireCoin: string,
  kind: "perp" | "spot"
): {
  /** The server's confirmed pair; null before the first read (or on spot). */
  value: AssetLeverageView | null;
  /** True when the last read was declined by the weight budget. */
  deferred: boolean;
  refresh: () => void;
  /** Submit a change, then re-read — resolves AFTER the server confirms. */
  apply: (next: AssetLeverageView) => Promise<LeverageResult>;
  applying: boolean;
} {
  const sessionState = useSessionState(session);
  // The ACTING address: a sub-account's leverage settings are its own, not
  // the master's — reading the master while acting as the sub would show a
  // regime the next order will not actually get.
  const acting = sessionState
    ? (sessionState.identity.subAccount ?? sessionState.identity.address)
    : null;

  const key = acting !== null && kind === "perp" ? `${acting}:${wireCoin}` : null;

  const [entry, setEntry] = useState<{
    key: string | null;
    value: AssetLeverageView | null;
    deferred: boolean;
  }>({ key: null, value: null, deferred: false });
  const [applying, setApplying] = useState(false);

  // The key the hook is CURRENTLY showing — written only inside the effect
  // (the compiler forbids render-phase ref writes) and consulted after every
  // await, so a slow read for the previous market can never clobber the new
  // market's confirmed entry (BTC's response landing after a switch to ETH
  // would otherwise overwrite ETH's pair, and nothing would ever re-read).
  const liveKey = useRef<string | null>(null);
  // A declined read is a DEFERRAL, not an answer — the counter re-fires the
  // effect after a pause, because pills showing account-default guesses for a
  // whole market visit is exactly the optimistic display this hook prevents.
  const [attempt, setAttempt] = useState(0);

  const read = useCallback(async (): Promise<"deferred" | "done"> => {
    if (key === null || acting === null) return "done";
    const raw = await weightBudget.tryRun("activeAssetData", () =>
      getInfoClient().activeAssetData({ user: acting as `0x${string}`, coin: wireCoin })
    );
    if (liveKey.current !== key) return "done"; // stale flight — drop it whole
    if (raw === null) {
      // Deferred, and it SAYS SO even when a previous value is kept.
      //
      // The old line returned the existing entry untouched, so a declined read
      // left `deferred: false` on a value the budget had just refused to
      // confirm — the UI showed a stale leverage and margin mode as if freshly
      // read. Worst after a successful apply(): the exchange holds the new
      // pair, the confirming read is declined, and the pill still reads the
      // OLD leverage with no indication, so the next order is sized against a
      // regime that no longer applies. Keeping the value is right (a blank pill
      // mid-visit is worse); claiming it is current is not.
      setEntry((current) =>
        current.key === key
          ? current.deferred
            ? current
            : { ...current, deferred: true }
          : { key, value: null, deferred: true }
      );
      return "deferred";
    }
    const parsed = parseActiveAssetData(raw);
    setEntry({ key, value: parsed, deferred: false });
    return "done";
  }, [key, acting, wireCoin]);

  useEffect(() => {
    liveKey.current = key;
    // `cancelled` rather than `liveKey` alone. The retry below is scheduled
    // from inside an async `.then`, which can land AFTER cleanup has already
    // run — and `liveKey.current` is only ever assigned, never reset, so on
    // unmount it still equals `key` and the guard would happily arm a 5s timer
    // that nothing is left to clear. It would then wake to `setAttempt` on an
    // unmounted hook. One stray timer per abandoned market, which a user
    // browsing markets does repeatedly.
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // Deferred a tick so nothing writes state synchronously from the effect —
    // the useFetch precedent (hooks/history.ts).
    const timer = setTimeout(() => {
      void read().then((state) => {
        if (cancelled) return;
        if (state === "deferred" && liveKey.current === key) {
          retry = setTimeout(() => setAttempt((n) => n + 1), 5_000);
        }
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (retry !== null) clearTimeout(retry);
    };
  }, [read, key, attempt]);

  // A market or account switch shows NO stale pair for even a frame: the
  // displayed entry is only trusted when it belongs to the current key.
  const current = entry.key === key ? entry : { key, value: null, deferred: false };

  const apply = useCallback(
    async (next: AssetLeverageView): Promise<LeverageResult> => {
      setApplying(true);
      try {
        const state = session.state();
        if (!state) throw new Error("no session");
        const spec = resolveAssetSpec(await assetIndex(), wireCoin);

        const result = await updateLeverage({
          client: session.exchangeClient(),
          assetId: spec.assetId,
          leverage: next.leverage,
          isCross: next.isCross,
          ...actingRoute(state.identity),
          onSpend: (n) => actionBudget.spend(state.identity, "other", n),
        });
        if (!result.ok) throw result.error ?? new Error("leverage change refused");

        // Confirmation IS the re-read — the sheet stays "applying" until the
        // server's answer replaces the slider's.
        //
        // A DECLINED re-read is the dangerous case: the change succeeded
        // server-side, so the displayed pair is now provably wrong. It reports
        // `deferred` (see `read`), and the retry counter is bumped so the
        // scheduled attempt runs rather than leaving the correction to whenever
        // the market next changes.
        if ((await read()) === "deferred") {
          setAttempt((n) => n + 1);
        }
        return {
          kind: "done",
          note: `${next.isCross ? "Cross" : "Isolated"} ${next.leverage}x`,
        };
      } catch (caught) {
        const error = toHlError(caught);
        logger.warn("leverage.apply_failed", { context: { coin: wireCoin }, error });
        return { kind: "failed", error };
      } finally {
        setApplying(false);
      }
    },
    [session, wireCoin, read]
  );

  return { value: current.value, deferred: current.deferred, refresh: read, apply, applying };
}
