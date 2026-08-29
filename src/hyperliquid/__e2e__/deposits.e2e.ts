/**
 * Deposits, against live Arbitrum One and Hyperliquid mainnet.
 *
 *   HL_E2E=1 bun run test:e2e --testPathPattern deposits
 *
 * **Why this exists at all.** Every other e2e suite guards behaviour. This one
 * guards two hex strings, because they are the only values in the project where
 * being wrong is unrecoverable rather than merely broken. A deposit is an ERC-20
 * transfer: send it to a wrong-but-valid address and it confirms, succeeds, and
 * is gone. Nothing throws, nothing reverts, and no test of our own logic would
 * notice.
 *
 * So this asserts the constants against the chain itself — the token really is
 * 6-decimal USDC, and the bridge really is a contract holding a bridge-sized
 * balance. If Hyperliquid ever migrates the bridge, this fails loudly instead of
 * a user's money going to a dead contract.
 *
 * **What it costs.** Nothing. Read-only: `balanceOf`, `symbol`, `decimals`,
 * `getBytecode`, and a log query. **Nothing is ever sent** — mainnet costs real
 * money, and on testnet a live rehearsal needs **USDC2** (`0x1baA…34d5`), of
 * which the signer holds 1 against the 5 floor. Not Circle's Sepolia USDC:
 * 12 of that went into the bridge unrefunded proving the distinction. The send
 * path is verified against a test double in `deposits/deposits.test.ts`.
 */

import { createPublicClient, erc20Abi, formatUnits, http, parseAbiItem } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";

import { checkArrival, parseDepositCredits } from "@/hyperliquid/deposits/arrival";
import {
  DEPOSIT_CREDIT_MS,
  MIN_DEPOSIT_USDC,
  depositNetwork,
  depositsAvailable,
} from "@/hyperliquid/deposits/network";
import { buildDepositQuote, confirmDeposit } from "@/hyperliquid/deposits/preflight";
import { buildDepositCall } from "@/hyperliquid/deposits/send";
import { setupHyperliquid } from "@/hyperliquid/setup";
import type { Hex } from "@/hyperliquid/types/domain";

import { withRateLimitRetry } from "@/hyperliquid/__e2e__/support";

const ENABLED = process.env.HL_E2E === "1";
const describeE2E = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.warn("e2e SKIPPED: set HL_E2E=1 to run against live Hyperliquid");
}

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

