import {
  ageLabel,
  aprLabel,
  commissionLabel,
  DAY_MS,
  followerCountLabel,
  lockupLine,
  pnlSpark,
  pnlSparkAbsence,
  remainingLabel,
  sinceLabel,
  topFollowers,
  vaultMonogram,
} from "@/components/vaults/vaultsView";
import live from "@/hyperliquid/vaults/__fixtures__/vault-list-mainnet.json";
import { parseVaultList } from "@/hyperliquid/vaults/list";
import type { FollowerPage, FollowerRow } from "@/hyperliquid/vaults/types";

describe("aprLabel", () => {
  it("renders the float-damaged APR as an approximation, coloured by sign", () => {
    expect(aprLabel("0.1234")).toEqual({ label: "≈ 12.3%", tone: "success" });
    expect(aprLabel("-0.05")).toEqual({ label: "≈ -5.0%", tone: "danger" });
    expect(aprLabel("0")).toEqual({ label: "≈ 0.0%", tone: "muted" });
  });

  it("renders null and garbage as -- rather than a number", () => {
    expect(aprLabel(null)).toEqual({ label: "--", tone: "muted" });
    expect(aprLabel("nope")).toEqual({ label: "--", tone: "muted" });
  });
});

describe("commissionLabel", () => {
  it("keeps unread distinct from zero", () => {
    // HLP's commission IS 0 — rendering null as 0% would claim a fact.
    expect(commissionLabel(null)).toBe("--");
    expect(commissionLabel("0")).toBe("≈ 0%");
    expect(commissionLabel("0.1")).toBe("≈ 10%");
  });
});

describe("remainingLabel", () => {
  it("steps through the units", () => {
    expect(remainingLabel(30_000)).toBe("under a minute");
    expect(remainingLabel(45 * 60_000)).toBe("45 m");
    expect(remainingLabel((3 * 60 + 12) * 60_000)).toBe("3 h 12 m");
    expect(remainingLabel((2 * 24 + 4) * 60 * 60_000)).toBe("2 d 4 h");
  });
});

describe("lockupLine", () => {
  it("keeps unknown distinct from unlocked — only one permits a withdrawal", () => {
    expect(lockupLine({ kind: "unlocked" })).toEqual({ label: "Unlocked", tone: "success" });
    const unknown = lockupLine({ kind: "unknown" });
    expect(unknown.tone).toBe("muted");
    expect(unknown.label).not.toBe("Unlocked");
  });

  it("counts down while locked and says unlocking at the boundary", () => {
    const locked = lockupLine({ kind: "locked", untilMs: 2, remainingMs: 45 * 60_000 });
    expect(locked).toEqual({ label: "Locked · 45 m", tone: "warning" });
    expect(lockupLine({ kind: "locked", untilMs: 2, remainingMs: 0 }).label).toBe("Unlocking…");
  });
});

describe("sinceLabel", () => {
  it("formats a real stamp and refuses a zero one", () => {
    expect(sinceLabel(Date.UTC(2025, 2, 15))).toBe("Mar 2025");
    expect(sinceLabel(0)).toBeNull();
  });
});

describe("ageLabel", () => {
  const NOW = Date.UTC(2026, 0, 1);

  it("counts whole days from the creation stamp", () => {
    expect(ageLabel(NOW - 1199 * DAY_MS, NOW)).toBe("1199 days old");
    // Singular, because "1 days old" is the kind of thing users screenshot.
    expect(ageLabel(NOW - DAY_MS, NOW)).toBe("1 day old");
  });

  it("never says 0 days old", () => {
    expect(ageLabel(NOW - 1_000, NOW)).toBe("less than a day old");
    expect(ageLabel(NOW, NOW)).toBe("less than a day old");
  });

  it("refuses a zero stamp and a future one — both are absence, not an age", () => {
    // A zero stamp dated from the epoch would read "20000 days old".
    expect(ageLabel(0, NOW)).toBeNull();
    expect(ageLabel(-1, NOW)).toBeNull();
    expect(ageLabel(NOW + DAY_MS, NOW)).toBeNull();
  });
});

