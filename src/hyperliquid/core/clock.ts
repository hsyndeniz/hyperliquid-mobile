/**
 * Clock skew — reconciling the device's clock with the exchange's.
 *
 * Two numbers in this codebase live on the *exchange's* clock rather than the
 * phone's, and both are silently wrong when the two disagree:
 *
 * 1. `expiresAfter`. Every L1 action carries an instant past which the exchange
 *    must not accept it. We compute it as `Date.now() + 30s`, so a phone
 *    running a minute slow signs actions that are *born expired*, with nothing
 *    in the app to explain why.
 *
 *    Which clock the exchange checks it against is NOT documented: the spec is
 *    three sentences and names no clock, and the "15 seconds" in the "Action
 *    already expired" FAQ is the web frontend's own delay-protection default —
 *    about congestion, not clock validity. That it must be the chain's own
 *    block time is an INFERENCE (a validator has no other clock to reach for),
 *    and it is flagged as one rather than quoted as fact. The consequence holds
 *    either way, and field reports add a second one: a stale `expiresAfter` is
 *    reported to cost 5x the normal address-based rate limit per attempt, so a
 *    slow clock is expensive as well as broken.
 * 2. `Scoped.serverTime`. Frames are stamped with the server's clock precisely
 *    so freshness does not inherit a bad mobile clock — and then compared
 *    against a local `Date.now()`, which puts the error straight back. A phone
 *    running slow makes every feed look eternally fresh; running fast makes the
 *    whole app look permanently stale.
 *
 * Nonces are the third, and they are subtler than the (T − 2 days, T + 1 day)
 * window suggests. The window is the loose bound; the one that actually binds
 * is that a nonce must exceed the SMALLEST of the signer's 100 highest — a
 * one-way ratchet, not a time tolerance. Every field report of a real nonce
 * rejection sits deep inside the ±day window and trips that ratchet instead.
 *
 * Two things keep this app clear of it: the SDK's monotonic manager, so it
 * cannot undercut itself within a session, and a dedicated per-install agent
 * key, so no other process raises the floor. Neither survives a process
 * restart combined with a backward clock jump, which is why the nonce is built
 * on {@link serverNow} too — see `api/clients.ts`. `expiresAfter` remains the
 * tighter constraint by three orders of magnitude.
 *
 * The fix is one offset, learned from frames we already receive: every scoped
 * value carries both the server's stamp and our receive time, so their
 * difference *is* the skew. See {@link observeServerTime}.
 */

/**
 * Where the learned offset is kept between launches.
 *
 * INJECTED, not imported — the same reasoning `setup.ts` gives for the Sentry
 * SDK. This module is pulled in by `core/freshness` and therefore by almost
 * everything, so a static `import` of `storage/mmkv` puts `react-native-mmkv`
 * (and through it all of react-native) in the path of every consumer. That is
 * invisible inside the app and fatal outside it: the smoke scripts run under
 * bun, which cannot parse react-native's Flow-typed source, so the live
 * payload canary this project relies on after any `state/` or `api/` change
 * died the day this import was added — with an error naming react-native and
 * nothing to do with the clock.
 *
 * Absent storage is a supported state, not a failure: the offset is simply
 * relearned from the first frames, which the estimator does within seconds.
 * That is why every use below tolerates `null` rather than asserting.
 */
export interface ClockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let storage: ClockStorage | null = null;

/** Hand the clock its persistence. Called once from `setupHyperliquid`. */
export function registerClockStorage(store: ClockStorage | null): void {
  storage = store;
}

/**
 * Samples before the offset is trusted at all.
 *
 * A single frame is not evidence — it could be the one that sat in a buffer.
 */
const MIN_SAMPLES = 3;

/** How many recent samples the median is taken over. */
const SAMPLE_CAP = 9;

/**
 * Offsets smaller than this are treated as zero.
 *
 * A frame's server stamp is written before it crosses the network, so even a
 * perfectly synchronised phone measures an offset of roughly minus one-way
 * latency. That is tens of milliseconds, and correcting for it would be
 * correcting for noise. The deadband keeps the normal case — a phone whose
 * clock is fine — on a path byte-identical to the one before this module
 * existed, and reserves the correction for skew that actually threatens a
 * 30-second expiry window.
 */
