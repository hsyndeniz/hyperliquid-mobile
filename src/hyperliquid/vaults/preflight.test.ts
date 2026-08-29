import {
  buildDepositQuote,
  buildWithdrawQuote,
  confirmVaultTransfer,
  isConfirmable,
  VAULT_QUOTE_TTL_MS,
  type VaultEcho,
  type VaultQuote,
} from "@/hyperliquid/vaults/preflight";
import { parseVaultList } from "@/hyperliquid/vaults/list";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import { HlError } from "@/hyperliquid/core/errors";
import type { VaultAddress } from "@/hyperliquid/vaults/types";

import liveList from "@/hyperliquid/vaults/__fixtures__/vault-list-mainnet.json";

const HLP = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303" as VaultAddress;
const HLP_NAME = "Hyperliquidity Provider (HLP)";
/** Contains hex LETTERS, so EIP-55 checksumming actually changes the string —
 * an all-digit address checksums to itself and would make the echo test vacuous. */
const PLAIN = "0xabcdef0123456789abcdef0123456789abcdef01" as VaultAddress;
const NOW = 1_770_000_000_000;

const known = parseVaultList(liveList);
/** The directory minus the live impersonator, so ordinary cases are not blocked. */
const unambiguous = known.filter((v) => !/Hyperliquidity Provider/i.test(v.name));

/** Sanity: the placeholder name must not exist in the fixture, or every quote blocks. */
if (known.some((v) => v.name.trim().toLowerCase() === "test vault alpha")) {
  throw new Error("fixture now contains the placeholder name; pick another");
}

function depositQuote(overrides: Partial<Parameters<typeof buildDepositQuote>[0]> = {}) {
  return buildDepositQuote({
    vault: { address: PLAIN, name: "Test Vault Alpha", isClosed: false, allowDeposits: true },
    amount: canonicalAmount("100"),
    actingSubAccount: null,
    available: canonicalAmount("1000"),
    known: unambiguous,
    now: () => NOW,
    ...overrides,
  });
}

function withdrawQuote(overrides: Partial<Parameters<typeof buildWithdrawQuote>[0]> = {}) {
  return buildWithdrawQuote({
    vault: { address: PLAIN, name: "Test Vault Alpha", alwaysCloseOnWithdraw: false },
    amount: canonicalAmount("50"),
    actingSubAccount: null,
    position: { equity: "500", lockedUntilMs: NOW - 1 },
    now: () => NOW,
    ...overrides,
  });
}

/** An echo built honestly from a quote — what a correct caller sends back. */
function echoFor(quote: VaultQuote): VaultEcho {
  return {
    token: quote.token,
    vaultAddressDisplayed: quote.vault.display,
    vaultNameDisplayed: quote.vault.name,
    amountDisplayed: quote.amount,
    acknowledged: quote.warnings.map((w) => w.code),
  };
}

