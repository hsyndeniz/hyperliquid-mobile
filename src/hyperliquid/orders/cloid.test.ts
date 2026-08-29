import { HlError } from "@/hyperliquid/core/errors";
import {
  assertCloid,
  generateCloid,
  isIntegerAmbiguous,
  isValidCloid,
  normalizeCloid,
  readCloid,
} from "@/hyperliquid/orders/cloid";

describe("generateCloid", () => {
  it("produces the exact 34-character form the schema requires", () => {
    const cloid = generateCloid();
    expect(cloid).toHaveLength(34);
    expect(cloid).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it("is unique across many draws", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateCloid()));
    expect(seen.size).toBe(500);
  });

  it("never emits a value that orderStatus would read as a numeric oid", () => {
    // orderStatus tries the UnsignedInteger branch first and Number("0x…")
    // parses hex, so a small-valued cloid queries an unrelated order.
    for (let i = 0; i < 200; i += 1) {
      expect(isIntegerAmbiguous(generateCloid())).toBe(false);
    }
  });

  it("throws rather than emitting a predictable id when no CSPRNG exists", () => {
    const original = globalThis.crypto;
    // @ts-expect-error — deliberately removing the global for this case.
    delete globalThis.crypto;
    try {
      expect(() => generateCloid()).toThrow(HlError);
    } finally {
      globalThis.crypto = original;
    }
  });
});

describe("isIntegerAmbiguous", () => {
  it("flags counter-derived ids, which are the realistic hazard", () => {
    expect(isIntegerAmbiguous("0x" + "0".repeat(31) + "1")).toBe(true);
    expect(isIntegerAmbiguous("0x" + "0".repeat(24) + "ffffffff")).toBe(true);
  });

  it("accepts a full-entropy id", () => {
    expect(isIntegerAmbiguous("0xffffffffffffffffffffffffffffffff")).toBe(false);
  });

  it("is exclusive at the safe-integer boundary", () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER).toString(16).padStart(32, "0");
    expect(isIntegerAmbiguous(`0x${max}`)).toBe(true);
    const justOver = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(16).padStart(32, "0");
    expect(isIntegerAmbiguous(`0x${justOver}`)).toBe(false);
  });

  it("does not throw on malformed input", () => {
    expect(isIntegerAmbiguous("not hex")).toBe(false);
  });
});

describe("normalizeCloid", () => {
  it("lowercases, matching what the exchange echoes back", () => {
    // The schema silently lowercases, so a mixed-case map key never matches.
    expect(normalizeCloid("0xABCDEF00000000000000000000000001")).toBe(
      "0xabcdef00000000000000000000000001"
    );
  });
});

describe("isValidCloid", () => {
  const valid = "0xabcdef01234567890abcdef012345678";

  it("accepts a well-formed cloid", () => {
    expect(isValidCloid(valid)).toBe(true);
  });

  it("accepts uppercase, which the schema tolerates", () => {
    expect(isValidCloid(valid.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("rejects wrong lengths — the schema enforces exactly 34", () => {
    expect(isValidCloid("0xabc")).toBe(false);
    expect(isValidCloid(`${valid}00`)).toBe(false);
  });

  it("rejects a missing prefix and non-hex characters", () => {
    expect(isValidCloid("abcdef01234567890abcdef01234567890")).toBe(false);
    expect(isValidCloid("0xzzcdef01234567890abcdef012345678")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidCloid(null)).toBe(false);
    expect(isValidCloid(123)).toBe(false);
    expect(isValidCloid(undefined)).toBe(false);
  });
});

describe("assertCloid", () => {
  it("returns the normalised value", () => {
    expect(assertCloid("0xABCDEF01234567890ABCDEF012345678")).toBe(
      "0xabcdef01234567890abcdef012345678"
    );
  });

  it("throws on a malformed value", () => {
    expect(() => assertCloid("0xnope")).toThrow(HlError);
  });
});

describe("readCloid", () => {
  it("handles the `string | null` shape from orderStatus/historicalOrders", () => {
    expect(readCloid({ cloid: "0xABCDEF01234567890ABCDEF012345678" })).toBe(
      "0xabcdef01234567890abcdef012345678"
    );
    expect(readCloid({ cloid: null })).toBeNull();
  });

  it("handles the `string | undefined` shape from openOrders/orderUpdates", () => {
    // The two Hyperliquid shapes differ; one accessor must cover both or live
    // order updates get silently dropped from the pending map.
    expect(readCloid({})).toBeNull();
    expect(readCloid({ cloid: undefined })).toBeNull();
  });
});