const DEADBAND_MS = 2_000;

/**
 * Ceiling on the correction.
 *
 * Real skew is minutes; a manually-set clock might be hours out. Anything
 * beyond this is likelier to be a malformed frame than a real clock, and an
 * unbounded offset could push `expiresAfter` somewhere absurd. Clamping bounds
 * the damage a bad measurement can do without discarding a real one.
 */
const MAX_OFFSET_MS = 12 * 60 * 60 * 1_000;

/**
 * Below this, a "server time" is not a wall clock.
 *
 * Roughly November 2023 — comfortably before this exchange existed and
 * comfortably after any small integer a payload might carry in a `time` field
 * that is really a duration, an index, or a test fixture. Rejecting those keeps
 * a mis-read field from moving the clock.
 */
const PLAUSIBLE_EPOCH_FLOOR = 1_700_000_000_000;

/**
 * Skew past which the device's clock is worth telling someone about.
 *
 * A third of the 30s expiry window. Below it nothing in the app depends on the
 * correction; above it the app still works — that is what the correction is for
 * — but the phone's clock is wrong enough that something else on it will
 * eventually break too. Diagnostic, not a gate.
 */
export const CLOCK_SKEW_LIMIT_MS = 10_000;

/**
 * Where the last known offset is kept between launches.
 *
 * Without it the correction is absent exactly when it is most needed. The
 * estimator needs three server-stamped frames past the deadband, which takes a
 * second or two of live feed — and the first order after launch is routinely
 * placed inside that window, uncorrected. A clock that was two minutes slow
 * yesterday is two minutes slow today, so the previous measurement is a far
 * better opening guess than zero.
 *
 * Provisional, not authoritative: the first three real samples replace it.
 */
const STORE_KEY = "hl.clock.offset";

/**
 * How stale a stored offset may be and still be trusted.
 *
 * A week. Long enough to cover a phone that is simply set wrong, short enough
 * that an offset from a device the user has since fixed does not haunt them —
 * and either way it survives only until the first three frames arrive.
 */
const SEED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * How much the offset must move before it is written again.
 *
 * The median jiggles by a few ms on every frame once it is past the deadband,
 * and a feed runs at 1-4 Hz. Writing each time would hammer storage to record
 * noise; a second is far below anything that matters against a 30s window.
 */
const PERSIST_DELTA_MS = 1_000;

let samples: number[] = [];
let offsetMs = 0;
let persistedOffsetMs = 0;
let restored = false;

/**
 * Record one (server stamp, local receive time) pair.
 *
 * Called from `scope()` — the one place both clocks are readable at the same
 * instant — for every frame whose channel supplies a timestamp. Cheap enough to
 * run per frame: one push, one shift, one median over at most nine numbers.
 *
 * Implausible stamps are ignored rather than clamped: a channel that stopped
 * supplying a real timestamp should leave the offset alone, not drag it.
 */
export function observeServerTime(serverTime: number, receivedAt: number): void {
  if (!Number.isFinite(serverTime) || serverTime < PLAUSIBLE_EPOCH_FLOOR) return;
  if (!Number.isFinite(receivedAt) || receivedAt < PLAUSIBLE_EPOCH_FLOOR) return;

  ensureRestored();
  samples.push(serverTime - receivedAt);
  if (samples.length > SAMPLE_CAP) samples.shift();

  // Below the sample floor the seed stands. Assigning `resolveOffset`'s zero
  // here would discard a restored offset on the very first frame — which is the
  // window the seed exists to cover.
  if (samples.length < MIN_SAMPLES) return;

  const next = resolveOffset(samples);
  if (next === offsetMs) return;
  offsetMs = next;
  persist(next);
}

/**
 * The correction, in ms, to add to a device instant to get a server instant.
 *
 * Zero until the offset is both established and large enough to matter, so a
 * caller never has to ask whether it is safe to apply.
 */
