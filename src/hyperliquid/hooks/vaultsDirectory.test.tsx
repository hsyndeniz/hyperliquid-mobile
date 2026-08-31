/**
 * The vault directory's stall bound.
 *
 * Separate file because it needs module mocks and fake timers, and
 * `vaults.test.ts` is deliberately a pure-logic suite.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useVaultList, VAULT_LIST_STALL_MS, vaultDirectory } from "@/hyperliquid/hooks/vaults";

const mockFetchVaultList = jest.fn();

jest.mock("@/hyperliquid/vaults/list", () => ({
  ...jest.requireActual("@/hyperliquid/vaults/list"),
  fetchVaultList: (...args: unknown[]) => mockFetchVaultList(...args),
}));
jest.mock("expo-router", () => ({
  // The hook only needs its callback run once, on mount.
  //
  // `require` INSIDE the factory, not a top-level import: jest hoists
  // `jest.mock` above the imports and then refuses any out-of-scope reference
  // from the factory, so an imported `useEffect` fails at module load with
  // "not allowed to reference any out-of-scope variables".
  useFocusEffect: (cb: () => void) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("react") as typeof import("react")).useEffect(() => cb(), [cb]),
}));

describe("the vault directory stall bound", () => {
  let tree: ReactTestRenderer;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => {
    act(() => tree?.unmount());
    jest.useRealTimers();
  });

  it("abandons a download that never settles, and records it as a failure", async () => {
    // The wedge: the single-flight latch makes every later caller await the
    // SAME promise, so a download that never settles holds the vault list for
    // the whole session — spinner forever, no retry path, nothing to clear it.
    let aborted = false;
    mockFetchVaultList.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        })
    );

    function Probe(): null {
      useVaultList("testnet");
      return null;
    }
    await act(async () => {
      tree = create(<Probe />);
    });

    expect(aborted).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(VAULT_LIST_STALL_MS + 1);
      await Promise.resolve();
    });

    expect(aborted).toBe(true);
    // Recorded as a failure, not as a silent empty list — that is what lets
    // the screen offer a retry.
    expect(vaultDirectory.fetchState().isFetching).toBe(false);
    expect(vaultDirectory.fetchState().lastFailure?.message).toMatch(/too long/i);
  });
});
