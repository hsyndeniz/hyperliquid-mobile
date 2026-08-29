import * as fs from "node:fs";
import * as path from "node:path";

import { HlError } from "@/hyperliquid/core/errors";
import {
  DEPOSIT_CREDITS,
  DEPOSIT_FEE_USDC,
  MIN_DEPOSIT_USDC,
  USDC_DECIMALS,
  depositNetwork,
  depositsAvailable,
} from "@/hyperliquid/deposits/network";
import {
  buildDepositQuote,
  confirmDeposit,
  isConfirmable,
  toBaseUnits,
  type DepositEcho,
  type DepositQuote,
} from "@/hyperliquid/deposits/preflight";
import { buildDepositCall, sendDeposit, type DepositWallet } from "@/hyperliquid/deposits/send";
import {
  CLOCK_SKEW_MS,
  DEPOSIT_SLOW_AFTER_MS,
  checkArrival,
  matchCredit,
  parseDepositCredits,
} from "@/hyperliquid/deposits/arrival";
import type { WireAmount } from "@/hyperliquid/transfers/types";

const NOW = 1_700_000_000_000;
const now = () => NOW;
const ARBITRUM = 42_161;

function quote(overrides: Partial<Parameters<typeof buildDepositQuote>[0]> = {}): DepositQuote {
  return buildDepositQuote({
    env: "mainnet",
    amount: "100",
    availableUsdc: "500",
    availableGas: "0.01",
    now,
    ...overrides,
  });
}

function echo(q: DepositQuote, overrides: Partial<DepositEcho> = {}): DepositEcho {
  return {
    token: q.token,
    walletChainId: ARBITRUM,
    bridgeDisplayed: q.network!.bridge,
    amountDisplayed: q.amount,
    acknowledged: q.warnings.map((w) => w.code),
    ...overrides,
  };
}

describe("the network, which is the part that cannot be wrong", () => {
  it("names Arbitrum One, verified USDC and the verified bridge", () => {
    const network = depositNetwork("mainnet");
    expect(network).toMatchObject({
      chainId: 42_161,
      chainName: "Arbitrum One",
      usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      bridge: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7",
      usdcDecimals: 6,
    });
  });

  it("names Arbitrum Sepolia, its bridge, and USDC2 for testnet", () => {
    expect(depositsAvailable("testnet")).toBe(true);
    expect(depositNetwork("testnet")).toMatchObject({
      chainId: 421_614,
      chainName: "Arbitrum Sepolia",
      // USDC2 — the token the bridge actually watches.
      usdc: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5",
      bridge: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89",
      usdcDecimals: 6,
    });
  });

  it("never uses Circle's Sepolia USDC, which this bridge silently eats", () => {
    // The mistake this project actually made, and the most expensive line in
    // the module. `0x75faf…` is a real 6-decimal token called "USD Coin" on
    // Arbitrum Sepolia — the obvious candidate, and the wrong one. Two 6-USDC
    // transfers of it confirmed on chain and were never credited; the bridge
    // holds 1,946.10 of it, all from people making this exact substitution.
    //
    // Structural, and over the WHOLE file rather than the config block: the
    // address must not appear at all, so it cannot creep back as a fallback, a
    // second constant, or a copy-pasteable line in a comment. The module refers
    // to it elided (`0x75fa…AA4d`) for exactly this reason.
    const source = fs.readFileSync(path.join(__dirname, "network.ts"), "utf8");
    expect(source).not.toMatch(/0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d/i);
  });

  it("shares NOTHING between the two networks", () => {
    // A mainnet address used on Sepolia, or the reverse, is a transfer to an
    // address nobody is watching. Both chains carry a 6-decimal token whose
    // symbol starts "USDC", so nothing downstream would notice.
    const main = depositNetwork("mainnet");
    const test = depositNetwork("testnet");
    expect(main.bridge).not.toBe(test.bridge);
    expect(main.usdc).not.toBe(test.usdc);
    expect(main.chainId).not.toBe(test.chainId);
  });

  it("refuses an environment it has no addresses for", () => {
    expect(() => depositNetwork("devnet" as never)).toThrow(HlError);
  });

  it("records the measured facts that contradict the withdrawal path", () => {
    // Withdrawals deduct $1 and debit perp. Deposits take no fee and credit perp.
    // Sharing a "fee" concept between the two directions invents one.
    expect(DEPOSIT_FEE_USDC).toBe("0");
    expect(DEPOSIT_CREDITS).toBe("perp");
    expect(MIN_DEPOSIT_USDC).toBe("5");
    expect(USDC_DECIMALS).toBe(6);
  });
});