describe("the impersonation defence", () => {
  it("warns — and cannot be skipped — when another vault displays the same name", () => {
    // `"Hyperliquidity Provider(HLP)"` sits beside the real
    // `"Hyperliquidity Provider (HLP)"` on mainnet today, one space apart.
    const quote = depositQuote({
      vault: { address: HLP, name: HLP_NAME, isClosed: false, allowDeposits: true },
      known,
    });

    expect(quote.warnings.map((w) => w.code)).toContain("name_shared_with_other_vaults");
    // A warning, not a blocker: 222 of 9,467 mainnet vaults (2.3%) share a name
    // with another and almost all are innocent, so blocking would make every one
    // of them undepositable. The unskippable acknowledgement is the gate.
    expect(isConfirmable(quote, NOW)).toBe(true);
    expect(() => confirmVaultTransfer(quote, { ...echoFor(quote), acknowledged: [] }, NOW)).toThrow(
      HlError
    );
    expect(() => confirmVaultTransfer(quote, echoFor(quote), NOW)).not.toThrow();
  });

  it("warns distinctly when the directory was unavailable", () => {
    // "We could not check" must never render as "checked and clean", and it gets
    // its own code so the UI can say which of the two happened.
    const quote = depositQuote({ known: undefined });
    expect(quote.warnings.map((w) => w.code)).toContain("name_not_checked");
    expect(quote.warnings.map((w) => w.code)).not.toContain("name_shared_with_other_vaults");
    expect(() => confirmVaultTransfer(quote, { ...echoFor(quote), acknowledged: [] }, NOW)).toThrow(
      /unacknowledged/
    );
  });

  it("says nothing about an ordinary, unique name", () => {
    const quote = depositQuote();
    expect(quote.blockers).toEqual([]);
    expect(quote.warnings.map((w) => w.code)).not.toContain("name_shared_with_other_vaults");
    expect(quote.warnings.map((w) => w.code)).not.toContain("name_not_checked");
  });

  it("ignores the vault's own row when looking for clashes", () => {
    // Otherwise every vault collides with itself and no deposit is ever possible.
    const self = known[0];
    const quote = depositQuote({
      vault: { address: self.address, name: self.name, isClosed: false, allowDeposits: true },
      known: [self],
    });
    expect(quote.blockers).toEqual([]);
  });
});

describe("the echo", () => {
  it("requires the CHECKSUMMED address the caller displayed", () => {
    // A caller that showed only the name cannot produce this, and one that
    // lowercased it fails here. That is the whole defence: the human must have
    // been shown the address.
    const quote = depositQuote();
    expect(quote.vault.display).not.toBe(quote.vault.wire);
    expect(quote.vault.display.toLowerCase()).toBe(quote.vault.wire);

    expect(() =>
      confirmVaultTransfer(
        quote,
        { ...echoFor(quote), vaultAddressDisplayed: quote.vault.wire },
        NOW
      )
    ).toThrow(/displayed vault address/);
  });

  it("chunks the address, because nobody compares 40 raw hex characters", () => {
    const quote = depositQuote();
    expect(quote.vault.chunks).toHaveLength(10);
    expect(quote.vault.chunks.join("")).toBe(quote.vault.display.slice(2));
  });

  it("requires the name too, so a swapped row cannot pass", () => {
    const quote = depositQuote();
    expect(() =>
      confirmVaultTransfer(quote, { ...echoFor(quote), vaultNameDisplayed: "Something else" }, NOW)
    ).toThrow(/displayed vault name/);
  });

  it("requires the amount", () => {
    const quote = depositQuote();
    expect(() =>
      confirmVaultTransfer(quote, { ...echoFor(quote), amountDisplayed: "99" }, NOW)
    ).toThrow(/displayed amount/);
  });

  it("rejects a token from a different quote", () => {
    const quote = depositQuote();
    const other = depositQuote({ amount: canonicalAmount("200") });
    expect(() =>
      confirmVaultTransfer(quote, { ...echoFor(quote), token: other.token }, NOW)
    ).toThrow(/does not match the quote/);
  });

  it("rejects an expired quote", () => {
    const quote = depositQuote();
    expect(() => confirmVaultTransfer(quote, echoFor(quote), NOW + VAULT_QUOTE_TTL_MS + 1)).toThrow(
      /expired/
    );
  });

  it("accepts an honest echo", () => {
    const quote = depositQuote();
    const ticket = confirmVaultTransfer(quote, echoFor(quote), NOW);
    expect(ticket.quote).toBe(quote);
    expect(ticket.confirmedAt).toBe(NOW);
  });
});

describe("warnings must be acknowledged", () => {
  it("refuses a confirmation that skips one", () => {
    const quote = depositQuote();
    expect(quote.warnings.length).toBeGreaterThan(0);
    expect(() => confirmVaultTransfer(quote, { ...echoFor(quote), acknowledged: [] }, NOW)).toThrow(
      /unacknowledged warnings/
    );
  });

  it("tolerates a superset", () => {
    const quote = depositQuote();
    expect(() =>
      confirmVaultTransfer(
        quote,
        {
          ...echoFor(quote),
          acknowledged: [...quote.warnings.map((w) => w.code), "net_is_an_estimate"],
        },
        NOW
      )
    ).not.toThrow();
  });
});

