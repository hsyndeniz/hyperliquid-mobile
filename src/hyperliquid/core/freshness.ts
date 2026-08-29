/**
 * Freshness — proving that data belongs to what is on screen *now*.
 *
 * The rule this enforces, from the reference's hardest-won lessons:
 *
 * > Never show old book, ticker, or position data after an asset, account or
 * > DEX switch. Ticker recovery does not prove book recovery; each surface
 * > proves its own freshness. Cached data may seed a cold start but must never
 * > *display* as fresh for the wrong target.
 *
 * Every value arriving from a subscription is wrapped once, at the listener
 * boundary, so no surface can forget to stamp it — and comparison is by the
 * same `subscriptionKey` the mutation queue uses, so "is this current" means
 * exactly the same thing everywhere.
 */

import { observeServerTime, toDeviceTime } from "@/hyperliquid/core/clock";
import { subscriptionKey } from "@/hyperliquid/core/identity";
import type { Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

/**
 * Wrap an inbound value.
 *
 * The **only** place `receivedAt` is set.
 */
export function scope<T>(
  target: SubscriptionTarget,
  value: T,
  options?: { serverTime?: number | null; isSnapshot?: boolean; now?: () => number }
): Scoped<T> {
  const serverTime = options?.serverTime ?? null;
  const receivedAt = (options?.now ?? Date.now)();

  // The one instant at which both clocks are readable together, so this is
  // where the skew between them is measured. See `core/clock`.
  if (serverTime !== null) observeServerTime(serverTime, receivedAt);

  return {
    target,
    value,
    serverTime,
    receivedAt,
    isSnapshot: options?.isSnapshot ?? false,
  };
}

/** Whether a value belongs to the target currently displayed. */
export function isForTarget(scoped: Scoped<unknown>, current: SubscriptionTarget): boolean {
  return subscriptionKey(scoped.target) === subscriptionKey(current);
}

/**
 * Age in ms, against a device-clock `now`.
 *
 * Prefers the server's own timestamp where the channel supplies one — local
 * clocks drift, and on mobile they can be badly wrong. But preferring it is
 * only half the job: a server stamp minus a local `now` is a subtraction across
 * two clocks, which puts the drift straight back and inverts the result's
 * meaning — a slow phone would read every feed as eternally fresh. So the stamp
 * is translated onto the device clock first. `receivedAt` is already local and
 * needs nothing.
 */
export function ageMs(scoped: Scoped<unknown>, now: number): number {
  return now - deviceInstantOf(scoped);
}

/**
 * When this value happened, **on the device's clock**.
 *
 * The single translation every freshness and ordering decision goes through.
 * A `Scoped` carries two instants on two different clocks — `serverTime` from
 * the exchange, `receivedAt` from the phone — and picking between them with
 * `??` yields a number whose clock depends on which channel produced it. That
 * is fine right up until it is compared with something, which is always.
 *
 * Three call sites got this wrong independently, in three different ways, which
 * is the argument for naming it rather than repeating the `??`.
 */
export function deviceInstantOf(scoped: Scoped<unknown>): number {
  const stamped = scoped.serverTime ?? null;
  return stamped === null ? scoped.receivedAt : toDeviceTime(stamped);
}

/**
 * Whether a value is current: right target **and** not too old.
 *
 * Both halves are required. A value for the right target that arrived a minute
 * ago is stale; a fresh value for the previous coin is worse — it is wrong.
 */
export function isFresh(
  scoped: Scoped<unknown> | null | undefined,
  current: SubscriptionTarget,
  maxAgeMs: number,
  now: number
): boolean {
  if (!scoped) return false;
  return isForTarget(scoped, current) && ageMs(scoped, now) <= maxAgeMs;
}

/**
 * Narrow to a value safe to display, or `null`.
 *
 * The accessor a surface should read through: returning `null` renders an empty
 * state, which is always preferable to rendering another market's numbers.
 */
export function freshValue<T>(
  scoped: Scoped<T> | null | undefined,
  current: SubscriptionTarget,
  maxAgeMs: number,
  now: number
): T | null {
  return isFresh(scoped, current, maxAgeMs, now) ? (scoped as Scoped<T>).value : null;
}