describe("converting to base units", () => {
  it("scales by the token's own decimals", () => {
    expect(toBaseUnits("100" as WireAmount, 6)).toBe("100000000");
    expect(toBaseUnits("5.5" as WireAmount, 6)).toBe("5500000");
    expect(toBaseUnits("0.000001" as WireAmount, 6)).toBe("1");
  });

  it("REFUSES more precision than USDC can hold, rather than truncating", () => {
    // Truncating signs a different number than the one the user read. `parseUnits`
    // would silently drop the tail; this will not.
    expect(() => toBaseUnits("1.0000001" as WireAmount, 6)).toThrow(HlError);
  });

  it("never goes through a float", () => {
    // The previous value here (123456789.123456) scales to 1.23e14, comfortably
    // inside 2^53 and exactly representable — so a naive float implementation
    // returned the same string and the test could not detect the regression it
    // named. These two can only be produced by exact arithmetic.
    expect(toBaseUnits("9007199254.740993" as WireAmount, 6)).toBe("9007199254740993");
    expect(Number("9007199254.740993") * 1e6).not.toBe(9007199254740993);
    expect(toBaseUnits("123456789012345678901234.123456" as WireAmount, 6)).toBe(
      "123456789012345678901234123456"
    );
  });
});

describe("the quote", () => {
  it("blocks below the measured floor", () => {
    // 1,371 consecutive mainnet deposits contained none below 5, and the twelve
    // smallest were all exactly 5.00. A block, not a warning: nobody has shown a
    // sub-minimum deposit comes back.
    const low = quote({ amount: "4.99" });
    expect(low.blockers.map((b) => b.code)).toContain("below_minimum");
    expect(quote({ amount: "5" }).blockers).toEqual([]);
  });

  it("distinguishes having no USDC from having no gas", () => {
    // Different sentences: one means you cannot afford it, the other means you
    // have the money and still cannot move it.
    expect(quote({ amount: "1000" }).blockers.map((b) => b.code)).toContain("insufficient_usdc");
    expect(quote({ availableGas: "0" }).blockers.map((b) => b.code)).toContain("no_gas");
  });

  it("pins both sides of the full-balance boundary", () => {
    // Without these, flipping the comparison from gt to gte — which would block
    // every deposit of a user's entire balance — left the suite green.
    expect(quote({ amount: "500", availableUsdc: "500" }).blockers).toEqual([]);
    expect(
      quote({ amount: "500.000001", availableUsdc: "500" }).blockers.map((b) => b.code)
    ).toContain("insufficient_usdc");
  });

  it("says when it could not check, rather than passing silently", () => {
    const unchecked = buildDepositQuote({ env: "mainnet", amount: "100", now });
    expect(unchecked.warnings.map((w) => w.code)).toContain("balances_not_checked");
    expect(unchecked.blockers).toEqual([]);
  });

  it("always discloses the perp credit and the irreversibility", () => {
    const codes = quote().warnings.map((w) => w.code);
    expect(codes).toContain("credits_perp_balance");
    expect(codes).toContain("irreversible");
  });

  it("quotes what arrives as equal to what is sent", () => {
    // No deposit fee, measured: 262.001324 sent, "262.001324" credited.
    const q = quote({ amount: "262.001324" });
    expect(q.credited).toBe(q.amount);
    expect(q.baseUnits).toBe("262001324");
  });

  it("chunks the bridge address, because nobody reads 40 hex characters", () => {
    const q = quote();
    expect(q.network!.bridgeChunks.join("")).toBe(q.network!.bridge.slice(2));
  });

  it("quotes a testnet deposit against the Sepolia bridge", () => {
    const q = buildDepositQuote({
      env: "testnet",
      amount: "100",
      availableUsdc: "500",
      availableGas: "0.01",
      now,
    });
    expect(q.blockers).toEqual([]);
    expect(q.network?.bridge).toBe("0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89");
    expect(q.network?.usdc).toBe("0x1baAbB04529D43a73232B713C0FE471f7c7334d5");
    expect(q.network?.chainId).toBe(421_614);
  });

  it("blocks an environment with no configured bridge", () => {
    const q = buildDepositQuote({ env: "devnet" as never, amount: "100", now });
    expect(q.blockers.map((b) => b.code)).toContain("network_unavailable");
    expect(q.network).toBeNull();
  });
});

