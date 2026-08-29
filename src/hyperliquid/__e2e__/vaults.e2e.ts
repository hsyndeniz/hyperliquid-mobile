/**
 * The vault path, end to end, against live data.
 *
 *   HL_E2E=1 bun run test:e2e --testPathPattern vaults
 *
 * **Why this exists, given `scripts/smoke-vaults.ts` already runs.** That script
 * checks the *data* path: that the CDN blob parses, that `vaultDetails` answers
 * `null` for a non-vault, that a follower's rows carry a lockup. It never builds
 * a session, and it never drives the ticket machinery past "a warning fired".
 *
 * What is unverified anywhere else is the **composition**:
 *
 *   session.start -> ledVaults read from `leadingVaults` on the WALLET address
 *   live directory -> vaultDetails -> deposit quote -> echo -> ticket
 *   the account's REAL locked position -> withdraw quote -> local refusal
 *   webData3 over the production channel wiring -> the pushed aggregate
 *
 * Every module in that chain has unit tests against fixtures. Fixtures cannot
 * tell you that two vaults called "Hyperliquidity Provider (HLP)" are *still*
 * live one space apart, that `maxWithdrawable` *still* reports the position's
 * full equity on funds that cannot be touched until 2026-08-08, or that
 * `webData3` *still* carries the aggregate as a string.
 *
 * **What it costs: nothing.** Not one byte is signed. The mainnet half is a CDN
 * read plus two `vaultDetails` calls; the testnet half reads state and calls
 * `withdrawFromVault` against a client that throws if the wire is ever reached.
 * No deposit, no `createVault`, no agent approval, no resting order — so there is
 * also no state to clean up.
 *
 * Skips itself unless `HL_E2E=1`, exactly like `session.e2e.ts`.
 */

import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { BigNumber } from "bignumber.js";
import { getAddress } from "viem";

import { WeightBudget } from "@/hyperliquid/api/weightBudget";
import { getSubscriptionClient } from "@/hyperliquid/api/clients";
import { storeAgentKey } from "@/hyperliquid/auth/keychain";
import { createIdentity, effectiveAddress } from "@/hyperliquid/core/identity";
import { addLogSink, createConsoleSink, setLogLevel } from "@/hyperliquid/core/logger";
import { HyperliquidSession } from "@/hyperliquid/session";
import { setupHyperliquid } from "@/hyperliquid/setup";
import { createSubscribeFn, type SubscriptionApi } from "@/hyperliquid/state/channels";
import type { SubscriptionHandle } from "@/hyperliquid/state/registry";
import { canonicalAmount, toMicroUsd } from "@/hyperliquid/transfers/amount";
import { sameAddress } from "@/hyperliquid/transfers/destination";
import type { Hex, Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";
import { importPrivateKey } from "@/hyperliquid/wallet/accounts";
import { fetchVaultDetails, FOLLOWER_PAGE_CAP } from "@/hyperliquid/vaults/details";
import {
  fetchVaultPositions,
  positionIn,
  readPushedVaultEquity,
  totalVaultEquity,
  withLockup,
} from "@/hyperliquid/vaults/equities";
import { fetchVaultList, findNameCollisions, normaliseVaultName } from "@/hyperliquid/vaults/list";
import { lockupState, VAULT_LOCKUP_MS } from "@/hyperliquid/vaults/lockup";
import { fetchLeadingVaults } from "@/hyperliquid/vaults/manage";
import {
  buildDepositQuote,
  buildWithdrawQuote,
  confirmVaultTransfer,
  isConfirmable,
  VAULT_QUOTE_TTL_MS,
  type VaultEcho,
  type VaultQuote,
} from "@/hyperliquid/vaults/preflight";
import {
  MIN_VAULT_DEPOSIT_USDC,
  withdrawFromVault,
  type VaultTransferClient,
} from "@/hyperliquid/vaults/transfer";
import type { VaultDetail, VaultPosition, VaultSummary } from "@/hyperliquid/vaults/types";
import { withRateLimitRetry } from "@/hyperliquid/__e2e__/support";

const KEY = process.env.HL_TESTNET_SIGNER_KEY;
const ENABLED = process.env.HL_E2E === "1" && Boolean(KEY);

/** The real HLP, mainnet. The vault the impersonator is dressed as. */
const MAINNET_HLP = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
/** HLP on testnet — where this account's $5 is locked. */
const TESTNET_HLP = "0xa15099a30bbf2e68942d6f4c43d70d04faeab0a0";

/** The key the collision group is filed under once whitespace and case are gone. */
const HLP_COLLISION_KEY = "hyperliquidityprovider(hlp)";

/**
 * The balance the deposit quote is built against.
 *
 * **Hypothetical, and it has to be.** The quote below targets a *mainnet* vault
 * so that the live impersonator is in scope, and this wallet has never touched
 * mainnet — its real balance there is zero, which would bury the echo gates
 * under an `insufficient_balance` blocker and prove nothing. Nothing in this file
 * is ever signed, and no mainnet signer is constructed anywhere in it, so the
 * number is display material and cannot become a transfer.
 */
const HYPOTHETICAL_AVAILABLE = "1000";

/**
 * A floor for "this is an epoch-millisecond timestamp the server computed",
 * not a date anyone cares about.
 *
 * Catches the shapes that would make a lockup assertion vacuous — `0`, a
 * seconds-denominated value, an epoch default — without asserting anything
 * about WHEN, which is what made three tests here expire.
 */
const YEAR_2020_MS = 1_577_836_800_000;

const describeE2E = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  console.warn(
    process.env.HL_E2E === "1"
      ? "e2e SKIPPED: HL_TESTNET_SIGNER_KEY is not set (is .env present?)"
      : "e2e SKIPPED: set HL_E2E=1 to run against live testnet"
  );
}

