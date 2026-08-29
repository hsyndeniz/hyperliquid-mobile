/**
 * The notification banner's read path, through real mount/commit cycles.
 *
 * Two rules are load-bearing and neither is visible to a selector test:
 *
 * - **`getSnapshot` must be referentially stable.** The store memoises `read()`
 *   for this; `unacknowledged()` is a fresh array every call. Subscribing to the
 *   wrong one makes React re-render forever, which shows up as a hang rather
 *   than a failure — so the "no infinite loop" case is asserted by counting
 *   renders, not by the suite completing.
 * - **Acknowledging must not swallow a message that arrived since the render.**
 *   That is the exact moment a liquidation warning is most likely to land.
 */

import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { createIdentity } from "@/hyperliquid/core/identity";
import { useUnacknowledged } from "@/hyperliquid/hooks/notifications";
import { NotificationStore } from "@/hyperliquid/state/notifications";
import type { Notification } from "@/hyperliquid/state/notifications";
import type { SubscriptionTarget } from "@/hyperliquid/types/domain";

const IDENTITY = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});

function target(): SubscriptionTarget {
  return {
    identity: IDENTITY,
    channel: "notification",
    coin: null,
    aggregation: null,
    interval: null,
  };
}

function deliver(store: NotificationStore, text: string): void {
  store.apply({
    target: target(),
    // `value`, matching the `Scoped` envelope `channels.ts` stamps.
    value: { notification: text },
    receivedAt: 1,
    serverTime: null,
    isSnapshot: false,
  });
}

/**
 * A probe and its capture, built per test.
 *
 * `react-hooks/globals` rejects a component writing to any binding declared
 * outside it, so the capture has to be a local the probe closes over — which is
 * also what keeps one test's render count from leaking into the next.
 */
function makeProbe(): {
  Probe: (props: { store: NotificationStore }) => null;
  pending: () => readonly Notification[];
  acknowledge: (seq: number) => void;
  renders: () => number;
} {
  const seen: { pending: readonly Notification[]; ack: (seq: number) => void }[] = [];
  function Probe({ store }: { store: NotificationStore }): null {
    const result = useUnacknowledged(store);
    seen.push({ pending: result.pending, ack: result.acknowledge });
    return null;
  }
  const last = () => seen[seen.length - 1];
  return {
    Probe,
    pending: () => last()?.pending ?? [],
    acknowledge: (seq: number) => last()?.ack(seq),
    renders: () => seen.length,
  };
}

describe("useUnacknowledged", () => {
  let store: NotificationStore;
  let tree: ReactTestRenderer;

  beforeEach(() => {
    store = new NotificationStore();
    store.setTarget(target());
  });

  afterEach(() => {
    act(() => tree?.unmount());
  });

  it("does not re-render forever", () => {
    const probe = makeProbe();
    // A `getSnapshot` that builds a fresh array each call loops here. React
    // gives up after ~25 nested updates with an error, but a low ceiling
    // catches it as the defect it is rather than as a stack trace.
    act(() => {
      tree = create(<probe.Probe store={store} />);
    });
    expect(probe.renders()).toBeLessThan(5);
  });

  it("surfaces a message the moment it arrives", () => {
    const probe = makeProbe();
    act(() => {
      tree = create(<probe.Probe store={store} />);
    });
    expect(probe.pending()).toHaveLength(0);

    act(() => deliver(store, "Your BTC position is close to liquidation"));

    expect(probe.pending()).toHaveLength(1);
    expect(probe.pending()[0]?.text).toBe("Your BTC position is close to liquidation");
  });

  it("re-renders on dismissal, not just on arrival", () => {
    const probe = makeProbe();
    act(() => {
      tree = create(<probe.Probe store={store} />);
    });
    act(() => deliver(store, "one"));
    expect(probe.pending()).toHaveLength(1);

    act(() => probe.acknowledge(probe.pending()[0]!.seq));

    // `acknowledge` nulls the store's memoised view and emits, so the component
    // re-reads. Without that emit the banner would stay on screen after a tap.
    expect(probe.pending()).toHaveLength(0);
  });

  it("does NOT swallow a message that arrives between render and dismissal", () => {
    const probe = makeProbe();
    act(() => {
      tree = create(<probe.Probe store={store} />);
    });
    act(() => deliver(store, "first"));
    const shown = probe.pending()[0]!.seq;

    // The race: a second message lands while the banner is on screen.
    act(() => deliver(store, "second — liquidation warning"));
    // The user taps Dismiss, which acknowledges only what they were SHOWN.
    act(() => probe.acknowledge(shown));

    expect(probe.pending()).toHaveLength(1);
    expect(probe.pending()[0]?.text).toBe("second — liquidation warning");
  });

  it("keeps two identical messages as two entries", () => {
    const probe = makeProbe();
    act(() => {
      tree = create(<probe.Probe store={store} />);
    });
    act(() => {
      deliver(store, "same text");
      deliver(store, "same text");
    });

    // The wire supplies no id, and text collides in practice — dedup by text
    // would hide the second of two real warnings.
    expect(probe.pending()).toHaveLength(2);
    expect(probe.pending()[0]!.seq).not.toBe(probe.pending()[1]!.seq);
  });

  it("shows nothing from a previous account after a target change", () => {
    const probe = makeProbe();
    act(() => {
      tree = create(<probe.Probe store={store} />);
    });
    act(() => deliver(store, "account A's liquidation warning"));
    expect(probe.pending()).toHaveLength(1);

    const other = createIdentity({
      env: "testnet",
      accountId: "acc",
      address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    act(() =>
      store.setTarget({
        identity: other,
        channel: "notification",
        coin: null,
        aggregation: null,
        interval: null,
      })
    );

    expect(probe.pending()).toHaveLength(0);
  });
});
