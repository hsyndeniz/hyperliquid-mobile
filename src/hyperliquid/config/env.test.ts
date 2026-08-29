import { builderFeePercentString, resolveHlConfig } from "@/hyperliquid/config/env";

describe("builderFeePercentString", () => {
  // Units confirmed from Hyperliquid's info-endpoint docs: the number is in
  // tenths of a basis point, i.e. 1 means 0.001%.
  it("converts tenths of a basis point to a percent string", () => {
    expect(builderFeePercentString(1)).toBe("0.001%");
    expect(builderFeePercentString(50)).toBe("0.05%");
    expect(builderFeePercentString(1000)).toBe("1%");
  });

  it("produces a string matching the action's strict schema", () => {
    const schema = /^[0-9]+(\.[0-9]+)?%$/;
    for (const value of [0, 1, 50, 100, 1000, 12345]) {
      expect(builderFeePercentString(value)).toMatch(schema);
    }
  });

  it("never emits exponent notation for small fees", () => {
    expect(builderFeePercentString(0.1)).not.toMatch(/e/i);
  });

  it("rejects negative fees rather than signing an invalid rate", () => {
    expect(() => builderFeePercentString(-1)).toThrow(/non-negative/);
  });
});

/**
 * Env values are injected rather than set on `process.env`: babel-preset-expo
 * inlines `process.env.EXPO_PUBLIC_*` at build time, so runtime mutation has no
 * effect. See the note in `env.ts`.
 */
describe("resolveHlConfig", () => {
  it("defaults to testnet so development never spends real funds", () => {
    const config = resolveHlConfig({}, {});
    expect(config.env).toBe("testnet");
    expect(config.isTestnet).toBe(true);
  });

  it("derives isTestnet from env", () => {
    expect(resolveHlConfig({}, { env: "mainnet" }).isTestnet).toBe(false);
    expect(resolveHlConfig({}, { env: "testnet" }).isTestnet).toBe(true);
  });

  it("keeps isTestnet consistent when env is overridden alone", () => {
    expect(resolveHlConfig({ env: "mainnet" }, { env: "testnet" }).isTestnet).toBe(false);
  });

  it("rejects an unknown network rather than silently defaulting", () => {
    expect(() => resolveHlConfig({}, { env: "staging" })).toThrow(/must be "mainnet" or "testnet"/);
  });

  it("disables builder fees when no address is configured", () => {
    expect(resolveHlConfig({}, {}).builderAddress).toBeNull();
  });

  it("treats a blank builder address as unset", () => {
    expect(resolveHlConfig({}, { builderAddress: "   " }).builderAddress).toBeNull();
  });

  it("normalises a valid builder address to lowercase", () => {
    const config = resolveHlConfig(
      {},
      { builderAddress: "0x9B12E858DA780A96876E3018780CF0D83359B0BB" }
    );
    expect(config.builderAddress).toBe("0x9b12e858da780a96876e3018780cf0d83359b0bb");
  });

  it("throws on a malformed builder address instead of failing at order time", () => {
    expect(() => resolveHlConfig({}, { builderAddress: "0xnope" })).toThrow(/20-byte address/);
  });

  it("throws on a non-numeric builder fee", () => {
    expect(() => resolveHlConfig({}, { maxBuilderFee: "half a bip" })).toThrow(/must be a number/);
  });

  it("falls back to the default builder fee when unset", () => {
    expect(resolveHlConfig({}, {}).maxBuilderFee).toBe(50);
  });

  it("pins the EIP-712 signature chain id to Arbitrum on both networks", () => {
    expect(resolveHlConfig({}, { env: "testnet" }).signatureChainId).toBe("0xa4b1");
    expect(resolveHlConfig({}, { env: "mainnet" }).signatureChainId).toBe("0xa4b1");
  });

  it("lets overrides win, as a future config service will", () => {
    const config = resolveHlConfig({ referralCode: "OVERRIDE" }, { referralCode: "FROMENV" });
    expect(config.referralCode).toBe("OVERRIDE");
  });
});
