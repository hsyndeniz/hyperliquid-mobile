/**
 * The CSV rules that protect reconciliation: wire strings verbatim, ISO-8601
 * UTC times, RFC-4180 escaping, and an empty cell — never a zero — for an
 * unknowable amount.
 */

import { csvField, fillsCsv, ledgerCsv } from "@/components/portfolio/exportCsv";
import type { LedgerRow } from "@/hyperliquid/history/ledger";
import type { Fill } from "@/hyperliquid/types/domain";

function fill(overrides: Partial<Fill>): Fill {
  return {
    key: "1:1",
    tid: 1,
    oid: 57804614205,
    coin: "BTC",
    side: "buy",
    px: "63645.0",
    sz: "0.00024",
    time: 1786629053442,
    startPosition: "0.0",
    dir: "Open Long",
    closedPnl: "0.0",
    fee: "0.006873",
    feeToken: "USDC",
    builderFee: null,
    crossed: true,
    hash: "0x2a26",
    twapId: null,
    liquidation: null,
    source: "fill",
    ...overrides,
  } as Fill;
}

describe("csvField", () => {
  it("passes plain values through untouched", () => {
    expect(csvField("63645.0")).toBe("63645.0");
    expect(csvField("Open Long")).toBe("Open Long");
  });

  it("quotes and doubles per RFC 4180 when a comma, quote or newline appears", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });
});

describe("fillsCsv", () => {
  it("emits wire strings verbatim with ISO UTC times", () => {
    const csv = fillsCsv([fill({})]);
    const [header, row] = csv.split("\n");
    expect(header).toBe("time,coin,side,dir,price,size,fee,fee_token,closed_pnl,oid,hash");
    // The exact wire spellings — a reformatted "63645" would defeat
    // reconciliation against the exchange's own export.
    expect(row).toBe(
      "2026-08-13T13:50:53.442Z,BTC,buy,Open Long,63645.0,0.00024,0.006873,USDC,0.0,57804614205,0x2a26"
    );
  });

  it("escapes a dir that grows a comma instead of corrupting the row", () => {
    const csv = fillsCsv([fill({ dir: "Close, Forced" })]);
    expect(csv.split("\n")[1]).toContain('"Close, Forced"');
    expect(csv.split("\n")[1]?.split(",").length).toBeGreaterThan(10);
  });
});

describe("ledgerCsv", () => {
  const deposit: LedgerRow = {
    time: 1786629053442,
    hash: "0xabc",
    type: "deposit",
    delta: { type: "deposit", usdc: "2.0" },
  };

  it("resolves direction relative to the viewer and keeps the amount verbatim", () => {
    const csv = ledgerCsv([deposit], "0x5bf8287baeda8de01c88b3016d64f3875b0b4347");
    expect(csv.split("\n")[0]).toBe("time,type,direction,amount,token,hash");
    // A real USDC row leaves `token` empty — the figure IS dollars.
    expect(csv.split("\n")[1]).toBe("2026-08-13T13:50:53.442Z,deposit,in,2.0,,0xabc");
  });

  it("names the TOKEN when the amount is not dollars", () => {
    // The column was `amount_usdc` and `ledgerAmount` falls back to the bare
    // `amount` field, which is a token quantity on every type carrying no USD
    // figure. An account that staked HYPE exported `1000` under a USDC header;
    // summing that column added 1,000 HYPE to a dollar total, with nothing on
    // the row to reveal it.
    const staking: LedgerRow = {
      time: 1786629053442,
      hash: "0xdef",
      type: "cStakingTransfer",
      delta: { type: "cStakingTransfer", amount: "1000", token: "HYPE" },
    };
    const csv = ledgerCsv([staking], "0x5bf8");
    expect(csv.split("\n")[1]).toBe(
      "2026-08-13T13:50:53.442Z,cStakingTransfer,unknown,1000,HYPE,0xdef"
    );
  });

  it("says `unknown` rather than nothing when a token amount names no token", () => {
    const bare: LedgerRow = {
      time: 1786629053442,
      hash: "0xdef",
      type: "spotGenesis",
      delta: { type: "spotGenesis", amount: "5" },
    };
    expect(ledgerCsv([bare], "0x5bf8").split("\n")[1]).toContain(",5,unknown,");
  });

  it("exports an unknown amount as an empty cell, never a zero", () => {
    const weird: LedgerRow = { time: 1786629053442, hash: "0x0", type: "mystery", delta: {} };
    const csv = ledgerCsv([weird], "0x5bf8");
    expect(csv.split("\n")[1]).toBe("2026-08-13T13:50:53.442Z,mystery,unknown,,,0x0");
  });
});
