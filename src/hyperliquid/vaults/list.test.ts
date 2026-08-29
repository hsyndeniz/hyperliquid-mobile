import {
  fetchVaultList,
  filterVaults,
  findNameCollisions,
  parseVaultList,
  parseVaultSummary,
} from "@/hyperliquid/vaults/list";
import { HlError } from "@/hyperliquid/core/errors";

import live from "@/hyperliquid/vaults/__fixtures__/vault-list-mainnet.json";

/** A CDN entry, in the wire's real shape: the summary is NESTED. */
function entry(summary: Record<string, unknown>, apr: unknown = 0) {
  return {
    apr,
    pnls: [["day", ["0.0", "0.0"]]],
    summary: {
      name: "A vault",
      vaultAddress: "0x1111111111111111111111111111111111111111",
      leader: "0x2222222222222222222222222222222222222222",
      tvl: "1000.5",
      isClosed: false,
      relationship: { type: "normal" },
      createTimeMillis: 1_700_000_000_000,
      ...summary,
    },
  };
}

describe("the recorded mainnet list", () => {
  it("parses every entry", () => {
    const parsed = parseVaultList(live);
    expect(parsed).toHaveLength(live.length);
    expect(parsed[0].address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(parsed[0].leader).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("reads the NESTED summary, not the outer entry", () => {
    // The CDN entry is `{apr, pnls, summary}`. Treating the entry itself as the
    // summary yields undefined for every field, and a row that renders blank.
    const parsed = parseVaultList(live);
    for (const vault of parsed) expect(vault.name).not.toBe("");
  });

  it("keeps tvl as a string", () => {
    // 45% of vaults hold exactly zero and the largest hold nine figures; a double
    // covers neither end honestly.
    for (const vault of parseVaultList(live)) expect(typeof vault.tvl).toBe("string");
  });
});

describe("name collisions", () => {
  it("catches the live HLP impersonator", () => {
    // `"Hyperliquidity Provider(HLP)"` sits beside the real
    // `"Hyperliquidity Provider (HLP)"` on mainnet today — one space apart. A
    // user who recognises a vault by name can fund the wrong one, irreversibly
    // and with a 24-hour lockup.
    const collisions = findNameCollisions(parseVaultList(live));
    const hlp = collisions.get("hyperliquidityprovider(hlp)");

    expect(hlp).toBeDefined();
    expect(hlp!.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hlp!.map((v) => v.address)).size).toBe(hlp!.length);
  });

  it("removes whitespace rather than collapsing it", () => {
    // Collapsing runs of spaces catches a DOUBLED space but not a MISSING one,
    // and missing is the shape the live impersonator uses. Both must collide.
    const collisions = findNameCollisions(
      parseVaultList([
        entry({ name: "Big Vault", vaultAddress: "0x1111111111111111111111111111111111111111" }),
        entry({ name: "Big  Vault", vaultAddress: "0x3333333333333333333333333333333333333333" }),
        entry({ name: "BigVault", vaultAddress: "0x6666666666666666666666666666666666666666" }),
      ])
    );
    expect(collisions.size).toBe(1);
    expect(collisions.get("bigvault")).toHaveLength(3);
  });

  it("reports nothing when names are genuinely distinct", () => {
    const collisions = findNameCollisions(
      parseVaultList([
        entry({ name: "Alpha", vaultAddress: "0x1111111111111111111111111111111111111111" }),
        entry({ name: "Beta", vaultAddress: "0x3333333333333333333333333333333333333333" }),
      ])
    );
    expect(collisions.size).toBe(0);
  });
});

describe("names are never trimmed at the identity level", () => {
  it("keeps surrounding whitespace verbatim", () => {
    // 9,467 names are distinct as sent and only 9,438 after trimming, so trimming
    // here would merge 29 pairs of genuinely different vaults.
    const [parsed] = parseVaultList([entry({ name: "  Padded  " })]);
    expect(parsed.name).toBe("  Padded  ");
  });
});

describe("apr and other JSON numbers", () => {
  it("wraps a wire double as an approximation rather than a wire amount", () => {
    // `apr` arrives as a JSON number; the precision is already spent upstream.
    const [parsed] = parseVaultList([entry({}, 0.0039864237126079555)]);
    expect(parsed.apr).toBe("0.0039864237126079555");
    expect(typeof parsed.apr).toBe("string");
  });

  it("accepts a string, in case the API ever fixes the field", () => {
    const [parsed] = parseVaultList([entry({}, "0.05")]);
    expect(parsed.apr).toBe("0.05");
  });

  it("falls back to zero rather than NaN", () => {
    const [parsed] = parseVaultList([entry({}, null)]);
    expect(parsed.apr).toBe("0");
  });
});

describe("relationship", () => {
  it("reads a parent's children", () => {
    const [parsed] = parseVaultList([
      entry({
        relationship: {
          type: "parent",
          data: { childAddresses: ["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] },
        },
      }),
    ]);
    expect(parsed.relationship).toEqual({
      kind: "parent",
      childAddresses: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    });
  });

  it("reads a child, which the wire never links back to its parent", () => {
    // Measured on both sources: a child arrives as a bare {"type":"child"} with
    // no data object at all. Kept as its own kind anyway — "this vault's equity
    // is a slice of a larger pool" is worth showing even with no link to follow.
    const [bare] = parseVaultList([entry({ relationship: { type: "child" } })]);
    expect(bare.relationship).toEqual({ kind: "child" });

    const [withEmptyData] = parseVaultList([entry({ relationship: { type: "child", data: {} } })]);
    expect(withEmptyData.relationship).toEqual({ kind: "child" });
  });

  it("treats an unknown relationship as normal rather than throwing", () => {
    const [parsed] = parseVaultList([entry({ relationship: { type: "somethingNew" } })]);
    expect(parsed.relationship).toEqual({ kind: "normal" });
  });
});

describe("parseVaultSummary", () => {
  it("returns null rather than throwing for a single bad entry", () => {
    // The list parser drops these; exposing the single-entry form lets a caller
    // validate one row without wrapping it in an array first.
    expect(parseVaultSummary(null)).toBeNull();
    expect(parseVaultSummary({ apr: 0 })).toBeNull();
    expect(parseVaultSummary(entry({}))?.name).toBe("A vault");
  });
});

describe("malformed entries", () => {
  it("drops an entry with no usable address, keeping the rest", () => {
    const parsed = parseVaultList([
      entry({}),
      { apr: 0, summary: { name: "no address" } },
      null,
      42,
      { apr: 0 },
    ]);
    expect(parsed).toHaveLength(1);
  });

  it("throws only when the whole payload is the wrong shape", () => {
    expect(() => parseVaultList({ nope: true })).toThrow(HlError);
    expect(() => parseVaultList(null)).toThrow(HlError);
  });
});

describe("filtering", () => {
  const vaults = parseVaultList([
    entry({ name: "dead", vaultAddress: "0x1111111111111111111111111111111111111111", tvl: "0" }),
    entry({
      name: "closed but rich",
      vaultAddress: "0x3333333333333333333333333333333333333333",
      tvl: "900000",
      isClosed: true,
    }),
    entry({
      name: "small",
      vaultAddress: "0x4444444444444444444444444444444444444444",
      tvl: "49999",
    }),
    entry({
      name: "big",
      vaultAddress: "0x5555555555555555555555555555555555555555",
      tvl: "1000000",
    }),
  ]);

  it("drops closed and sub-threshold vaults", () => {
    // Of 9,467 real vaults only 107 are open with TVL above $50k. Without this
    // the user scrolls nine thousand dead rows.
    const kept = filterVaults(vaults, { openOnly: true, minTvl: "50000" });
    expect(kept.map((v) => v.name)).toEqual(["big"]);
  });

  it("compares TVL numerically, not lexicographically", () => {
    // "9" > "1000000" as strings.
    const kept = filterVaults(
      parseVaultList([
        entry({
          name: "nine",
          vaultAddress: "0x1111111111111111111111111111111111111111",
          tvl: "9",
        }),
        entry({
          name: "million",
          vaultAddress: "0x3333333333333333333333333333333333333333",
          tvl: "1000000",
        }),
      ]),
      { minTvl: "10" }
    );
    expect(kept.map((v) => v.name)).toEqual(["million"]);
  });

  it("sorts by TVL descending", () => {
    expect(filterVaults(vaults).map((v) => v.name)).toEqual([
      "big",
      "closed but rich",
      "small",
      "dead",
    ]);
  });

  it("applies the limit after sorting, not before", () => {
    expect(filterVaults(vaults, { limit: 1 }).map((v) => v.name)).toEqual(["big"]);
  });
});

describe("fetchVaultList", () => {
  function respondWith(body: unknown, ok = true, status = 200): typeof fetch {
    return (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
  }

  it("uses the capitalised CDN path per network", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => [entry({})] };
    }) as unknown as typeof fetch;

    await fetchVaultList({ env: "mainnet", fetchImpl });
    await fetchVaultList({ env: "testnet", fetchImpl });

    expect(urls[0]).toBe("https://stats-data.hyperliquid.xyz/Mainnet/vaults");
    expect(urls[1]).toBe("https://stats-data.hyperliquid.xyz/Testnet/vaults");
  });

  it("applies the filter before returning", async () => {
    const kept = await fetchVaultList({
      env: "mainnet",
      fetchImpl: respondWith([
        entry({ tvl: "0", vaultAddress: "0x1111111111111111111111111111111111111111" }),
        entry({ tvl: "99999", vaultAddress: "0x3333333333333333333333333333333333333333" }),
      ]),
      filter: { minTvl: "1000" },
    });
    expect(kept).toHaveLength(1);
  });

  it("raises a transport error on a non-2xx rather than parsing the body", async () => {
    await expect(
      fetchVaultList({ env: "mainnet", fetchImpl: respondWith(null, false, 503) })
    ).rejects.toThrow(/HTTP 503/);
  });
});
