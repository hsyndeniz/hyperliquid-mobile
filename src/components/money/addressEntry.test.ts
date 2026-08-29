/**
 * Address entry: forgiving in, canonical out, honest about what was checked.
 */

import {
  addressParts,
  clipboardCandidate,
  entryStatus,
  normalizeAddressInput,
} from "@/components/money/addressEntry";

const CHECKSUMMED = "0x3Fa99D6dE97AB2A83Da9Ff4958f882C420e47CC3";
const LOWER = CHECKSUMMED.toLowerCase();

describe("normalizeAddressInput", () => {
  it("strips the whitespace our own chunked rendering carries", () => {
    // Pasting "5Bf8 287B …" — the app's own display format — must work.
    expect(normalizeAddressInput("3Fa9 9D6d E97A B2A8 3Da9 Ff49 58f8 82C4 20e4 7CC3")).toBe(
      CHECKSUMMED.replace("0x3", "0x3")
    );
  });

  it("supplies a missing 0x", () => {
    expect(normalizeAddressInput(CHECKSUMMED.slice(2))).toBe(CHECKSUMMED);
  });

  it("preserves case — it carries the checksum", () => {
    expect(normalizeAddressInput(CHECKSUMMED)).toBe(CHECKSUMMED);
    expect(normalizeAddressInput(LOWER)).toBe(LOWER);
  });

  it("cuts pasted surroundings rather than overflowing", () => {
    expect(normalizeAddressInput(`${CHECKSUMMED}extra999`)).toBe(CHECKSUMMED);
  });

  it("drops non-hex noise", () => {
    expect(normalizeAddressInput("0x3Fa9!!9D6d")).toBe("0x3Fa99D6d");
  });

  it("is empty for empty", () => {
    expect(normalizeAddressInput("   ")).toBe("");
  });
});

describe("addressParts", () => {
  it("splits into bold head, quiet middle, bold tail — reassembling exactly", () => {
    const parts = addressParts(CHECKSUMMED);

    expect(parts.head).toBe("3Fa9");
    expect(parts.tail).toBe("7CC3");
    // The emphasis is a rendering, never a rewrite: the three spans joined must
    // be the input byte for byte, or the "same string" claim is false.
    expect(`${parts.prefix}${parts.head}${parts.middle}${parts.tail}`).toBe(CHECKSUMMED);
  });

  it("keeps a partial entry whole rather than inventing a tail", () => {
    // Mid-typing there is no meaningful "last four" — the string is still
    // growing, and bolding its current end would highlight a moving target.
    const parts = addressParts("0x3Fa99D");

    expect(parts).toEqual({ prefix: "0x", head: "3Fa99D", middle: "", tail: "" });
  });

  it("handles a bare body without a prefix", () => {
    const parts = addressParts(CHECKSUMMED.slice(2));

    expect(parts.prefix).toBe("");
    expect(`${parts.head}${parts.middle}${parts.tail}`).toBe(CHECKSUMMED.slice(2));
  });
});

describe("entryStatus", () => {
  it("counts progress mid-entry", () => {
    expect(entryStatus("0x3Fa99D")).toEqual({ kind: "typing", count: 6 });
  });

  it("says VERIFIED only for a checksummed address", () => {
    expect(entryStatus(CHECKSUMMED)).toMatchObject({ kind: "verified" });
  });

  it("says unverified — not valid — for an all-lowercase address", () => {
    // Lowercase carries no checksum. Calling it "valid" would launder "failed
    // to be malformed" into "survived a check".
    expect(entryStatus(LOWER)).toMatchObject({ kind: "unverified" });
  });

  it("names the wrong-character case specifically", () => {
    // One flipped case character breaks EIP-55.
    const wrong = `${CHECKSUMMED.slice(0, -1)}${CHECKSUMMED.slice(-1) === "3" ? "3" : "3"}`;
    const flipped = wrong.replace("3Fa9", "3fA9");
    const status = entryStatus(flipped);

    expect(status).toMatchObject({ kind: "invalid" });
    if (status.kind === "invalid") expect(status.reason).toMatch(/checksum/i);
  });

  it("refuses a black hole with the reason that matters", () => {
    const status = entryStatus("0x0000000000000000000000000000000000000000");

    if (status.kind !== "invalid") throw new Error("expected invalid");
    expect(status.reason).toMatch(/ever be recovered/i);
  });
});

describe("clipboardCandidate", () => {
  it("offers a copied address, even space-grouped or bare", () => {
    expect(clipboardCandidate("3Fa9 9D6d E97A B2A8 3Da9 Ff49 58f8 82C4 20e4 7CC3")).toMatchObject({
      display: CHECKSUMMED,
    });
  });

  it("stays silent for anything that is not an address", () => {
    // The clipboard may hold a password or a message. Only a valid address is
    // ever surfaced; arbitrary clipboard text must never reach the screen.
    expect(clipboardCandidate("correct horse battery staple")).toBeNull();
    expect(clipboardCandidate("")).toBeNull();
    expect(clipboardCandidate(`${CHECKSUMMED.slice(0, 30)}`)).toBeNull();
  });

  it("stays silent for a black hole", () => {
    expect(clipboardCandidate("0x0000000000000000000000000000000000000000")).toBeNull();
  });
});