describeE2E("vaults through the real session and real live data", () => {
  let session: HyperliquidSession;
  let masterAddress: Hex;

  /** Read-only, and the ONLY mainnet client in this file. No wallet is attached. */
  const mainnet = new InfoClient({ transport: new HttpTransport() });
  const testnet = new InfoClient({ transport: new HttpTransport({ isTestnet: true }) });

  /**
   * A private weight budget.
   *
   * Other agents run against this same account concurrently, and the module-level
   * budget is shared process-wide with the session's own reads. A private one
   * keeps a throttle in one suite from surfacing here as a `deferred: true` that
   * looks like a parse failure.
   */
  const budget = new WeightBudget();

  beforeAll(async () => {
    setLogLevel("warn");
    addLogSink(createConsoleSink());

    // The module bootstrap. Without it the vault refuses to operate: its AES-GCM
    // backend is registered here and nowhere else, so `importPrivateKey` below
    // fails rather than returning a key.
    setupHyperliquid();

    const derived = await importPrivateKey(KEY as string);
    masterAddress = derived.address;

    // The SAME already-approved agent `session.e2e.ts` seeds. The testnet master
    // is capped at three API wallets and all three exist, so this suite must
    // never call `approveAgent` — it derives the known key and seeds it.
    const identity = createIdentity({
      env: "testnet",
      accountId: masterAddress,
      address: masterAddress,
    });
    await storeAgentKey(identity, deriveApprovedAgentKey(masterAddress));

    session = new HyperliquidSession();
    await withRateLimitRetry("session.start", () => session.start({ env: "testnet" }));
  }, 120_000);

  afterAll(async () => {
    // Nothing was placed and nothing was signed, so teardown is only the socket.
    await session?.stop().catch(() => undefined);
  }, 60_000);

  // -------------------------------------------------------------------------
  describe("1. session.state().ledVaults, and the two 'none' conventions", () => {
    it("reads led vaults as [] — a value distinct from null", () => {
      const state = session.state();
      expect(state).not.toBeNull();

      // `[]` means "asked, leads none". `null` means "the read failed". A leader
      // screen that cannot tell them apart shows a confident "you lead no vaults"
      // to a user whose vault list merely failed to load.
      expect(state!.ledVaults).not.toBeNull();
      expect(state!.ledVaults).toEqual([]);
    });

    it("keys the read on the WALLET address, which is what the wire answers for", async () => {
      const identity = session.state()!.identity;

      // No sub-account is selected, so these coincide — asserted so the next
      // assertion is known to be about `identity.address` and not accidentally
      // about a sub-account that happens to be absent.
      expect(effectiveAddress(identity)).toBe(identity.address);
      expect(identity.address.toLowerCase()).toBe(masterAddress.toLowerCase());

      const direct = await fetchLeadingVaults({
        probe: testnet as unknown as Parameters<typeof fetchLeadingVaults>[0]["probe"],
        user: identity.address,
        budget,
      });
      // What the session holds is what the wire says for this address, right now.
      expect(direct.deferred).toBe(false);
      expect(direct.value).toEqual(session.state()!.ledVaults);

      // And `leadingVaults` genuinely answers *per address* rather than returning
      // a constant `[]` that would make the check above vacuous: the live mainnet
      // HLP leader owns exactly the vault it leads. Without this control, a
      // production `fetchLeadingVaults` stubbed to `return []` passes everything
      // above — this account leads nothing, so `[]` is also the correct answer.
      const hlpLeader = "0x677d831aef5328190852e24f13c46cac05f984e7";
      const led = await fetchLeadingVaults({
        probe: mainnet as unknown as Parameters<typeof fetchLeadingVaults>[0]["probe"],
        user: hlpLeader,
        budget,
      });
      expect(led.deferred).toBe(false);
      expect(led.value!.length).toBeGreaterThan(0);
      expect(led.value!.map((v) => v.address)).toContain(MAINNET_HLP);
      // And the rows carry parsed CONTENT, not just the right count: a name that
      // survived verbatim, and an address normalised to lowercase the way
      // `positionIn` and `isLedVault` both assume. A parser that dropped `name`
      // renders a leader screen full of blank rows.
      const hlpRow = led.value!.find((v) => sameAddress(v.address, MAINNET_HLP))!;
      expect(hlpRow.address).toBe(hlpRow.address.toLowerCase());
      expect(hlpRow.name.length).toBeGreaterThan(0);

      // Which is the whole point of passing the wallet: a sub-account is a
      // DIFFERENT address, and asking about it returns a different answer. The
      // session's own comment says "the wallet, not effectiveAddress" — this is
      // the arithmetic behind it.
      const withSub = createIdentity({
        env: "testnet",
        accountId: masterAddress,
        address: masterAddress,
        subAccount: "0x0000000000000000000000000000000000000001",
      });
      expect(effectiveAddress(withSub)).not.toBe(withSub.address);
    }, 60_000);

    it("normalises two OPPOSITE wire conventions for 'none' onto the same []", async () => {
      // Read raw, deliberately bypassing our parsers, because the point is what
      // the exchange actually sends for the same account in the same second.
      const rawLed = await testnet.leadingVaults({ user: masterAddress });
      const rawSubs = await testnet.subAccounts2({ user: masterAddress });

      // `leadingVaults` says "none" with an empty array...
      expect(Array.isArray(rawLed)).toBe(true);
      expect(rawLed).toHaveLength(0);
      // ...and `subAccounts2`, one phase away, says "none" with a literal null.
      expect(rawSubs).toBeNull();

      // Both surface as `[]`. A parser that assumed either convention would
      // either crash on `null.map` at first launch, or render an unreadable list
      // as "you have none".
      const state = session.state()!;
      expect(state.ledVaults).toEqual([]);
      expect(state.subAccounts).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe("2. the deposit preflight against the LIVE mainnet directory", () => {
    let directory: VaultSummary[];
    let collisionGroup: VaultSummary[];
    let real: VaultDetail;
    let impostor: VaultDetail;

    beforeAll(async () => {
      // The 14.2 MB CDN blob. `vaultSummaries` is not the directory — it answers
      // `[]` — so this is the only list a deposit can be checked against.
      directory = await fetchVaultList({ env: "mainnet" });

      const group = findNameCollisions(directory).get(HLP_COLLISION_KEY);
      if (!group) throw new Error("the HLP collision group is no longer in the directory");
      collisionGroup = group;

      const realSummary = group.find((v) => sameAddress(v.address, MAINNET_HLP));
      const impostorSummary = group.find((v) => !sameAddress(v.address, MAINNET_HLP));
      if (!realSummary || !impostorSummary) throw new Error("expected two HLP-named vaults");

      const [a, b] = await Promise.all([
        fetchVaultDetails({ probe: mainnet, vaultAddress: realSummary.address, budget }),
        fetchVaultDetails({ probe: mainnet, vaultAddress: impostorSummary.address, budget }),
      ]);
      if (!a.value || !b.value) throw new Error("vaultDetails did not resolve both HLP vaults");
      real = a.value;
      impostor = b.value;
    }, 180_000);

    it("still finds TWO live vaults a user cannot tell apart by name", () => {
      // The premise of the entire preflight. If this ever stops being true the
      // echo is defending against nothing and someone should say so out loud.
      expect(collisionGroup).toHaveLength(2);
      expect(real.name).toBe("Hyperliquidity Provider (HLP)");
      expect(impostor.name).toBe("Hyperliquidity Provider(HLP)");

      // Byte-different names, identical once whitespace is dropped, and two
      // different addresses. One space is the only thing a human sees.
      expect(impostor.name).not.toBe(real.name);
      expect(normaliseVaultName(impostor.name)).toBe(normaliseVaultName(real.name));
      expect(impostor.address).not.toBe(real.address);

      // The real one is the one holding nine figures — so the name a user
      // recognises is attached to the money, and the impersonator is the cheap
      // side of the trade. Matched case-insensitively: the CDN blob and
      // `vaultDetails` are two different producers and neither promises casing.
      const realTvl = directory.find((v) => sameAddress(v.address, real.address))!.tvl;
      expect(new BigNumber(realTvl).isGreaterThan("1000000")).toBe(true);
    });

    it("raises the collision warning on a quote for the real, open HLP", () => {
      const quote = quoteFor(real);

      // Nothing is wrong with this vault — it is the genuine one, open, taking
      // deposits — and the warning still fires. That is deliberate: 222 of 9,467
      // mainnet vaults share a name and blocking them all would be a regression,
      // so the collision is a thing the user must LOOK at, not a refusal.
      expect(quote.blockers).toEqual([]);
      expect(quote.warnings.map((w) => w.code).sort()).toEqual([
        "funds_lock_after_deposit",
        "name_shared_with_other_vaults",
      ]);
      // The disclosure quotes the LONGER window. HLP locks for 96 h, measured;
      // promising 24 h tells a user they can have their money back three days
      // before they can. Both halves matter: a `toContain("96")` alone passes on
      // a detail reading "24 to 96 hours", which is still a sentence a user reads
      // as "probably tomorrow".
      const maxHours = VAULT_LOCKUP_MS.maximum / 3_600_000;
      const typicalHours = VAULT_LOCKUP_MS.typical / 3_600_000;
      const lock = quote.warnings.find((w) => w.code === "funds_lock_after_deposit")!;
      expect(lock.detail).toContain(`${maxHours} hours`);
      expect(lock.detail).not.toContain(`${typicalHours} hours`);
    });

    it("refuses to let the collision be acknowledged away silently", () => {
      const quote = quoteFor(real);
      const honest = echoFor(quote);

      // Nothing acknowledged: refused, and refused FOR THAT REASON. A bare
      // `/Refused/` here would be satisfied by any refusal at all — including one
      // caused by a bug that rejects every honest confirmation — so it would pass
      // just as happily against a `confirmVaultTransfer` that always throws.
      expect(() => confirmVaultTransfer(quote, { ...honest, acknowledged: [] })).toThrow(
        /unacknowledged warnings: .*name_shared_with_other_vaults/
      );

      // The interesting one: everything acknowledged EXCEPT the collision. A UI
      // that renders warnings as a list and forgets one row lands here, and the
      // refusal has to name the missing code rather than passing on a majority.
      expect(() =>
        confirmVaultTransfer(quote, {
          ...honest,
          acknowledged: ["funds_lock_after_deposit"],
        })
      ).toThrow(/name_shared_with_other_vaults/);
    });

    it("gates on the CHECKSUMMED address, so the impersonator cannot be echoed through", () => {
      const quote = quoteFor(real);

      // THE attack, with today's live addresses: the user was quoted the real
      // HLP and shown the impostor's address (or vice versa — a swapped row in a
      // list, a stale render). Deposits are irreversible and locked for 96 h.
      expect(() =>
        confirmVaultTransfer(quote, {
          ...echoFor(quote),
          vaultAddressDisplayed: getAddress(impostor.address),
        })
      ).toThrow(/displayed vault address does not match/);

      // A caller that showed the lowercase wire form fails too. That is not
      // pedantry: EIP-55 casing is what makes two addresses that differ in one
      // nibble visibly different, and a caller that lowercased it never showed
      // the user the checksummed string the quote is built around.
      expect(quote.vault.display).not.toBe(quote.vault.wire);
      expect(quote.vault.display).toBe(getAddress(real.address));
      expect(() =>
        confirmVaultTransfer(quote, {
          ...echoFor(quote),
          vaultAddressDisplayed: quote.vault.wire,
        })
      ).toThrow(/displayed vault address does not match/);
      // The positive control for both refusals above lives in the next test: it
      // takes THIS quote and an honest echo and gets a ticket out. Without it, a
      // `confirmVaultTransfer` that refused every echo — the regression that
      // silently disables deposits for everyone — would pass this test.

      // And the four-character groups a human actually compares are cut from the
      // DISPLAYED form. Chunks whose casing differs from the address printed
      // beside them defeat the comparison they exist to enable.
      expect(quote.vault.chunks.join("")).toBe(quote.vault.display.slice(2));
    });

    it("issues a ticket for an honest echo, bound to that one quote", () => {
      const quote = quoteFor(real);
      expect(isConfirmable(quote)).toBe(true);

      const ticket = confirmVaultTransfer(quote, echoFor(quote));
      // The ticket carries the quote itself, so whatever signs later signs the
      // amount and address that were displayed rather than re-reading state that
      // may have moved.
      expect(ticket.quote).toBe(quote);
      expect(ticket.quote.amount).toBe(MIN_VAULT_DEPOSIT_USDC);
      expect(ticket.confirmedAt).toBeGreaterThan(1_700_000_000_000);

      // A token from a DIFFERENT quote does not transfer. Without this, a screen
      // holding two quotes could confirm the one the user did not look at.
      const other = quoteFor(impostor);
      expect(other.token).not.toBe(quote.token);
      expect(() => confirmVaultTransfer(quote, { ...echoFor(quote), token: other.token })).toThrow(
        /does not match the quote it was built from/
      );

      // An expired quote is refused even when every echoed field is right: the
      // vault's open/closed state and the user's balance were read a minute ago.
      expect(() =>
        confirmVaultTransfer(quote, echoFor(quote), quote.issuedAt + VAULT_QUOTE_TTL_MS + 1)
      ).toThrow(/expired/);
    });

    it("blocks the impersonator outright today, because it is closed", () => {
      const quote = quoteFor(impostor);

      // Today's live state, and it IS a snapshot: the impostor is closed right
      // now. Asserted deliberately rather than derived, so that if it reopens
      // this test goes red and a human decides — a reopened impersonator sharing
      // the real HLP's name is a fact worth someone's attention, and by then the
      // collision warning above is all that stands between a user and their money.
      expect(impostor.isClosed).toBe(true);
      expect(quote.blockers.map((b) => b.code)).toContain("vault_not_accepting_deposits");
      // The collision is still a WARNING here, not a second blocker — the two
      // channels stay independent, so unblocking a vault never quietly drops the
      // impersonation notice with it.
      expect(quote.warnings.map((w) => w.code)).toContain("name_shared_with_other_vaults");
      // Blockers are checked before anything else, so even a perfectly honest
      // echo cannot produce a ticket — and it fails on the CLOSURE, not on some
      // incidental echo mismatch that would make this test green for the wrong
      // reason.
      expect(isConfirmable(quote)).toBe(false);
      expect(() => confirmVaultTransfer(quote, echoFor(quote))).toThrow(/This vault is closed/);
    });

    /** A deposit quote for a real, live vault, checked against the real directory. */
    function quoteFor(vault: VaultDetail): VaultQuote {
      return buildDepositQuote({
        vault: {
          address: vault.address,
          name: vault.name,
          isClosed: vault.isClosed,
          allowDeposits: vault.allowDeposits,
        },
        amount: canonicalAmount(MIN_VAULT_DEPOSIT_USDC),
        actingSubAccount: null,
        available: canonicalAmount(HYPOTHETICAL_AVAILABLE),
        known: directory,
        minimumDeposit: MIN_VAULT_DEPOSIT_USDC,
      });
    }
  });

  // -------------------------------------------------------------------------
  describe("3. the withdrawal preflight against the account's REAL locked position", () => {
    let positions: VaultPosition[];
    let position: VaultPosition;
    let details: VaultDetail;

    beforeAll(async () => {
      const read = await fetchVaultPositions({
        probe: testnet as unknown as Parameters<typeof fetchVaultPositions>[0]["probe"],
        user: masterAddress,
        budget,
      });
      // `[]` is this endpoint's "none" — never `null`, which only the budget
      // produces. Conflating them shows an empty vault screen on a throttle.
      if (read.deferred || !read.value) {
        throw new Error("userVaultEquities was deferred by the weight budget");
      }
      positions = read.value;

      const held = positionIn(positions, TESTNET_HLP);
      if (!held) throw new Error("the $5 testnet HLP position is gone");
      position = held;

      const fetched = await fetchVaultDetails({
        probe: testnet,
        vaultAddress: TESTNET_HLP,
        // WITH the user, or `maxWithdrawable` comes back `0` and the whole
        // disagreement below is invisible.
        user: masterAddress,
        budget,
      });
      if (!fetched.value) throw new Error("testnet HLP did not resolve");
      details = fetched.value;
    }, 90_000);

    it("reads the real $5 position with a future unlock timestamp", () => {
      // One position, and it is the one this account really holds. A zero-length
      // read here would make every assertion below vacuously true, which is the
      // failure mode this whole suite exists to eliminate.
      expect(positions).toHaveLength(1);

      const row = positions[0];
      expect(row.vault).toBe(TESTNET_HLP);
      // A STRING, and an exact decimal one. Equities run to twelve significant
      // digits on real accounts; a double drops the tail with no error, and the
      // structural test bans `Number()` in money paths for exactly this.
      expect(typeof row.equity).toBe("string");
      expect(row.equity).toMatch(/^[0-9]+(\.[0-9]+)?$/);
      // ~$5.000041 when measured. A window, not an equality: it marks to market.
      // Bounds are strings, like every other money value in this codebase.
      expect(new BigNumber(row.equity).isGreaterThan("4.9")).toBe(true);
      expect(new BigNumber(row.equity).isLessThan("6")).toBe(true);
      // Sums as an exact decimal string — nothing in the chain reaches for a
      // float. Compared numerically, not byte-wise: the wire sent `"5.0"` on this
      // run and BigNumber's plain form is `"5"`, which is the same money. A
      // byte-wise assertion here would fail on a trailing zero and teach nothing.
      const total = totalVaultEquity(positions);
      expect(total).toMatch(/^[0-9]+(\.[0-9]+)?$/);
      expect(new BigNumber(total).isEqualTo(row.equity)).toBe(true);

      // A REAL server-computed timestamp, asserted without depending on the
      // wall clock. This used to require `lockedUntilMs > Date.now()`, which
      // was true when written and became permanently false on 2026-08-08 when
      // the position's lockup expired — three tests went red for a reason that
      // had nothing to do with the code, and stayed red.
      //
      // What is actually claimed about the live wire is that the field is a
      // plausible epoch-millisecond deposit lockup: not zero, not seconds, and
      // no further past its own deposit than the measured HLP window.
      expect(Number.isFinite(row.lockedUntilMs)).toBe(true);
      expect(row.lockedUntilMs).toBeGreaterThan(YEAR_2020_MS);

      // The lockup RULE is then exercised deterministically, from an instant
      // chosen relative to the timestamp itself rather than from "now". This is
      // the half that has to keep working whatever the calendar says.
      const whileLocked = row.lockedUntilMs - 1_000;
      expect(row.lockedUntilMs - whileLocked).toBeLessThan(VAULT_LOCKUP_MS.maximum);

      const [held] = withLockup(positions, whileLocked);
      expect(held.lockup.kind).toBe("locked");

      // And it releases on the far side, so "locked" is not simply what this
      // function always answers.
      const [freed] = withLockup(positions, row.lockedUntilMs + 1_000);
      expect(freed.lockup.kind).not.toBe("locked");
    });

    it("BLOCKS the quote on the lockup, while maxWithdrawable says the money is there", () => {
      // An instant INSIDE the position's own lockup, not `Date.now()`. The
      // disagreement under test — the server reporting the full equity as
      // withdrawable on a position that cannot be touched — is a property of
      // the two numbers, and pinning it to the wall clock made the test expire
      // along with the lockup rather than keep checking the rule.
      const now = position.lockedUntilMs - 1_000;
      const quote = buildWithdrawQuote({
        vault: {
          address: details.address,
          name: details.name,
          alwaysCloseOnWithdraw: details.alwaysCloseOnWithdraw,
        },
        // A dollar out of five: comfortably inside the position, so the ONLY
        // reason this can be refused is the lockup.
        amount: canonicalAmount("1"),
        actingSubAccount: null,
        position,
        now: () => now,
      });

      expect(quote.blockers.map((b) => b.code)).toEqual(["vault_locked"]);
      expect(isConfirmable(quote, now)).toBe(false);
      expect(() =>
        confirmVaultTransfer(
          quote,
          {
            token: quote.token,
            vaultAddressDisplayed: quote.vault.display,
            vaultNameDisplayed: quote.vault.name,
            amountDisplayed: quote.amount,
            acknowledged: quote.warnings.map((w) => w.code),
          },
          now
        )
      ).toThrow(/still locked/);

      // The reason `lockup.ts` exists. Every other signal says go: the server
      // reports the follower's FULL equity as withdrawable — measured $5.000006
      // against an equity of $5.000006, agreeing to the last digit it sends — on
      // a position that cannot be touched for days. A UI deriving "available"
      // from this enables a button the exchange will refuse, and tells the user
      // they have money they do not have.
      //
      // The bound is a thousandth rather than a cent on purpose: "reports the
      // full equity" is the claim, and a cent of slack on a $5 position would
      // also be satisfied by a `maxWithdrawable` that had started subtracting
      // something. The two figures come from reads seconds apart and HLP marks to
      // market continuously, so it cannot be an equality.
      expect(details.maxWithdrawable).not.toBeNull();
      const claimed = new BigNumber(details.maxWithdrawable!);
      expect(claimed.isGreaterThan(0)).toBe(true);
      expect(claimed.minus(position.equity).abs().isLessThan("0.001")).toBe(true);
      expect(lockupState(position.lockedUntilMs, now).kind).toBe("locked");
    });

    it("cross-checks the lockup against the OTHER endpoint that carries it", () => {
      // `userVaultEquities[].lockedUntilTimestamp` and
      // `vaultDetails.followerState.lockupUntil` are independent reads of the same
      // fact. If they ever diverge, one of the two gates in this codebase is
      // reading a stale or differently-scoped number and the disagreement should
      // surface here rather than as an unexplained rejected withdrawal.
      //
      // Read from `followerState` — the row the server scopes to the `user` we
      // asked with — and NOT by searching `followers.rows`. That page is capped
      // and sorted ascending by address, and testnet HLP is at the cap today
      // (101 rows, `truncated` set), so whether this account appears in it is
      // decided by where its address sorts among every follower on the exchange.
      // A test that searched the page would go red the day a lower-addressed
      // follower joins, and the failure would read as a lockup bug.
      //
      // Asserted as the parser's own rule against live data rather than as
      // "truncated is true": the follower count is Hyperliquid's to change, but
      // the flag must always follow the cap. A `truncated` stuck at false is what
      // lets a caller sum `rows[].vaultEquity` and render it as the vault's TVL —
      // measured $138.1m of an actual $177.5m on mainnet HLP.
      expect(details.followers.truncated).toBe(details.followers.rows.length >= FOLLOWER_PAGE_CAP);

      const mine = details.followerState;
      expect(mine).not.toBeNull();
      expect(mine!.user).not.toBeNull();
      expect(sameAddress(mine!.user!, masterAddress)).toBe(true);
      expect(mine!.lockupUntilMs).toBe(position.lockedUntilMs);

      // The two endpoints agree on the money to the cent but NOT byte for byte:
      // `userVaultEquities` truncates to six decimals ("5.000006") while
      // `followerState` sends ten ("5.0000069579"). Measured, both today. An
      // equality assertion between them would encode a coincidence, and code that
      // assumes one is a substring of the other silently rounds a real position.
      expect(mine!.vaultEquity).toMatch(/^[0-9]+(\.[0-9]+)?$/);
      expect(
        new BigNumber(mine!.vaultEquity).minus(position.equity).abs().isLessThan("0.001")
      ).toBe(true);
    });

    it("refuses the withdrawal LOCALLY, without a byte reaching the wire", async () => {
      let wireCalls = 0;
      const neverReached: VaultTransferClient = {
        vaultTransfer: async () => {
          wireCalls += 1;
          throw new Error("the wire must not be reached while the position is locked");
        },
      };

      // The maximum the server itself claims is withdrawable — the most
      // optimistic number available anywhere — and it is still refused.
      const claimed = new BigNumber(details.maxWithdrawable!)
        .decimalPlaces(6, BigNumber.ROUND_DOWN)
        .toFixed();

      const outcome = await withdrawFromVault({
        signer: "agent",
        client: neverReached,
        vault: position.vault as Parameters<typeof withdrawFromVault>[0]["vault"],
        usd: toMicroUsd(canonicalAmount(claimed)),
        // Evaluated INSIDE the position's own lockup, not at `Date.now()`.
        // The claim under test is "a locked position is refused before
        // anything is signed", which is a property of the guard — but
        // `lockupState` defaults its `now` to the wall clock, so once this
        // position's lockup expired on 2026-08-08 the guard correctly reported
        // "unlocked", the call fell through to the throwing client, and the
        // test failed with `unknown` for a reason that was nothing to do with
        // the code it exercises.
        lockup: lockupState(position.lockedUntilMs, position.lockedUntilMs - 1_000),
      });

      // `rejected_locally`, not `rejected_by_server`. The difference is a
      // spent action-budget slot and a user-facing "these funds are still
      // locked, for 68 more hours" instead of an opaque exchange string.
      expect(outcome.kind).toBe("rejected_locally");
      if (outcome.kind !== "rejected_locally") throw new Error("unreachable");
      expect(outcome.error.code).toBe("not_authorized");
      expect(outcome.error.context?.reason).toBe("vault_locked");
      expect(outcome.error.context?.untilMs).toBe(position.lockedUntilMs);

      // The whole claim of this test. A single call here means a signed vault
      // action left the device on a position the exchange was always going to
      // refuse.
      expect(wireCalls).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("4. the pushed aggregate, over the production channel wiring", () => {
    let handle: SubscriptionHandle | null = null;
    let frame: Scoped<unknown> | null = null;

    afterAll(async () => {
      await handle?.unsubscribe().catch(() => undefined);
    }, 30_000);

    it("extracts the aggregate from a real webData3 frame and agrees with the HTTP breakdown", async () => {
      const identity = session.state()!.identity;
      const target: SubscriptionTarget = {
        identity,
        channel: "webData3",
        coin: null,
        aggregation: null,
        interval: null,
      };

      // The REAL wiring — `createSubscribeFn` is what the registry calls — so
      // this exercises the parameter mapping and the scoping boundary, not just
      // the SDK.
      const subscribe = createSubscribeFn({
        api: getSubscriptionClient() as unknown as SubscriptionApi,
        sink: (event) => {
          frame ??= event;
        },
      });
      handle = await subscribe(target);

      // ~4-5 s between frames, measured. 45 s is many heartbeats.
      const received = await waitFor(() => frame, 45_000);
      expect(received.target.channel).toBe("webData3");
      // `readServerTime` maps this channel to `userState.serverTime`. A null here
      // means freshness falls back to the device clock, and a feed that died
      // server-side reads as perfectly fresh forever. Bounded on BOTH sides: a
      // lower bound alone is satisfied by seconds-since-epoch read as ms (year
      // 56000) and by any garbage large number, and either would make every
      // staleness check in the app permanently say "fresh".
      expect(received.serverTime).toBeGreaterThan(1_700_000_000_000);
      expect(received.serverTime).toBeLessThan(received.receivedAt + 60_000);

      const pushed = readPushedVaultEquity(received.value);
      // A STRING on the wire, unlike the five float-damaged fields on
      // `vaultDetails`. `readPushedVaultEquity` returns null for a number rather
      // than coercing one, so a non-string would show up here as a null and the
      // headline figure would silently stop updating.
      expect(typeof pushed).toBe("string");
      expect(pushed).toMatch(/^[0-9]+(\.[0-9]+)?$/);

      // It is the aggregate of `userVaultEquities`, which is the only thing that
      // makes it usable as a live headline between HTTP polls. Both sides are
      // mark-to-market and sampled seconds apart — measured a 0.00003 gap on a
      // $5 position — so it cannot be an equality. A cent is three hundred times
      // the observed drift and still tight enough to fail on "this is a
      // different number"; a dollar, on a $5 position, would pass on a figure
      // that was 20% wrong.
      const positions = await fetchVaultPositions({
        probe: testnet as unknown as Parameters<typeof fetchVaultPositions>[0]["probe"],
        user: masterAddress,
        budget,
      });
      const polled = totalVaultEquity(positions.value ?? []);
      expect(new BigNumber(pushed!).minus(polled).abs().isLessThan("0.01")).toBe(true);
      // Not zero on either side: an all-zero comparison would satisfy the bound
      // above while proving the account has no vault position at all.
      expect(new BigNumber(polled).isGreaterThan("0")).toBe(true);
      expect(new BigNumber(pushed!).isGreaterThan("0")).toBe(true);
    }, 90_000);

    it("carries NO breakdown and NO lockup, so it can never gate a withdrawal", () => {
      // Explicit rather than `frame!`: this test reuses the frame the previous one
      // waited for, and a bare non-null assertion turns "the subscription never
      // delivered" into an unreadable `TypeError` two lines further down.
      if (!frame) throw new Error("no webData3 frame — the preceding test must run first");
      const payload = frame.value as Record<string, unknown>;

      // Two keys, measured. Everything a withdrawal needs — per-vault equity, the
      // unlock timestamp — is absent, which is why `equities.ts` polls
      // `userVaultEquities` rather than living off this feed. A future frame that
      // grew a lockup field should be noticed deliberately, not relied on by
      // accident.
      expect(Object.keys(payload).sort()).toEqual(["perpDexStates", "userState"]);
      expect(JSON.stringify(payload)).not.toContain("lockedUntil");
      expect(JSON.stringify(payload)).not.toContain("vaultAddress");

      // The main dex, index 0. Vaults cannot trade HIP-3 perps or spot, so there
      // is nothing at the other indices to miss — and they are all "0.0" here.
      const states = payload.perpDexStates as { totalVaultEquity?: unknown }[];
      expect(states.length).toBeGreaterThan(0);
      expect(typeof states[0].totalVaultEquity).toBe("string");
      expect(readPushedVaultEquity(payload)).toBe(states[0].totalVaultEquity);
    });
  });

  // -------------------------------------------------------------------------
  describe("5. teardown", () => {
    it("stops cleanly, having placed nothing and signed nothing", async () => {
      await session.stop();
      expect(session.state()).toBeNull();
    }, 60_000);
  });
});

/** An echo a well-behaved caller would produce for this quote. */
function echoFor(quote: VaultQuote): VaultEcho {
  return {
    token: quote.token,
    vaultAddressDisplayed: quote.vault.display,
    vaultNameDisplayed: quote.vault.name,
    amountDisplayed: quote.amount,
    acknowledged: quote.warnings.map((w) => w.code),
  };
}

/** See `session.e2e.ts` — live frames arrive on the exchange's schedule. */
async function waitFor<T>(
  read: () => T | null | undefined,
  timeoutMs: number
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for live state`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * The agent key `probe-vault-signer.ts` derives — already approved on testnet.
 *
 * Seeded, never approved: the master's allowance is three API wallets and all
 * three are used. Duplicated from `session.e2e.ts` rather than shared, because
 * that file is another agent's and must not be edited.
 */
function deriveApprovedAgentKey(master: Hex): Hex {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { keccak256, stringToBytes } = require("viem") as typeof import("viem");
  return keccak256(stringToBytes(`hl-vault-probe:${master.toLowerCase()}`)) as Hex;
}
