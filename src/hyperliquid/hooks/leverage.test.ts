import { parseActiveAssetData } from "@/hyperliquid/hooks/leverage";

describe("parseActiveAssetData", () => {
  it("reads both live wire shapes", () => {
    expect(parseActiveAssetData({ leverage: { type: "cross", value: 20 } })).toEqual({
      leverage: 20,
      isCross: true,
    });
    expect(
      parseActiveAssetData({ leverage: { type: "isolated", value: 5, rawUsd: "12.5" } })
    ).toEqual({ leverage: 5, isCross: false });
  });

  it("returns null on any shape surprise — no partial credit on margin inputs", () => {
    expect(parseActiveAssetData(null)).toBeNull();
    expect(parseActiveAssetData({})).toBeNull();
    expect(parseActiveAssetData({ leverage: { type: "cross", value: "20" } })).toBeNull();
    expect(parseActiveAssetData({ leverage: { type: "margin", value: 3 } })).toBeNull();
    expect(parseActiveAssetData({ leverage: { type: "cross", value: Number.NaN } })).toBeNull();
  });
});