export function clockOffsetMs(): number {
  ensureRestored();
  return offsetMs;
}

/** Now, on the exchange's clock. The instant `expiresAfter` must be built from. */
export function serverNow(deviceNow: number = Date.now()): number {
  ensureRestored();
  return deviceNow + offsetMs;
}

/**
 * Translate a server instant onto the device clock.
 *
 * The inverse of {@link serverNow}, for comparing a server stamp against a
 * local `Date.now()` — which is what every freshness check does.
 */
export function toDeviceTime(serverInstant: number): number {
  ensureRestored();
  return serverInstant - offsetMs;
}

/**
 * The measurement behind the correction, for diagnostics.
 *
 * `rawOffsetMs` is the median before the deadband and clamp, so a support
 * conversation can distinguish "we measured nothing" from "we measured a small
 * skew and deliberately ignored it".
 */
export function clockSkew(): { offsetMs: number; rawOffsetMs: number | null; samples: number } {
  return {
    offsetMs,
    rawOffsetMs: samples.length === 0 ? null : median(samples),
    samples: samples.length,
  };
}

/** Drop every measurement. For tests, and for an environment switch. */
export function resetClock(): void {
  samples = [];
  offsetMs = 0;
  persistedOffsetMs = 0;
  // `restored` stays true so a reset does not immediately re-seed from disk —
  // a test that reset expects zero, not yesterday's measurement.
  restored = true;
  try {
    storage?.removeItem(STORE_KEY);
  } catch {
    // Storage is best-effort here; see `persist`.
  }
}

/**
 * Re-arm the lazy restore, as a fresh process would find it. **Tests only.**
 *
 * `resetClock` deliberately leaves the clock marked restored so a test that
 * reset gets zero rather than yesterday's measurement; this is the other half,
 * for the tests that need to model a cold start specifically.
 */
export function restoreClockForTest(): void {
  restored = false;
  samples = [];
  offsetMs = 0;
  persistedOffsetMs = 0;
  ensureRestored();
}

/**
 * Read the stored offset, once, on first use.
 *
 * Lazy rather than at module load: this module is imported by `core/freshness`
 * and therefore by almost everything, and touching MMKV at import time is the
 * failure `moduleImports.test.ts` exists to catch.
 */
function ensureRestored(now: number = Date.now()): void {
  if (restored) return;
  restored = true;
  try {
    const raw = storage?.getItem(STORE_KEY) ?? null;
    if (raw === null) return;
    const saved: unknown = JSON.parse(raw);
    if (typeof saved !== "object" || saved === null) return;
    const { offsetMs: storedOffset, at } = saved as { offsetMs?: unknown; at?: unknown };
    if (typeof storedOffset !== "number" || !Number.isFinite(storedOffset)) return;
    if (typeof at !== "number" || !Number.isFinite(at)) return;
    if (now - at > SEED_MAX_AGE_MS || now < at) return;
    if (Math.abs(storedOffset) < DEADBAND_MS) return;
    offsetMs = clamp(storedOffset);
    persistedOffsetMs = offsetMs;
  } catch {
    // A malformed or unreadable value must not stop the app starting; the
    // estimator will have a real offset within seconds regardless.
  }
}

/** Write the offset, but only when it has moved enough to be worth recording. */
function persist(next: number): void {
  if (Math.abs(next - persistedOffsetMs) < PERSIST_DELTA_MS) return;
  persistedOffsetMs = next;
  try {
    storage?.setItem(STORE_KEY, JSON.stringify({ offsetMs: next, at: Date.now() }));
  } catch {
    // Best-effort: a device that cannot persist still corrects within seconds
    // of the feed opening, it just does not get the head start.
  }
}

function clamp(value: number): number {
  return Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, value));
}

function resolveOffset(observed: number[]): number {
  if (observed.length < MIN_SAMPLES) return 0;

  // Median, not mean: one frame delayed by a slow radio must not move the
  // clock, and with an even count the lower of the two middles is the more
  // conservative pick (a smaller correction).
  const raw = median(observed);
  if (Math.abs(raw) < DEADBAND_MS) return 0;
  return clamp(raw);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}