describe("the ticket", () => {
  it("is issued when the echo matches and every warning was acknowledged", () => {
    const q = quote();
    expect(isConfirmable(q, NOW)).toBe(true);
    expect(confirmDeposit(q, echo(q), "mainnet", NOW).confirmedAt).toBe(NOW);
  });

  it("REFUSES a wallet on the wrong chain", () => {
    // The single most likely way to lose a deposit: the same USDC symbol exists
    // on Ethereum, Base, Polygon. The transfer confirms and nothing on that chain
    // is watching the bridge address.
    const q = quote();
    // 421614 is Arbitrum Sepolia — a REAL deposit chain now, just not this
    // quote's. Sending a mainnet deposit there is still unrecoverable.
    for (const wrongChain of [1, 8453, 137, 421_614]) {
      expect(() =>
        confirmDeposit(q, echo(q, { walletChainId: wrongChain }), "mainnet", NOW)
      ).toThrow(/must be sent on Arbitrum One/);
    }
  });

  it("refuses a displayed address that is not the real bridge", () => {
    const q = quote();
    expect(() =>
      confirmDeposit(
        q,
        echo(q, { bridgeDisplayed: "0x0000000000000000000000000000000000000001" }),
        "mainnet",
        NOW
      )
    ).toThrow(HlError);
  });

  it("refuses a blocked quote before checking anything else", () => {
    const low = quote({ amount: "1" });
    expect(() => confirmDeposit(low, echo(low), "mainnet", NOW)).toThrow(/Deposits start at 5/);
  });

  it("refuses a stale quote and an unacknowledged warning", () => {
    const q = quote();
    expect(() => confirmDeposit(q, echo(q), "mainnet", q.expiresAt + 1)).toThrow(/expired/);
    expect(() => confirmDeposit(q, echo(q, { acknowledged: [] }), "mainnet", NOW)).toThrow(
      /unacknowledged/
    );
  });

  it("changes token when any quoted fact changes", () => {
    const a = quote();
    const b = quote({ amount: "101" });
    expect(a.token).not.toBe(b.token);
    expect(() => confirmDeposit(a, echo(a, { token: b.token }), "mainnet", NOW)).toThrow(HlError);
  });
});

