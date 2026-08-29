import fixture from "@/hyperliquid/vaults/__fixtures__/vault-list-mainnet.json";
import {
  buildVaultDirectory,
  joinPositionNames,
  searchDirectory,
  VAULT_TOP_LIMIT,
} from "@/hyperliquid/vaults/directory";
import { findNameCollisions, parseVaultList } from "@/hyperliquid/vaults/list";
import type { VaultPosition, VaultSummary } from "@/hyperliquid/vaults/types";

const NOW = 1_700_000_000_000;

function summaries(): VaultSummary[] {
  return parseVaultList(fixture);
}

describe("buildVaultDirectory", () => {
  const all = summaries();
  const dir = buildVaultDirectory("mainnet", all, NOW);

  it("indexes EVERY vault, open or closed", () => {
    expect(dir.index.size).toBe(all.length);
    const closed = all.find((vault) => vault.isClosed);
    expect(closed).toBeDefined();
    // A closed vault is out of `top` but MUST stay in the index: a held
    // position can point at it and needs its name.
    expect(dir.index.get(closed!.address)).toEqual({ name: closed!.name, isClosed: true });
    expect(dir.top.some((vault) => vault.address === closed!.address)).toBe(false);
  });

  it("caps and sorts the top set open-only, TVL descending", () => {
    expect(dir.top.length).toBeLessThanOrEqual(VAULT_TOP_LIMIT);
    expect(dir.top.every((vault) => !vault.isClosed)).toBe(true);
    const tvls = dir.top.map((vault) => Number(vault.tvl));
    const sorted = [...tvls].sort((a, b) => b - a);
    expect(tvls).toEqual(sorted);
  });

  it("keeps exactly the colliding groups findNameCollisions reports", () => {
    const expected = findNameCollisions(all);
    expect([...dir.collisions.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [key, group] of expected) {
      expect(dir.collisions.get(key)).toHaveLength(group.length);
    }
  });

  it("stamps env and fetch time", () => {
    expect(dir.env).toBe("mainnet");
    expect(dir.fetchedAtMs).toBe(NOW);
  });
});

describe("joinPositionNames", () => {
  const all = summaries();
  const dir = buildVaultDirectory("mainnet", all, NOW);
  const listed = all[0];

  // A real unlocked position carries a PAST timestamp; zero would be `unknown`
  // (lockupState treats a missing/zero stamp as "we don't know", not "free").
  const held: VaultPosition = { vault: listed.address, equity: "12.5", lockedUntilMs: NOW - 1_000 };
  // The measured testnet-HLP case: a held vault the directory has never heard of.
  const unlisted: VaultPosition = {
    vault: "0x00000000000000000000000000000000000000aa" as VaultPosition["vault"],
    equity: "5",
    lockedUntilMs: NOW + 60_000,
  };

  it("names a listed position and leaves an unlisted one null, never a fallback string", () => {
    const [a, b] = joinPositionNames([held, unlisted], dir.index, NOW);
    expect(a.name).toBe(listed.name);
    expect(a.isClosed).toBe(listed.isClosed);
    expect(b.name).toBeNull();
    expect(b.isClosed).toBeNull();
  });

  it("attaches the lockup state from the absolute timestamp", () => {
    const [a, b] = joinPositionNames([held, unlisted], dir.index, NOW);
    expect(a.lockup.kind).toBe("unlocked");
    expect(b.lockup).toEqual({ kind: "locked", untilMs: NOW + 60_000, remainingMs: 60_000 });
  });

  it("does not wait for the directory — a null index still yields rows", () => {
    const rows = joinPositionNames([held], null, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBeNull();
  });
});

describe("searchDirectory", () => {
  const all = summaries();
  const dir = buildVaultDirectory("mainnet", all, NOW);

  it("finds a top vault with a full summary, whitespace-insensitively", () => {
    const target = dir.top[0];
    const spaced = target.name.split("").join(" ");
    const hits = searchDirectory(dir, spaced);
    expect(hits.some((hit) => hit.address === target.address && hit.summary !== null)).toBe(true);
  });

  it("falls back to the full index for vaults outside the rendered cut", () => {
    const closed = all.find((vault) => vault.isClosed && vault.name.length > 2);
    expect(closed).toBeDefined();
    const hits = searchDirectory(dir, closed!.name);
    const hit = hits.find((entry) => entry.address === closed!.address);
    expect(hit).toBeDefined();
    // Index-only hits carry no summary — the detail screen is the confirmer.
    expect(hit!.summary).toBeNull();
    expect(hit!.isClosed).toBe(true);
  });

  it("returns nothing for a blank query and respects the limit", () => {
    expect(searchDirectory(dir, "   ")).toEqual([]);
    expect(searchDirectory(dir, "a", 3).length).toBeLessThanOrEqual(3);
  });
});
