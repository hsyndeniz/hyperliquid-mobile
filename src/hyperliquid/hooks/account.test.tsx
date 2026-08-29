/**
 * Real mount/commit cycles, not selector unit tests.
 *
 * The failure this binding exists to prevent — account A's number under account
 * B's header — only appears across an actual unmount, store clear and remount.
 * A test that calls the selector directly cannot see it: the wrong value comes
 * from React's retained state, not from the selector.
 */

import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { AccountStore } from "@/hyperliquid/state/account";
import { parseClearinghouseState } from "@/hyperliquid/state/accountWire";
import { createIdentity } from "@/hyperliquid/core/identity";
import { usePosition, usePositions, useAccountSummary } from "@/hyperliquid/hooks/account";
import type { AccountSnapshot, Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

import chsMixed from "@/hyperliquid/state/__fixtures__/chs-mixed-testnet.json";

const A = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});
const B = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
});

function targetFor(identity = A): SubscriptionTarget {
  return { identity, channel: "clearinghouseState", coin: null, aggregation: null, interval: null };
}

const BASE = parseClearinghouseState(chsMixed);
const COIN = BASE.positions[0].coin;
const OTHER_COIN = BASE.positions[1].coin;

function snapshotWith(
  serverTime: number,
  mutate: (s: AccountSnapshot) => AccountSnapshot = (s) => s
): AccountSnapshot {
  const cloned = JSON.parse(JSON.stringify(BASE)) as AccountSnapshot;
  return mutate({ ...cloned, summary: { ...cloned.summary, serverTime } });
}

function push(store: AccountStore, value: AccountSnapshot, target = targetFor()): void {
  const event: Scoped<AccountSnapshot> = {
    target,
    value,
    serverTime: value.summary.serverTime,
    receivedAt: value.summary.serverTime,
    isSnapshot: true,
  };
  act(() => {
    store.apply(event);
  });
}

/** Renders one coin's size, and counts how often it re-rendered. */
function positionProbe(store: AccountStore, coin: string) {
  const renders = { count: 0 };
  function Row(): React.ReactElement {
    renders.count += 1;
    const position = usePosition(store, coin);
    return <>{position ? position.size : "—"}</>;
  }
  return { Row, renders };
}

function textOf(tree: ReactTestRenderer): string {
  const json = tree.toJSON();
  const flatten = (node: unknown): string => {
    if (node === null || node === undefined) return "";
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(flatten).join("");
    const children = (node as { children?: unknown }).children;
    return children ? flatten(children) : "";
  };
  return flatten(json);
}

describe("usePosition", () => {
  it("renders the coin's current size", () => {
    const store = new AccountStore();
    store.setTarget(targetFor());
    push(store, snapshotWith(1_000));

    const { Row } = positionProbe(store, COIN);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<Row />);
    });

    expect(textOf(tree)).toBe(BASE.positions[0].size);
  });

  it("does NOT re-render when a different coin moves", () => {
    // The per-row subscription. Every row wakes on every 5s heartbeat, but React
    // bails out unless this coin's object changed — which only works because the
    // store preserves object identity for unchanged positions.
    const store = new AccountStore();
    store.setTarget(targetFor());
    push(store, snapshotWith(1_000));

    const { Row, renders } = positionProbe(store, COIN);
    act(() => {
      create(<Row />);
    });
    const before = renders.count;

    push(
      store,
      snapshotWith(2_000, (s) => ({
        ...s,
        positions: s.positions.map((p) =>
          p.coin === OTHER_COIN ? { ...p, unrealizedPnl: "999.0" } : p
        ),
      }))
    );

    expect(renders.count).toBe(before);
  });

  it("re-renders when its own coin moves", () => {
    const store = new AccountStore();
    store.setTarget(targetFor());
    push(store, snapshotWith(1_000));

    const { Row, renders } = positionProbe(store, COIN);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<Row />);
    });
    const before = renders.count;

    push(
      store,
      snapshotWith(2_000, (s) => ({
        ...s,
        positions: s.positions.map((p) => (p.coin === COIN ? { ...p, size: "42.0" } : p)),
      }))
    );

    expect(renders.count).toBeGreaterThan(before);
    expect(textOf(tree)).toBe("42.0");
  });

  it("does not re-render on a byte-identical heartbeat", () => {
    // These channels re-send the same payload every ~5s forever.
    const store = new AccountStore();
    store.setTarget(targetFor());
    push(store, snapshotWith(1_000));

    const { Row, renders } = positionProbe(store, COIN);
    act(() => {
      create(<Row />);
    });
    const before = renders.count;

    push(store, snapshotWith(2_000));
    push(store, snapshotWith(3_000));

    expect(renders.count).toBe(before);
  });
});