describe("pnlSpark", () => {
  it("maps the series onto an ordinal axis that fills the canvas exactly", () => {
    const spark = pnlSpark(["0.0", "12.5", "-3.25"]);
    expect(spark).not.toBeNull();
    expect(spark!.points).toEqual([
      { time: 0, value: 0 },
      { time: 1, value: 12.5 },
      { time: 2, value: -3.25 },
    ]);
    // `timeWindow` / `nowOverride`: last index, so no point sits off-canvas.
    expect(spark!.window).toBe(2);
    expect(spark!.end).toBe(2);
  });

  it("reads the net direction across the window, not the last step", () => {
    expect(pnlSpark(["0.0", "-500.0", "40.0"])!.trend).toBe("up");
    expect(pnlSpark(["0.0", "500.0", "-40.0"])!.trend).toBe("down");
    // Shape but no net move: still a line worth drawing, just not a coloured one.
    expect(pnlSpark(["0.0", "500.0", "0.0"])!.trend).toBe("flat");
  });

  it("refuses a FLAT series rather than drawing a mid-height rule", () => {
    // A flat line reads as "held steady". These vaults did nothing at all —
    // 8 of the 18 recorded mainnet entries, one of them holding $30m.
    expect(pnlSpark(["0.0", "0.0", "0.0", "0.0"])).toBeNull();
    expect(pnlSpark(["4.0", "4.0", "4.0"])).toBeNull();
  });

  it("refuses anything that is not two or more points", () => {
    expect(pnlSpark(null)).toBeNull();
    expect(pnlSpark([])).toBeNull();
    expect(pnlSpark(["0.0"])).toBeNull();
  });

  it("rejects the whole series on a non-finite point — position is the axis", () => {
    expect(pnlSpark(["0.0", "nope", "5.0"])).toBeNull();
  });

  it("keeps a flat vault and a history-less one apart at the caption", () => {
    // A flat month is a fact about the VAULT; a missing series is a fact about
    // our DATA. One caption for both would invent a measurement.
    expect(pnlSparkAbsence(["0.0", "0.0", "0.0"])).toBe("flat this month");
    expect(pnlSparkAbsence(null)).toBe("no P&L history");
    expect(pnlSparkAbsence(["0.0"])).toBe("no P&L history");
    expect(pnlSparkAbsence(["0.0", "oops"])).toBe("no P&L history");
    // A drawn line has nothing to caption.
    expect(pnlSparkAbsence(["0.0", "1.0"])).toBeNull();
  });

  it("survives every recorded mainnet entry, drawing only the ones that moved", () => {
    const parsed = parseVaultList(live);
    const drawn = parsed.filter((vault) => pnlSpark(vault.monthPnl) !== null);
    // Both halves are real states: some vaults moved this month, some did not.
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(parsed.length);
    for (const vault of parsed) {
      const spark = pnlSpark(vault.monthPnl);
      if (spark === null) continue;
      // Lengths vary 11–14 on the wire; the window follows the series, never a
      // hard-coded twelve.
      expect(spark.window).toBe(spark.points.length - 1);
      expect(spark.points.map((point) => point.time)).toEqual(
        spark.points.map((_, index) => index)
      );
    }
  });
});

function follower(user: string, equity: string, isLeader = false): FollowerRow {
  return {
    user: user as FollowerRow["user"],
    isLeader,
    vaultEquity: equity,
    pnl: "0",
    allTimePnl: "0",
    daysFollowing: 1,
    entryTimeMs: 0,
    lockupUntilMs: 0,
  };
}

describe("topFollowers", () => {
  const page: FollowerPage = {
    rows: [
      follower("0xa", "10"),
      follower("0xb", "500"),
      follower(null as unknown as string, "90000", true),
      follower("0xc", "200"),
    ],
    truncated: true,
  };

  it("pins the leader first, then the largest of the page", () => {
    const rows = topFollowers(page, 3);
    expect(rows[0].isLeader).toBe(true);
    expect(rows.slice(1).map((row) => row.vaultEquity)).toEqual(["500", "200"]);
  });

  it("copes with a page that has no leader row — measured on HLP", () => {
    const leaderless: FollowerPage = {
      rows: page.rows.filter((r) => !r.isLeader),
      truncated: false,
    };
    const rows = topFollowers(leaderless, 2);
    expect(rows.map((row) => row.vaultEquity)).toEqual(["500", "200"]);
  });
});

describe("followerCountLabel", () => {
  it("marks a capped page as open-ended", () => {
    expect(followerCountLabel({ rows: [follower("0xa", "1")], truncated: false })).toBe("1");
    expect(followerCountLabel({ rows: [follower("0xa", "1")], truncated: true })).toBe("1+");
  });
});

describe("vaultMonogram", () => {
  it("takes the first two significant characters", () => {
    expect(vaultMonogram("Alpha Vault")).toBe("AL");
    expect(vaultMonogram("  $BTC maxi  ")).toBe("BT");
    expect(vaultMonogram("··")).toBe("??");
  });
});
