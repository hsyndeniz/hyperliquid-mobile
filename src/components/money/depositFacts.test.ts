/**
 * What the deposit screen tells a user to send.
 *
 * Every case here maps to an outcome that **confirms on-chain and is
 * unrecoverable**. There is no revert to learn from and no support channel, so
 * these strings are the only defence.
 */

import { chunkForDisplay, depositFacts } from "@/components/money/depositFacts";
import { depositNetwork } from "@/hyperliquid/deposits/network";

function fact(env: "mainnet" | "testnet", label: string) {
  const found = depositFacts(depositNetwork(env)).find((f) => f.label === label);
  if (!found) throw new Error(`no fact "${label}"`);
  return found;
}

describe("the token instruction", () => {
  it("names the TESTNET token as USDC2, not USDC", () => {
    // The bug this whole field exists for. Circle's Sepolia USDC is a real
    // 6-decimal token on the same chain reporting `name() = "USD Coin"`, and
    // this bridge silently keeps it — 12 USDC of this project's went that way.
    // A screen hardcoding "USDC" instructs a testnet user to send exactly that.
    expect(fact("testnet", "Token").value).toContain("USDC2");
  });

  it("names the MAINNET token as USDC", () => {
    const value = fact("mainnet", "Token").value;

    expect(value).toContain("USDC");
    expect(value).not.toContain("USDC2");
  });

  it("shows the contract address alongside the symbol", () => {
    // A symbol can be spoofed by any contract; the address is what a user
    // pastes into an exchange's withdrawal form.
    expect(fact("testnet", "Token").value).toContain(depositNetwork("testnet").usdc);
  });

  it("never mentions Circle's Sepolia USDC", () => {
    const CIRCLE_SEPOLIA = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
    const all = depositFacts(depositNetwork("testnet"))
      .map((f) => `${f.value} ${f.consequence ?? ""}`)
      .join(" ");

    expect(all.toLowerCase()).not.toContain(CIRCLE_SEPOLIA.toLowerCase());
  });
});

describe("the facts that lose money if ignored", () => {
  it.each([["Network"], ["Token"], ["Minimum"]])("marks %s critical", (label) => {
    expect(fact("mainnet", label).critical).toBe(true);
  });

  it("gives each critical fact the specific outcome it prevents", () => {
    // General caution is ignorable. "It confirms and is not credited" is not.
    for (const label of ["Network", "Token", "Minimum"]) {
      expect(fact("mainnet", label).consequence).toBeTruthy();
    }
  });

  it("puts the two silent-loss facts first", () => {
    // Chain and token are the pair that consume the funds outright.
    expect(
      depositFacts(depositNetwork("mainnet"))
        .slice(0, 2)
        .map((f) => f.label)
    ).toEqual(["Network", "Token"]);
  });
});

describe("the facts that are not warnings", () => {
  it("states the fee as None rather than omitting it", () => {
    // Withdrawals charge 1 USDC, so a user reasonably assumes symmetry.
    // Measured: 262.001324 sent, "262.001324" credited.
    expect(fact("mainnet", "Fee").value).toBe("None");
    expect(fact("mainnet", "Fee").critical).toBe(false);
  });

  it("says deposits credit the PERPS balance", () => {
    // Not spot. `state/spot.ts` used to claim otherwise, and a screen watching
    // the spot balance for a deposit waits forever.
    expect(fact("mainnet", "Credited to").value).toMatch(/perp/i);
  });

  it("does not invent a fee row for deposits", () => {
    const values = depositFacts(depositNetwork("mainnet")).map((f) => f.value);

    expect(values.some((v) => /^\d+(\.\d+)? (USDC|USDC2)$/.test(v) && v.startsWith("1 "))).toBe(
      false
    );
  });
});

describe("chunkForDisplay", () => {
  it("breaks an address into 4-character groups", () => {
    // An unbroken 42-character string cannot be checked by eye, and this is the
    // one address a user must verify themselves.
    expect(chunkForDisplay("0x2Df1c51E")).toEqual(["0x2D", "f1c5", "1E"]);
  });

  it("returns an empty list for an empty string rather than throwing", () => {
    expect(chunkForDisplay("")).toEqual([]);
  });
});

describe("the sending address", () => {
  // The screen's primary flow is to copy the bridge address into an exchange
  // withdrawal form. The exchange broadcasts from its own omnibus wallet, and
  // the validators credit whoever sent — so the funds land in the exchange's
  // Hyperliquid account, and the arrival watcher polls the user's own ledger
  // and shows "watching" forever. Nothing on the screen used to say this.
  const ME = "0x1111111111111111111111111111111111111111";

  it("states who the deposit must come from, and marks it critical", () => {
    const fact = depositFacts(depositNetwork("testnet"), ME)[0];
    expect(fact?.label).toBe("Must be sent from");
    expect(fact?.value).toBe(ME);
    expect(fact?.critical).toBe(true);
  });

  it("names the actual consequence rather than a generic caution", () => {
    const fact = depositFacts(depositNetwork("testnet"), ME)[0];
    expect(fact?.consequence).toMatch(/credits the exchange, not you/i);
  });

  it("comes first — it is the one the primary flow gets wrong", () => {
    expect(depositFacts(depositNetwork("testnet"), ME).map((f) => f.label)[0]).toBe(
      "Must be sent from"
    );
  });

  it("is OMITTED rather than guessed when there is no session", () => {
    // A "Must be sent from" line showing the wrong address would be worse than
    // no line at all.
    const labels = depositFacts(depositNetwork("testnet")).map((f) => f.label);
    expect(labels).not.toContain("Must be sent from");
    expect(labels[0]).toBe("Network");
  });
});