describe("the identity switch", () => {
  it("shows no value after the account changes, in the same commit", () => {
    // The measured jotai failure was account A's size rendering under account
    // B's address and NEVER self-correcting. useSyncExternalStore re-runs
    // getSnapshot on every render, so a cleared store cannot be missed.
    const store = new AccountStore();
    store.setTarget(targetFor(A));
    push(store, snapshotWith(1_000));

    const { Row } = positionProbe(store, COIN);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<Row />);
    });
    expect(textOf(tree)).toBe(BASE.positions[0].size);

    act(() => {
      store.setTarget(targetFor(B));
    });

    expect(textOf(tree)).toBe("—");
  });

  it("shows no value after unmount, switch and remount", () => {
    // The exact scenario that produced a permanently wrong number: navigate
    // away, switch account, navigate back. A retained atom value survives the
    // unmount; a getSnapshot read cannot.
    const store = new AccountStore();
    store.setTarget(targetFor(A));
    push(store, snapshotWith(1_000));

    const { Row } = positionProbe(store, COIN);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<Row />);
    });
    act(() => {
      tree.unmount();
    });

    act(() => {
      store.setTarget(targetFor(B));
    });

    let remounted!: ReactTestRenderer;
    act(() => {
      remounted = create(<Row />);
    });

    // The FIRST paint must already be empty — a one-frame flash of the previous
    // account's number is the half-fix, not the fix.
    expect(textOf(remounted)).toBe("—");
  });

  it("does not resurrect the old account's data when switching back", () => {
    const store = new AccountStore();
    store.setTarget(targetFor(A));
    push(store, snapshotWith(1_000));

    const { Row } = positionProbe(store, COIN);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<Row />);
    });

    act(() => {
      store.setTarget(targetFor(B));
    });
    act(() => {
      store.setTarget(targetFor(A));
    });

    // Switching back must show nothing until account A's data arrives again.
    expect(textOf(tree)).toBe("—");
  });

  it("renders the header from the same store as the rows", () => {
    // Torn commits are real: with the address and the numbers in two separate
    // sources written a macrotask apart, the DOM genuinely contained account
    // B's address beside account A's size. One store, one commit.
    const store = new AccountStore();
    store.setTarget(targetFor(A));
    push(store, snapshotWith(1_000));

    function Screen(): React.ReactElement {
      const summary = useAccountSummary(store);
      const positions = usePositions(store);
      return <>{`${summary ? summary.total.accountValue : "—"}|${positions.length}`}</>;
    }

    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<Screen />);
    });
    expect(textOf(tree)).toBe(`${BASE.summary.total.accountValue}|${BASE.positions.length}`);

    act(() => {
      store.setTarget(targetFor(B));
    });

    // Both halves cleared together — never a value beside an empty header.
    expect(textOf(tree)).toBe("—|0");
  });
});

describe("usePositions", () => {
  it("returns a stable empty array before anything arrives", () => {
    // `?? []` would allocate on every render and loop forever.
    const store = new AccountStore();
    store.setTarget(targetFor());

    const seen: readonly unknown[][] = [];
    function Probe(): React.ReactElement {
      const positions = usePositions(store);
      (seen as unknown[][]).push(positions as unknown[]);
      return <>{positions.length}</>;
    }

    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<Probe />);
    });
    act(() => {
      tree.update(<Probe />);
    });

    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).toBe(seen[seen.length - 1]);
  });
});
