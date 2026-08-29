import {
  activatedLabel,
  agentLine,
  avatarLabel,
  budgetTone,
  connectionMeasure,
  countLabel,
  importCaption,
  importKind,
  phraseWords,
  sessionPhase,
  socketLine,
  walletLine,
  walletMeasure,
} from "@/components/account/accountView";
import type { AgentReadiness } from "@/hyperliquid/auth/session";
import type { WalletMetadata, WalletState } from "@/hyperliquid/wallet/accounts";

function agentWith(status: AgentReadiness["status"]): AgentReadiness {
  return { status, activated: true, registeredAgents: [], agentsRead: true } as AgentReadiness;
}

describe("sessionPhase", () => {
  it("maps each provider status to a distinct line", () => {
    expect(sessionPhase("idle")).toEqual({ label: "Signed out", tone: "muted" });
    expect(sessionPhase("starting").tone).toBe("warning");
    expect(sessionPhase("ready")).toEqual({ label: "Live", tone: "success" });
    expect(sessionPhase("error").tone).toBe("danger");
  });
});

describe("agentLine", () => {
  it("is a muted dash before a session has run the gate", () => {
    expect(agentLine(null)).toEqual({ label: "—", tone: "muted" });
  });

  it("renders ready and rotation-due as distinct states", () => {
    expect(agentLine(agentWith({ kind: "ready", account: {} as never }))).toEqual({
      label: "Ready",
      tone: "success",
    });
    const due = agentLine(
      agentWith({ kind: "rotation_due", account: {} as never, validUntil: 123 })
    );
    expect(due.tone).toBe("warning");
    expect(due.label).toContain("rotation due");
  });

  it("spells out every approval_required reason", () => {
    const reasons = [
      "no_agents_registered",
      "no_local_key",
      "key_address_mismatch",
      "expired",
    ] as const;
    for (const reason of reasons) {
      const line = agentLine(agentWith({ kind: "approval_required", reason }));
      expect(line.tone).toBe("warning");
      expect(line.label).toMatch(/^Approval required — ./);
      // Never the raw enum spelling — that is the bug this map exists to fix.
      expect(line.label).not.toContain("_");
    }
  });
});

describe("activatedLabel", () => {
  it("keeps a failed read distinct from a real no", () => {
    // Collapsing null into false told a funded user under a shared-IP 429 to
    // "deposit first" — the exact lie AgentReadiness.activated documents.
    expect(activatedLabel(null)).toBe("unknown (read failed)");
    expect(activatedLabel(false)).toBe("not activated — deposit first");
    expect(activatedLabel(true)).toBe("activated");
    expect(activatedLabel(null)).not.toBe(activatedLabel(false));
  });
});

describe("countLabel", () => {
  it("refuses to render a failed read as zero", () => {
    expect(countLabel(null, true)).toBe("unknown (read failed)");
    expect(countLabel([], true)).toBe("0");
    expect(countLabel([1, 2], true)).toBe("2");
    expect(countLabel(null, false)).toBe("—");
  });
});

describe("budgetTone", () => {
  it("escalates at half and at 85% of the window", () => {
    // Against the limit the app ENFORCES (`SOFT_WEIGHT_PER_MINUTE`), not the
    // documented 1200. The gauge used to be scaled to 1200 while `used` is
    // provably bounded by 1000, so the arc could never pass 83% and the danger
    // band at 85% was unreachable in production — the cases below asserted on
    // inputs the live budget could not produce.
    expect(budgetTone(0, 1000)).toBe("success");
    expect(budgetTone(499, 1000)).toBe("success");
    expect(budgetTone(500, 1000)).toBe("warning");
    expect(budgetTone(849, 1000)).toBe("warning");
    expect(budgetTone(850, 1000)).toBe("danger");
    expect(budgetTone(1000, 1000)).toBe("danger");
  });

  it("is muted on a degenerate limit rather than dividing by zero", () => {
    expect(budgetTone(10, 0)).toBe("muted");
  });
});

describe("walletLine", () => {
  it("keeps loading, none and locked as three different answers", () => {
    expect(walletLine(null).title).toBe("Checking…");
    expect(walletLine({ kind: "none" }).tone).toBe("muted");
    const locked = walletLine({ kind: "locked" });
    // Rendering locked as "no wallet" invites creating a second wallet on top
    // of a recoverable one — the single worst move available from that state.
    expect(locked.tone).toBe("danger");
    expect(locked.title).not.toBe(walletLine({ kind: "none" }).title);
  });

  it("names the wallet kind and counts accounts", () => {
    const ready: WalletState = {
      kind: "ready",
      metadata: {
        kind: "seeded",
        accounts: [{ index: 0, address: "0xab", label: null }],
        createdAt: 0,
        backedUp: false,
      },
    } as WalletState;
    expect(walletLine(ready)).toEqual({
      title: "Recovery-phrase wallet",
      detail: "1 account on this device",
      tone: "success",
    });
  });
});

describe("socketLine", () => {
  it("maps each connection state", () => {
    expect(socketLine("open")).toEqual({ label: "Connected", tone: "success" });
    expect(socketLine("connecting").tone).toBe("warning");
    expect(socketLine("idle").tone).toBe("muted");
    expect(socketLine("terminated").tone).toBe("danger");
  });
});

