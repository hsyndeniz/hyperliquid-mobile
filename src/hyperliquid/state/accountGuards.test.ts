/**
 * Structural guards for the account path.
 *
 * These assert on the *source text* rather than on behaviour, because the
 * hazards they cover cannot be caught any other way: each one produces a
 * plausible wrong number with no error, and a behavioural test would need the
 * exact input that triggers it. Reading the code is the only way to prove the
 * mistake is absent everywhere rather than absent from the cases someone
 * happened to think of.
 *
 * Every rule below corresponds to a divergence measured against the live API.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");

/**
 * Directories whose every module handles money that ends up inside a signed,
 * irreversible message.
 *
 * **Enumerated from disk, not listed by hand.** A hand-written list has failed
 * twice in exactly the same way: `transfers/ledger.ts` slipped a `parseFloat`
 * past a guard that covered `transfers/` and `dex/` but not `orders/`, and the
 * `orders/` entries were only added after a review found three more defects
 * there. The list is the thing that goes stale, so it is derived — a new module
 * is covered the moment it is written, without anyone remembering.
 */
const MONEY_DIRS = [
  "transfers",
  "dex",
  "orders",
  "subaccounts",
  "vaults",
  "predictions",
  "deposits",
];

function sourcesIn(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
    )
    .map((entry) => `${dir}/${entry.name}`)
    .sort();
}

const TRANSFER_SOURCES = MONEY_DIRS.flatMap(sourcesIn);

const ACCOUNT_SOURCES = [
  "state/accountWire.ts",
  "state/account.ts",
  "state/openOrders.ts",
  "state/fills.ts",
  "state/spot.ts",
  "state/accountSession.ts",
  "api/account.ts",
];

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

