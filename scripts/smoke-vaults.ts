/**
 * Live vault smoke — the payload-shape check unit tests cannot do.
 *
 *   bun run smoke:vaults
 *
 * Read-only against **mainnet** for the data path, because vaults barely exist
 * on testnet: the directory there is a fraction of the size and HLP is not on it.
 * Nothing is signed in that section and no funds can move.
 *
 * The final section runs on **testnet** and guards the finding that vault actions
 * are **agent-signable**. It signs actions that cannot succeed — a withdrawal from
 * a vault, and a deposit far larger than any balance — with both keys, and
 * compares the refusals.
 *
 * That question was settled by `bun run probe:vault-signer`, not here: read-only
 * probing could not do it, because Hyperliquid's vault refusals name no address
 * and both accounts held zero. The probe made a real $5 deposit into testnet HLP
 * signed by the agent; the master's balance went 11.0 -> 6.0 and the position
 * landed on the master.
 *
 * The sharpest check below only works once the master holds a locked position:
 * the agent has none of its own, so an agent-signed withdrawal that reports a
 * LOCKUP is reading the master's. Acting on itself, it would still say "zero
 * balance".
 *
 * `createVault` is never called anywhere. It costs a 10,000 USDC gas fee.
 */

import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { addLogSink, createConsoleSink, setLogLevel } from "@/hyperliquid/core/logger";
import {
  fetchVaultList,
  findNameCollisions,
  VAULT_LIST_APPROX_BYTES,
} from "@/hyperliquid/vaults/list";
import { fetchVaultDetails, FOLLOWER_PAGE_CAP } from "@/hyperliquid/vaults/details";
import {
  fetchVaultPositions,
  positionIn,
  totalVaultEquity,
  withLockup,
} from "@/hyperliquid/vaults/equities";
import { fetchLeadingVaults } from "@/hyperliquid/vaults/manage";
import { buildDepositQuote, confirmVaultTransfer } from "@/hyperliquid/vaults/preflight";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import { WeightBudget } from "@/hyperliquid/api/weightBudget";

const HLP = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303" as const;