describe("avatarLabel", () => {
  it("wears the two hex characters after 0x, uppercased", () => {
    expect(avatarLabel("0x5bf8287baeda8de01c88b3016d64f3875b0b4347")).toBe("5B");
    expect(avatarLabel(null)).toBe("· ·");
  });
});

describe("phraseWords", () => {
  it("numbers words from 1 and survives irregular whitespace", () => {
    expect(phraseWords("alpha beta  gamma")).toEqual([
      { index: 1, word: "alpha" },
      { index: 2, word: "beta" },
      { index: 3, word: "gamma" },
    ]);
    expect(phraseWords("  ")).toEqual([]);
  });
});

describe("importKind", () => {
  const key = "a".repeat(64);

  it("classifies a 64-hex key with or without 0x", () => {
    expect(importKind(key)).toBe("privateKey");
    expect(importKind(`0x${key}`)).toBe("privateKey");
    expect(importKind(`  ${key}  `)).toBe("privateKey");
  });

  it("refuses to round a truncated or overlong key into one", () => {
    expect(importKind("a".repeat(63))).toBe("invalid");
    expect(importKind("a".repeat(65))).toBe("invalid");
    expect(importKind(`${"a".repeat(63)}g`)).toBe("invalid");
  });

  it("accepts only BIP-39 word counts as a phrase", () => {
    const words = (n: number): string => Array.from({ length: n }, () => "abandon").join(" ");
    for (const n of [12, 15, 18, 21, 24]) expect(importKind(words(n))).toBe("mnemonic");
    for (const n of [1, 11, 13, 23, 25]) expect(importKind(words(n))).toBe("invalid");
  });

  it("rejects word lists containing non-letters, and empty input", () => {
    const eleven = Array.from({ length: 11 }, () => "abandon").join(" ");
    expect(importKind(`${eleven} 42`)).toBe("invalid");
    expect(importKind("")).toBe("invalid");
    expect(importKind("   ")).toBe("invalid");
  });
});

describe("importCaption", () => {
  it("captions each state, counting phrase words", () => {
    expect(importCaption("invalid", "")).toContain("64-character");
    expect(importCaption("privateKey", "a".repeat(64))).toBe("Looks like a private key.");
    const twelve = Array.from({ length: 12 }, () => "abandon").join(" ");
    expect(importCaption("mnemonic", twelve)).toBe("Looks like a 12-word recovery phrase.");
    expect(importCaption("invalid", "nope")).toContain("Not a private key");
  });
});

describe("connectionMeasure", () => {
  it("shows the socket whenever it is not open — a quiet budget hides a dead feed", () => {
    // 0/1200 next to a terminated socket reads as perfect health; the socket
    // is the fact that matters, so it takes the slot.
    expect(connectionMeasure("terminated", 0, 1200)).toEqual({
      label: "Terminated",
      tone: "danger",
    });
    expect(connectionMeasure("connecting", 0, 1200)).toEqual({
      label: "Connecting…",
      tone: "warning",
    });
    expect(connectionMeasure("idle", 900, 1200)).toEqual({ label: "Idle", tone: "muted" });
  });

  it("shows the budget once the socket is up, toned by pressure", () => {
    expect(connectionMeasure("open", 100, 1200)).toEqual({
      label: "100 / 1200 weight",
      tone: "success",
    });
    expect(connectionMeasure("open", 600, 1200)).toEqual({
      label: "600 / 1200 weight",
      tone: "warning",
    });
    expect(connectionMeasure("open", 1100, 1200)).toEqual({
      label: "1100 / 1200 weight",
      tone: "danger",
    });
  });

  it("names the unit — a bare fraction under a 'Connection' heading means nothing", () => {
    // What is metered is request WEIGHT per minute, not connections or
    // messages, and the heading above it invites both wrong readings.
    expect(connectionMeasure("open", 8, 1000).label).toContain("weight");
  });
});

describe("walletMeasure", () => {
  const seeded = (backedUp: boolean): WalletState => ({
    kind: "ready",
    metadata: {
      kind: "seeded",
      accounts: [{ index: 0, address: "0xabc", label: null }],
      createdAt: 0,
      backedUp,
    } as WalletMetadata,
  });

  it("asks for a backup exactly once — and only for a phrase that exists", () => {
    // The one state on this screen with an outstanding user action, visible
    // without opening the section.
    expect(walletMeasure(seeded(false))).toEqual({ label: "Back up", tone: "warning" });
    expect(walletMeasure(seeded(true))).toEqual({ label: "Backed up", tone: "success" });
  });

  it("never claims a backup for an imported key — there is no phrase to hold", () => {
    const imported: WalletState = {
      kind: "ready",
      metadata: {
        kind: "importedKey",
        accounts: [{ index: 0, address: "0xabc", label: null }],
        createdAt: 0,
        backedUp: false,
      } as WalletMetadata,
    };
    expect(walletMeasure(imported)).toEqual({ label: "Imported key", tone: "success" });
  });

  it("keeps locked apart from absent, and in-flight apart from both", () => {
    // Rendering `locked` as "None" invites a second wallet on top of funds.
    expect(walletMeasure({ kind: "locked" })).toEqual({ label: "Locked", tone: "danger" });
    expect(walletMeasure({ kind: "none" })).toEqual({ label: "None", tone: "muted" });
    expect(walletMeasure(null)).toEqual({ label: "Checking…", tone: "muted" });
  });
});