/** Strip comments so a rule's own explanation cannot trip it. */
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("money is never parsed as a float", () => {
  it.each(ACCOUNT_SOURCES)("%s uses BigNumber, never Number() or parseFloat()", (file) => {
    // Observed 18-20 significant digits on live accounts — `accountValue
    // "26138202.4954839982"`, spot `total "4967580207.8122634888"`. A double
    // silently loses the tail, and the result still renders as a number.
    const source = code(file);
    expect(source).not.toMatch(/(?<![A-Za-z])Number\s*\(/);
    expect(source).not.toMatch(/parseFloat\s*\(/);
    expect(source).not.toMatch(/parseInt\s*\(/);
  });

  it.each(ACCOUNT_SOURCES)("%s never string-compares an amount against zero", (file) => {
    // Every wire zero is spelled "0.0", so `x === "0"` never fires and a
    // no-funds branch silently never runs.
    expect(code(file)).not.toMatch(/[=!]==\s*"0"/);
  });
});

describe("the account path derives no price-dependent number", () => {
  it("accountWire imports no price source and no liquidation calculator", () => {
    // Even inside ONE atomic response, positionValue/|szi| disagreed with
    // assetCtxs.markPx 11-12% of the time; across separate calls, 23-32%. And
    // a client-side liquidation price diverged from the server's by 64x on an
    // account holding spot collateral. Anything derived from a second source is
    // wrong by construction, so the import simply must not exist.
    const imports = read("state/accountWire.ts")
      .split("\n")
      .filter((line) => line.startsWith("import"));

    for (const forbidden of ["state/book", "state/candles", "allMids", "assetCtxs", "precision"]) {
      expect(imports.join("\n")).not.toContain(forbidden);
    }
  });

  it("no store computes a liquidation price", () => {
    // `calculateLiquidationPrice` is an order-form estimate for a trade not yet
    // placed. For a position that exists, the server's `liquidationPx` is the
    // only correct answer.
    for (const file of ACCOUNT_SOURCES) {
      expect(code(file)).not.toContain("calculateLiquidationPrice");
    }
  });

  it("no store recomputes unrealizedPnl or returnOnEquity", () => {
    // entryPx is truncated toward zero in 5,004 of 5,004 observed positions, so
    // recomputing from it overstates every long and understates every short —
    // worst single position $11,252.
    for (const file of ACCOUNT_SOURCES.filter((f) => f !== "state/accountWire.ts")) {
      const source = code(file);
      expect(source).not.toContain("entryPxDisplay");
      expect(source).not.toContain("markPx");
    }
  });
});

describe("the raw margin summaries never escape the parser", () => {
  it("nothing downstream names marginSummary or crossMarginSummary", () => {
    // Two sibling objects with identical field names and different numbers —
    // 9,874.50 against 5,094.59 on the recorded fixture. They are renamed
    // total/cross at the boundary precisely so the choice cannot be made by
    // autocomplete further downstream.
    for (const file of ACCOUNT_SOURCES.filter((f) => f !== "state/accountWire.ts")) {
      const source = code(file);
      expect(source).not.toContain("marginSummary");
      expect(source).not.toContain("crossMarginSummary");
    }
  });
});

describe("fill aggregation is pinned in exactly one place", () => {
  it("every caller reads the shared constant rather than a literal", () => {
    // An aggregated row reuses a constituent fill's `tid` with a summed size and
    // arrives on the same channel with no marker, so a mixed store double-counts
    // and no dedup key repairs it.
    const callers = ["state/channels.ts", "api/account.ts"];
    for (const file of callers) {
      const source = code(file);
      expect(source).toContain("FILL_AGGREGATION");
      expect(source).not.toMatch(/aggregateByTime:\s*(true|false)/);
    }
  });
});

describe("stores clear rather than only guarding", () => {
  it.each([
    "state/account.ts",
    "state/openOrders.ts",
    "state/fills.ts",
    "state/spot.ts",
    "state/notifications.ts",
  ])("%s clears its held value on a target change", (file) => {
    // `isForTarget` drops incoming writes; it does not remove what is already
    // held. A store with the guard and no clear keeps the previous account's
    // numbers under the new account's header.
    const source = code(file);
    expect(source).toContain("setTarget");
    expect(source).toMatch(/if \(changed\)/);
  });
});

describe("the transfer path never parses money as a float", () => {
  it("scans every money-handling module, and knows if the scan broke", () => {
    // The failure mode of a derived list is that it silently derives NOTHING —
    // a moved directory, a changed suffix — and every rule below then passes
    // vacuously. Pinning the known members makes that loud.
    expect(TRANSFER_SOURCES.length).toBeGreaterThanOrEqual(26);
    for (const known of [
      "transfers/amount.ts",
      "transfers/withdraw.ts",
      "dex/margin.ts",
      "orders/exchange.ts",
      "subaccounts/manage.ts",
      "subaccounts/transfer.ts",
      "vaults/details.ts",
      "vaults/equities.ts",
      "vaults/transfer.ts",
      "deposits/preflight.ts",
      "deposits/send.ts",
    ]) {
      expect(TRANSFER_SOURCES).toContain(known);
    }
  });

  it.each(TRANSFER_SOURCES)("%s uses BigNumber only", (file) => {
    // Caught exactly this in `ledger.ts` during Phase 7: `parseFloat` on a
    // withdrawal's gross and fee, which renders fine and drops the tail.
    const source = code(file);
    expect(source).not.toMatch(/(?<![A-Za-z])Number\s*\.\s*parseFloat/);
    expect(source).not.toMatch(/(?<![A-Za-z.])parseFloat\s*\(/);
    expect(source).not.toMatch(/(?<![A-Za-z.])parseInt\s*\(/);
  });

  it.each(TRANSFER_SOURCES)("%s never string-compares an amount against zero", (file) => {
    expect(code(file)).not.toMatch(/[=!]==\s*"0"/);
  });
});

describe("routing is per action, never ambient", () => {
  it("the client factory sets no defaultVaultAddress", () => {
    // `executeL1Action` resolves `options?.vaultAddress ?? config.defaultVaultAddress`
    // for EVERY L1 action. A default would not merely add routing — it would
    // invert the meaning of `routeTo()` returning `{}`, so every master-path
    // order, cancel and amend in `orders/exchange.ts` would silently act on the
    // vault instead. And it reaches actions whose options type has no
    // `vaultAddress` at all, such as `userOutcome`, where no call site could
    // even see it.
    expect(code("api/clients.ts")).not.toContain("defaultVaultAddress");
  });

  it("nothing anywhere sets one", () => {
    const dirs = [...MONEY_DIRS, "api", "auth", "state"];
    const offenders = dirs
      .flatMap(sourcesIn)
      .filter((file) => code(file).includes("defaultVaultAddress"));
    expect(offenders).toEqual([]);
  });
});

describe("the withdrawal path exposes no way to retry", () => {
  it("neither withdraw.ts nor transfer.ts offers a retry or resend helper", () => {
    // A blind retry does not re-attempt a withdrawal; it performs a second one,
    // because there is no idempotency key and no expiresAfter.
    for (const file of ["transfers/withdraw.ts", "transfers/transfer.ts"]) {
      const source = code(file);
      expect(source).not.toMatch(/export (async )?function \w*[Rr]etry/);
      expect(source).not.toMatch(/export (async )?function \w*[Rr]esend/);
    }
  });

  it("the withdrawal journal is swept on session start", () => {
    // `reconcileWithdrawals` existed, fully tested, with NO caller for an
    // entire phase. The cost of that is invisible on a first withdrawal and
    // total on a second: an unsettled entry is read by the preflight as the
    // `withdrawal_in_flight` BLOCKER, so a withdrawal that succeeded and was
    // never reconciled locks the next one out for the whole settlement floor.
    //
    // A grep, not a behaviour test, because the failure is an ABSENT call —
    // there is no wrong output to assert on, only a missing one.
    expect(code("session.ts")).toMatch(/reconcileWithdrawals\s*\(\s*\{/);
  });

  it("that sweep is scoped to one identity", () => {
    // Unscoped, it settles journal entries belonging to every account this
    // device has ever signed for — the same hazard the order sweep documents.
    const call = /reconcileWithdrawals\s*\(\s*\{[^}]*identityKey:/s;
    expect(code("session.ts")).toMatch(call);
  });

  it("withdraw3 is CALLED from exactly one module", () => {
    // The single call site is what makes the unforgeable ticket a real gate
    // rather than a convention. Matches the invocation, not the name — several
    // modules discuss `withdraw3` in their docs, and an earlier version of this
    // test failed on prose rather than on code.
    const callers = TRANSFER_SOURCES.filter((file) => /\.withdraw3\s*\(/.test(code(file)));
    expect(callers).toEqual(["transfers/withdraw.ts"]);
  });
});

describe("the wallet path never leaks a secret", () => {
  const WALLET_SOURCES = [
    "wallet/accounts.ts",
    "wallet/derive.ts",
    "wallet/mnemonic.ts",
    "wallet/signer.ts",
    "wallet/vault.ts",
  ];

  it.each(WALLET_SOURCES)("%s never puts a secret in a log context", (file) => {
    // The logger redacts by key name, but a secret passed under an innocuous
    // name would sail through. Cheapest defence is to never reference one in a
    // logging call at all.
    const source = code(file);
    // Stop at the first `);` — an earlier version required `});` and, on a
    // call with no object argument, kept scanning into the next function body.
    const logCalls = source.match(/logger\.(info|warn|error|debug)\([\s\S]*?\);/g) ?? [];
    for (const call of logCalls) {
      expect(call).not.toMatch(/\bmnemonic\b\s*[,}]/);
      expect(call).not.toMatch(/\bprivateKey\b/);
      expect(call).not.toMatch(/\bseed\b/);
      expect(call).not.toMatch(/\bphrase\b\s*[,}]/);
      expect(call).not.toMatch(/masterKey/);
    }
  });

  it("the vault never returns its master key", () => {
    // Not exported means it cannot be logged, persisted, or passed somewhere
    // less careful.
    const source = code("wallet/vault.ts");
    expect(source).not.toMatch(/export\s+(async\s+)?function\s+\w*[Mm]asterKey/);
    expect(source).not.toMatch(/export\s+const\s+\w*[Mm]asterKey\s*=/);
  });

  it("only the vault writes secrets to storage", () => {
    // Every other wallet module must go through the encrypt-then-store path
    // rather than reaching for MMKV directly.
    for (const file of WALLET_SOURCES.filter((f) => f !== "wallet/vault.ts")) {
      expect(code(file)).not.toContain("hlStringStorage");
    }
  });
});
