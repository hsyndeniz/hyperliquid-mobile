/**
 * Deposit reads, for the screen.
 *
 * This module covers the **address-first** half of depositing: which network to
 * send on, and whether anything has landed. Executing a transfer from the app's
 * own wallet is a separate concern with a separate signer, and lives elsewhere.
 *
 * ## Watching for a deposit that this app did not send
 *
 * `deposits/arrival.ts` `checkArrival` matches a *specific* transfer by amount
 * and time, which is right when the app sent it. Here the user is paying in
 * from Coinbase or MetaMask, so there is no amount and no `sentAt` to match —
 * only "has anything arrived since I opened this screen".
 *
 * So this polls the ledger for `{type: "deposit"}` rows newer than the moment
 * the screen opened, via the same `parseDepositCredits` the matcher uses. It
 * reports credits; it never reports a failure, because absence is not evidence:
 * a quorum not yet reached is indistinguishable from a slow one.
 *
 * **It watches the ledger, not the balance.** A deposit credits the PERP
 * account (measured; `state/spot.ts` used to claim otherwise), and a balance
 * that moves for some other reason is not a deposit.
 */

import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";

import { getInfoClient } from "@/hyperliquid/api/clients";
import { weightBudget } from "@/hyperliquid/api/weightBudget";
import { log } from "@/hyperliquid/core/logger";
import {
  parseDepositCredits,
  type DepositCredit,
  type LedgerProbe,
} from "@/hyperliquid/deposits/arrival";
import {
  depositNetwork,
  depositsAvailable,
  type DepositNetwork,
} from "@/hyperliquid/deposits/network";
import type { Hex, HlEnv } from "@/hyperliquid/types/domain";

const logger = log.child("hooks.deposit");

/** How often to re-read the ledger while the screen is open. */
export const DEPOSIT_WATCH_INTERVAL_MS = 5_000;

/**
 * The network to deposit on, or `null` when this env has no bridge.
 *
 * `depositNetwork` throws for an unsupported env rather than returning null, so
 * the availability check comes first — a screen must be able to say "not
 * available here" without catching.
 */
export function useDepositNetwork(env: HlEnv): DepositNetwork | null {
  return depositsAvailable(env) ? depositNetwork(env) : null;
}

/**
 * Deposits credited since the screen opened.
 *
 * Newest first. Empty is the normal state and means nothing — see the header.
 */
export function useIncomingDeposits(user: Hex | null): {
  credits: readonly DepositCredit[];
  since: number;
  refresh: () => void;
} {
  // Fixed at mount: the window must not slide, or a credit that arrives while
  // a request is in flight falls outside the next one and is never seen.
  const [since] = useState(() => Date.now());
  const [credits, setCredits] = useState<readonly DepositCredit[]>([]);

  const load = useCallback(async () => {
    if (user === null) return;
    try {
      const rows = await weightBudget.tryRun("userNonFundingLedgerUpdates", () =>
        (getInfoClient() as unknown as LedgerProbe).userNonFundingLedgerUpdates({
          user,
          startTime: since,
        })
      );
      // Deferred by the budget is not "nothing arrived" — leave what we have.
      if (rows === null) return;
      setCredits(parseDepositCredits(rows, since).sort((a, b) => b.at - a.at));
    } catch (error) {
      logger.warn("deposit.watch_failed", { error });
    }
  }, [user, since]);

  // FOCUS-gated, like `useMarketList`'s mids poll and for a stronger version of
  // the same reason. This calls a 20-weight endpoint every 5 s — 240 weight per
  // minute, a quarter of the enforced 1000, held down for as long as the screen
  // is mounted. The mids poll it copies is 8 weight/min and was gated with the
  // note "a backgrounded tab must not spend 8 weight/min forever"; this is 30x
  // heavier and was the only ungated sustained poll in the tree.
  //
  // Backgrounding is exactly when it runs: the user has left for their exchange
  // app to send the funds, and Android keeps JS timers alive throughout. The
  // polling buys nothing there either — `since` is fixed at mount, so one poll
  // on return catches every credit in the window.
  useFocusEffect(
    useCallback(() => {
      if (user === null) return;
      // Deferred a tick so the mount effect never writes state synchronously.
      const first = setTimeout(() => void load(), 0);
      const timer = setInterval(() => void load(), DEPOSIT_WATCH_INTERVAL_MS);
      return () => {
        clearTimeout(first);
        clearInterval(timer);
      };
    }, [user, load])
  );

  return { credits, since, refresh: () => void load() };
}