describeE2E("deposits, live on Arbitrum One", () => {
  const network = depositNetwork("mainnet");
  const client = createPublicClient({ chain: arbitrum, transport: http() });
  const info = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });

  beforeAll(() => setupHyperliquid());

  describe("the two addresses that cannot be wrong", () => {
    it("the USDC constant is 6-decimal USD Coin", async () => {
      const [symbol, decimals, name] = await Promise.all([
        client.readContract({ address: network.usdc, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address: network.usdc, abi: erc20Abi, functionName: "decimals" }),
        client.readContract({ address: network.usdc, abi: erc20Abi, functionName: "name" }),
      ]);
      expect([name, symbol, decimals]).toEqual(["USD Coin", "USDC", 6]);
      expect(decimals).toBe(network.usdcDecimals);
    }, 60_000);

    it("the bridge constant is a contract holding a bridge-sized balance", async () => {
      const [code, held] = await Promise.all([
        client.getBytecode({ address: network.bridge }),
        client.readContract({
          address: network.usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [network.bridge],
        }),
      ]);

      // An EOA would mean the address is somebody's wallet, not the bridge.
      expect(code).toBeDefined();
      expect(code).not.toBe("0x");

      const usdc = Number(formatUnits(held, 6));
      console.log(`e2e: bridge holds ${usdc.toLocaleString()} USDC`);
      // Measured at 426,910,328. A floor two orders of magnitude below that is a
      // sanity check, not a market-cap assertion.
      expect(usdc).toBeGreaterThan(1_000_000);
    }, 60_000);

    it("is on chain 42161", () => {
      expect(network.chainId).toBe(arbitrum.id);
    });

    it("the TESTNET token is USDC2, and NOT Circle's Sepolia USDC", async () => {
      // The most expensive assertion in this file. Circle's Sepolia USDC is a
      // real 6-decimal token named "USD Coin" on the same chain — the obvious
      // candidate, and the one this project actually sent, twice, into the
      // correct bridge. Both confirmed on chain; neither was ever credited.
      //
      // So checking `symbol() === "USDC"` would have PASSED on the wrong token.
      // The name is the discriminator, and it is asserted exactly.
      const testnet = depositNetwork("testnet");
      expect(depositsAvailable("testnet")).toBe(true);
      expect(testnet.chainId).toBe(arbitrumSepolia.id);

      const sepolia = createPublicClient({ chain: arbitrumSepolia, transport: http() });
      const [name, symbol, decimals, held, junk] = await Promise.all([
        sepolia.readContract({ address: testnet.usdc, abi: erc20Abi, functionName: "name" }),
        sepolia.readContract({ address: testnet.usdc, abi: erc20Abi, functionName: "symbol" }),
        sepolia.readContract({ address: testnet.usdc, abi: erc20Abi, functionName: "decimals" }),
        sepolia.readContract({
          address: testnet.usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [testnet.bridge],
        }),
        // The wrong token's balance AT the bridge — money people lost making
        // this exact substitution, 12 USDC of it ours. Asserted non-zero so the
        // trap stays visible rather than becoming folklore.
        sepolia.readContract({
          address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as Hex,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [testnet.bridge],
        }),
      ]);

      expect([name, symbol, decimals]).toEqual(["USDC2", "USDC2", 6]);
      // A bridge-sized balance of the RIGHT token.
      expect(Number(formatUnits(held, 6))).toBeGreaterThan(1_000_000);
      expect(Number(formatUnits(junk, 6))).toBeGreaterThan(0);
      console.log(
        `e2e: testnet bridge holds ${formatUnits(held, 6)} USDC2, ` +
          `and ${formatUnits(junk, 6)} of wrong-token USDC nobody will get back`
      );
    }, 60_000);
  });

  describe("real deposits, as they actually arrive", () => {
    it("is a plain ERC-20 transfer, and the floor holds", async () => {
      const head = await client.getBlockNumber();
      const logs = await client.getLogs({
        address: network.usdc,
        event: TRANSFER,
        args: { to: network.bridge },
        fromBlock: head - 5_000n,
        toBlock: head,
      });

      console.log(`e2e: ${logs.length} deposits in the last ~5000 blocks`);
      if (logs.length === 0) {
        console.warn("e2e: no deposits in window; floor check skipped");
        return;
      }

      const amounts = logs.map((l) => Number(formatUnits(l.args.value ?? 0n, 6)));
      // Every deposit is a bare Transfer — the call our own path builds.
      expect(amounts.every((a) => a > 0)).toBe(true);
      // Measured over 1,371 deposits: none below 5, twelve smallest all exactly
      // 5.00. If this ever fails, the floor moved and `MIN_DEPOSIT_USDC` is stale.
      const below = amounts.filter((a) => a < Number(MIN_DEPOSIT_USDC));
      console.log(`e2e: min=${Math.min(...amounts)} below-floor=${below.length}`);
      expect(below).toEqual([]);
    }, 120_000);

    it("credits the sender, within the measured latency", async () => {
      const head = await client.getBlockNumber();
      const logs = await client.getLogs({
        address: network.usdc,
        event: TRANSFER,
        args: { to: network.bridge },
        fromBlock: head - 5_000n,
        toBlock: head,
      });
      if (logs.length === 0) {
        console.warn("e2e: no deposits in window; latency check skipped");
        return;
      }

      const deposit = logs[0];
      const block = await client.getBlock({ blockNumber: deposit.blockNumber! });
      const sentAt = Number(block.timestamp) * 1000;
      const sender = deposit.args.from as Hex;
      const amount = formatUnits(deposit.args.value ?? 0n, 6);

      const state = await withRateLimitRetry("arrival", () =>
        checkArrival({
          probe: info as never,
          user: sender,
          amount,
          sentAt,
          now: () => Date.now(),
        })
      );

      console.log(`e2e: ${sender.slice(0, 10)}… sent ${amount} -> ${state.kind}`);
      // Confirmed on-chain minutes ago; it has had far longer than the 5.7–10.0 s
      // observed range. Anything but `arrived` means the credit path changed.
      expect(state.kind).toBe("arrived");
      if (state.kind === "arrived") {
        console.log(
          `e2e: credited after ${state.credit.at - sentAt}ms ` +
            `(observed range ${DEPOSIT_CREDIT_MS.observedMin}-${DEPOSIT_CREDIT_MS.observedMax}ms)`
        );
      }

      // The no-fee claim, checked INDEPENDENTLY of `matchCredit`. Asserting it on
      // `state.credit` would only restate the matcher's own selection predicate —
      // it picks the row whose amount equals `amount`, so of course it does.
      // Instead, read every deposit row in the window and find this transaction's
      // by time alone, then compare the amount.
      const rows = await withRateLimitRetry("nofee", () =>
        info.userNonFundingLedgerUpdates({ user: sender, startTime: sentAt - 60_000 })
      );
      const nearby = parseDepositCredits(rows, sentAt - 60_000).filter(
        (c) => c.at >= sentAt && c.at <= sentAt + 120_000
      );
      expect(nearby.length).toBeGreaterThan(0);
      // Selected by TIME; the amount is what is being tested.
      expect(nearby.some((c) => Number(c.usdc) === Number(amount))).toBe(true);
    }, 120_000);

    it("finds deposit rows and nothing else in a real ledger", async () => {
      const head = await client.getBlockNumber();
      const logs = await client.getLogs({
        address: network.usdc,
        event: TRANSFER,
        args: { to: network.bridge },
        fromBlock: head - 5_000n,
        toBlock: head,
      });
      if (logs.length === 0) return;

      const sender = logs[0].args.from as Hex;
      const rows = await withRateLimitRetry("ledger", () =>
        info.userNonFundingLedgerUpdates({ user: sender, startTime: 0 })
      );
      const credits = parseDepositCredits(rows, 0);
      expect(credits.length).toBeGreaterThan(0);
      for (const credit of credits) {
        expect(typeof credit.usdc).toBe("string");
        expect(credit.at).toBeGreaterThan(1_700_000_000_000);
      }
    }, 120_000);
  });

  describe("the transaction this path would send", () => {
    it("targets the live USDC contract with the live bridge as its argument", () => {
      const quote = buildDepositQuote({
        env: "mainnet",
        amount: "5",
        availableUsdc: "100",
        availableGas: "0.01",
      });
      const ticket = confirmDeposit(
        quote,
        {
          token: quote.token,
          walletChainId: arbitrum.id,
          bridgeDisplayed: network.bridge,
          amountDisplayed: quote.amount,
          acknowledged: quote.warnings.map((w) => w.code),
        },
        "mainnet"
      );

      const call = buildDepositCall(ticket);
      expect(call).toMatchObject({
        chainId: arbitrum.id,
        to: network.usdc,
        functionName: "transfer",
        value: 0n,
      });
      expect(call.args[0]).toBe(network.bridge);
      expect(call.args[1]).toBe(5_000_000n);
    });
  });
});
