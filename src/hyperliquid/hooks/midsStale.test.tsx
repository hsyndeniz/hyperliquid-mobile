/**
 * `useMidsStale` exists so three whole screens stop re-rendering every ≤5 s.
 *
 * The contract under test is the RENDER COUNT, not the boolean: the tick and
 * the poll notifications keep firing, and the consumer must re-render only
 * when the staleness answer flips. If a change here makes the hook hand back
 * a fresh value per tick again, the Markets tab quietly returns to a 13–77 ms
 * whole-screen render every five seconds — the regression is invisible in a
 * value assertion and loud in a render count.
 */

import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { marketMids, MIDS_STALE_AFTER_MS, useMidsStale } from "@/hyperliquid/hooks/markets";

const TICK_MS = 5_000;

/** Each call is one render; the argument is that render's value. */
const probe = jest.fn<void, [boolean]>();
const renderCount = (): number => probe.mock.calls.length;
const lastValue = (): boolean | undefined => probe.mock.lastCall?.[0];

function Probe(): null {
  probe(useMidsStale(MIDS_STALE_AFTER_MS, TICK_MS));
  return null;
}

describe("useMidsStale", () => {
  let tree: ReactTestRenderer | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    probe.mockClear();
    // A fresh poll so age starts near zero.
    marketMids.set({ BTC: "1" }, Date.now());
  });

  afterEach(() => {
    act(() => tree?.unmount());
    tree = null;
    jest.useRealTimers();
  });

  it("does not re-render on ticks while the answer holds", () => {
    act(() => {
      tree = create(<Probe />);
    });
    const after_mount = renderCount();
    expect(lastValue()).toBe(false);

    // Two ticks inside the freshness window: the interval fires, the state
    // write bails out, nothing renders.
    act(() => {
      jest.advanceTimersByTime(TICK_MS * 2);
    });
    expect(lastValue()).toBe(false);
    expect(renderCount()).toBe(after_mount);
  });

  it("renders on the flip, settles, then holds flat across stale ticks", () => {
    act(() => {
      tree = create(<Probe />);
    });
    const after_mount = renderCount();

    // Cross the threshold: the next tick flips the answer — one render.
    act(() => {
      jest.advanceTimersByTime(MIDS_STALE_AFTER_MS + TICK_MS);
    });
    expect(lastValue()).toBe(true);
    expect(renderCount()).toBe(after_mount + 1);

    // React's documented bail-out caveat: the first same-value set AFTER a
    // change may render once more before the fiber is marked clean. One
    // settling render is allowed; what must not happen is one per tick.
    act(() => {
      jest.advanceTimersByTime(TICK_MS);
    });
    const settled = renderCount();
    expect(settled).toBeLessThanOrEqual(after_mount + 2);

    // The guard: further stale ticks add NOTHING.
    act(() => {
      jest.advanceTimersByTime(TICK_MS * 4);
    });
    expect(renderCount()).toBe(settled);

    // A poll landing recovers it — the store notification flips it back.
    act(() => {
      marketMids.set({ BTC: "2" }, Date.now());
    });
    expect(lastValue()).toBe(false);
    expect(renderCount()).toBe(settled + 1);
  });

  it("does not re-render on poll frames that keep it fresh", () => {
    act(() => {
      tree = create(<Probe />);
    });
    const after_mount = renderCount();

    // Three mids frames inside the window — the store notifies each time, the
    // hook's write bails out every time.
    act(() => {
      marketMids.set({ BTC: "3" }, Date.now());
      marketMids.set({ BTC: "4" }, Date.now());
      marketMids.set({ BTC: "5" }, Date.now());
    });
    expect(lastValue()).toBe(false);
    expect(renderCount()).toBe(after_mount);
  });
});
