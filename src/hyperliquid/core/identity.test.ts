import {
  actingRoute,
  agentScopeKey,
  createIdentity,
  dexParam,
  effectiveAddress,
  identityKey,
  isForIdentity,
  normalizeAddress,
  sameIdentity,
  subscriptionKey,
} from "@/hyperliquid/core/identity";

const ADDRESS = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
const SUB = "0x1111111111111111111111111111111111111111";

describe("createIdentity", () => {
  it("lowercases addresses so mixed-case echoes do not create a second key", () => {
    const id = createIdentity({ env: "testnet", accountId: "acc-1", address: ADDRESS });
    expect(id.address).toBe(ADDRESS.toLowerCase());
  });

  it("lowercases the sub-account too", () => {
    const id = createIdentity({
      env: "testnet",
      accountId: "acc-1",
      address: ADDRESS,
      subAccount: SUB.toUpperCase(),
    });
    expect(id.subAccount).toBe(SUB.toLowerCase());
  });

  it("canonicalises absent dimensions to null", () => {
    const id = createIdentity({ env: "testnet", accountId: "acc-1", address: ADDRESS });
    expect(id.dex).toBeNull();
    expect(id.subAccount).toBeNull();
  });

  it("treats the empty-string dex (Hyperliquid's main DEX) as null", () => {
    const id = createIdentity({ env: "testnet", accountId: "acc-1", address: ADDRESS, dex: "" });
    expect(id.dex).toBeNull();
  });
});

describe("identityKey", () => {
  const base = { env: "testnet" as const, accountId: "acc-1", address: ADDRESS };

  it("is stable for the same identity", () => {
    expect(identityKey(createIdentity(base))).toBe(identityKey(createIdentity(base)));
  });

  it("ignores address casing", () => {
    const upper = createIdentity({ ...base, address: ADDRESS.toUpperCase() });
    const lower = createIdentity({ ...base, address: ADDRESS.toLowerCase() });
    expect(identityKey(upper)).toBe(identityKey(lower));
  });

  it("separates accounts", () => {
    expect(identityKey(createIdentity(base))).not.toBe(
      identityKey(createIdentity({ ...base, accountId: "acc-2" }))
    );
  });

  it("separates DEXs — the same address on two DEXs is two scopes", () => {
    expect(identityKey(createIdentity({ ...base, dex: "xyz" }))).not.toBe(
      identityKey(createIdentity(base))
    );
  });

  it("separates sub-accounts — Hyperliquid treats them as distinct users", () => {
    expect(identityKey(createIdentity({ ...base, subAccount: SUB }))).not.toBe(
      identityKey(createIdentity(base))
    );
  });

  it("cannot collide across dimensions", () => {
    // "a" as a dex must not produce the same key as "a" in another position.
    const asDex = identityKey(createIdentity({ ...base, dex: "a" }));
    const asSub = identityKey(createIdentity({ ...base, subAccount: SUB }));
    expect(asDex).not.toBe(asSub);
  });
});

describe("effectiveAddress", () => {
  it("is the main address when no sub-account is selected", () => {
    const id = createIdentity({ env: "testnet", accountId: "a", address: ADDRESS });
    expect(effectiveAddress(id)).toBe(ADDRESS.toLowerCase());
  });

  it("is the sub-account when one is selected", () => {
    const id = createIdentity({
      env: "testnet",
      accountId: "a",
      address: ADDRESS,
      subAccount: SUB,
    });
    expect(effectiveAddress(id)).toBe(SUB.toLowerCase());
  });
});

describe("dexParam", () => {
  it("sends the empty string for the main perp DEX", () => {
    expect(dexParam(createIdentity({ env: "testnet", accountId: "a", address: ADDRESS }))).toBe("");
  });

  it("sends the dex name for a builder DEX", () => {
    expect(
      dexParam(createIdentity({ env: "testnet", accountId: "a", address: ADDRESS, dex: "xyz" }))
    ).toBe("xyz");
  });
});

describe("sameIdentity / isForIdentity", () => {
  const current = createIdentity({ env: "testnet", accountId: "a", address: ADDRESS });
  const other = createIdentity({ env: "testnet", accountId: "b", address: ADDRESS });

  it("handles nulls", () => {
    expect(sameIdentity(null, null)).toBe(true);
    expect(sameIdentity(current, null)).toBe(false);
  });

  it("accepts data belonging to the current identity", () => {
    expect(isForIdentity({ identity: current }, current)).toBe(true);
  });

  it("rejects in-flight data from a previous account after a switch", () => {
    expect(isForIdentity({ identity: other }, current)).toBe(false);
  });
});

describe("normalizeAddress", () => {
  it("lowercases", () => {
    expect(normalizeAddress(ADDRESS)).toBe(ADDRESS.toLowerCase());
  });
});