describe("the lockup disclosure on deposit", () => {
  it("says the lockup RESTARTS when a position already exists", () => {
    // Topping up $10 on a $10,000 position re-locks all of it. A user told only
    // "funds lock for 24h" reads that as applying to the $10.
    const quote = depositQuote({
      existingPosition: { equity: "10000", lockedUntilMs: NOW + 3_600_000 },
    });
    expect(quote.warnings.map((w) => w.code)).toContain("lockup_restarts_on_whole_balance");
    expect(quote.warnings.map((w) => w.code)).not.toContain("funds_lock_after_deposit");
  });

  it("says funds will lock when this is a first deposit", () => {
    const quote = depositQuote();
    expect(quote.warnings.map((w) => w.code)).toContain("funds_lock_after_deposit");
    // The MAXIMUM (96h), not the typical 24h: which applies is unknowable before
    // the deposit lands, and understating a lock is the harmful direction.
    expect(quote.warnings.find((w) => w.code === "funds_lock_after_deposit")!.detail).toMatch(/96/);
  });

  it("does NOT block a deposit into a currently locked position", () => {
    // Depositing while locked is legitimate; the restart is a disclosure, not a
    // refusal.
    const quote = depositQuote({
      existingPosition: { equity: "10000", lockedUntilMs: NOW + 3_600_000 },
    });
    expect(quote.blockers).toEqual([]);
  });
});

describe("deposit blockers", () => {
  it("blocks a closed vault and a deposits-disabled vault alike", () => {
    // Independent axes: `allowDeposits` stays true on most closed vaults.
    for (const vault of [
      { address: PLAIN, name: "Test Vault Alpha", isClosed: true, allowDeposits: true },
      { address: PLAIN, name: "Test Vault Alpha", isClosed: false, allowDeposits: false },
    ]) {
      expect(depositQuote({ vault }).blockers.map((b) => b.code)).toContain(
        "vault_not_accepting_deposits"
      );
    }
  });

  it("blocks an amount above the available balance, comparing numerically", () => {
    // "9" > "1000" as strings.
    const quote = depositQuote({
      amount: canonicalAmount("1001"),
      actingSubAccount: null,
      available: canonicalAmount("1000"),
    });
    expect(quote.blockers.map((b) => b.code)).toContain("insufficient_balance");
    expect(
      depositQuote({ amount: canonicalAmount("9"), available: canonicalAmount("1000") }).blockers
    ).toEqual([]);
  });

  it("warns rather than blocks below the advisory minimum", () => {
    // $5 is measured, but it stays a warning: it is Hyperliquid's number to
    // change, and a gate set too high blocks a deposit the exchange would take.
    const quote = depositQuote({ amount: canonicalAmount("1"), minimumDeposit: "5" });
    expect(quote.blockers).toEqual([]);
    expect(quote.warnings.map((w) => w.code)).toContain("below_advisory_minimum");
  });
});

