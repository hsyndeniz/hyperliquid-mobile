import { hlStringStorage } from "@/hyperliquid/storage/mmkv";

import {
  clockOffsetMs,
  clockSkew,
  observeServerTime,
  registerClockStorage,
  resetClock,
  restoreClockForTest,
  serverNow,
  toDeviceTime,
} from "@/hyperliquid/core/clock";

/** Well past the plausibility floor, so these read as real wall-clock stamps. */
const BASE = 1_800_000_000_000;

/**
 * Feed `count` frames whose server stamp sits `skewMs` from our receive time.
 *
 * Receive times advance so the samples are not literally identical — a real
 * feed never repeats an instant.
 */
function observe(skewMs: number, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const receivedAt = BASE + i * 500;
    observeServerTime(receivedAt + skewMs, receivedAt);
  }
}

beforeEach(resetClock);

describe("clockOffsetMs", () => {
  it("is zero before anything has been observed", () => {
    expect(clockOffsetMs()).toBe(0);
    expect(serverNow(BASE)).toBe(BASE);
  });

  it("stays zero below the sample floor — one frame is not evidence", () => {
    // A single frame could be the one that sat in a radio buffer. Two still
    // cannot outvote each other.
    observe(60_000, 2);
    expect(clockOffsetMs()).toBe(0);
  });

  it("ignores skew inside the deadband, so a healthy clock is left alone", () => {
    // A server stamp is written before the frame crosses the network, so even a
    // perfect clock measures a small negative offset. Correcting for that would
    // be correcting for noise.
    observe(-120, 9);
    expect(clockOffsetMs()).toBe(0);
    expect(serverNow(BASE)).toBe(BASE);
  });

  it("corrects a device running slow — the case that expires every order", () => {
    // Phone is a minute behind the exchange: its stamps read a minute early, so
    // the server's stamp lands a minute *ahead* of our receive time.
    observe(60_000, 5);
    expect(clockOffsetMs()).toBe(60_000);
    expect(serverNow(BASE)).toBe(BASE + 60_000);
  });

  it("corrects a device running fast", () => {
    observe(-60_000, 5);
    expect(clockOffsetMs()).toBe(-60_000);
    expect(serverNow(BASE)).toBe(BASE - 60_000);
  });

  it("takes the median, so one delayed frame cannot move the clock", () => {
    observe(60_000, 3);
    // One frame that sat somewhere for ten minutes.
    observeServerTime(BASE + 600_000, BASE);
    expect(clockOffsetMs()).toBe(60_000);
  });

  it("clamps an absurd measurement rather than trusting it", () => {
    observe(20 * 60 * 60 * 1_000, 5);
    expect(clockOffsetMs()).toBe(12 * 60 * 60 * 1_000);
  });

  it("ignores stamps that are not wall clocks", () => {
    // A `time` field that is really a duration, an index, or a test fixture.
    for (let i = 0; i < 9; i += 1) observeServerTime(1_000 + i, BASE + i);
    expect(clockSkew().samples).toBe(0);
    expect(clockOffsetMs()).toBe(0);
  });

  it("ignores a non-finite stamp", () => {
    for (let i = 0; i < 9; i += 1) observeServerTime(Number.NaN, BASE + i);
    expect(clockSkew().samples).toBe(0);
  });

  it("forgets everything on reset", () => {
    observe(60_000, 5);
    resetClock();
    expect(clockOffsetMs()).toBe(0);
    expect(clockSkew()).toEqual({ offsetMs: 0, rawOffsetMs: null, samples: 0 });
  });
});

describe("clockSkew", () => {
  it("reports the raw measurement even when the deadband suppressed it", () => {
    // So a support conversation can tell "measured nothing" from "measured
    // something small and deliberately ignored it".
    observe(-120, 5);
    expect(clockSkew()).toEqual({ offsetMs: 0, rawOffsetMs: -120, samples: 5 });
  });
});

describe("toDeviceTime", () => {
  it("inverts serverNow", () => {
    observe(60_000, 5);
    expect(toDeviceTime(serverNow(BASE))).toBe(BASE);
  });

  it("is identity while the clock is untrusted", () => {
    expect(toDeviceTime(BASE)).toBe(BASE);
  });
});

