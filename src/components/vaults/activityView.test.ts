import {
  applyFlag,
  distinctFlags,
  explorerTxUrl,
  sortFeed,
  windowMs,
  type FeedRow,
} from "@/components/vaults/activityView";

function row(over: Partial<FeedRow> & { timeMs: number }): FeedRow {
  return { sortValue: null, flag: null, ...over };
}

describe("distinctFlags", () => {
  it("offers each flag once, in first-appearance order", () => {
    // Rows arrive newest-first, so the tags lead with what is happening now.
    expect(
      distinctFlags([
        row({ timeMs: 3, flag: "Close Long" }),
        row({ timeMs: 2, flag: "Open Short" }),
        row({ timeMs: 1, flag: "Close Long" }),
      ])
    ).toEqual(["Close Long", "Open Short"]);
  });

  it("never offers a filter that matches nothing", () => {
    // The list is derived from the rows, so an empty feed offers no tags.
    expect(distinctFlags([])).toEqual([]);
    expect(distinctFlags([row({ timeMs: 1 })])).toEqual([]);
  });
});

describe("applyFlag", () => {
  const rows = [
    row({ timeMs: 3, flag: "Buy" }),
    row({ timeMs: 2, flag: "Sell" }),
    row({ timeMs: 1, flag: "Buy" }),
  ];

  it("selects everything for null", () => {
    expect(applyFlag(rows, null)).toHaveLength(3);
  });

  it("matches the flag exactly", () => {
    expect(applyFlag(rows, "Buy").map((r) => r.timeMs)).toEqual([3, 1]);
    expect(applyFlag(rows, "Nothing")).toEqual([]);
  });
});

describe("sortFeed", () => {
  const rows = [
    row({ timeMs: 10, sortValue: 5 }),
    row({ timeMs: 30, sortValue: -100 }),
    row({ timeMs: 20, sortValue: 50 }),
  ];

  it("orders by time both ways", () => {
    expect(sortFeed(rows, "newest").map((r) => r.timeMs)).toEqual([30, 20, 10]);
    expect(sortFeed(rows, "oldest").map((r) => r.timeMs)).toEqual([10, 20, 30]);
  });

  it("ranks 'largest' by MAGNITUDE, so a big loss outranks a small gain", () => {
    expect(sortFeed(rows, "largest").map((r) => r.sortValue)).toEqual([-100, 50, 5]);
  });

  it("sorts a row with no figure LAST, never as a zero", () => {
    // An open order has no P&L; ranking it below every loss would assert it
    // broke even.
    const mixed = [row({ timeMs: 1, sortValue: null }), row({ timeMs: 2, sortValue: -3 })];
    expect(sortFeed(mixed, "largest").map((r) => r.sortValue)).toEqual([-3, null]);
  });

  it("never mutates the caller's array", () => {
    const original = [row({ timeMs: 1 }), row({ timeMs: 2 })];
    sortFeed(original, "newest");
    expect(original.map((r) => r.timeMs)).toEqual([1, 2]);
  });
});

describe("explorerTxUrl", () => {
  const HASH = "0x9c2f8e1d4b7a6053f2e1c8d94b7a60531f2e8c4d9b7a60532f1e8c4d9b7a6053";

  it("builds the link on the network being viewed", () => {
    expect(explorerTxUrl("mainnet", HASH)).toBe(`https://app.hyperliquid.xyz/explorer/tx/${HASH}`);
    expect(explorerTxUrl("testnet", HASH)).toBe(
      `https://app.hyperliquid-testnet.xyz/explorer/tx/${HASH}`
    );
  });

  it("refuses the all-zero hash — that row has NO transaction", () => {
    // 18 of 22,832 measured ledger rows carry it; linking sends the reader to
    // a 404 and implies the transfer is missing from the chain.
    expect(explorerTxUrl("mainnet", "0x0000000000000000000000000000000000000000")).toBeNull();
    expect(explorerTxUrl("mainnet", "0x0")).toBeNull();
  });

  it("refuses anything that is not a hex hash", () => {
    expect(explorerTxUrl("mainnet", null)).toBeNull();
    expect(explorerTxUrl("mainnet", undefined)).toBeNull();
    expect(explorerTxUrl("mainnet", "")).toBeNull();
    expect(explorerTxUrl("mainnet", "not-a-hash")).toBeNull();
    // No `0x` prefix is not a hash this app will hand to a browser.
    expect(explorerTxUrl("mainnet", "9c2f8e1d")).toBeNull();
  });
});

describe("windowMs", () => {
  it("maps each window to its span", () => {
    expect(windowMs("day")).toBe(86_400_000);
    expect(windowMs("week")).toBe(604_800_000);
    expect(windowMs("month")).toBe(2_592_000_000);
  });
});
