/**
 * The transfer family, end to end, against live Hyperliquid testnet.
 *
 *   HL_E2E=1 bun run test:e2e --testPathPattern transfers
 *
 * **Why this exists.** `transfers/transfer.ts` had zero production callers and,
 * until recently, zero tests — the least-exercised money path in the module. Its
 * central claim is not about a data shape but about *which key signs what*:
 * `agentSendAsset` is an L1 action the agent may sign, while `usdClassTransfer`,
 * `usdSend`, `spotSend`, `sendAsset` and `withdraw3` are EIP-712 actions that
 * carry **no `user` field**, so the account debited is whoever the signature
 * recovers to. No unit test can check that claim: a mock happily accepts either
 * key and answers `{status:"ok"}` to both.
 *
 * So this drives the real objects in the real order:
 *
 *   vault -> session -> agent client + master client
 *     -> live spotMeta token id -> canonicalAmount
 *     -> moveWithinAccount (agent-signed) -> balances actually move
 *     -> the websocket spot store sees the same number
 *     -> classTransfer (master-signed) -> balances move back
 *     -> the non-funding ledger shows both, in the shapes the code assumes
 *
 * **What it costs.** Four signed in-account moves — 0.5 USDC out and back,
 * 0.25 USDC out and back — all between this account's own spot and perp buckets.
 * Nothing leaves the account, nothing touches the bridge, no order is placed and
 * no fee is charged. Both round trips are symmetric, and `afterAll` repairs the
 * balance if a leg failed halfway.
 *
 * Deliberately NOT exercised on the wire: anything that moves funds off this
 * account. `sendUsdToAccount`, `sendSpotToAccount`, `sendAssetToAccount` and the
 * withdrawal path all take money somewhere it cannot be swept back from, so
 * their guards are tested and their wires are not.
 *
 * Skips itself unless `HL_E2E=1`, so it can never run in the fast suite by
 * accident, and skips loudly if the signing key is absent.
 */

import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { BigNumber } from "bignumber.js";
import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { storeAgentKey } from "@/hyperliquid/auth/keychain";
import { createIdentity } from "@/hyperliquid/core/identity";
import { addLogSink, createConsoleSink, setLogLevel } from "@/hyperliquid/core/logger";
import { HyperliquidSession } from "@/hyperliquid/session";
import { setupHyperliquid } from "@/hyperliquid/setup";
import { amountsEqual, canonicalAmount } from "@/hyperliquid/transfers/amount";
import { requireDestination } from "@/hyperliquid/transfers/destination";
import { arrivedAmount, fetchLedger, type LedgerRow } from "@/hyperliquid/transfers/ledger";
import { loadTokenCatalogue, type TokenCatalogue } from "@/hyperliquid/transfers/tokens";
import {
  assertMasterSigner,
  assertNotSubAccount,
  classTransfer,
  moveWithinAccount,
  type TransferClient,
} from "@/hyperliquid/transfers/transfer";
import type { ValidatedAddress, WireToken } from "@/hyperliquid/transfers/types";
import { importPrivateKey } from "@/hyperliquid/wallet/accounts";
import type { Hex } from "@/hyperliquid/types/domain";
import { withRateLimitRetry } from "@/hyperliquid/__e2e__/support";

const KEY = process.env.HL_TESTNET_SIGNER_KEY;
const ENABLED = process.env.HL_E2E === "1" && Boolean(KEY);

/** The agent-signed leg. Small enough to be irrelevant, large enough to see. */
const MOVE_AMOUNT = "0.5";
/**
 * The master-signed leg. Deliberately a different figure from `MOVE_AMOUNT`, so
 * the two families of ledger row cannot be confused for one another when they
 * are read back.
 */
const CLASS_AMOUNT = "0.25";

/** How long a settled in-account move may take to show up in a balance read. */
const SETTLE_TIMEOUT_MS = 60_000;

/** A real, active testnet account. Used only as a shape-accurate stand-in. */
const OTHER_ACCOUNT = "0xCC8A21B439951529281859f6aD39F279606304A7";

const describeE2E = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  // Loud, and explains which of the two conditions failed — a silently skipped
  // e2e suite reads exactly like a passing one.
  console.warn(
    process.env.HL_E2E === "1"
      ? "e2e SKIPPED: HL_TESTNET_SIGNER_KEY is not set (is .env present?)"
      : "e2e SKIPPED: set HL_E2E=1 to run against live testnet"
  );
}

/**
 * The live testnet USDC token id, as `transfers/tokens.ts` documents it.
 *
 * Written down here — and nowhere in production — precisely so the live
 * catalogue can be checked against it. The mainnet id is a different 32 hex
 * characters and the field is a bare string all the way to the signature.
 */
const TESTNET_USDC = "USDC:0xeb62eee3685fc4c43992febcd9e75443";
/** The id every `spotSend` example in the SDK's doc comments uses. */
const MAINNET_USDC = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";

