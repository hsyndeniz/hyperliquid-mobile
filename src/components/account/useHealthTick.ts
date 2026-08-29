/**
 * The two connection readings that have nothing to subscribe to.
 *
 * `weightBudget.used()` and `getConnectionState()` are plain field reads on
 * module singletons — no listener, no store — so this genuinely has to poll.
 * It does so every 2 s and **only while the screen is focused**: NativeTabs
 * keeps unfocused screens mounted, so a bare `useEffect` interval would tick
 * forever in the background, which is exactly the quiet waste the weight
 * budget exists to prevent.
 *
 * Lifted out of `HealthCard` because the reading is now needed in two places
 * at once — the card's gauge and the collapsed section header's measure — and
 * two independent 2 s intervals reading the same two fields would drift
 * against each other, showing different numbers a pixel apart.
 */

import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";

import { getConnectionState, type ConnectionState } from "@/hyperliquid/api/clients";
import { weightBudget } from "@/hyperliquid/api/weightBudget";

/** Gauge/socket refresh cadence while focused. */
export const HEALTH_TICK_MS = 2_000;

export interface HealthTick {
  /** Request weight spent in the trailing minute, device-wide. */
  used: number;
  socket: ConnectionState;
}

export function useHealthTick(): HealthTick {
  const [tick, setTick] = useState<HealthTick>({ used: 0, socket: "idle" });

  useFocusEffect(
    useCallback(() => {
      const read = (): void => {
        setTick({ used: weightBudget.used(Date.now()), socket: getConnectionState() });
      };
      read();
      const timer = setInterval(read, HEALTH_TICK_MS);
      return () => clearInterval(timer);
    }, [])
  );

  return tick;
}
