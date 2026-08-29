import {
  fetchVaultPositions,
  parseVaultPosition,
  parseVaultPositions,
  positionIn,
  readPushedVaultEquity,
  totalVaultEquity,
  withLockup,
} from "@/hyperliquid/vaults/equities";
import {
  assertUnlocked,
  earliestUnlockMs,
  isUnlocked,
  lockupState,
  VAULT_LOCKUP_MS,
} from "@/hyperliquid/vaults/lockup";
import { WeightBudget } from "@/hyperliquid/api/weightBudget";
import { HlError } from "@/hyperliquid/core/errors";

import live from "@/hyperliquid/vaults/__fixtures__/user-vault-equities-mainnet.json";

const HLP = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
const OTHER = "0x1111111111111111111111111111111111111111";
const USER = "0x03e161499870b0a37549b16a5d33e0582fe1255e";
const NOW = 1_770_000_000_000;

describe("the recorded mainnet response", () => {
  it("parses the live row", () => {
    const [position] = parseVaultPositions(live);
    expect(position.vault).toBe(HLP);
    expect(position.equity).toBe("599637.394621");
    expect(position.lockedUntilMs).toBe(1_770_680_880_422);
  });

  it("keeps equity a string", () => {
    // Twelve significant digits on this one row; a double drops the tail and
    // still renders as a plausible number.
    for (const p of parseVaultPositions(live)) expect(typeof p.equity).toBe("string");
  });
});

describe("the empty response", () => {
  it("is [] and stays []", () => {
    // Measured: `userVaultEquities` answers `[]`, never null, for a user with no
    // positions. This is the OPPOSITE of `subAccounts2` one phase away, which
    // uses null for "none" — so neither convention may be assumed.
    expect(parseVaultPositions([])).toEqual([]);
  });

  it("tolerates a null anyway rather than crashing at launch", () => {
    // Never observed here, but the sibling endpoint does exactly this, and the
    // cost of being wrong is a crash on first render.
    expect(parseVaultPositions(null)).toEqual([]);
    expect(parseVaultPositions(undefined)).toEqual([]);
  });

  it("still rejects a shape that is neither", () => {
    expect(() => parseVaultPositions({ nope: true })).toThrow(HlError);
  });
});

describe("malformed rows", () => {
  it("drops a row with no usable vault address", () => {
    expect(parseVaultPositions([{ equity: "5" }, null, 42])).toEqual([]);
  });

  it("lowercases the vault address so comparisons are safe", () => {
    const parsed = parseVaultPosition({
      vaultAddress: HLP.toUpperCase().replace("0X", "0x"),
      equity: "1",
      lockedUntilTimestamp: 1,
    });
    expect(parsed?.vault).toBe(HLP);
  });

  it("defaults a missing lockup to 0, which reads as unknown downstream", () => {
    const parsed = parseVaultPosition({ vaultAddress: HLP, equity: "1" })!;
    expect(parsed.lockedUntilMs).toBe(0);
    expect(lockupState(parsed.lockedUntilMs, NOW).kind).toBe("unknown");
  });
});

describe("totals", () => {
  it("sums exactly, not as floats", () => {
    // 0.1 + 0.2 as doubles is 0.30000000000000004, and real equities carry
    // twelve significant digits.
    const positions = parseVaultPositions([
      { vaultAddress: HLP, equity: "0.1", lockedUntilTimestamp: 1 },
      { vaultAddress: OTHER, equity: "0.2", lockedUntilTimestamp: 1 },
    ]);
    expect(totalVaultEquity(positions)).toBe("0.3");
  });

  it("is 0 for no positions", () => {
    expect(totalVaultEquity([])).toBe("0");
  });

  it("finds a position case-insensitively", () => {
    const positions = parseVaultPositions(live);
    expect(positionIn(positions, HLP.toUpperCase())?.equity).toBe("599637.394621");
    expect(positionIn(positions, OTHER)).toBeNull();
  });
});

describe("lockup", () => {
  it("classifies a future timestamp as locked, with the remaining time", () => {
    const state = lockupState(NOW + 3_600_000, NOW);
    expect(state).toEqual({ kind: "locked", untilMs: NOW + 3_600_000, remainingMs: 3_600_000 });
  });

  it("treats a passed timestamp as unlocked", () => {
    expect(lockupState(NOW - 1, NOW)).toEqual({ kind: "unlocked" });
    expect(lockupState(NOW, NOW)).toEqual({ kind: "unlocked" });
  });

  it("reports an ABSENT timestamp as unknown, never as unlocked", () => {
    // An absent lockup and a passed one both mean "you may withdraw" to a naive
    // reader, and only one of them is a fact. Collapsing them turns a wire change
    // into failed withdrawals with no explanation.
    for (const bad of [0, -1, undefined, null, "later", NaN]) {
      expect(lockupState(bad, NOW)).toEqual({ kind: "unknown" });
    }
  });

  it("does not treat unknown as free", () => {
    expect(isUnlocked(lockupState(undefined, NOW))).toBe(false);
    expect(isUnlocked(lockupState(NOW - 1, NOW))).toBe(true);
  });

  it("throws for both locked and unknown, naming which", () => {
    // Throws rather than returning a boolean: a caller that forgets to check a
    // boolean signs anyway, and the server then rejects with nothing to show.
    expect(() => assertUnlocked(lockupState(NOW + 1, NOW))).toThrow(/still locked/);
    expect(() => assertUnlocked(lockupState(undefined, NOW))).toThrow(/could not be determined/);
    expect(() => assertUnlocked(lockupState(NOW - 1, NOW))).not.toThrow();
  });

  it("carries the remaining time in the error context, for the UI", () => {
    try {
      assertUnlocked(lockupState(NOW + 7_200_000, NOW));
      throw new Error("unreachable");
    } catch (error) {
      expect((error as HlError).context).toMatchObject({ remainingMs: 7_200_000 });
    }
  });

  it("exposes BOTH measured windows, because there is not one number", () => {
    // Ordinary vaults: 24h — largest remaining lockup across 1,677 follower rows
    // over 28 mainnet vaults was 23.77h, nothing above.
    // HLP: 96h — settled exactly by a real $5 testnet deposit, whose returned
    // lockedUntilTimestamp was 95.993h out.
    expect(VAULT_LOCKUP_MS.typical).toBe(86_400_000);
    expect(VAULT_LOCKUP_MS.maximum).toBe(4 * 86_400_000);
    // Both are for pre-deposit disclosure; every gate reads the server timestamp.
    expect(VAULT_LOCKUP_MS.maximum).toBeGreaterThan(VAULT_LOCKUP_MS.typical);
  });
});