describe("env as a key dimension", () => {
  const base = { accountId: "acc-1", address: ADDRESS };

  it("separates networks — asset ids differ between mainnet and testnet", () => {
    // HYPE is spot 107 on mainnet and 1035 on testnet, so a key without env
    // would let one network's cached metadata surface on the other.
    const mainnet = createIdentity({ ...base, env: "mainnet" });
    const testnet = createIdentity({ ...base, env: "testnet" });
    expect(identityKey(mainnet)).not.toBe(identityKey(testnet));
    expect(sameIdentity(mainnet, testnet)).toBe(false);
  });

  it("carries env through verbatim", () => {
    expect(createIdentity({ ...base, env: "mainnet" }).env).toBe("mainnet");
  });

  it("still cannot collide across dimensions with env in the key", () => {
    const a = identityKey(createIdentity({ ...base, env: "mainnet", dex: "x" }));
    const b = identityKey(createIdentity({ ...base, env: "mainnet", subAccount: SUB }));
    expect(a).not.toBe(b);
  });
});

describe("subscriptionKey — candle interval", () => {
  const base = createIdentity({ env: "testnet", accountId: "a", address: ADDRESS });
  const candle = (interval: "1m" | "1h") => ({
    identity: base,
    channel: "candle" as const,
    coin: "BTC",
    aggregation: null,
    interval,
  });

  it("separates intervals — BTC/1m and BTC/1h are distinct subscriptions", () => {
    // Without this the second subscribe is skipped as a duplicate and the chart
    // silently renders the wrong timeframe.
    expect(subscriptionKey(candle("1m"))).not.toBe(subscriptionKey(candle("1h")));
  });

  it("does not collide with a non-candle channel on the same coin", () => {
    const book = { ...candle("1m"), channel: "l2Book" as const, interval: null };
    expect(subscriptionKey(candle("1m"))).not.toBe(subscriptionKey(book));
  });
});

describe("agentScopeKey", () => {
  const master = createIdentity({ env: "testnet", accountId: "acc", address: ADDRESS });

  it("is the SAME for a master and its sub-account", () => {
    // A sub-account has no private key and can hold no agent of its own —
    // 19/19 sampled live returned `extraAgents: []`. The master's agent acts
    // for it. Keying the credential by full identity demanded a key that cannot
    // exist and left every sub-account permanently unable to trade.
    const sub = createIdentity({
      env: "testnet",
      accountId: "acc",
      address: ADDRESS,
      subAccount: "0x1111111111111111111111111111111111111111",
    });

    expect(agentScopeKey(sub)).toBe(agentScopeKey(master));
    // But the STATE key must still separate them.
    expect(identityKey(sub)).not.toBe(identityKey(master));
  });

  it("is the SAME across dexes", () => {
    // One agent covers every dex. Keying on it minted a fresh agent and
    // re-prompted on every HIP-3 dex switch.
    const onDex = createIdentity({
      env: "testnet",
      accountId: "acc",
      address: ADDRESS,
      dex: "xyz",
    });

    expect(agentScopeKey(onDex)).toBe(agentScopeKey(master));
    expect(identityKey(onDex)).not.toBe(identityKey(master));
  });

  it("still separates networks and accounts", () => {
    // An agent approved on testnet is not valid on mainnet, and one account's
    // agent must never be reachable from another's.
    expect(
      agentScopeKey(createIdentity({ env: "mainnet", accountId: "acc", address: ADDRESS }))
    ).not.toBe(agentScopeKey(master));
    expect(
      agentScopeKey(createIdentity({ env: "testnet", accountId: "other", address: ADDRESS }))
    ).not.toBe(agentScopeKey(master));
  });
});

describe("actingRoute", () => {
  it("is empty when the master itself is acting", () => {
    const id = createIdentity({ env: "testnet", accountId: "a", address: ADDRESS });
    expect(actingRoute(id)).toEqual({});
  });

  it("omits the key rather than sending an explicit undefined", () => {
    // `{ vaultAddress: undefined }` is a hard schema rejection, not a no-op.
    const id = createIdentity({ env: "testnet", accountId: "a", address: ADDRESS });
    expect("vaultAddress" in actingRoute(id)).toBe(false);
  });

  it("routes to the sub-account when one is selected", () => {
    const id = createIdentity({
      env: "testnet",
      accountId: "a",
      address: ADDRESS,
      subAccount: SUB,
    });
    expect(actingRoute(id)).toEqual({ vaultAddress: SUB });
  });

  it("routes to the same address reads are attributed to", () => {
    // The two halves of the same question: `effectiveAddress` for a `user`
    // parameter on a read, `actingRoute` for a signed action. If they ever
    // disagree, the app shows one account and trades another.
    const id = createIdentity({
      env: "testnet",
      accountId: "a",
      address: ADDRESS,
      subAccount: SUB,
    });
    expect(actingRoute(id).vaultAddress).toBe(effectiveAddress(id));
  });
});
