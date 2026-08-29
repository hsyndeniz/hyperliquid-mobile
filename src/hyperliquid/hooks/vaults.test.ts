import { buildVaultTransferQuote } from "@/hyperliquid/hooks/vaults";
import { normaliseVaultName } from "@/hyperliquid/vaults/list";
import type { Fetched } from "@/hyperliquid/hooks/history";
import type {
  VaultAddress,
  VaultDetail,
  VaultPosition,
  VaultSummary,
} from "@/hyperliquid/vaults/types";

const ADDRESS = "0x00000000000000000000000000000000000000aa" as VaultAddress;
const NOW = 1_700_000_000_000;

function detail(overrides: Partial<VaultDetail> = {}): VaultDetail {
  return {
    address: ADDRESS,
    name: "Alpha Vault",
    leader: "0x00000000000000000000000000000000000000ff",
    description: "A vault for tests",
    isClosed: false,
    allowDeposits: true,
    alwaysCloseOnWithdraw: false,
    relationship: { kind: "normal" },
    followers: { rows: [], truncated: false },
    portfolio: [],
    followerState: null,
    apr: null,
    leaderFraction: null,
    leaderCommission: null,
    maxDistributable: null,
    maxWithdrawable: null,
    ...overrides,
  } as VaultDetail;
}

function ready(positions: VaultPosition[]): Fetched<readonly VaultPosition[]> {
  return { kind: "ready", value: positions };
}

const HELD: VaultPosition = { vault: ADDRESS, equity: "50", lockedUntilMs: NOW - 1 };

describe("buildVaultTransferQuote null gates", () => {
  it("refuses without a detail, a parseable amount, or ready positions", () => {
    const base = {
      kind: "deposit" as const,
      vault: detail(),
      amount: "10",
      available: "100",
      positions: ready([]),
      collisions: null,
      actingSubAccount: null,
      basisMs: NOW,
    };
    expect(buildVaultTransferQuote({ ...base, vault: null })).toBeNull();
    expect(buildVaultTransferQuote({ ...base, amount: "abc" })).toBeNull();
    expect(buildVaultTransferQuote({ ...base, amount: "" })).toBeNull();
    // The re-lock honesty gate: deferred equities must NOT quote — a null
    // existingPosition would show the friendly first-deposit disclosure on
    // what is actually a whole-balance re-lock.
    expect(buildVaultTransferQuote({ ...base, positions: { kind: "deferred" } })).toBeNull();
    expect(buildVaultTransferQuote({ ...base, available: null })).toBeNull();
  });

  it("refuses a withdraw without a position in this vault", () => {
    const quote = buildVaultTransferQuote({
      kind: "withdraw",
      vault: detail(),
      amount: "10",
      available: null,
      positions: ready([]),
      collisions: null,
      actingSubAccount: null,
      basisMs: NOW,
    });
    expect(quote).toBeNull();
  });
});

describe("buildVaultTransferQuote deposits", () => {
  const base = {
    kind: "deposit" as const,
    vault: detail(),
    amount: "10",
    available: "100",
    positions: ready([]),
    collisions: null,
    actingSubAccount: null,
    basisMs: NOW,
  };

  it("warns name_not_checked when the directory has not loaded, never a fake all-clear", () => {
    const quote = buildVaultTransferQuote(base);
    expect(quote).not.toBeNull();
    expect(quote!.warnings.map((w) => w.code)).toContain("name_not_checked");
  });

  it("passes the collision group through to the impersonation warning", () => {
    const impostor: VaultSummary = {
      address: "0x00000000000000000000000000000000000000bb" as VaultAddress,
      name: "AlphaVault", // collides with "Alpha Vault" once whitespace is ignored
      leader: "0x00000000000000000000000000000000000000fe",
      tvl: "1",
      isClosed: false,
      relationship: { kind: "normal" },
      createdAtMs: 0,
      apr: "0" as VaultSummary["apr"],
      monthPnl: null,
    };
    const self: VaultSummary = { ...impostor, address: ADDRESS, name: "Alpha Vault" };
    const collisions = new Map([[normaliseVaultName("Alpha Vault"), [self, impostor]]]);
    const quote = buildVaultTransferQuote({ ...base, collisions });
    expect(quote!.warnings.map((w) => w.code)).toContain("name_shared_with_other_vaults");
  });

  it("discloses the re-lock when a position already exists", () => {
    const quote = buildVaultTransferQuote({ ...base, positions: ready([HELD]) });
    expect(quote!.warnings.map((w) => w.code)).toContain("lockup_restarts_on_whole_balance");
  });

  it("warns below the advisory minimum instead of blocking", () => {
    const quote = buildVaultTransferQuote({ ...base, amount: "4.99" });
    expect(quote!.blockers.map((b) => b.code)).not.toContain("below_advisory_minimum");
    expect(quote!.warnings.map((w) => w.code)).toContain("below_advisory_minimum");
  });
});

describe("buildVaultTransferQuote withdrawals", () => {
  it("quotes against the position and blocks while locked", () => {
    // Relative to the REAL clock: the quote builder consults Date.now().
    const locked: VaultPosition = {
      vault: ADDRESS,
      equity: "50",
      lockedUntilMs: Date.now() + 60_000,
    };
    const quote = buildVaultTransferQuote({
      kind: "withdraw",
      vault: detail(),
      amount: "10",
      available: null,
      positions: ready([locked]),
      collisions: null,
      actingSubAccount: null,
      basisMs: NOW,
    });
    expect(quote).not.toBeNull();
    expect(quote!.kind).toBe("withdraw");
    expect(quote!.blockers.map((b) => b.code)).toContain("vault_locked");
  });

  it("blocks a withdrawal exceeding the position", () => {
    const quote = buildVaultTransferQuote({
      kind: "withdraw",
      vault: detail(),
      amount: "60",
      available: null,
      positions: ready([HELD]),
      collisions: null,
      actingSubAccount: null,
      basisMs: NOW,
    });
    expect(quote!.blockers.map((b) => b.code)).toContain("exceeds_position");
  });
});
