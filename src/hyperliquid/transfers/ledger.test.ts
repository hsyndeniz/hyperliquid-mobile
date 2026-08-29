/**
 * Settlement, against the shape the wire actually sends.
 *
 * Every fixture below is a real `withdraw` delta from this project's testnet
 * account — all three withdrawals it has ever made:
 *
 * ```
 * {type:"withdraw", usdc:"1.0", fee:"1.0", nonce:1785886185721000}
 * {type:"withdraw", usdc:"6.0", fee:"1.0", nonce:1786542613412000}
 * {type:"withdraw", usdc:"1.0", fee:"1.0", nonce:1786676722180000}
 * ```
 *
 * Two facts follow, and both contradicted what this module believed:
 *
 * 1. **`usdc` is the NET.** The 7 USDC withdrawal reports `6.0`. The gross that
 *    was signed appears nowhere; it is `usdc + fee`.
 * 2. **There is no `destination`.** The delta has exactly four keys.
 *
 * The previous tests fabricated a row where `usdc` held the gross, so they
 * passed against a function that could never match a live withdrawal.
 */

import { arrivedAmount, grossOf, judgeSettlement } from "@/hyperliquid/transfers/ledger";

const SIGNED = 1_800_000_000_000;

const base = {
  signedAt: SIGNED,
  now: SIGNED + 300_000,
  settlementFloorMs: 900_000,
};

/**
 * A withdraw row exactly as the wire sends one: net in `usdc`, fee alongside,
 * microsecond nonce, and **no destination**.
 */
function row({
  net,
  fee = "1.0",
  nonceMs,
  at = SIGNED + 240_000,
}: {
  net: string;
  fee?: string;
  nonceMs?: number;
  at?: number;
}) {
  return {
    time: at,
    hash: "0xabc",
    type: "withdraw",
    usdc: net,
    usdValue: net,
    amount: null,
    token: null,
    fee,
    destination: null,
    nonce: nonceMs === undefined ? null : nonceMs * 1000,
    raw: {},
  };
}

describe("the gross is reconstructed, because the wire does not send it", () => {
  it("adds the fee back to the net", () => {
    // The real 7 USDC withdrawal: reported as 6.0 with a 1.0 fee.
    expect(grossOf(row({ net: "6.0" }))).toBe("7");
  });

  it("settles a withdrawal whose row reports the NET", () => {
    // The bug this replaces: comparing `usdc` to the gross could never match a
    // live row, so every withdrawal sat pending to the floor and then reported
    // unresolved forever — permanently blocking the duplicate guard.
    const verdict = judgeSettlement({ ...base, rows: [row({ net: "6.0" })], grossAmount: "7" });

    expect(verdict.kind).toBe("settled");
  });

  it("does NOT settle when the net alone happens to equal the gross", () => {
    // A 2 USDC withdrawal reports `usdc: "1.0"`. Matching that against a signed
    // gross of "1" would settle the wrong entry.
    const verdict = judgeSettlement({ ...base, rows: [row({ net: "1.0" })], grossAmount: "1" });

    expect(verdict.kind).toBe("pending");
  });

  it("matches numerically, so a padded ledger form still settles", () => {
    // We sign the canonical form ("9"); the ledger pads it ("8.0" + "1.0").
    const verdict = judgeSettlement({ ...base, rows: [row({ net: "8.0" })], grossAmount: "9" });

    expect(verdict.kind).toBe("settled");
  });

  it("still refuses a different amount", () => {
    expect(judgeSettlement({ ...base, rows: [row({ net: "7.0" })], grossAmount: "9" }).kind).toBe(
      "pending"
    );
  });
});