interface Balances {
  /** Perp `marginSummary.accountValue`. A transfer or a fill moves it. */
  perp: string;
  /** Spot USDC `total`. Only a transfer changes it — perp trading cannot. */
  spot: string;
}

describeE2E("the transfer family against live testnet", () => {
  let session: HyperliquidSession;
  let masterAddress: Hex;
  let agentAddress: Hex;
  /** The owner's own address, past EIP-55 validation — the only producer of one. */
  let owner: ValidatedAddress;
  let usdc: WireToken;
  let catalogue: TokenCatalogue;
  /** Balances as this file found them. Every round trip restores these. */
  let opening: Balances;
  /** Everything this run does to the ledger happens after this instant. */
  const startedAt = Date.now();
  /**
   * The nonces `moveWithinAccount` reported for the two agent-signed legs.
   *
   * Held at suite scope because section 6 reconciles them against the ledger —
   * that reconciliation is the only reason the nonce exists on the outcome.
   */
  let outNonce: number | null = null;
  let backNonce: number | null = null;

  const info = new InfoClient({ transport: new HttpTransport({ isTestnet: true }) });

  async function readBalances(): Promise<Balances> {
    const [perp, spot] = await Promise.all([
      info.clearinghouseState({ user: masterAddress }),
      info.spotClearinghouseState({ user: masterAddress }),
    ]);
    return {
      perp: perp.marginSummary.accountValue,
      spot: spot.balances.find((balance) => balance.coin === "USDC")?.total ?? "0",
    };
  }

  /** Poll until the spot balance is no longer `previousSpot`, then return both. */
  async function waitForSpotToMove(previousSpot: string): Promise<Balances> {
    return waitFor(async () => {
      const now = await readBalances();
      return amountsEqual(now.spot, previousSpot) ? undefined : now;
    }, SETTLE_TIMEOUT_MS);
  }

  beforeAll(async () => {
    setLogLevel("warn");
    addLogSink(createConsoleSink());

    // The module bootstrap, exactly as `src/app/_layout.tsx` calls it: the vault
    // refuses to operate without its AES-GCM backend registered.
    setupHyperliquid();

    // The REAL wallet path: encrypt into the vault, key in the keychain. Only
    // the storage backends are in-memory.
    const derived = await importPrivateKey(KEY as string);
    masterAddress = derived.address;
    owner = requireDestination(masterAddress).wire;

    const agentKey = deriveApprovedAgentKey(masterAddress);
    agentAddress = privateKeyToAccount(agentKey).address as Hex;

    const identity = createIdentity({
      env: "testnet",
      accountId: masterAddress,
      address: masterAddress,
    });
    await storeAgentKey(identity, agentKey);

    session = new HyperliquidSession();
    await withRateLimitRetry("session.start", () => session.start({ env: "testnet" }));

    // The token id is network-specific and sits inside the signed message, so it
    // is resolved from live `spotMeta` rather than written down anywhere.
    const loaded = await loadTokenCatalogue({ probe: info, env: "testnet" });
    if (!loaded.catalogue) throw new Error("spotMeta was deferred by the weight budget");
    catalogue = loaded.catalogue;
    usdc = catalogue.wireToken("USDC");

    opening = await readBalances();

    // Every perp assertion below compares `marginSummary.accountValue` EXACTLY,
    // and that is only legitimate while the account holds no position: with one
    // open, unrealised PnL moves `accountValue` between the before and after
    // reads and an exact delta fails for a reason that has nothing to do with
    // transfers. Asserted rather than assumed, so that failure explains itself
    // instead of looking like a broken transfer. Measured at authoring time:
    // no positions, accountValue "4.0", spot USDC "14.0".
    const positions = await info.clearinghouseState({ user: masterAddress });
    expect(positions.assetPositions).toEqual([]);
  }, 120_000);

  afterAll(async () => {
    // Leave nothing behind. Each round trip restores itself, so this only fires
    // when a leg failed between its two halves — and it is bounded at 1 USDC so
    // a misread can never turn cleanup into a large transfer.
    try {
      if (opening && session?.state()) {
        const now = await readBalances();
        const drift = new BigNumber(now.spot).minus(opening.spot);
        if (!drift.isZero() && drift.abs().isLessThanOrEqualTo(1)) {
          await classTransfer({
            signer: "master",
            client: session.masterClient(),
            amount: canonicalAmount(drift.abs()),
            toPerp: drift.isGreaterThan(0),
          });
          console.warn(`transfers.e2e: repaired a ${drift.toFixed()} USDC spot drift`);
        }
      }
    } catch (error) {
      console.warn("transfers.e2e: balance repair failed", error);
    }
    await session?.stop().catch(() => undefined);
  }, 120_000);

  // -------------------------------------------------------------------------
  describe("1. which key may sign — the guard the whole family rests on", () => {
    it("accepts the master, and the live exchange agrees it is a plain user", async () => {
      // The probe is the real `userRole` endpoint, wrapped so the calls are
      // counted. Counting is not decoration: `assertMasterSigner` resolves to
      // `undefined`, so a body reduced to `return;` would satisfy a bare
      // `resolves.toBeUndefined()` — the guard would be gone and this test would
      // still be green. The count is what says the live role was actually read.
      const asked: string[] = [];
      const counting = {
        userRole: async (params: { user: string }) => {
          asked.push(params.user.toLowerCase());
          return info.userRole({ user: params.user as Hex });
        },
      };

      await expect(
        assertMasterSigner({
          walletAddress: masterAddress,
          expectedOwner: masterAddress,
          probe: counting,
        })
      ).resolves.toBeUndefined();
      expect(asked).toEqual([masterAddress.toLowerCase()]);

      // If the exchange ever started reporting something other than "user" for
      // an ordinary account, every user-signed transfer in the app would be
      // refused outright — so this is what tells us the guard is calibrated
      // against reality rather than against a fixture we wrote ourselves.
      const role = (await info.userRole({ user: masterAddress })) as { role?: string };
      expect(role.role).toBe("user");
    }, 60_000);

    it("refuses the agent key outright, before any probe", async () => {
      // `usdSend`/`spotSend`/`sendAsset`/`withdraw3` carry no `user` field. Signed
      // by the agent they act on the AGENT's address: the user asks to send from
      // an account holding funds and the exchange debits an address they have
      // never seen. Without this guard the symptom is an opaque server error
      // naming a stranger's address, and on a funded agent, a silent drain.
      await expect(
        assertMasterSigner({ walletAddress: agentAddress, expectedOwner: masterAddress })
      ).rejects.toThrow(/account owner/);
    });

    it("the exchange itself confirms the agent is a SEPARATE account with nothing in it", async () => {
      // Not a restatement of the guard — the measured reason for it. `userRole`
      // on the agent answers "agent" and names the master as its principal, which
      // is the exchange saying the two addresses are distinct accounts. And the
      // agent's own balance is empty, which is what a user-signed transfer signed
      // by the agent would actually be drawing on.
      const role = (await info.userRole({ user: agentAddress })) as {
        role?: string;
        data?: { user?: string };
      };
      expect(role.role).toBe("agent");
      expect(role.data?.user?.toLowerCase()).toBe(masterAddress.toLowerCase());

      const agentPerp = await info.clearinghouseState({ user: agentAddress });
      expect(new BigNumber(agentPerp.marginSummary.accountValue).isZero()).toBe(true);

      // And the role guard fires on it: a caller that mistakenly treated the
      // agent as the owner — so the cheap address comparison passes — is still
      // stopped, by the live probe rather than by local reasoning.
      await expect(
        assertMasterSigner({
          walletAddress: agentAddress,
          expectedOwner: agentAddress,
          probe: info,
        })
      ).rejects.toThrow(/role "agent"/);
    }, 60_000);

    it("refuses to send out of the account while a sub-account is selected", async () => {
      // `WithdrawAction3` is `{signatureChainId, hyperliquidChain, destination,
      // amount, time}` with `deny_unknown_fields` — there is no field that could
      // name a sub-account, and a sub-account holds no key. So the master signs
      // and the MASTER's balance is what leaves, while the screen still shows the
      // sub-account's. Nothing downstream can detect that after the fact.
      const asSub = createIdentity({
        env: "testnet",
        accountId: masterAddress,
        address: masterAddress,
        subAccount: OTHER_ACCOUNT,
      });
      expect(() => assertNotSubAccount(asSub)).toThrow(/main account/);
      expect(() => assertNotSubAccount(session.state()!.identity)).not.toThrow();

      // And why it cannot be tested any harder than that here: this account has
      // no sub-accounts. `subAccounts` answers a literal `null` for none — where
      // `userVaultEquities` answers `[]` — and creating one needs $100k of
      // lifetime volume this account has never traded.
      expect(await info.subAccounts({ user: masterAddress })).toBeNull();
      expect(session.state()?.subAccounts).toEqual([]);
    }, 60_000);

    it("and the two session accessors really do hand over two DIFFERENT keys", () => {
      // The load-bearing composition claim of this whole file, and the one every
      // other test here silently assumes. Sections 4 and 5 pass a client to a
      // function marked `signer: "agent"` or `signer: "master"` and then watch
      // money move — but money moves either way. If `exchangeClient()` returned
      // the MASTER-signed client, section 4 would be green from top to bottom
      // while the claim it exists to prove (that the agent key is accepted for
      // `agentSendAsset`, so an in-account move needs no wallet prompt) would be
      // untested. That is the shape of the Phase 8 `vaultAddress` bug exactly:
      // every module correct, the wrong thing wired to the call site.
      //
      // So read the address off the wallet each accessor actually built with.
      expect(signingAddressOf(session.exchangeClient())).toBe(agentAddress.toLowerCase());
      expect(signingAddressOf(session.masterClient())).toBe(masterAddress.toLowerCase());
      // Not the same key — the entire reason there are two accessors.
      expect(agentAddress.toLowerCase()).not.toBe(masterAddress.toLowerCase());
    });
  });

  // -------------------------------------------------------------------------
  describe("2. a same-bucket move is refused locally, without reaching the wire", () => {
    it("rejects spot -> spot and perp -> perp before the client is touched", async () => {
      // The exchange's answer to a same-bucket self-move is not guaranteed to be
      // an error, and burning a signature and an action-budget slot to find that
      // out is the wrong shape. `rejected_locally` is also the only outcome kind
      // carrying a *local* HlError, so a UI can render the reason with no round
      // trip at all.
      for (const bucket of [{ kind: "spot" } as const, { kind: "perp", dex: null } as const]) {
        const wire = tripwire();
        const outcome = await moveWithinAccount({
          signer: "agent",
          client: wire.client,
          owner,
          from: bucket,
          to: bucket,
          token: usdc,
          amount: canonicalAmount(MOVE_AMOUNT),
        });

        expect(outcome.kind).toBe("rejected_locally");
        if (outcome.kind !== "rejected_locally") throw new Error("unreachable");
        expect(outcome.error.code).toBe("validation_error");
        // The whole claim. A single call here means a signature was produced and
        // an action spent for a move that could never have been wanted.
        expect(wire.calls).toEqual([]);
      }
    });

    it("but a move between DIFFERENT buckets does reach the client", async () => {
      // The negative control. Without it the test above passes just as well
      // against a `moveWithinAccount` that refuses everything.
      const wire = tripwire();
      const outcome = await moveWithinAccount({
        signer: "agent",
        client: wire.client,
        owner,
        from: { kind: "spot" },
        to: { kind: "perp", dex: null },
        token: usdc,
        amount: canonicalAmount(MOVE_AMOUNT),
      });

      expect(wire.calls).toEqual(["agentSendAsset"]);
      // A thrown transport error is NOT a server rejection: the action may well
      // have landed. `unknown` is what tells the caller to watch rather than
      // retry — there is no cloid and no `expiresAfter` to make a retry safe.
      expect(outcome.kind).toBe("unknown");
      if (outcome.kind !== "unknown") throw new Error("unreachable");
      // And the watch window is the only actionable thing an `unknown` carries.
      // A zero-width or inverted one means the settlement watcher scans a range
      // no ledger row can fall into, so a transfer that DID land is reported
      // `unresolved` forever and the duplicate guard blocks the next one.
      expect(outcome.window.toMs - outcome.window.fromMs).toBe(900_000);
      expect(outcome.window.fromMs).toBe(outcome.nonce);
    });
  });

  // -------------------------------------------------------------------------
  describe("3. the token id comes from the live network, not from a constant", () => {
    it("resolves USDC to the TESTNET id", () => {
      // The exact id, not just a well-formed one. A regex passes for ANY token
      // in the catalogue, so it would not notice `wireToken` returning the wrong
      // row — and the id sits inside a signed message the SDK types as a bare
      // string, so nothing downstream would catch it either.
      expect(usdc).toBe(TESTNET_USDC);
      // Every `spotSend` example in the SDK's own doc comments uses the MAINNET
      // id, so the most obvious way to write this code is silently wrong on
      // exactly one network.
      expect(usdc).not.toBe(MAINNET_USDC);
      // Measured on live testnet spotMeta at authoring time: 1,644 tokens. The
      // floor is deliberately far below that and far above one — a catalogue
      // that half-parsed the response would fail this, while a fixture-sized
      // handful would sail through `> 1`.
      expect(catalogue.size).toBeGreaterThan(500);
      expect(catalogue.find("USDC")?.tokenId).toBe(TESTNET_USDC.slice("USDC:".length));
      expect(() => catalogue.wireToken("NOTATOKEN")).toThrow(/not on testnet/);
    });
  });

  // -------------------------------------------------------------------------
  describe("4. moveWithinAccount: agent-signed, spot -> perp and back", () => {
    it("moves spot -> perp with the AGENT client, and the money actually arrives", async () => {
      const before = await readBalances();

      const outcome = await moveWithinAccount({
        signer: "agent",
        // The agent-signed accessor. This is the composition claim: the type's
        // `signer: "agent"` marker and `session.exchangeClient()` have to agree,
        // and only a live exchange can say whether the agent key is accepted for
        // this action at all.
        client: session.exchangeClient(),
        owner,
        from: { kind: "spot" },
        to: { kind: "perp", dex: null },
        token: usdc,
        amount: canonicalAmount(MOVE_AMOUNT),
      });

      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") {
        throw new Error(`agentSendAsset did not settle: ${JSON.stringify(outcome)}`);
      }
      outNonce = outcome.nonce;
      // A plausible wall-clock millisecond inside this run. The settlement
      // watcher matches on a window around this figure, so a nonce that is not a
      // real timestamp makes a completed transfer look permanently unresolved.
      expect(outNonce).toBeGreaterThanOrEqual(startedAt);
      expect(outNonce).toBeLessThanOrEqual(Date.now());

      const after = await waitForSpotToMove(before.spot);
      // Exact, in BigNumber. A float comparison here would still pass on a
      // transfer that lost the tail of an 18-significant-digit balance — the
      // class of bug that shows a user money they cannot withdraw.
      //
      // Spot USDC is the load-bearing one: only a transfer can change it. Perp
      // `accountValue` also moves on a fill, so if this pair ever disagrees, the
      // spot line is the transfer and the perp line is something else trading on
      // the same account.
      expectDelta(before.spot, after.spot, `-${MOVE_AMOUNT}`, "spot USDC");
      expectDelta(before.perp, after.perp, MOVE_AMOUNT, "perp account value");
    }, 120_000);

    it("and the websocket spot store sees the same number the HTTP read does", async () => {
      // Crosses the boundary no unit test crosses: the transfer went out over
      // HTTP through the exchange client, and this observes it arriving on an
      // entirely separate subscription. A store that silently kept its first
      // frame would show a balance that stopped updating after login — and a
      // merging store would keep the pre-transfer figure on screen forever.
      const expected = new BigNumber(opening.spot).minus(MOVE_AMOUNT);
      const seen = await waitFor(() => {
        const balance = session.stores.spot.balanceOf("USDC");
        if (!balance) return undefined;
        return new BigNumber(balance.total).isEqualTo(expected) ? balance.total : undefined;
      }, SETTLE_TIMEOUT_MS);

      // A string on the wire, never a parsed double.
      expect(typeof seen).toBe("string");
      expect(seen).toMatch(/^[0-9]+(\.[0-9]+)?$/);
    }, 90_000);

    it("moves it straight back, leaving both buckets exactly where they started", async () => {
      const before = await readBalances();
      const outcome = await moveWithinAccount({
        signer: "agent",
        client: session.exchangeClient(),
        owner,
        from: { kind: "perp", dex: null },
        to: { kind: "spot" },
        token: usdc,
        amount: canonicalAmount(MOVE_AMOUNT),
      });

      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") throw new Error("unreachable");
      backNonce = outcome.nonce;

      const after = await waitForSpotToMove(before.spot);
      expectDelta(before.spot, after.spot, MOVE_AMOUNT, "spot USDC");
      expectDelta(before.perp, after.perp, `-${MOVE_AMOUNT}`, "perp account value");
      // The round trip is a no-op on the account, which is the only reason this
      // suite is safe to run repeatedly against a $20 testnet account.
      expect(amountsEqual(after.spot, opening.spot)).toBe(true);
      expect(amountsEqual(after.perp, opening.perp)).toBe(true);
    }, 120_000);

    it("carries a nonce on both legs, and they are distinct", () => {
      // Two moves of the same size to the same address in the same minute are
      // otherwise indistinguishable in history. The nonce is the only field that
      // separates them.
      expect(typeof outNonce).toBe("number");
      expect(typeof backNonce).toBe("number");
      expect(outNonce).not.toBe(backNonce);
    });

    it("reports an over-balance move as `rejected_by_server`, not as `unknown`", async () => {
      // The last outcome kind, and the one that decides what a caller may do
      // next. A rejection the server articulated is a FACT — nothing moved, and
      // the UI may safely offer a retry. `unknown` is the opposite: the action
      // may well have landed, there is no cloid and no `expiresAfter`, so the
      // only safe response is to watch. Collapsing the two either strands the
      // user on a transfer that plainly failed, or invites a double-send.
      //
      // Safe on the wire: the exchange refuses it outright, so nothing moves and
      // no ledger row appears. It costs one action.
      const before = await readBalances();
      const outcome = await moveWithinAccount({
        signer: "agent",
        client: session.exchangeClient(),
        owner,
        from: { kind: "spot" },
        to: { kind: "perp", dex: null },
        token: usdc,
        amount: canonicalAmount("999999"),
      });

      expect(outcome.kind).toBe("rejected_by_server");
      if (outcome.kind !== "rejected_by_server") {
        throw new Error(`expected a server rejection, got ${JSON.stringify(outcome)}`);
      }
      // The server's own words, surfaced verbatim. Pinned to what testnet
      // actually SAYS rather than to "some non-empty string": `reason` is the
      // only field this outcome carries, so it is the failure message on screen,
      // and `"Error"`, `"[object Object]"` or an HTTP status line would all
      // satisfy a length check while telling the user nothing.
      //
      // Measured live, exactly: "Insufficient balance for token transfer".
      // Matched on the substantive words rather than the whole sentence, so a
      // reworded server message reads as a message change and not as a broken
      // transfer path — but "Error" still fails, which is the point.
      expect(outcome.reason).toMatch(/insufficient balance/i);

      const after = await readBalances();
      expect(amountsEqual(after.spot, before.spot)).toBe(true);
      expect(amountsEqual(after.perp, before.perp)).toBe(true);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  describe("5. classTransfer: the master-signed fallback", () => {
    it("moves spot -> perp with the MASTER client", async () => {
      const before = await readBalances();
      const outcome = await classTransfer({
        signer: "master",
        // The master-signed accessor. `usdClassTransfer` is EIP-712 with no
        // `user` field, so handing it `session.exchangeClient()` would try to
        // move the agent's own (empty) balance instead. Two accessors exist to
        // make that choice visible at the call site rather than buried in a flag.
        client: session.masterClient(),
        amount: canonicalAmount(CLASS_AMOUNT),
        // A real boolean: the schema rejects "true" and 1.
        toPerp: true,
      });

      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") {
        throw new Error(`usdClassTransfer did not settle: ${JSON.stringify(outcome)}`);
      }

      const after = await waitForSpotToMove(before.spot);
      expectDelta(before.spot, after.spot, `-${CLASS_AMOUNT}`, "spot USDC");
      expectDelta(before.perp, after.perp, CLASS_AMOUNT, "perp account value");
    }, 120_000);

    it("moves it back, restoring the opening balances exactly", async () => {
      const before = await readBalances();
      const outcome = await classTransfer({
        signer: "master",
        client: session.masterClient(),
        amount: canonicalAmount(CLASS_AMOUNT),
        toPerp: false,
      });
      expect(outcome.kind).toBe("settled");

      const after = await waitForSpotToMove(before.spot);
      expectDelta(before.spot, after.spot, CLASS_AMOUNT, "spot USDC");
      expect(amountsEqual(after.spot, opening.spot)).toBe(true);
      expect(amountsEqual(after.perp, opening.perp)).toBe(true);
    }, 120_000);
  });

  // -------------------------------------------------------------------------
  describe("6. the ledger records what we just did, in the shape the code assumes", () => {
    let rows: LedgerRow[];

    beforeAll(async () => {
      // The ledger lags the balance by a few seconds, so this polls for the full
      // set rather than sampling once and asserting on whatever happened to have
      // landed by then.
      rows = await waitFor(async () => {
        const fetched = await fetchLedger({
          probe: info,
          user: masterAddress,
          startTime: startedAt,
        });
        if (fetched.deferred) return undefined;
        const sends = fetched.rows.filter((row) => row.type === "send");
        const classes = fetched.rows.filter((row) => row.type === "accountClassTransfer");
        return sends.length >= 2 && classes.length >= 2 ? fetched.rows : undefined;
      }, 120_000);
    }, 150_000);

    it("files the agent-signed moves as `send` rows naming our own address on both ends", () => {
      const sends = rows.filter((row) => row.type === "send");
      expect(sends).toHaveLength(2);

      for (const row of sends) {
        // Self-only: `moveWithinAccount` forces the destination to the owner, and
        // this is the exchange confirming it recorded exactly that. A row
        // pointing anywhere else would mean an "internal" move had in fact left
        // the account — the failure `moveWithinAccount`'s destination rule exists
        // to prevent, and one no local test can observe.
        expect(row.destination?.toLowerCase()).toBe(masterAddress.toLowerCase());
        expect((row.raw.user as string).toLowerCase()).toBe(masterAddress.toLowerCase());
        expect(row.time).toBeGreaterThanOrEqual(startedAt);
        // Strings on the wire, in the canonical decimal form `canonicalAmount`
        // produces. A ledger read that parsed these as doubles would round-trip
        // an 18-significant-digit balance into a figure that cannot be paid out.
        expect(row.raw.amount).toBe(MOVE_AMOUNT);
        expect(row.raw.usdcValue).toBe(MOVE_AMOUNT);
        expect(row.raw.token).toBe("USDC");
        // Free. `agentSendAsset` between one's own buckets costs nothing, which
        // is why the two round trips leave the account exactly as they found it.
        expect(row.raw.fee).toBe("0.0");
      }

      // The buckets round-trip through `dexBucketWire` and come back unchanged:
      // `{kind:"spot"}` -> "spot" and `{kind:"perp",dex:null}` -> "". Getting
      // that mapping wrong sends the funds to a HIP-3 dex named "" or "spot"
      // rather than to the bucket the user picked, and the call still succeeds.
      const outbound = sends.find((row) => row.raw.sourceDex === "spot");
      const inbound = sends.find((row) => row.raw.sourceDex === "");
      expect(outbound?.raw.destinationDex).toBe("");
      expect(inbound?.raw.destinationDex).toBe("spot");

      // The reason `moveWithinAccount` is preferred over `classTransfer`: each
      // row can be tied back to one signature. The row's nonce is the SDK's,
      // sampled when it signed — NOT the `nonce` the outcome reports, which this
      // module samples just before the call. So a reconciler must match on a
      // WINDOW; matching on strict equality would report every completed
      // transfer as unresolved forever, and the duplicate guard would then block
      // the next one for the full settlement floor.
      //
      // The DIRECTION is not a guess. The SDK's nonce manager is
      // `now > last ? now : last + 1`, monotonic per (wallet × network), so the
      // nonce it signs is always at or after the millisecond this module
      // sampled. A ledger nonce BEFORE ours would mean we matched a row from
      // some earlier action — which is the mis-attribution the window is
      // supposed to prevent. Measured gap on a live run: 668 ms and 716 ms.
      for (const [row, ours] of [
        [outbound, outNonce],
        [inbound, backNonce],
      ] as const) {
        expect(typeof row?.nonce).toBe("number");
        expect(typeof ours).toBe("number");
        const rowNonce = row!.nonce as number;
        expect(rowNonce).toBeGreaterThanOrEqual(ours as number);
        expect(rowNonce - (ours as number)).toBeLessThan(30_000);
        // A real wall-clock millisecond, not a counter: the row's own `time` is
        // stamped by the exchange after it settled, so the nonce must precede it.
        expect(rowNonce).toBeLessThanOrEqual(row!.time);
      }

      // The two legs are separable, which is the whole practical value of the
      // nonce: without it, a spot->perp and a perp->spot of the same size in the
      // same minute are one indistinguishable pair of rows.
      expect(sends[0].nonce).not.toBe(sends[1].nonce);
      expect(new Set(sends.map((row) => row.hash)).size).toBe(2);
    });

    it("but `LedgerRow` reads no amount at all off a `send` — the field is not called `usdc`", () => {
      // A LIVE-MEASURED GAP, asserted as it actually behaves rather than as the
      // code hopes. A `send` delta carries `amount`/`usdcValue`/`token`; it has
      // no `usdc` key, so `parseLedger` maps `usdc: null` and `arrivedAmount`
      // returns null with it.
      //
      // The user-visible symptom: `send` is the most common non-funding row
      // there is — `transfers/transfer.ts` records 590 of 1,938 sampled rows as
      // exactly this self spot<->perp move — and every one of them renders in a
      // transaction history with a blank amount. It is not a money-safety bug
      // (nothing signs off this field) but it makes the whole family invisible
      // in history, which is the one place a user goes to confirm a transfer
      // happened.
      for (const row of rows.filter((row) => row.type === "send")) {
        expect(row.usdc).toBeNull();
        // Sharper than it looks: the row's FEE parses fine, because that field
        // really is spelled `fee`. So `arrivedAmount` holds a fee and no gross,
        // and answers null — "gross minus fee" with nothing to subtract from.
        expect(row.fee).toBe("0.0");
        expect(arrivedAmount(row)).toBeNull();
        // The figure is right there on the raw delta, which is the only reason
        // this is recoverable at all.
        expect(new BigNumber(row.raw.amount as string).isEqualTo(MOVE_AMOUNT)).toBe(true);
      }
    });

    it("files the master-signed moves as `accountClassTransfer`, with NO nonce and NO destination", () => {
      const classes = rows.filter((row) => row.type === "accountClassTransfer");
      expect(classes).toHaveLength(2);

      for (const row of classes) {
        expect(typeof row.usdc).toBe("string");
        expect(amountsEqual(row.usdc as string, CLASS_AMOUNT)).toBe(true);
        // Documenting the measured gap rather than an aspiration: this row
        // carries neither a nonce nor a destination, so two `classTransfer`s of
        // the same size in the same second are literally indistinguishable
        // afterwards. That is why `moveWithinAccount` is the default and this is
        // the fallback — a settlement watcher built on this row alone would
        // mis-attribute a retry to the original.
        expect(row.nonce).toBeNull();
        expect(row.destination).toBeNull();
        // The direction survives only on the raw delta, which is why `raw` is
        // kept verbatim instead of being narrowed to the named fields.
        expect(typeof row.raw.toPerp).toBe("boolean");
        expect(row.time).toBeGreaterThanOrEqual(startedAt);
      }

      // One in each direction — the round trip, as the exchange recorded it.
      expect(classes.map((row) => row.raw.toPerp).sort()).toEqual([false, true]);
    });

    it("returns rows only from the window asked for", async () => {
      // `fetchLedger` passes `startTime` straight through. Were it dropped, a
      // history screen would render every transfer the account ever made, and a
      // settlement watcher would match an ancient row as today's.
      expect(rows.length).toBeGreaterThanOrEqual(4);
      for (const row of rows) {
        expect(row.time).toBeGreaterThanOrEqual(startedAt);
        expect(row.hash).toMatch(/^0x[0-9a-f]{64}$/);
      }

      // The above alone proves nothing: it holds trivially for an account with
      // no history, and would hold for a `fetchLedger` that ignored `startTime`
      // entirely. The discriminator is the SAME call from the beginning of time
      // — it must return strictly more, and the windowed set must be a subset of
      // it. This account has been used by earlier runs, so there IS older
      // history for the parameter to exclude.
      const everything = await fetchLedger({ probe: info, user: masterAddress, startTime: 0 });
      expect(everything.deferred).toBe(false);
      expect(everything.rows.length).toBeGreaterThan(rows.length);
      expect(everything.rows.some((row) => row.time < startedAt)).toBe(true);

      const wideHashes = new Set(everything.rows.map((row) => row.hash));
      for (const row of rows) expect(wideHashes.has(row.hash)).toBe(true);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe("7. the account is exactly where this file found it", () => {
    it("left nothing behind: both buckets back at their opening figures", async () => {
      // The suite's safety claim, checked rather than asserted in prose. Every
      // round trip restores itself, the over-balance move was refused and the
      // tripwire never reached the wire — so if this fails, a leg landed without
      // its partner and the account is genuinely drifting run over run. On a
      // ~$18 testnet account that is the difference between a suite that can be
      // run all day and one that empties the wallet it tests with.
      const now = await readBalances();
      expect(`spot ${new BigNumber(now.spot).toFixed()}`).toBe(
        `spot ${new BigNumber(opening.spot).toFixed()}`
      );
      expect(`perp ${new BigNumber(now.perp).toFixed()}`).toBe(
        `perp ${new BigNumber(opening.perp).toFixed()}`
      );
    }, 60_000);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * A `TransferClient` whose every method records the call and then throws.
 *
 * The recording is the point: "refused locally" only means something if nothing
 * was sent, and a client that merely answered `{status:"ok"}` could not tell a
 * refusal apart from a completed transfer.
 */
function tripwire(): { client: TransferClient; calls: string[] } {
  const calls: string[] = [];
  const trip = (method: string) => async (): Promise<never> => {
    calls.push(method);
    throw new Error(`${method} reached the wire`);
  };
  return {
    calls,
    client: {
      usdSend: trip("usdSend"),
      spotSend: trip("spotSend"),
      sendAsset: trip("sendAsset"),
      agentSendAsset: trip("agentSendAsset"),
      usdClassTransfer: trip("usdClassTransfer"),
    },
  };
}

/**
 * The address of the key an `ExchangeClient` will actually sign with.
 *
 * `config_` is the SDK's own record of how the client was built, so this is the
 * signer itself rather than our belief about it. Lowercased because one side is
 * EIP-55 checksummed and the other is whatever the wallet returned.
 */
function signingAddressOf(client: { config_: unknown }): string {
  const config = client.config_ as { wallet?: { address?: string } };
  const address = config.wallet?.address;
  if (typeof address !== "string") {
    throw new Error("exchange client was not built with a single address-bearing wallet");
  }
  return address.toLowerCase();
}

/**
 * Assert a balance moved by exactly `delta`, in BigNumber.
 *
 * `Number()`/`parseFloat` are banned in money paths for a measured reason: live
 * balances carry 18 to 20 significant digits, and a double drops the tail while
 * still rendering as a number. Comparing the plain-decimal strings makes a
 * failure say what the two figures actually were.
 */
function expectDelta(before: string, after: string, delta: string, label: string): void {
  const expected = new BigNumber(before).plus(delta).toFixed();
  expect(`${label}: ${new BigNumber(after).toFixed()}`).toBe(`${label}: ${expected}`);
}

/**
 * Poll until `read` returns something truthy, or fail with a useful message.
 *
 * Live state arrives on the exchange's schedule — the account channels are a
 * ~5 s heartbeat, and a transfer takes a block to land — so every assertion
 * about arriving state has to wait rather than sample once.
 */
async function waitFor<T>(
  read: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for live state`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * The agent key `probe-vault-signer.ts` derives — already approved on testnet
 * under the name "probe".
 *
 * Seeded into the (mocked, in-memory) keychain before the session starts, so the
 * agent gate finds a valid key and reuses it. Without this, every run would
 * approve a **new** agent, and the allowance is three per master until volume is
 * traded — all three are already spoken for.
 */
function deriveApprovedAgentKey(master: Hex): Hex {
  return keccak256(stringToBytes(`hl-vault-probe:${master.toLowerCase()}`)) as Hex;
}