describe("the transaction", () => {
  const ticket = () => confirmDeposit(quote(), echo(quote()), "mainnet", NOW);

  /** A wallet double that is on Arbitrum unless told otherwise. */
  function wallet(
    onWrite: () => Promise<`0x${string}`>,
    chainId: number = ARBITRUM
  ): DepositWallet & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      getChainId: async () => chainId,
      writeContract: async (call) => {
        calls.push(call);
        return onWrite();
      },
    };
  }

  it("calls the USDC contract, with the bridge as an ARGUMENT", () => {
    // It reads backwards and it matters: moving an ERC-20 means calling the
    // token. Sending to the bridge address directly is a different transaction.
    const call = buildDepositCall(ticket());
    expect(call.to).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
    expect(call.args[0]).toBe("0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7");
    expect(call.args[1]).toBe(100_000_000n);
    expect(call.value).toBe(0n);
    expect(call.functionName).toBe("transfer");
  });

  it("re-derives the transferred integer from the amount the user echoed", () => {
    // `confirmDeposit` verifies `amountDisplayed` against `amount`, and never
    // verifies `baseUnits`. So a quote whose two representations disagree would
    // otherwise confirm cleanly and transfer the wrong number.
    const q = quote();
    const tampered = { ...q, baseUnits: "999999999999" };
    const t = confirmDeposit(tampered, echo(tampered), "mainnet", NOW);
    expect(buildDepositCall(t).args[1]).toBe(100_000_000n);
  });

  it("ASKS THE WALLET for its chain, because viem does not enforce the one we pass", () => {
    // Measured in viem 2.55: `sendTransaction` asserts against `client.chain`,
    // and the `chainId` field falls into `...rest` where only the nonce manager
    // reads it. Without this call there is no signing-time chain guard at all.
    const w = wallet(async () => "0xhash", 1);
    return sendDeposit({ wallet: w, ticket: ticket(), now }).then((outcome) => {
      expect(outcome.kind).toBe("rejected");
      // And nothing was sent.
      expect(w.calls).toEqual([]);
      if (outcome.kind === "rejected") {
        expect(outcome.error.message).toMatch(/must be sent on chain 42161/);
      }
    });
  });

  it("sends when the wallet is on the right chain", async () => {
    const w = wallet(async () => "0xhash");
    const outcome = await sendDeposit({ wallet: w, ticket: ticket(), now });
    expect(outcome).toEqual({ kind: "sent", hash: "0xhash", at: NOW });
    expect((w.calls[0] as { chainId: number }).chainId).toBe(ARBITRUM);
  });

  it("refuses rather than guessing when the chain cannot be read", async () => {
    const outcome = await sendDeposit({
      wallet: {
        getChainId: async () => Promise.reject(new Error("provider disconnected")),
        writeContract: async () => "0xhash",
      },
      ticket: ticket(),
      now,
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("treats a declined prompt as correctable — through viem's REAL error shape", async () => {
    // viem wraps everything: ContractFunctionExecutionError -> ... -> the leaf.
    // Only the leaf says whether anything was broadcast.
    const declined = Object.assign(new Error("User rejected the request."), {
      name: "ContractFunctionExecutionError",
      cause: Object.assign(new Error("User rejected"), {
        name: "TransactionExecutionError",
        cause: Object.assign(new Error("User rejected"), {
          name: "UserRejectedRequestError",
        }),
      }),
    });
    const outcome = await sendDeposit({
      wallet: wallet(async () => Promise.reject(declined)),
      ticket: ticket(),
      now,
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("reads a bare EIP-1193 rejection code, for providers that carry no name", async () => {
    const declined = Object.assign(new Error("ContractFunctionExecutionError"), {
      name: "ContractFunctionExecutionError",
      cause: Object.assign(new Error("User denied"), { code: 4001 }),
    });
    const outcome = await sendDeposit({
      wallet: wallet(async () => Promise.reject(declined)),
      ticket: ticket(),
      now,
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("treats a BROADCAST-THEN-TIMEOUT as UNKNOWN, not as 'nothing was sent'", async () => {
    // THE defect this suite exists for. viem's writeContract wraps every failure
    // in ContractFunctionExecutionError, so matching that outer name classified a
    // transaction already in the mempool as "safe to retry" — and a retry is a
    // second irreversible deposit. The old test used `new Error("socket hang up")`,
    // a shape viem never produces, so it passed against the bug.
    const timedOut = Object.assign(new Error("The request took too long to respond."), {
      name: "ContractFunctionExecutionError",
      cause: Object.assign(new Error("timed out"), {
        name: "TransactionExecutionError",
        cause: Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      }),
    });
    const outcome = await sendDeposit({
      wallet: wallet(async () => Promise.reject(timedOut)),
      ticket: ticket(),
      now,
    });
    expect(outcome).toMatchObject({ kind: "unknown", at: NOW });
  });

  it("treats an HTTP failure under the same wrapper as UNKNOWN", async () => {
    const http = Object.assign(new Error("HTTP request failed."), {
      name: "ContractFunctionExecutionError",
      cause: Object.assign(new Error("fetch failed"), { name: "HttpRequestError" }),
    });
    const outcome = await sendDeposit({
      wallet: wallet(async () => Promise.reject(http)),
      ticket: ticket(),
      now,
    });
    expect(outcome.kind).toBe("unknown");
  });

  it("treats anything unrecognised as UNKNOWN", async () => {
    for (const error of [new Error("socket hang up"), "a string", null, { weird: true }]) {
      const outcome = await sendDeposit({
        wallet: wallet(async () => Promise.reject(error)),
        ticket: ticket(),
        now,
      });
      expect(outcome.kind).toBe("unknown");
    }
  });

  it("exposes no retry helper", () => {
    // Re-sending is not a retry, it is a second deposit. There is no idempotency
    // key on an ERC-20 transfer.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require("@/hyperliquid/deposits/send");
    expect(Object.keys(module).filter((name) => /retry|resend/i.test(name))).toEqual([]);
  });
});

describe("arrival", () => {
  const USER = "0x5Bf8287BAeDA8De01C88b3016D64f3875B0B4347" as const;
  const SENT_AT = NOW;

  const ledger = (rows: unknown[]) => ({
    userNonFundingLedgerUpdates: async () => rows,
  });

  it("reads the deposit row and ignores every other ledger type", () => {
    const credits = parseDepositCredits(
      [
        { time: NOW + 6_000, hash: "0xa", delta: { type: "deposit", usdc: "100.0" } },
        { time: NOW + 7_000, hash: "0xb", delta: { type: "withdraw", usdc: "100.0" } },
        { time: NOW + 8_000, hash: "0xc", delta: { type: "accountClassTransfer", usdc: "100.0" } },
        { time: NOW + 9_000, hash: "0xd", delta: { type: "vaultDeposit", usdc: "100.0" } },
      ],
      NOW
    );
    expect(credits).toEqual([{ at: NOW + 6_000, usdc: "100.0", hash: "0xa" }]);
  });

  it("matches numerically, because the wire says 5.0 where the user typed 5", () => {
    const credits = [{ at: NOW + 6_000, usdc: "5.0", hash: null }];
    expect(matchCredit(credits, "5", NOW)).not.toBeNull();
    // String equality would fail here, and the deposit would look lost.
    expect(credits[0].usdc).not.toBe("5");
  });

  it("matches a credit carrying a FLOAT ARTIFACT — 12.2% of real deposit rows do", () => {
    // Measured on live mainnet ledger rows: a user who deposits 1500000.88 is
    // credited "1500000.8799999999". Under exact BigNumber equality that deposit
    // never matched — it sat in `waiting`, aged into `slow`, and the client told
    // someone their money had not arrived when it had. USDC holds 6 decimals, so
    // everything past the sixth is noise the token cannot represent.
    const credits = [{ at: NOW + 6_000, usdc: "1500000.8799999999", hash: "0xa" }];
    expect(matchCredit(credits, "1500000.88", NOW)).not.toBeNull();
  });

  it("still refuses a credit that differs within USDC's own precision", () => {
    // The tolerance is exactly six decimals, not a fudge factor: a cent is a real
    // difference and must not match.
    const credits = [{ at: NOW + 6_000, usdc: "100.010000", hash: "0xa" }];
    expect(matchCredit(credits, "100.00", NOW)).toBeNull();
    expect(matchCredit(credits, "100.01", NOW)).not.toBeNull();
  });

  it("REFUSES a credit that predates the send — an earlier deposit of the same size", () => {
    // The sharpest bug the audit found. A user topping up 100 USDC twice in a
    // minute saw the FIRST credit reported as the second deposit's arrival, and
    // stopped waiting for money still in flight. The query window and the match
    // window are now separate constants.
    const earlier = [{ at: NOW - 30_000, usdc: "100.0", hash: "0xold" }];
    expect(matchCredit(earlier, "100", NOW)).toBeNull();
    // Within clock-skew tolerance, it still matches.
    expect(
      matchCredit([{ at: NOW - 1_000, usdc: "100.0", hash: null }], "100", NOW)
    ).not.toBeNull();
    expect(
      matchCredit([{ at: NOW - CLOCK_SKEW_MS - 1, usdc: "100.0", hash: null }], "100", NOW)
    ).toBeNull();
  });

  it("does not hand the same credit to two deposits", () => {
    // Two identical deposits seconds apart are indistinguishable to both systems,
    // so the caller passes what it has already attributed.
    const credit = { at: NOW + 6_000, usdc: "100.0", hash: "0xa" };
    expect(matchCredit([credit], "100", NOW)).toEqual(credit);
    expect(matchCredit([credit], "100", NOW, [credit])).toBeNull();
  });

  it("does not report an earlier credit through checkArrival either", async () => {
    const state = await checkArrival({
      probe: {
        userNonFundingLedgerUpdates: async () => [
          { time: NOW - 30_000, hash: "0xold", delta: { type: "deposit", usdc: "100.0" } },
        ],
      },
      user: USER,
      amount: "100",
      sentAt: SENT_AT,
      now: () => NOW + 8_000,
    });
    expect(state.kind).toBe("waiting");
  });

  it("reports arrival with how long it took", async () => {
    const state = await checkArrival({
      probe: ledger([
        { time: NOW + 6_311, hash: "0xa", delta: { type: "deposit", usdc: "100.0" } },
      ]),
      user: USER,
      amount: "100",
      sentAt: SENT_AT,
      now: () => NOW + 6_311,
    });
    expect(state).toMatchObject({ kind: "arrived", waitedMs: 6_311 });
  });

  it("says waiting inside the normal window and slow past it", async () => {
    const empty = ledger([]);
    const soon = await checkArrival({
      probe: empty,
      user: USER,
      amount: "100",
      sentAt: SENT_AT,
      now: () => NOW + 8_000,
    });
    expect(soon.kind).toBe("waiting");

    const late = await checkArrival({
      probe: empty,
      user: USER,
      amount: "100",
      sentAt: SENT_AT,
      now: () => NOW + DEPOSIT_SLOW_AFTER_MS + 1,
    });
    expect(late.kind).toBe("slow");
  });

  it("never reports a deposit as LOST", async () => {
    // A quorum that has not been reached is indistinguishable from one that is
    // slow. "Your money is gone" is not a conclusion this can reach.
    const state = await checkArrival({
      probe: ledger([]),
      user: USER,
      amount: "100",
      sentAt: SENT_AT,
      now: () => NOW + 86_400_000,
    });
    expect(["waiting", "slow"]).toContain(state.kind);
  });

  it("degrades to 'not yet' on a malformed ledger, never to a false arrival", async () => {
    for (const junk of [
      null,
      42,
      [null],
      [{ delta: null }],
      [{ time: "x", delta: { type: "deposit", usdc: "100.0" } }],
    ]) {
      const state = await checkArrival({
        probe: { userNonFundingLedgerUpdates: async () => junk },
        user: USER,
        amount: "100",
        sentAt: SENT_AT,
        now: () => NOW + 6_000,
      });
      expect(state.kind).not.toBe("arrived");
    }
  });

  it("tolerates a device clock running ahead of the server's", async () => {
    // The credit is stamped by the server. A phone a few seconds fast would
    // otherwise filter out the very row it is waiting for.
    const state = await checkArrival({
      probe: ledger([
        { time: NOW - 5_000, hash: "0xa", delta: { type: "deposit", usdc: "100.0" } },
      ]),
      user: USER,
      amount: "100",
      sentAt: SENT_AT,
      now: () => NOW + 6_000,
    });
    expect(state.kind).toBe("arrived");
  });
});
