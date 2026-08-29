/**
 * Live testnet **account-state** smoke test.
 *
 *   bun run smoke:account
 *
 * Read-only, no wallet, no funds. Every check below is phrased as the assertion
 * that would have caught a specific hazard, and every one of those hazards is
 * an instance of the same failure class: a wrong assumption about a live payload
 * that produces a **wrong number on screen** rather than an error. Unit tests
 * cannot catch that class — they assert against fixtures, and a fixture can only
 * encode what its author already believed.
 *
 * The default address is one verified to hold both cross and isolated positions.
 * The repo's own testnet account has **zero** positions and would validate
 * almost nothing: an empty account passes every parser trivially.
 */

import {
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from "@nktkas/hyperliquid";
import { BigNumber } from "bignumber.js";

import { fetchAccountSnapshot, fetchOpenOrders, fetchSpotState } from "@/hyperliquid/api/account";
import type { AccountProbe } from "@/hyperliquid/api/account";
import { addLogSink, createConsoleSink, setLogLevel } from "@/hyperliquid/core/logger";
import { createIdentity, dexParam, effectiveAddress } from "@/hyperliquid/core/identity";
import { AccountStore } from "@/hyperliquid/state/account";
import { parseClearinghouseState, parseSpotState } from "@/hyperliquid/state/accountWire";
import { createSubscribeFn, type SubscriptionApi } from "@/hyperliquid/state/channels";
import { SubscriptionRegistry } from "@/hyperliquid/state/registry";
import { SpotBalanceStore } from "@/hyperliquid/state/spot";
import type { Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

/** Verified on testnet: 3 cross / 7 isolated positions, 3 with a null liquidationPx. */
const DEFAULT_ADDRESS = "0xcc8a21b439951529281859f6ad39f279606304a7";
const ADDRESS = (process.env.HL_SMOKE_ADDRESS ?? DEFAULT_ADDRESS) as `0x${string}`;

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function main(): Promise<void> {
  setLogLevel("error");
  addLogSink(createConsoleSink());

  console.log(`Hyperliquid ACCOUNT smoke — TESTNET\n${"=".repeat(46)}\n  address ${ADDRESS}`);

  const transport = new HttpTransport({ isTestnet: true });
  const info = new InfoClient({ transport });
  const probe = info as unknown as AccountProbe;
  const identity = createIdentity({ env: "testnet", accountId: "smoke", address: ADDRESS });

  // -------------------------------------------------------------------------
  section("1. clearinghouseState shape");
  // -------------------------------------------------------------------------
  const raw = (await info.clearinghouseState({ user: ADDRESS })) as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  check(
    "top-level key set is exactly the six known keys",
    JSON.stringify(keys) ===
      JSON.stringify([
        "assetPositions",
        "crossMaintenanceMarginUsed",
        "crossMarginSummary",
        "marginSummary",
        "time",
        "withdrawable",
      ]),
    keys.join(",")
  );

  let parsed;
  try {
    parsed = parseClearinghouseState(raw);
    check("the parser accepts the live response", true, `${parsed.positions.length} position(s)`);
  } catch (error) {
    check("the parser accepts the live response", false, String(error));
    finish();
    return;
  }

  if (parsed.positions.length === 0) {
    console.log("\n  ! this account holds no positions — most checks below validate nothing.");
    console.log("    Set HL_SMOKE_ADDRESS to an account with open positions.");
  }

  // -------------------------------------------------------------------------
  section("2. The numbers a user checks against their own arithmetic");
  // -------------------------------------------------------------------------
  const nullLiq = parsed.positions.filter((p) => p.liquidationPx === null);
  check(
    "no liquidation price is coerced to zero",
    parsed.positions.every(
      (p) => p.liquidationPx === null || !new BigNumber(p.liquidationPx).isZero()
    ),
    `${nullLiq.length}/${parsed.positions.length} genuinely have none`
  );

  const mixed =
    parsed.summary.total.accountValue !== parsed.summary.cross.accountValue ||
    parsed.positions.every((p) => p.marginMode === "cross");
  check(
    "the two margin buckets are kept apart",
    mixed,
    `total ${parsed.summary.total.accountValue} vs cross ${parsed.summary.cross.accountValue}`
  );

  let roeWorst = 0;
  let entryWorst = 0;
  for (const p of parsed.positions) {
    roeWorst = Math.max(
      roeWorst,
      new BigNumber(p.unrealizedPnl)
        .times(p.leverage)
        .div(p.entryNotional)
        .minus(p.returnOnEquity)
        .abs()
        .toNumber()
    );
    const implied = new BigNumber(p.entryNotional).div(p.size);
    entryWorst = Math.max(
      entryWorst,
      implied.minus(p.entryPxDisplay).abs().div(implied).toNumber()
    );
  }
  check(
    "returnOnEquity is unrealizedPnl x leverage / entryNotional",
    parsed.positions.length === 0 || roeWorst < 5e-11,
    `worst residual ${roeWorst.toExponential(2)}`
  );
  check(
    "entryPx is the truncated form of the exact entry notional",
    parsed.positions.length === 0 || entryWorst < 1e-3,
    `worst relative gap ${entryWorst.toExponential(2)}`
  );

  const badMode = parsed.positions.filter(
    (p) => (p.marginMode === "cross") !== (p.isolatedRawUsd === null)
  );
  check("rawUsd is present iff the position is isolated", badMode.length === 0);

  const crossPositions = parsed.positions.filter((p) => p.marginMode === "cross");
  const badMargin = crossPositions.filter((p) =>
    new BigNumber(p.notionalValue).div(p.leverage).minus(p.marginUsed).abs().isGreaterThan(1e-6)
  );
  check(
    "cross margin is notional / leverage",
    badMargin.length === 0,
    `${crossPositions.length} cross position(s)`
  );

  const isolatedMargin = parsed.positions
    .filter((p) => p.marginMode === "isolated")
    .reduce((total, p) => total.plus(p.marginUsed), new BigNumber(0));
  check(
    "total = cross + isolated margin",
    new BigNumber(parsed.summary.total.accountValue)
      .minus(parsed.summary.cross.accountValue)
      .minus(isolatedMargin)
      .abs()
      .isLessThan(1e-6)
  );

  // -------------------------------------------------------------------------
  section("3. The wrong-dex trap");
  // -------------------------------------------------------------------------
  // A real-but-wrong dex answers 200 with a fully-formed EMPTY account. The
  // dangerous case is precisely the one that looks valid, which is why the store
  // verifies the echoed dex rather than trusting a plausible response.
  try {
    const wrongDex = (await info.clearinghouseState({
      user: ADDRESS,
      dex: "test",
    })) as Record<string, unknown>;
    const empty = parseClearinghouseState(wrongDex, { dex: "test" });
    check(
      "a wrong dex returns a plausible EMPTY account, not an error",
      empty.positions.length === 0,
      `accountValue ${empty.summary.total.accountValue} — indistinguishable from a real empty account`
    );

    const store = new AccountStore();
    const chsTarget: SubscriptionTarget = {
      identity,
      channel: "clearinghouseState",
      coin: null,
      aggregation: null,
      interval: null,
    };
    store.setTarget(chsTarget);
    const accepted = store.apply(
      {
        target: chsTarget,
        value: empty,
        serverTime: empty.summary.serverTime,
        receivedAt: Date.now(),
        isSnapshot: true,
      },
      { dex: "test", user: ADDRESS }
    );
    check("the store refuses it on the echoed dex", accepted === false && store.read() === null);
  } catch (error) {
    check("wrong-dex probe completed", false, String(error));
  }

  // -------------------------------------------------------------------------
  section("4. REST seeds through the weight budget");
  // -------------------------------------------------------------------------
  const seed = await fetchAccountSnapshot({ probe, user: ADDRESS });
  check(
    "account snapshot seeds",
    !seed.deferred && seed.value !== null,
    `${seed.value?.positions.length ?? 0} position(s)`
  );
  check("seed records the dex it asked for", seed.value?.summary.dex === "");

  const orders = await fetchOpenOrders({ probe, user: ADDRESS });
  check(
    "open orders seed via one concurrent dual-endpoint fetch",
    !orders.deferred && orders.value !== null,
    orders.value
      ? `${orders.value.rows.length} detailed / ${orders.value.totalKnown} total${orders.value.truncated ? " (TRUNCATED)" : ""}`
      : "deferred"
  );
  const triggers = orders.value?.rows.filter((r) => r.isTrigger) ?? [];
  check(
    "trigger orders keep their trigger price",
    triggers.every((r) => r.triggerPx !== null),
    `${triggers.length} trigger order(s)`
  );
  check(
    "non-trigger orders carry no phantom trigger at zero",
    (orders.value?.rows ?? []).every((r) => r.isTrigger || r.triggerPx === null)
  );

  const spotSeed = await fetchSpotState({ probe, user: ADDRESS });
  const spotValue = spotSeed.value;
  check("spot state seeds", !spotSeed.deferred && spotValue !== null);
  if (spotValue) {
    const outcomes = spotValue.balances.filter((b) => b.kind === "outcome");
    check(
      "rows without a token parse as outcome markets",
      outcomes.every((b) => b.token === null),
      `${outcomes.length}/${spotValue.balances.length} carry no token`
    );
    check(
      "available is total minus hold",
      spotValue.balances.every((b) =>
        new BigNumber(b.available).eq(new BigNumber(b.total).minus(b.hold))
      )
    );
    check(
      "portfolio margin is absent rather than zero on an ordinary account",
      spotValue.portfolioMargin === null || typeof spotValue.portfolioMargin.enabled === "boolean",
      spotValue.portfolioMargin === null ? "null" : "present"
    );
  }

  // -------------------------------------------------------------------------
  section("5. Live account feed");
  // -------------------------------------------------------------------------
  const wsTransport = new WebSocketTransport({ isTestnet: true, keepAlive: { interval: 30_000 } });
  const subscriptionClient = new SubscriptionClient({ transport: wsTransport });

  const accountStore = new AccountStore();
  const spotStore = new SpotBalanceStore();
  let chsEvents = 0;
  let spotEvents = 0;
  let emits = 0;
  const serverTimes: (number | null)[] = [];
  const echoes: { dex: string; user: string }[] = [];

  const subscribe = createSubscribeFn({
    api: subscriptionClient as unknown as SubscriptionApi,
    sink: (event) => {
      serverTimes.push(event.serverTime);
      if (event.target.channel === "clearinghouseState") {
        chsEvents += 1;
        const payload = event.value as { clearinghouseState: unknown; dex?: string; user?: string };
        const echo = { dex: payload.dex ?? "", user: payload.user ?? "" };
        echoes.push(echo);
        accountStore.apply(
          {
            ...event,
            value: parseClearinghouseState(payload.clearinghouseState, { dex: echo.dex }),
          } as Scoped<ReturnType<typeof parseClearinghouseState>>,
          echo
        );
      } else if (event.target.channel === "spotState") {
        spotEvents += 1;
        const payload = event.value as { spotState?: unknown };
        spotStore.apply({
          ...event,
          value: parseSpotState(payload.spotState ?? payload),
        } as Scoped<ReturnType<typeof parseSpotState>>);
      }
    },
    onError: (target, error) => console.log(`  ! ${target.channel}:`, error),
  });

  const registry = new SubscriptionRegistry(subscribe);
  const chsTarget: SubscriptionTarget = {
    identity,
    channel: "clearinghouseState",
    coin: null,
    aggregation: null,
    interval: null,
  };
  const spotTarget: SubscriptionTarget = { ...chsTarget, channel: "spotState" };

  accountStore.setTarget(chsTarget);
  spotStore.setTarget(spotTarget);
  accountStore.subscribe(() => {
    emits += 1;
  });

  await registry.add(chsTarget);
  await registry.add(spotTarget);
  check("account subscriptions opened", registry.activeCount === 2);

  const arrived = await waitFor(() => chsEvents >= 4, 30_000);
  check(
    "account pushes arrive",
    arrived,
    `${chsEvents} clearinghouseState, ${spotEvents} spotState`
  );

  check(
    "the store holds a snapshot from the live feed",
    accountStore.read() !== null,
    `${accountStore.read()?.positions.length ?? 0} position(s)`
  );
  check("no push was refused on its echoed identity", accountStore.rejected === 0);
  check(
    "every push echoed the dex and address we asked for",
    echoes.every(
      (e) =>
        e.dex === dexParam(identity) &&
        e.user.toLowerCase() === effectiveAddress(identity).toLowerCase()
    ),
    `${echoes.length} echo(es)`
  );

  // Content-diff suppression, tested deterministically by replaying the last
  // accepted snapshot rather than by hoping the market stands still. On an
  // account with open positions the unrealised PnL moves on every push, so
  // measuring `emits < pushes` against a live feed proves nothing either way —
  // it only passes when the market happens to be quiet.
  const held = accountStore.readScoped();
  if (held) {
    const before = emits;
    const replayed = accountStore.apply(
      { ...held, receivedAt: Date.now() },
      { dex: dexParam(identity), user: effectiveAddress(identity) }
    );
    check(
      "replaying the held snapshot does not re-notify",
      replayed === false && emits === before,
      `${chsEvents} live push(es) produced ${emits} emit(s)`
    );
    check(
      "but freshness still advances, so a live feed is not mistaken for a dead one",
      !accountStore.isStale(Date.now())
    );
  } else {
    check("a snapshot was held to replay", false);
  }

  const chsServerTimes = serverTimes.filter((t): t is number => t !== null);
  check(
    "clearinghouseState carries a nested server timestamp",
    chsServerTimes.length > 0,
    chsServerTimes.length > 0
      ? String(chsServerTimes[0])
      : "none — freshness would use the device clock"
  );
  check(
    "timestamp-less channels report null rather than the receive time",
    serverTimes.some((t) => t === null)
  );

  // -------------------------------------------------------------------------
  section("6. Identity switch clears held state");
  // -------------------------------------------------------------------------
  await registry.removeForIdentity(identity);
  accountStore.setTarget(null);
  spotStore.setTarget(null);

  check("subscriptions torn down", registry.activeCount === 0);
  check("account store cleared", accountStore.read() === null);
  check("spot store cleared", spotStore.read() === null);

  wsTransport.close();
  finish();
}

function finish(): void {
  console.log(`\n${"=".repeat(46)}`);
  console.log(
    failures === 0
      ? "PASS — account state verified against live testnet"
      : `FAIL — ${failures} check(s) failed`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nAccount smoke crashed:", error);
  process.exit(1);
});