describe("earliestUnlockMs", () => {
  const locked = (untilMs: number) => ({ lockedUntilMs: untilMs });

  it("returns the soonest future unlock", () => {
    expect(
      earliestUnlockMs([locked(NOW + 5_000), locked(NOW + 1_000), locked(NOW + 9_000)], NOW)
    ).toBe(NOW + 1_000);
  });

  it("returns null when anything is already withdrawable", () => {
    // There is nothing to wait for, so a "next unlock" countdown would be a lie.
    expect(earliestUnlockMs([locked(NOW + 5_000), locked(NOW - 1)], NOW)).toBeNull();
  });

  it("ignores rows with no usable timestamp rather than treating them as now", () => {
    expect(earliestUnlockMs([locked(0), locked(NOW + 5_000)], NOW)).toBe(NOW + 5_000);
    expect(earliestUnlockMs([locked(0)], NOW)).toBeNull();
  });
});

describe("withLockup", () => {
  it("attaches state so no caller re-derives it from the raw timestamp", () => {
    const held = withLockup(parseVaultPositions(live), NOW);
    expect(held[0].lockup).toEqual({
      kind: "locked",
      untilMs: 1_770_680_880_422,
      remainingMs: 1_770_680_880_422 - NOW,
    });
  });
});

describe("readPushedVaultEquity", () => {
  it("reads the aggregate out of a webData3 frame", () => {
    // Measured live: 599637.071547 pushed against a userVaultEquities sum of
    // 599637.131483 read ~2s later — mark-to-market drift, not disagreement.
    const frame = {
      userState: {},
      perpDexStates: [{ totalVaultEquity: "599637.071547", perpsAtOpenInterestCap: [] }],
    };
    expect(readPushedVaultEquity(frame)).toBe("599637.071547");
  });

  it("accepts the whole websocket envelope too", () => {
    // A caller passing `{channel, data}` would otherwise get null — which reads
    // as "no vault positions" rather than as "wrong object".
    expect(
      readPushedVaultEquity({
        channel: "webData3",
        data: { perpDexStates: [{ totalVaultEquity: "12.5" }] },
      })
    ).toBe("12.5");
  });

  it("returns null rather than coercing a number", () => {
    // The field is a string on the wire, unlike the five float-damaged fields on
    // vaultDetails. If that ever changes, the value is no longer exact and the
    // caller should learn it from a null, not from a silently rounded string.
    expect(readPushedVaultEquity({ perpDexStates: [{ totalVaultEquity: 599637.07 }] })).toBeNull();
  });

  it("returns null for a frame with no vault equity, which is not an error", () => {
    // A user with no vault positions still receives webData3.
    expect(readPushedVaultEquity({ perpDexStates: [{ perpsAtOpenInterestCap: [] }] })).toBeNull();
    expect(readPushedVaultEquity({ perpDexStates: [] })).toBeNull();
    expect(readPushedVaultEquity({})).toBeNull();
    expect(readPushedVaultEquity(null)).toBeNull();
  });
});

describe("fetchVaultPositions", () => {
  it("queries the user and returns parsed positions", async () => {
    const calls: { user: string }[] = [];
    const { value, deferred } = await fetchVaultPositions({
      probe: {
        userVaultEquities: async (params) => {
          calls.push(params);
          return live;
        },
      },
      user: USER,
    });

    expect(deferred).toBe(false);
    expect(value).toHaveLength(1);
    expect(calls[0].user).toBe(USER);
  });

  it("distinguishes HAS-NONE from a refused read", async () => {
    // Both would be an empty-looking result. Only one means the user has no
    // vault positions.
    const none = await fetchVaultPositions({
      probe: { userVaultEquities: async () => [] },
      user: USER,
    });
    expect(none).toEqual({ value: [], deferred: false });

    const refused = await fetchVaultPositions({
      probe: { userVaultEquities: async () => live },
      user: USER,
      budget: new WeightBudget(0),
    });
    expect(refused).toEqual({ value: null, deferred: true });
  });
});
