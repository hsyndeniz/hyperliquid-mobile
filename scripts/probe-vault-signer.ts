/**
 * Settle the one open question in Phase 9: **may an agent sign a vault action?**
 *
 *   bun run probe:vault-signer                       # dry run, signs nothing
 *   HL_VAULT_PROBE_EXECUTE=1 bun run probe:vault-signer
 *
 * Testnet only, and the script refuses to run anywhere else.
 *
 * Every read-only approach was tried first and none of them settles it. Aiming
 * at a non-vault gives `"Vault not registered: 0x…dead"`, which names the target
 * and not the signer. Aiming at a real vault gives `"Cannot withdraw with zero
 * balance in vault."` and `"Insufficient funds available to deposit."` — refusals
 * that name **no address at all**, identical for the master and the agent,
 * because both accounts hold zero. That is the whole problem: the two are
 * indistinguishable while neither has a position.
 *
 * So the only decisive test is a deposit that **succeeds**, and then reading
 * which address ended up holding it:
 *
 *   agent signs a deposit
 *     -> position lands on the MASTER  => L1 phantom-agent applies; agent-signable
 *     -> position lands on the AGENT   => the agent acted on itself; master-only
 *
 * The stake is the protocol minimum, $5, locked for the measured 24-hour lockup
 * and fully recoverable after it. `createVault` is never called: it costs a
 * 10,000 USDC gas fee.
 */

import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { canonicalAmount, toMicroUsd } from "@/hyperliquid/transfers/amount";
import { MIN_VAULT_DEPOSIT_USDC } from "@/hyperliquid/vaults/transfer";

/** Testnet HLP. A real, live vault with a real lockup. */
const TESTNET_HLP = "0xa15099a30bbf2e68942d6f4c43d70d04faeab0a0";
const EXECUTE = process.env.HL_VAULT_PROBE_EXECUTE === "1";
/** Reused so the probe rotates an agent rather than consuming one of the three slots. */
const AGENT_NAME = "probe";

interface Snapshot {
  perp: string;
  vaults: { vaultAddress: string; equity: string; lockedUntilTimestamp: number }[];
}

async function snapshot(info: InfoClient, user: `0x${string}`): Promise<Snapshot> {
  const ch = (await info.clearinghouseState({ user })) as {
    marginSummary?: { accountValue?: string };
  };
  const vaults = (await info.userVaultEquities({ user })) as Snapshot["vaults"];
  return { perp: ch?.marginSummary?.accountValue ?? "?", vaults: vaults ?? [] };
}

function show(label: string, s: Snapshot): void {
  console.log(
    `  ${label.padEnd(7)} perp=${s.perp.padStart(10)}  vaults=${JSON.stringify(s.vaults)}`
  );
}

async function main(): Promise<void> {
  const key = process.env.HL_TESTNET_SIGNER_KEY;
  if (!key) {
    console.error("HL_TESTNET_SIGNER_KEY is not set.");
    process.exit(1);
  }

  const master = privateKeyToAccount(key as `0x${string}`);
  // Derived from the master address: stable across runs, unique per account, and
  // not a well-known test key. A hardcoded one was refused with "Cannot use
  // existing user address as agent".
  const agent = privateKeyToAccount(
    keccak256(stringToBytes(`hl-vault-probe:${master.address.toLowerCase()}`))
  );

  const transport = new HttpTransport({ isTestnet: true });
  const info = new InfoClient({ transport });
  const masterClient = new ExchangeClient({ transport, wallet: master, isTestnet: true });

  console.log(`master ${master.address}`);
  console.log(`agent  ${agent.address}\n`);

  console.log("BEFORE");
  const beforeMaster = await snapshot(info, master.address);
  const beforeAgent = await snapshot(info, agent.address);
  show("master", beforeMaster);
  show("agent", beforeAgent);

  if (beforeMaster.vaults.length > 0 || beforeAgent.vaults.length > 0) {
    console.error(
      "\nRefusing to run: one of the accounts already holds a vault position, so a new " +
        "one could not be attributed to this deposit."
    );
    process.exit(1);
  }

  const amount = canonicalAmount(MIN_VAULT_DEPOSIT_USDC);
  const usd = toMicroUsd(amount);
  console.log(`\nWould deposit ${amount} USDC into testnet HLP, signed by the AGENT.`);
  console.log(`  wire: { vaultAddress: "${TESTNET_HLP}", isDeposit: true, usd: ${usd} }`);

  if (!EXECUTE) {
    console.log("\nDry run. Set HL_VAULT_PROBE_EXECUTE=1 to sign.");
    return;
  }

  // Approve only when genuinely absent: re-approving the same agent fails with
  // "Extra agent already used."
  const existing = (await info.extraAgents({ user: master.address })) as {
    address: string;
    validUntil: number;
  }[];
  if (
    !existing.some(
      (a) => a.address.toLowerCase() === agent.address.toLowerCase() && a.validUntil > Date.now()
    )
  ) {
    await masterClient.approveAgent({ agentAddress: agent.address, agentName: AGENT_NAME });
    console.log(`\napproved agent as "${AGENT_NAME}"`);
  } else {
    console.log(`\nreusing already-approved agent`);
  }

  const agentClient = new ExchangeClient({ transport, wallet: agent, isTestnet: true });

  console.log("\nsigning with the AGENT key...");
  try {
    const response = await agentClient.vaultTransfer({
      vaultAddress: TESTNET_HLP,
      isDeposit: true,
      usd,
    });
    console.log("  accepted:", JSON.stringify(response));
  } catch (error) {
    console.log("  REFUSED:", (error as Error).message);
    console.log("\nVERDICT: inconclusive — the deposit did not land, so nothing moved.");
    return;
  }

  // The vault credits asynchronously; give it a moment before reading back.
  await new Promise((r) => setTimeout(r, 4_000));

  console.log("\nAFTER");
  const afterMaster = await snapshot(info, master.address);
  const afterAgent = await snapshot(info, agent.address);
  show("master", afterMaster);
  show("agent", afterAgent);

  const landedOnMaster = afterMaster.vaults.length > beforeMaster.vaults.length;
  const landedOnAgent = afterAgent.vaults.length > beforeAgent.vaults.length;

  console.log(`\n${"=".repeat(64)}`);
  if (landedOnMaster && !landedOnAgent) {
    console.log("VERDICT: AGENT-SIGNABLE.");
    console.log("  The agent's signature created a position on the MASTER, so vault");
    console.log("  actions route through the L1 phantom-agent scheme exactly as");
    console.log("  sub-account actions do. `vaults/transfer.ts` can drop");
    console.log("  RequiresMasterWallet and route through the agent client — no wallet");
    console.log("  prompt on deposit or withdrawal.");
  } else if (landedOnAgent && !landedOnMaster) {
    console.log("VERDICT: MASTER-ONLY.");
    console.log("  The agent's signature acted on the AGENT's own address. The current");
    console.log("  RequiresMasterWallet wiring is correct and must stay.");
  } else {
    console.log("VERDICT: inconclusive — no new position appeared on either address.");
  }
  console.log(
    `\nThe deposit is locked for ~24h. Recover it afterwards with a withdrawal from ` +
      `whichever address holds it.`
  );
}

main().catch((error) => {
  console.error("\nprobe crashed:", error);
  process.exit(1);
});
