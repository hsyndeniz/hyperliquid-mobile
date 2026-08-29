/**
 * The `pnls` slice of the directory blob.
 *
 * Lives beside `list.test.ts` rather than inside it because the whole point of
 * this field is that it is nearly free — the blob is already downloaded and
 * already outside the weight budget — so the cost that matters is what the
 * parse *retains*, and that is what these tests pin.
 */

import live from "@/hyperliquid/vaults/__fixtures__/vault-list-mainnet.json";
import { parseVaultList, parseVaultSummary, readPeriodPnl } from "@/hyperliquid/vaults/list";

/** The four-tuple shape the CDN actually sends, with the period under test filled. */
function pnls(month: unknown): unknown {
  return [
    ["day", ["0.0", "1.0"]],
    ["week", ["0.0", "2.0"]],
    ["month", month],
    ["allTime", ["0.0", "3.0"]],
  ];
}

describe("readPeriodPnl", () => {
  it("reads the asked-for period, not the first tuple", () => {
    expect(readPeriodPnl(pnls(["0.0", "9.5"]), "month")).toEqual(["0.0", "9.5"]);
    expect(readPeriodPnl(pnls(["0.0", "9.5"]), "day")).toEqual(["0.0", "1.0"]);
    expect(readPeriodPnl(pnls(["0.0", "9.5"]), "allTime")).toEqual(["0.0", "3.0"]);
  });

  it("keeps the points as strings — they are money and never become numbers here", () => {
    const series = readPeriodPnl(pnls(["0.0", "-11216.250904"]), "month");
    expect(series).not.toBeNull();
    for (const point of series!) expect(typeof point).toBe("string");
    // Exact to the last digit: a round-trip through a double loses it.
    expect(series![1]).toBe("-11216.250904");
  });

  it("refuses a series under two points — one point is not a line", () => {
    expect(readPeriodPnl(pnls(["0.0"]), "month")).toBeNull();
    expect(readPeriodPnl(pnls([]), "month")).toBeNull();
  });

  it("rejects the WHOLE series when one point is malformed, never a shifted one", () => {
    // Position is the x-axis — these points carry no timestamps. Dropping the
    // bad one would slide every later point left and draw a confident line
    // through a shape that does not exist.
    expect(readPeriodPnl(pnls(["0.0", "1.0", null, "3.0"]), "month")).toBeNull();
    expect(readPeriodPnl(pnls(["0.0", 1.0, "3.0"]), "month")).toBeNull();
    expect(readPeriodPnl(pnls(["0.0", "1e3", "3.0"]), "month")).toBeNull();
    expect(readPeriodPnl(pnls(["0.0", "", "3.0"]), "month")).toBeNull();
  });

  it("answers null for an absent period, an absent field, and a non-array", () => {
    expect(readPeriodPnl(pnls(["0.0", "1.0"]), "quarter")).toBeNull();
    expect(readPeriodPnl(undefined, "month")).toBeNull();
    expect(readPeriodPnl({ month: ["0.0", "1.0"] }, "month")).toBeNull();
    expect(readPeriodPnl([["month", "0.0,1.0"]], "month")).toBeNull();
  });
});

describe("parseVaultSummary wires monthPnl from the OUTER entry", () => {
  const summary = {
    name: "A vault",
    vaultAddress: "0x1111111111111111111111111111111111111111",
    leader: "0x2222222222222222222222222222222222222222",
    tvl: "1000.5",
    isClosed: false,
    relationship: { type: "normal" },
    createTimeMillis: 1_700_000_000_000,
  };

  it("reads `pnls` beside `apr`, not inside `summary`", () => {
    const parsed = parseVaultSummary({ apr: 0, pnls: pnls(["0.0", "4.5"]), summary });
    expect(parsed!.monthPnl).toEqual(["0.0", "4.5"]);
    // The same field nested one level down is NOT where the CDN puts it.
    const misplaced = parseVaultSummary({
      apr: 0,
      summary: { ...summary, pnls: pnls(["0.0", "4.5"]) },
    });
    expect(misplaced!.monthPnl).toBeNull();
  });

  it("leaves an entry with no pnls usable — the row survives without a sparkline", () => {
    const parsed = parseVaultSummary({ apr: 0, summary });
    expect(parsed).not.toBeNull();
    expect(parsed!.monthPnl).toBeNull();
  });
});

describe("the recorded mainnet blob", () => {
  const parsed = parseVaultList(live);

  it("carries a month series on every entry", () => {
    expect(parsed).toHaveLength(live.length);
    for (const vault of parsed) expect(vault.monthPnl).not.toBeNull();
  });

  it("has VARYING lengths — nothing may index a fixed twelfth point", () => {
    const lengths = new Set(parsed.map((vault) => vault.monthPnl!.length));
    // Measured on this blob: 11 to 13 across 18 entries. A parser that assumed
    // one length would read `undefined` on most of them.
    expect(lengths.size).toBeGreaterThan(1);
    for (const length of lengths) expect(length).toBeGreaterThanOrEqual(2);
  });

  it("anchors every series at zero — this is PnL since the period, not equity", () => {
    for (const vault of parsed) expect(vault.monthPnl![0]).toBe("0.0");
  });

  it("keeps signed decimals verbatim, including the losing vaults", () => {
    const negative = parsed.filter((vault) => vault.monthPnl!.some((p) => p.startsWith("-")));
    expect(negative.length).toBeGreaterThan(0);
    for (const vault of parsed) {
      for (const point of vault.monthPnl!) expect(point).toMatch(/^-?[0-9]+(\.[0-9]+)?$/);
    }
  });

  it("leaves a large share of the blob flat at zero — a real state, not a gap", () => {
    // 8 of these 18, one of them a $30m-TVL vault. The card must not draw a
    // line for these; see `pnlSpark`.
    const flat = parsed.filter((vault) => vault.monthPnl!.every((point) => point === "0.0"));
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.length).toBeLessThan(parsed.length);
  });
});