describe("a known nonce excludes rows that name a different one", () => {
  it("does NOT settle on another client's same-amount withdrawal", () => {
    // The ordinary path to this: an app withdrawal ends `unknown` (response
    // lost), the user is unsure and withdraws the same amount again from the
    // web app, and that row lands minutes later carrying its OWN nonce. The
    // amount+window fallback used to claim it and report the first withdrawal
    // as arrived — money that had not moved, marked as moved.
    const verdict = judgeSettlement({
      ...base,
      rows: [row({ net: "6.0", nonceMs: SIGNED + 999_000 })],
      grossAmount: "7",
      nonce: SIGNED + 100,
    });

    expect(verdict.kind).not.toBe("settled");
  });

  it("still falls back to amount for a row with NO nonce", () => {
    // The case the fallback exists for — an older row the wire does not key.
    const verdict = judgeSettlement({
      ...base,
      rows: [row({ net: "6.0" })],
      grossAmount: "7",
      nonce: SIGNED + 100,
    });

    expect(verdict.kind).toBe("settled");
  });
});

describe("the nonce is the exact key", () => {
  it("settles on the nonce even when the amount does not match", () => {
    // `nonce / 1000` is the millisecond nonce we journalled — an identity across
    // all three live rows, not a heuristic.
    const verdict = judgeSettlement({
      ...base,
      rows: [row({ net: "999.0", nonceMs: SIGNED + 100 })],
      grossAmount: "7",
      nonce: SIGNED + 100,
    });

    expect(verdict.kind).toBe("settled");
  });

  it("picks the right row when two withdrawals share an amount and a window", () => {
    // What amount matching cannot do, and the reason the duplicate guard exists
    // to keep this case rare rather than to make it correct.
    const wanted = row({ net: "6.0", nonceMs: SIGNED + 500, at: SIGNED + 260_000 });
    const other = row({ net: "6.0", nonceMs: SIGNED + 100, at: SIGNED + 240_000 });

    const verdict = judgeSettlement({
      ...base,
      rows: [other, wanted],
      grossAmount: "7",
      nonce: SIGNED + 500,
    });
    if (verdict.kind !== "settled") throw new Error("expected settled");

    expect(verdict.row.time).toBe(SIGNED + 260_000);
  });

  it("does not settle a DIFFERENT withdrawal's nonce on the amount alone", () => {
    // A row that matches the amount but carries someone else's nonce still
    // settles — by amount. What must not happen is settling when neither
    // matches.
    const verdict = judgeSettlement({
      ...base,
      rows: [row({ net: "3.0", nonceMs: SIGNED + 100 })],
      grossAmount: "7",
      nonce: SIGNED + 500,
    });

    expect(verdict.kind).toBe("pending");
  });

  it("falls back to the amount when the row carries no nonce", () => {
    const verdict = judgeSettlement({
      ...base,
      rows: [row({ net: "6.0" })],
      grossAmount: "7",
      nonce: SIGNED + 500,
    });

    expect(verdict.kind).toBe("settled");
  });
});

describe("absence is never failure", () => {
  it("reports pending inside the floor", () => {
    expect(judgeSettlement({ ...base, rows: [], grossAmount: "9" }).kind).toBe("pending");
  });

  it("reports unresolved past the floor, never failed", () => {
    // A withdrawal has no cancel and no status endpoint, so absence past the
    // floor is grounds for telling the user to check the chain, never to resend.
    const verdict = judgeSettlement({
      ...base,
      rows: [],
      grossAmount: "9",
      now: SIGNED + 1_000_000,
    });

    expect(verdict.kind).toBe("unresolved");
  });

  it("ignores rows that are not withdrawals", () => {
    const send = { ...row({ net: "6.0" }), type: "send" };

    expect(judgeSettlement({ ...base, rows: [send], grossAmount: "7" }).kind).toBe("pending");
  });
});

describe("arrivedAmount", () => {
  it("returns the net as sent, without subtracting the fee again", () => {
    // The fee is already out of `usdc`. Subtracting it a second time reported
    // `0` arrived for the 2 USDC withdrawal that is this project's test case.
    expect(arrivedAmount(row({ net: "1.0" }))).toBe("1");
    expect(arrivedAmount(row({ net: "6.0" }))).toBe("6");
  });

  it("is null when the row carries no usdc at all", () => {
    // A `send` row has no `usdc` key — its value lives in `usdcValue`.
    expect(arrivedAmount({ ...row({ net: "1.0" }), usdc: null })).toBeNull();
  });
});
