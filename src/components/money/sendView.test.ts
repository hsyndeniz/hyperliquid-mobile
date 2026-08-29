/**
 * What a spot send offers, and what stops one.
 */

import { planSend, sendableTokens } from "@/components/money/sendView";
import type { SpotBalance } from "@/hyperliquid/types/domain";

const SELF = "0x5bf8287baeda8de01c88b3016d64f3875b0b4347";
const OTHER = "0x1234567890AbcdEF1234567890aBcdef12345678";

function balance(overrides: Partial<SpotBalance>): SpotBalance {
  return {
    coin: "USDC",
    token: 0,
    kind: "token",
    total: "10",
    hold: "0",
    available: "10",
    entryNtl: "0",
    ...overrides,
  } as SpotBalance;
}

function plan(overrides: Partial<Parameters<typeof planSend>[0]> = {}) {
  return planSend({
    token: { name: "USDC", available: "10" },
    amount: "2",
    destinationInput: OTHER,
    selfAddress: SELF,
    subAccount: null,
    ...overrides,
  });
}

describe("sendableTokens", () => {
  it("lists held tokens, largest first", () => {
    const tokens = sendableTokens([
      balance({ coin: "HYPE", available: "1.5" }),
      balance({ coin: "USDC", available: "10" }),
    ]);

    expect(tokens.map((t) => t.name)).toEqual(["USDC", "HYPE"]);
  });

  it("drops zero balances — they cannot fund a send", () => {
    const tokens = sendableTokens([
      balance({ coin: "USDC", available: "10" }),
      balance({ coin: "PURR", available: "0" }),
    ]);

    expect(tokens.map((t) => t.name)).toEqual(["USDC"]);
  });

  it("excludes outcome shares — a position, not a transferable token", () => {
    // `spotSend` has no spelling for a `+N` row; offering one invites a signed
    // message naming a token that does not exist.
    const tokens = sendableTokens([
      balance({ coin: "USDC", available: "10" }),
      balance({ coin: "+102251", kind: "outcome", token: null, available: "20" }),
    ]);

    expect(tokens.map((t) => t.name)).toEqual(["USDC"]);
  });

  it("is empty while balances are unread — null is not []", () => {
    expect(sendableTokens(null)).toEqual([]);
  });
});

describe("planSend", () => {
  it("passes a plain valid send", () => {
    expect(plan().blockers).toEqual([]);
  });

  it("blocks a sub-account context — spotSend debits the MASTER", () => {
    const result = plan({ subAccount: "0x2222222222222222222222222222222222222222" });

    expect(result.blockers.map((b) => b.code)).toContain("sub_account_context");
  });

  it("blocks an overdraw against AVAILABLE, not total", () => {
    // `hold` is money already committed to resting orders; offering `total`
    // produces a server rejection for an amount the screen itself displayed.
    const result = plan({ token: { name: "USDC", available: "1.5" }, amount: "2" });

    expect(result.blockers.map((b) => b.code)).toContain("insufficient_balance");
  });

  it("blocks a half-typed amount rather than signing '2.'", () => {
    expect(plan({ amount: "2." }).blockers.map((b) => b.code)).toContain("amount_incomplete");
  });

  it("blocks a malformed destination", () => {
    expect(plan({ destinationInput: "0xnope" }).blockers.map((b) => b.code)).toContain(
      "destination_invalid"
    );
  });

  it("blocks a blacklisted destination with the reason that matters", () => {
    const result = plan({ destinationInput: "0x0000000000000000000000000000000000000000" });
    const blocker = result.blockers.find((b) => b.code === "destination_invalid");

    expect(blocker?.detail).toMatch(/ever be recovered/i);
  });

  it("blocks a self-send with the server's own reason", () => {
    // Live fact, not caution: the exchange answers "Cannot self-transfer." to a
    // spotSend addressed to the sender. Blocking before the wallet prompt beats
    // signing a message the server will refuse.
    const result = plan({ destinationInput: SELF });
    const blocker = result.blockers.find((b) => b.code === "self_transfer");

    expect(blocker?.detail).toMatch(/your own address/i);
    expect(blocker?.detail).toMatch(/move/i);
    expect(result.isSelf).toBe(true);
  });

  it("exposes the CHECKSUMMED destination for display", () => {
    const result = plan();

    expect(result.destinationDisplay).toBe(OTHER);
    expect(`0x${result.destinationChunks?.join("")}`).toBe(OTHER);
  });
});