describe("surviving a cold start", () => {
  const STORE_KEY = "hl.clock.offset";

  // The clock takes its storage by INJECTION now (see `registerClockStorage`):
  // a static import of `storage/mmkv` here put react-native in the path of
  // every module that transitively imports the clock — nearly all of them —
  // which is invisible in the app and fatal in the bun-run smoke scripts.
  // `setupHyperliquid` does this wiring in the app; the suite does it itself.
  beforeEach(() => {
    registerClockStorage(hlStringStorage);
  });

  afterEach(() => {
    resetClock();
    hlStringStorage.removeItem(STORE_KEY);
    registerClockStorage(null);
  });

  it("persists NOTHING when no storage has been registered", () => {
    // The supported absent-storage state — a script or a test that never calls
    // `setupHyperliquid`. It must degrade to "relearn from the feed", never
    // throw, which is what every `storage?.` below is for.
    registerClockStorage(null);
    resetClock();
    expect(() => {
      observeServerTime(BASE + 60_000, BASE);
      restoreClockForTest();
    }).not.toThrow();
  });

  /**
   * A fresh process: in-memory state gone, whatever is on disk still there.
   *
   * Deliberately NOT `resetClock()`, which erases the stored value too — that
   * models an environment switch, not a relaunch, and using it here would have
   * tested nothing.
   */
  function coldStart(): void {
    restoreClockForTest();
  }

  it("has no correction at all before anything is stored — the hole this closes", () => {
    // The estimator needs three server-stamped frames past the deadband, and
    // the first order after launch routinely lands inside that window.
    coldStart();
    expect(clockOffsetMs()).toBe(0);
  });

  it("opens with the last known offset instead of zero", () => {
    observe(60_000, 5);
    expect(clockOffsetMs()).toBe(60_000);

    coldStart();
    expect(clockOffsetMs()).toBe(60_000);
    expect(serverNow(BASE)).toBe(BASE + 60_000);
  });

  it("lets real samples overrule the seed rather than being erased by them", () => {
    // The trap: `resolveOffset` returns 0 below the sample floor, so assigning
    // it on the first frame would throw the seed away in the very window the
    // seed exists for.
    observe(60_000, 5);
    coldStart();

    observeServerTime(BASE + 60_000, BASE);
    expect(clockOffsetMs()).toBe(60_000);

    // Three frames saying otherwise, and the measurement wins.
    for (let i = 0; i < 5; i += 1) observeServerTime(BASE - 20_000 + i, BASE + i);
    expect(clockOffsetMs()).toBe(-20_000);
  });

  it("ignores a stored offset older than a week", () => {
    hlStringStorage.setItem(
      STORE_KEY,
      JSON.stringify({ offsetMs: 60_000, at: Date.now() - 8 * 24 * 60 * 60 * 1_000 })
    );
    coldStart();
    expect(clockOffsetMs()).toBe(0);
  });

  it("ignores a stored value that is not a measurement", () => {
    for (const raw of ["not json", "null", '{"offsetMs":"60000"}', '{"at":1}', "[]"]) {
      hlStringStorage.setItem(STORE_KEY, raw);
      coldStart();
      expect(clockOffsetMs()).toBe(0);
    }
  });

  it("clamps a stored offset the same as a measured one", () => {
    hlStringStorage.setItem(
      STORE_KEY,
      JSON.stringify({ offsetMs: 20 * 60 * 60 * 1_000, at: Date.now() })
    );
    coldStart();
    expect(clockOffsetMs()).toBe(12 * 60 * 60 * 1_000);
  });

  it("does not write noise — only a move worth recording", () => {
    observe(60_000, 5);
    const first = hlStringStorage.getItem(STORE_KEY);
    expect(first).not.toBeNull();

    // A few ms of median jiggle, at the 1-4 Hz a live feed runs at.
    for (let i = 0; i < 9; i += 1) observeServerTime(BASE + 60_010 + i, BASE + i);
    expect(hlStringStorage.getItem(STORE_KEY)).toBe(first);
  });
});