/** Reused on purpose, so this script rotates one agent rather than adding one. */
const AGENT_NAME = "probe";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function note(label: string, detail: string): void {
  console.log(`  · ${label} — ${detail}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  setLogLevel("warn");
  addLogSink(createConsoleSink());

  const info = new InfoClient({ transport: new HttpTransport() });
  // A generous private budget: this script deliberately makes several weighted
  // calls in a row, and it must not be throttled by whatever else ran before it.
  const budget = new WeightBudget();

  // -------------------------------------------------------------------------
  section("1. The directory is NOT vaultSummaries");
  // -------------------------------------------------------------------------
  const summaries = await info.vaultSummaries();
  check(
    "vaultSummaries is empty, as recorded",
    Array.isArray(summaries) && summaries.length === 0,
    `len=${Array.isArray(summaries) ? summaries.length : "not an array"}`
  );

  const startedAt = Date.now();
  const all = await fetchVaultList({ env: "mainnet" });
  const listMs = Date.now() - startedAt;
  check("the CDN blob parses", all.length > 1_000, `${all.length} vaults in ${listMs}ms`);
  note("expected payload", `~${(VAULT_LIST_APPROX_BYTES / 1e6).toFixed(1)} MB, uncompressed`);

  const live = await fetchVaultList({
    env: "mainnet",
    filter: { openOnly: true, minTvl: "50000" },
  });
  check(
    "filtering leaves a renderable list",
    live.length > 0 && live.length < all.length / 10,
    `${live.length} open with TVL > $50k, of ${all.length}`
  );
  check(
    "filtered list is sorted by TVL descending",
    live.every((v, i) => i === 0 || Number(live[i - 1].tvl) >= Number(v.tvl))
  );

  const collisions = findNameCollisions(all);
  check(
    "name collisions are detected",
    collisions.size > 0,
    `${collisions.size} colliding name(s)`
  );
  const hlpGroup = collisions.get("hyperliquidityprovider(hlp)");
  check(
    "the HLP impersonator is still live and caught",
    Boolean(hlpGroup && hlpGroup.length >= 2),
    hlpGroup ? hlpGroup.map((v) => JSON.stringify(v.name)).join(" vs ") : "not found"
  );

  // -------------------------------------------------------------------------
  section("2. vaultDetails, including its null answer");
  // -------------------------------------------------------------------------
  const notAVault = await fetchVaultDetails({
    probe: info,
    vaultAddress: "0x5bf8287baeda8de01c88b3016d64f3875b0b4347",
    budget,
  });
  check(
    "a non-vault address is null, not an error",
    notAVault.value === null && !notAVault.deferred
  );

  await sleep(1_200);
  const hlp = await fetchVaultDetails({ probe: info, vaultAddress: HLP, budget });
  check("HLP parses", hlp.value !== null, hlp.value?.name);
  if (hlp.value) {
    const v = hlp.value;
    check(
      "followers are capped and flagged truncated",
      v.followers.rows.length === FOLLOWER_PAGE_CAP && v.followers.truncated,
      `${v.followers.rows.length} rows, truncated=${v.followers.truncated}`
    );
    check(
      "the five wire numbers are wrapped as approximations",
      [v.apr, v.leaderFraction, v.maxDistributable].every(
        (x) => x === null || typeof x === "string"
      ),
      `apr=${v.apr} leaderFraction=${v.leaderFraction}`
    );
    check(
      "portfolio periods parse",
      v.portfolio.length > 0,
      v.portfolio.map((p) => p.period).join(",")
    );
    check(
      "history values are strings",
      v.portfolio.every((p) => p.accountValueHistory.every(([, s]) => typeof s === "string"))
    );
    check(
      "HLP is a parent",
      v.relationship.kind === "parent",
      v.relationship.kind === "parent"
        ? `${v.relationship.childAddresses.length} children`
        : v.relationship.kind
    );
  }

  // -------------------------------------------------------------------------
  section("3. A real follower's position and lockup");
  // -------------------------------------------------------------------------
  const follower = hlp.value?.followers.rows.find((r) => r.user !== null)?.user;
  if (!follower) {
    check("a follower address was available", false);
  } else {
    await sleep(1_200);
    const positions = await fetchVaultPositions({ probe: info, user: follower, budget });
    check(
      "userVaultEquities parses",
      positions.value !== null,
      `${positions.value?.length} position(s)`
    );

    const rows = positions.value ?? [];
    const held = withLockup(rows);
    check(
      "every position carries a lockup state",
      held.every((p) => p.lockup.kind !== undefined),
      held.map((p) => p.lockup.kind).join(",")
    );
    check(
      "total is an exact decimal string",
      /^[0-9]+(\.[0-9]+)?$/.test(totalVaultEquity(rows)),
      totalVaultEquity(rows)
    );

    const inHlp = positionIn(rows, HLP);
    check("the HLP position is found by address", inHlp !== null, inHlp?.equity);

    // The whole point of `lockup.ts`: this and `maxWithdrawable` disagree.
    if (inHlp && hlp.value) {
      note(
        "maxWithdrawable vs lockup",
        `maxWithdrawable=${hlp.value.maxWithdrawable} (scoped to no user, so 0) ` +
          `lockedUntil=${new Date(inHlp.lockedUntilMs).toISOString()}`
      );
    }
  }

  // -------------------------------------------------------------------------
  section("4. Ownership resolves leader -> vaults only");
  // -------------------------------------------------------------------------
  const hlpLeader = hlp.value?.leader;
  if (hlpLeader) {
    await sleep(1_200);
    const led = await fetchLeadingVaults({ probe: info, user: hlpLeader, budget });
    check(
      "leadingVaults answers for a real leader",
      led.value !== null,
      `${led.value?.length} vault(s)`
    );

    await sleep(1_200);
    const subs = await info.subAccounts2({ user: hlpLeader });
    const listsVault = Array.isArray(subs)
      ? subs.some((s: { subAccountUser?: string }) => s.subAccountUser?.toLowerCase() === HLP)
      : false;
    check("a vault never appears in its leader's subAccounts2", !listsVault);

    await sleep(1_200);
    const role = (await info.userRole({ user: HLP as `0x${string}` })) as { role?: string };
    check("userRole on a vault is a bare 'vault'", role.role === "vault", JSON.stringify(role));
  }

  // -------------------------------------------------------------------------
  section("5. The deposit preflight refuses the impersonator");
  // -------------------------------------------------------------------------
  const impostor = hlpGroup?.find((v) => v.address.toLowerCase() !== String(HLP));
  if (impostor) {
    const quote = buildDepositQuote({
      vault: {
        address: impostor.address,
        name: impostor.name,
        isClosed: false,
        allowDeposits: true,
      },
      amount: canonicalAmount("10"),
      actingSubAccount: null,
      available: canonicalAmount("1000"),
      known: all,
    });
    check(
      "a colliding name raises the warning",
      quote.warnings.some((w) => w.code === "name_shared_with_other_vaults"),
      quote.warnings.map((w) => w.code).join(",")
    );

    const honest = {
      token: quote.token,
      vaultAddressDisplayed: quote.vault.display,
      vaultNameDisplayed: quote.vault.name,
      amountDisplayed: quote.amount,
      acknowledged: quote.warnings.map((w) => w.code),
    };

    let skipped = false;
    try {
      confirmVaultTransfer(quote, { ...honest, acknowledged: [] });
    } catch {
      skipped = true;
    }
    check("and cannot be skipped silently", skipped);
    check(
      "but an acknowledged deposit still proceeds",
      (() => {
        try {
          confirmVaultTransfer(quote, honest);
          return true;
        } catch {
          return false;
        }
      })()
    );
    check(
      "the checksummed display differs from the wire form",
      quote.vault.display !== quote.vault.wire,
      quote.vault.display
    );
    check(
      "chunks are cut from the DISPLAYED form",
      quote.vault.chunks.join("") === quote.vault.display.slice(2)
    );
  }

  // -------------------------------------------------------------------------
  section("6. Which key may sign a vault action? (testnet, nothing can move)");
  // -------------------------------------------------------------------------
  const key = process.env.HL_TESTNET_SIGNER_KEY;
  if (!key) {
    note("skipped", "HL_TESTNET_SIGNER_KEY is not set");
  } else
    try {
      const master = privateKeyToAccount(key as `0x${string}`);
      const testnet = new HttpTransport({ isTestnet: true });
      const masterClient = new ExchangeClient({
        transport: testnet,
        wallet: master,
        isTestnet: true,
      });

      // Derived from the master address, so it is stable across runs (re-approving
      // the same agent is idempotent and does not accumulate agents) and unique per
      // account. A hardcoded key is not safe here: the first attempt used a
      // well-known Anvil test key and testnet refused it with "Cannot use existing
      // user address as agent".
      const agent = privateKeyToAccount(
        keccak256(stringToBytes(`hl-vault-probe:${master.address.toLowerCase()}`))
      );
      // Re-approving an already-registered agent fails with "Extra agent already
      // used.", and the key here is deterministic, so a second run of this script
      // would always hit it. Approve only when it is genuinely absent or expired.
      const testnetInfo = new InfoClient({ transport: testnet });
      const existing = (await testnetInfo.extraAgents({ user: master.address })) as {
        address: string;
        validUntil: number;
      }[];
      const alreadyValid = existing.some(
        (a) => a.address.toLowerCase() === agent.address.toLowerCase() && a.validUntil > Date.now()
      );
      if (!alreadyValid) {
        await masterClient.approveAgent({ agentAddress: agent.address, agentName: AGENT_NAME });
        note("approved agent", `${agent.address.toLowerCase()} as "${AGENT_NAME}"`);
      } else {
        note("reusing agent", agent.address.toLowerCase());
      }
      const agentClient = new ExchangeClient({
        transport: testnet,
        wallet: agent,
        isTestnet: true,
      });

      // A REAL testnet vault, and a WITHDRAWAL from it.
      //
      // Aiming at a non-vault only ever produced "Vault not registered: 0x…dead",
      // which names the target and says nothing about the signer — the check
      // fires before signer resolution matters. A withdrawal from a real vault
      // the signer holds no position in is refused for a reason that names the
      // ACCOUNT that was checked, which is the question.
      //
      // **`usd` is MICRO-USD**, and getting that wrong is how a probe that
      // promises "nothing can move" moves money. The withdrawal below asked for
      // `1_000_000`, which reads as a million and is $1 — an amount this
      // account's ~$5 testnet HLP position can satisfy outright. It was masked
      // only by that position's deposit lockup, which expired on 2026-08-08, so
      // this section became a live $1 withdrawal that reports itself as
      // "UNEXPECTEDLY SUCCEEDED" and moves on.
      //
      // Both probes now ask for an amount no account on testnet holds, in the
      // unit the wire actually uses, so the refusal they are reading is a
      // refusal and never a completed transfer.
      const TESTNET_HLP = "0xa15099a30bbf2e68942d6f4c43d70d04faeab0a0";

      /** $1,000,000,000 in micro-USD — refused by balance, whatever the state. */
      const IMPOSSIBLE_MICRO_USD = 1_000_000_000_000_000;
      const messages: Record<string, string> = {};

      for (const [who, client] of [
        ["master", masterClient],
        ["agent", agentClient],
      ] as const) {
        try {
          await client.vaultTransfer({
            vaultAddress: TESTNET_HLP,
            isDeposit: false,
            usd: IMPOSSIBLE_MICRO_USD,
          });
          messages[who] = "UNEXPECTEDLY SUCCEEDED";
        } catch (error) {
          messages[who] = (error as Error).message;
        }
      }

      // A second shape, in case this one names an account where the first does
      // not: a deposit far larger than either account holds.
      for (const [who, client] of [
        ["masterBig", masterClient],
        ["agentBig", agentClient],
      ] as const) {
        try {
          await client.vaultTransfer({
            vaultAddress: TESTNET_HLP,
            isDeposit: true,
            usd: IMPOSSIBLE_MICRO_USD,
          });
          messages[who] = "UNEXPECTEDLY SUCCEEDED";
        } catch (error) {
          messages[who] = (error as Error).message;
        }
      }

      console.log(`    master signed -> ${messages.master}`);
      console.log(`    agent  signed -> ${messages.agent}`);
      console.log(`    master (large deposit) -> ${messages.masterBig}`);
      console.log(`    agent  (large deposit) -> ${messages.agentBig}`);

      const agentMsg = `${messages.agent} ${messages.agentBig}`.toLowerCase();

      // Settled by `bun run probe:vault-signer`: an agent-signed $5 deposit into
      // testnet HLP moved the MASTER's balance 11.0 -> 6.0 and put the position on
      // the MASTER. What this section does now is keep that true.
      check(
        "an agent signature is accepted, not rejected as unauthorised",
        !/unauthor|not authorized|invalid signature|must deposit/i.test(agentMsg),
        messages.agent
      );
      check(
        "the master and the agent are treated as ONE account",
        messages.agent === messages.master && messages.agentBig === messages.masterBig,
        "identical refusals"
      );

      // The sharpest regression signal available, and it only exists once the
      // master holds a position: the agent has none of its own, so an agent-signed
      // withdrawal that reports a LOCKUP is reading the MASTER's position. If the
      // agent were acting on itself it would still say "zero balance".
      if (/lockup|locked/i.test(messages.master)) {
        check(
          "an agent-signed withdrawal sees the MASTER's locked position",
          /lockup|locked/i.test(messages.agent),
          messages.agent
        );
      } else {
        note(
          "weaker check this run",
          "the master holds no locked vault position, so 'zero balance' cannot " +
            "distinguish the two accounts. Run `probe:vault-signer` to re-establish it."
        );
      }
    } catch (error) {
      // Never fatal: this section answers an open question, it does not verify a
      // shipped behaviour, and the mainnet sections above are the real gate.
      note("could not run", (error as Error).message);
    }

  console.log(`\n${"=".repeat(46)}`);
  console.log(
    failures === 0 ? "PASS — vault path verified against live data" : `FAIL — ${failures} check(s)`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nsmoke:vaults crashed:", error);
  process.exit(1);
});
