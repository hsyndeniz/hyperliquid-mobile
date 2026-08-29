import {
  chunkAddress,
  isBlackHole,
  requireDestination,
  sameAddress,
  validateDestination,
} from "@/hyperliquid/transfers/destination";
import { HlError } from "@/hyperliquid/core/errors";

/** A real checksummed testnet address used throughout this project. */
const CHECKSUMMED = "0x5Bf8287BAeDA8De01C88b3016D64f3875B0B4347";
const LOWER = CHECKSUMMED.toLowerCase();

describe("validateDestination", () => {
  it("accepts a correctly checksummed address and reports both forms", () => {
    const result = validateDestination(CHECKSUMMED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The wire form is lowercase because that is what gets signed; the display
    // form is checksummed because that is what a human verifies.
    expect(result.value.wire).toBe(LOWER);
    expect(result.value.display).toBe(CHECKSUMMED);
    expect(result.checksummed).toBe(true);
  });

  describe("typo detection", () => {
    it("rejects a single altered character in a checksummed address", () => {
      // This is the whole point of the module. The SDK lowercases BEFORE
      // validating, so by the time it looks, this is indistinguishable from a
      // real address — and the server accepts it, and there is no recall.
      const typo = `0x5Bf8287BAeDA8De01C88b3016D64f3875B0B4348`;
      const result = validateDestination(typo);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("checksum_failed");
    });

    it("rejects a transposition", () => {
      const swapped = `0x5Bf8287BAeDA8De01C88b3016D64f3875B0B4374`;
      const result = validateDestination(swapped);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("checksum_failed");
    });

    it("catches a mistyped character in a longer sweep", () => {
      // Sample across the whole address rather than trusting one position.
      const body = CHECKSUMMED.slice(2);
      let caught = 0;
      let attempted = 0;
      for (let i = 0; i < body.length; i += 3) {
        const original = body[i];
        const replacement = original.toLowerCase() === "a" ? "b" : "a";
        // Keep the case pattern intact so only the VALUE changes.
        const swapped =
          original === original.toUpperCase() ? replacement.toUpperCase() : replacement;
        if (swapped === original) continue;
        attempted += 1;
        const candidate = `0x${body.slice(0, i)}${swapped}${body.slice(i + 1)}`;
        const result = validateDestination(candidate);
        if (!result.ok && result.reason === "checksum_failed") caught += 1;
      }
      expect(attempted).toBeGreaterThan(5);
      // EIP-55 is probabilistic, but should catch the overwhelming majority.
      expect(caught / attempted).toBeGreaterThan(0.9);
    });
  });

  it("accepts an all-lowercase address but reports that it carries no checksum", () => {
    // A single-case address makes no checksum claim, so there is nothing to
    // verify. The caller is told, so it can demand a stronger form.
    const result = validateDestination(LOWER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checksummed).toBe(false);
    expect(result.value.display).toBe(CHECKSUMMED);
  });

  it.each([
    ["too short", "0x5Bf8287BAeDA8De01C88b3016D64f3875B0B43"],
    ["too long", `${CHECKSUMMED}00`],
    ["no 0x prefix", CHECKSUMMED.slice(2)],
    ["not hex", "0xZZf8287BAeDA8De01C88b3016D64f3875B0B4347"],
    ["empty", ""],
  ])("rejects a %s address as malformed", (_label, bad) => {
    const result = validateDestination(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it.each([
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dEaD",
    "0xffffffffffffffffffffffffffffffffffffffff",
  ])("blocks the black hole %s", (address) => {
    // preTransferCheck reports every one of these as an existing, unsanctioned
    // account, so its green light is worthless here.
    const result = validateDestination(address);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("blacklisted");
    expect(isBlackHole(address)).toBe(true);
  });

  it("trims surrounding whitespace from a paste", () => {
    expect(validateDestination(`  ${CHECKSUMMED}  `).ok).toBe(true);
  });
});

describe("requireDestination", () => {
  it("returns the validated forms", () => {
    expect(requireDestination(CHECKSUMMED).wire).toBe(LOWER);
  });

  it("throws on a failed checksum", () => {
    expect(() => requireDestination("0x5Bf8287BAeDA8De01C88b3016D64f3875B0B4348")).toThrow(HlError);
  });
});

describe("chunkAddress", () => {
  it("groups into fours so a human can actually compare them", () => {
    // Asked to compare 40 undifferentiated hex characters, nobody does.
    const chunks = chunkAddress(CHECKSUMMED);
    expect(chunks).toHaveLength(10);
    expect(chunks[0]).toBe("5Bf8");
    expect(chunks.join("")).toBe(CHECKSUMMED.slice(2));
  });
});

describe("sameAddress", () => {
  it("compares case-insensitively", () => {
    expect(sameAddress(CHECKSUMMED, LOWER)).toBe(true);
    expect(sameAddress(CHECKSUMMED, "0x1111111111111111111111111111111111111111")).toBe(false);
  });
});