describe("withdrawal", () => {
  it("blocks while locked, and names it", () => {
    const quote = withdrawQuote({
      position: { equity: "500", lockedUntilMs: NOW + 3_600_000 },
    });
    expect(quote.blockers.map((b) => b.code)).toContain("vault_locked");
    expect(quote.lockup.kind).toBe("locked");
  });

  it("blocks an UNKNOWN lockup too", () => {
    // A missing timestamp is not permission; blocking makes a wire change an
    // explainable refusal rather than a stream of failed signatures.
    const quote = withdrawQuote({ position: { equity: "500", lockedUntilMs: 0 } });
    expect(quote.blockers.map((b) => b.code)).toContain("vault_locked");
    expect(quote.lockup.kind).toBe("unknown");
  });

  it("blocks more than the position holds", () => {
    const quote = withdrawQuote({ amount: canonicalAmount("501") });
    expect(quote.blockers.map((b) => b.code)).toContain("exceeds_position");
  });

  it("ALWAYS warns that the net is an estimate", () => {
    // A performance fee is charged at withdrawal on the profit portion, and this
    // project has not measured the arithmetic — so no figure is promised.
    expect(withdrawQuote().warnings.map((w) => w.code)).toContain("net_is_an_estimate");
  });

  it("adds the position-closing warning only when the vault sets it", () => {
    expect(withdrawQuote().warnings.map((w) => w.code)).not.toContain(
      "closes_positions_on_withdraw"
    );
    const closes = withdrawQuote({
      vault: { address: PLAIN, name: "Test Vault Alpha", alwaysCloseOnWithdraw: true },
    });
    expect(closes.warnings.map((w) => w.code)).toContain("closes_positions_on_withdraw");
  });

  it("confirms a clean withdrawal", () => {
    const quote = withdrawQuote();
    expect(quote.blockers).toEqual([]);
    expect(() => confirmVaultTransfer(quote, echoFor(quote), NOW)).not.toThrow();
  });
});

describe("the token", () => {
  it("changes when any quoted fact changes", () => {
    // A stale confirmation sheet must not confirm a quote whose amount or vault
    // has since been re-read.
    const base = depositQuote();
    expect(depositQuote({ amount: canonicalAmount("101") }).token).not.toBe(base.token);
    expect(
      depositQuote({
        vault: { address: HLP, name: "Test Vault Alpha", isClosed: false, allowDeposits: true },
      }).token
    ).not.toBe(base.token);
    expect(
      depositQuote({ existingPosition: { equity: "1", lockedUntilMs: NOW + 1 } }).token
    ).not.toBe(base.token);
  });

  it("is stable for identical inputs", () => {
    expect(depositQuote().token).toBe(depositQuote().token);
  });

  it("separates a deposit from a withdrawal of the same size", () => {
    const deposit = depositQuote({ amount: canonicalAmount("50") });
    expect(deposit.token).not.toBe(withdrawQuote().token);
  });
});

describe("the ticket cannot be forged", () => {
  it("is only produced by confirmVaultTransfer", () => {
    const quote = depositQuote();
    // @ts-expect-error the brand is a module-private symbol
    const forged: VaultTicket = { quote, confirmedAt: NOW };
    void forged;
    expect(confirmVaultTransfer(quote, echoFor(quote), NOW).quote).toBe(quote);
  });
});

describe("acting as a sub-account", () => {
  /**
   * `vaultTransfer` carries no `vaultAddress`, so the agent signs for the
   * MASTER — measured, not inferred: a $5 agent-signed deposit moved the
   * master's perp balance 11.0 -> 6.0 and put the position on the master. The
   * screen meanwhile quoted the sub-account's balance and then refreshed the
   * sub-account's equities, where nothing had appeared.
   *
   * Blocked rather than warned, because the quote itself is derived from the
   * wrong balance — confirming a figure computed against the wrong account is
   * worse than being told to switch.
   */
  it("blocks a DEPOSIT while a sub-account is selected", () => {
    const quote = depositQuote({
      actingSubAccount: "0x2222222222222222222222222222222222222222",
    });
    expect(quote.blockers.map((b) => b.code)).toContain("vault_acts_on_master_account");
  });

  it("blocks a WITHDRAWAL the same way", () => {
    const quote = withdrawQuote({
      actingSubAccount: "0x2222222222222222222222222222222222222222",
    });
    expect(quote.blockers.map((b) => b.code)).toContain("vault_acts_on_master_account");
  });

  it("does not block on the main account", () => {
    expect(depositQuote({ actingSubAccount: null }).blockers.map((b) => b.code)).not.toContain(
      "vault_acts_on_master_account"
    );
  });
});
