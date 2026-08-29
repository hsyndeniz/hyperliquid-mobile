/**
 * Structural guards on how screens read the session.
 *
 * These are source greps, not behaviour tests, and that is deliberate: the bug
 * they prevent **cannot be reproduced under Jest**. React Compiler runs in the
 * Metro/Babel pipeline and not in the test transform, so a component that calls
 * `session.address()` behaves correctly in a unit test and wrongly on device.
 * The only enforceable line is the call itself.
 *
 * ## The bug, measured
 *
 * `session.address()` is a plain method on an object whose identity never
 * changes. React Compiler is free to treat the call as pure and memoise it for
 * the life of the component — and does. A screen that rendered once while
 * signed out cached `null` and kept returning it after the session started, so
 * in the same render `session.state()` reported a live session while
 * `session.address()` reported nobody. On the Portfolio screen that silently
 * removed the account-value chart, because it renders only when the address is
 * non-null.
 *
 * It surfaced only after the call was hoisted above the screen's no-session
 * early return. Below that return the first evaluation always had a session, so
 * the memoised value happened to be right — which is why this survived review:
 * the code was equally wrong before, and got away with it.
 *
 * `useSessionAddress` subscribes through `useSyncExternalStore`, which the
 * compiler cannot fold away.
 *
 * ## What is banned, and what is not
 *
 * Only **render-path** reads are wrong. A call inside an event handler or an
 * async probe is correct and sometimes required — the Account screen's probes read
 * `session.address()` after an await precisely because React state "has not
 * re-rendered inside this callback". Banning those would break working code.
 *
 * Render position is detected two ways, both textual:
 *
 * 1. A `const x = session.foo()` at **exactly two spaces** of indent — the
 *    component body under this project's Prettier config. A callback body is
 *    indented further.
 * 2. The call inside a JSX expression container (`value={session.address()}`).
 *
 * That is a heuristic, not a parse, and it is written down here so nobody
 * mistakes it for one: a reformatted file could slip past rule 1. It is chosen
 * over an AST pass because it costs nothing and catches the two shapes this bug
 * has actually taken.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");

/** Every `.ts`/`.tsx` file under a directory, recursively, excluding tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/** Where React components live — the only place the compiler runs. */
const COMPONENT_DIRS = ["app", "components", "providers"];

/** Every component source, resolved once for the suites below. */
const files = COMPONENT_DIRS.flatMap((dir) => {
  try {
    return sourceFiles(join(SRC, dir));
  } catch {
    return [];
  }
});

describe("screens subscribe to the session rather than calling it", () => {
  it("finds the component sources it is supposed to be guarding", () => {
    // A guard that silently matches nothing is worse than no guard.
    expect(files.length).toBeGreaterThan(3);
  });

  /** Lines that read the session from the render path. */
  function renderPathReads(source: string, method: string): string[] {
    const call = String.raw`session\.${method}\s*\(`;
    const componentBody = new RegExp(String.raw`^ {2}const \w+(?::[^=]+)? = ${call}`);
    const jsxExpression = new RegExp(String.raw`=\{[^}]*${call}`);

    return source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)) // comments are not calls
      .filter((line) => componentBody.test(line) || jsxExpression.test(line));
  }

  it.each([["address"], ["state"], ["canTrade"], ["needsAgentRotation"]])(
    "no component reads session.%s() from the render path",
    (method) => {
      const offenders = files.flatMap((file) =>
        renderPathReads(readFileSync(file, "utf8"), method).map(
          (line) => `${file.replace(`${SRC}/`, "")}: ${line.trim()}`
        )
      );

      // Each of these has a `use*` counterpart in `hooks/session.ts`. A direct
      // call on the render path is evaluated once and may never be evaluated
      // again; the hook re-reads on every session change.
      expect(offenders).toEqual([]);
    }
  );

  it("the Portfolio screen reads its address through the hook", () => {
    const screen = readFileSync(join(SRC, "app/(tabs)/portfolio.tsx"), "utf8");

    // Positive assertion as well as the negative one above: deleting the read
    // entirely would satisfy "does not call session.address()" while removing
    // the chart just as effectively.
    expect(screen).toMatch(/useSessionAddress\s*\(\s*session\s*\)/);
  });
});

describe("the account picker shows equity across EVERY dex", () => {
  /**
   * `SubAccountSummary.perpEquityTotal` exists solely to prevent one failure,
   * and its own docstring names it: *"Reading only the main dex is how a picker
   * shows $0.01 for an account holding $50m on a HIP-3 dex — a user reads
   * 'empty' and abandons it."* The picker read the main dex anyway.
   *
   * Worse than the HIP-3 case, which is rare today: `perpEquityByDex` is
   * SPARSE — 48 of 67 sampled sub-accounts carried no main-dex entry at all —
   * so `?? "0"` rendered most accounts as `0` while the "Combined perps" line
   * one card up counted the money the row denied.
   *
   * A source grep for the same reason as the guards above: the value is read
   * inside markup that Jest cannot mount in this repo.
   */
  const SWITCHER = join(SRC, "components/portfolio/AccountSwitcher.tsx");

  it("finds the file it is guarding", () => {
    // Without this, a rename turns both assertions below into vacuous passes.
    expect(readFileSync(SWITCHER, "utf8")).toContain("function AccountRow");
  });

  it("passes the cross-dex total to the row, not the main-dex entry", () => {
    const source = readFileSync(SWITCHER, "utf8");
    expect(source).toMatch(/equity=\{account\.perpEquityTotal\}/);
    expect(source).not.toMatch(/equity=\{account\.perpEquityByDex/);
  });
});

describe("every money path is behind the presence gate", () => {
  /**
   * `wallet/signer.ts` states the design: *"Gating here puts it in front of the
   * operations that actually move money, which is where a prompt means
   * something"*, and `GatedOperation` has declared `"withdraw" | "transfer"`
   * since it was written.
   *
   * Neither had a call site. The only gated operations in the whole app were
   * reading the recovery phrase and forgetting the wallet, so a withdrawal was
   * signed with the in-vault master key with no authentication of any kind —
   * while three hook headers asserted that `masterClient()` "prompts". That is
   * true only of an `interactive` signer, and `externalSigner()` has no call
   * sites: `signerFor` returns `localSigner` on both branches, which is
   * `kind: "silent"` — "the user sees nothing".
   *
   * A grep because the call sits inside a hook this repo cannot mount under
   * Jest, and because the failure mode is ABSENCE — exactly what a behaviour
   * test of the remaining code cannot see.
   */
  const MONEY_HOOKS: [string, string][] = [
    ["hyperliquid/hooks/withdraw.ts", "withdraw"],
    ["hyperliquid/hooks/send.ts", "transfer"],
    ["hyperliquid/hooks/transfer.ts", "transfer"],
  ];

  it.each(MONEY_HOOKS)("%s gates on requireUserPresence(%s)", (file, operation) => {
    const source = readFileSync(join(SRC, file), "utf8");
    // Self-check first: a rename must fail loudly rather than vacuously pass.
    expect(source).toMatch(/masterClient\(\)/);
    expect(source).toMatch(new RegExp(`requireUserPresence\\(\\s*"${operation}"`));
  });

  it("no money hook still claims masterClient() prompts", () => {
    // The comments said the gate was already there, which is most of why it
    // was never noticed missing.
    for (const [file] of MONEY_HOOKS) {
      expect(readFileSync(join(SRC, file), "utf8")).not.toMatch(/masterClient\(\)` prompts/);
    }
  });
});

describe("Sentry has exactly one path in, and it is the redacted one", () => {
  /**
   * `core/sentrySink.ts` states the architecture: *"`core/logger.ts` redacts
   * BEFORE any sink is called … A sink therefore cannot leak them, which is the
   * whole reason the sink boundary sits where it does."*
   *
   * `enableLogs: true` put a second sink on the other side of that line.
   * Verified in the installed package: `integrations/default.js:45` pushes
   * `consoleLoggingIntegration()`, and `logs/console-integration.js:19` falls
   * back to every `CONSOLE_LEVELS` entry when given no options — so every
   * `console.*` in the process, ours and every dependency's, went to Sentry
   * unredacted. viem embeds request payloads in its warnings.
   *
   * A grep because the defect is a CONFIGURATION FLAG: there is no behaviour to
   * assert on, and the wizard's defaults are what put it there in the first
   * place.
   */
  const config = () => readFileSync(join(SRC, "sentry.ts"), "utf8");

  it("finds the config it is guarding", () => {
    expect(config()).toMatch(/Sentry\.init\(/);
  });

  it("does not capture the console", () => {
    expect(config()).toMatch(/enableLogs:\s*false/);
  });

  it("nothing in src/ unmasks a Session Replay", () => {
    // `mobileReplayIntegration` masks all text, images and vectors by default,
    // and that default is the ONLY thing keeping a recovery phrase out of a
    // replay that samples 10% of sessions. `app/wallet.tsx` holds a phrase in
    // React state and `accountView.phraseWords` renders it.
    //
    // A single `unmask` added for a chart or a logo, anywhere in the tree,
    // removes that protection with nothing to notice it. If one is ever
    // genuinely needed, scope it here deliberately.
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => (/\bunmask\b/i.test(line) ? [`${file}:${i + 1}`] : []))
    );
    expect(offenders).toEqual([]);
  });

  it("does not attach IP and user context to every event", () => {
    // A wallet that ties a network location to on-chain activity creates a
    // linkage worth not creating.
    expect(config()).toMatch(/sendDefaultPii:\s*false/);
  });
});

describe("layout uses padding and gap, never margin", () => {
  /**
   * A house rule, stated by the user: *"I do not want you to margin anywhere if
   * not necessary. Paddings and gaps are better."*
   *
   * The reason it is worth a guard rather than a convention: a margin makes
   * spacing a claim the CHILD asserts about its neighbours, so the same
   * component spaces itself differently in every container it is dropped into.
   * `gap` puts that decision on the parent, which is the thing that knows the
   * layout. It also rules out the negative-margin nudge — alignment gets fixed
   * with a wrapper and flex alignment instead.
   */
  // The class may be FIRST in the attribute (right after the quote) or later
  // (after whitespace). Requiring whitespace missed the first case entirely —
  // caught by reverting a margin in and watching this pass.
  const MARGIN = /className=(?:"|\{`)(?:[^"`]*\s)?-?m[trblxy]?-[0-9.]+/;

  it("finds no margin utility in any component", () => {
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => MARGIN.test(line))
        .map((line) => `${file.replace(`${SRC}/`, "")}: ${line.trim()}`)
    );

    expect(offenders).toEqual([]);
  });
});

describe("a coin badge is one size, whichever branch renders it", () => {
  /**
   * `CoinBadge` has two branches — real artwork, and a monogram fallback for
   * the ~half of Hyperliquid's markets with no icon. They used to disagree:
   * the SVG path hardcoded 32px while the fallback used `Avatar size="sm"`,
   * which `heroui-native`'s own `avatar.css` defines as 40px.
   *
   * The result was visible on any list mixing the two — the rows sat 8px apart
   * and every column after the badge inherited it. A grep, because the failure
   * is two numbers that must agree and nothing in the type system says so.
   */
  const source = () => readFileSync(join(SRC, "components/portfolio/primitives.tsx"), "utf8");

  it("declares the size once", () => {
    expect(source()).toMatch(/export const COIN_BADGE_PX = \d+;/);
  });

  it("hardcodes no pixel size in either branch", () => {
    const body = source().slice(
      source().indexOf("export function CoinBadge"),
      source().indexOf("export function Empty")
    );

    // Any bare number where a dimension belongs means one branch can drift.
    expect(body).not.toMatch(/width=\{\d+\}/);
    expect(body).not.toMatch(/height=\{\d+\}/);
    expect(body).not.toMatch(/\bh-\d+ w-\d+\b/);
  });

  it("sizes BOTH branches from the same binding", () => {
    // The invariant is that the two agree — not that either uses a particular
    // constant. This guard used to assert the fallback referenced
    // `COIN_BADGE_PX`, which was the same thing while the size was fixed. Once
    // `size` became a prop it stopped being: the artwork branch followed the
    // prop, the fallback kept the literal, and every caller asking for a larger
    // badge got a 32px monogram beside a 44px logo. Roughly half of every list
    // is a fallback, so that is every other row.
    const body = source().slice(
      source().indexOf("export function CoinBadge"),
      source().indexOf("export function Empty")
    );
    const artwork = body.slice(0, body.indexOf("<Avatar"));
    const avatar = body.slice(body.indexOf("<Avatar"));

    // `size="sm"` alone is 40px, so an explicit override is still required.
    expect(avatar).toMatch(/style=\{\{ width: size, height: size \}\}/);
    expect(artwork).toMatch(/style=\{\{ width: size, height: size \}\}/);
  });

  it("defaults that binding to the one declared size", () => {
    const body = source().slice(
      source().indexOf("export function CoinBadge"),
      source().indexOf("export function Empty")
    );
    expect(body).toMatch(/size = COIN_BADGE_PX/);
  });
});

/**
 * A withdrawal is final, and two of its hazards live only in the UI.
 *
 * The module below cannot enforce either: `submitWithdrawal` is handed a
 * checksummed-or-not address by the ticket, and it has no idea whether the
 * screen offered a retry button. Both are properties of the markup.
 */
describe("the money screens do not undo the withdrawal safeguards", () => {
  const moneyFiles = files.filter(
    (file) => file.includes("/components/money/") || file.endsWith("app/withdraw.tsx")
  );

  it("finds the money sources it is supposed to be guarding", () => {
    expect(moneyFiles.length).toBeGreaterThan(3);
  });

  it("never renders the lowercase wire spelling of a destination", () => {
    // `wire` is what gets signed; `display` is EIP-55 checksummed and is the
    // ONLY form in which a single-character typo is detectable. Showing the
    // lowercase form throws the check away, and `confirmWithdrawal` compares
    // case-sensitively so that a screen cannot.
    const offenders = moneyFiles.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        // Inside a JSX expression container, which is where a value is rendered.
        .filter((line) => /\{[^}]*\.wire\b/.test(line))
        .map((line) => `${file.replace(`${SRC}/`, "")}: ${line.trim()}`)
    );

    expect(offenders).toEqual([]);
  });

  /**
   * The `unknown` branch of `Outcome`, as rendered text.
   *
   * Comments are stripped and whitespace collapsed: the guard is about what a
   * user reads, and this file's own explanatory comments legitimately contain
   * the words it bans in the copy.
   */
  function unknownBranchCopy(): string {
    const screen = readFileSync(join(SRC, "app/withdraw.tsx"), "utf8");
    // The early return inside `Outcome`, not the ternary that chooses it.
    const start = screen.indexOf('if (phase.kind === "unknown") {');
    const end = screen.indexOf("Withdrawal sent");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);

    return screen
      .slice(start, end)
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "") // JSX comments
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, "") // line comments
      .replace(/\s+/g, " ");
  }

  it("offers nothing that re-sends an unresolved withdrawal", () => {
    // A withdrawal has no idempotency key and no cancel, so re-sending is a
    // SECOND withdrawal. The module-level guard (`withdraw.test.ts`) bans a
    // `retry`/`resend` export; this bans the button.
    expect(unknownBranchCopy()).not.toMatch(/\b(retry|try again|send again|resend)\b/i);
  });

  it("tells the user NOT to re-send, rather than merely omitting the button", () => {
    expect(unknownBranchCopy()).toMatch(/do not send it again/i);
  });

  it("never calls a withdrawal failed on absence of confirmation", () => {
    // `reconcileWithdrawals` is explicit: absence past the floor is grounds for
    // telling the user to check the destination chain — never for calling it
    // failed, and never for re-sending.
    expect(unknownBranchCopy()).not.toMatch(/\b(failed|lost)\b/i);
  });
});

/**
 * A spot balance's `hold` is money already committed to resting orders.
 *
 * `total` includes it; `available` is what can actually move. Offering `total`
 * gets a server rejection for an amount the screen itself displayed — and with
 * no agent, a real wallet prompt the user approves first. `sendView.ts` states
 * the rule; three screens broke it anyway, at the same line, in the same way.
 * A grep, because nothing in the type system distinguishes the two fields.
 */
describe("spot balances are read as `available`", () => {
  // `[^)]*` cannot span the predicate's own parens — `(b) => …` closes one
  // before `?.total` is reached, so the first version of this guard matched
  // nothing and passed against the very bug it was written for.
  const SPOT_TOTAL = /balances\.find\([\s\S]*?\)\?\.total\b/;

  it("never sources a movable amount from `total`", () => {
    const offenders = files.filter((file) => SPOT_TOTAL.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("a signed action reaches the acting account", () => {
  /**
   * A sub-account has no agent of its own: the master's agent signs, and
   * `vaultAddress` is the only thing saying who the action is FOR. Omit it and
   * the action succeeds — against the master — while the user is looking at the
   * sub-account. `useOrderActions.cancelOrder` shipped exactly that bug, sending
   * an oid to an account it did not exist on.
   *
   * Greps rather than types: making the field required would force `route: {}`
   * onto 88 construction sites, almost all of them tests, to protect seven real
   * call sites. These two checks cover the same ground at the two points it can
   * actually go wrong — writing the mapping by hand, or forgetting it.
   */
  const EXCHANGE = join(SRC, "hyperliquid/orders/exchange.ts");

  /** Exported actions whose params carry `VaultRouted`, read from the source. */
  function routedActions(): string[] {
    const source = readFileSync(EXCHANGE, "utf8");
    const routedParams = new Set(
      [...source.matchAll(/export interface (\w+) extends VaultRouted/g)].map((m) => m[1]!)
    );
    return source
      .split("export async function ")
      .slice(1)
      .flatMap((chunk) => {
        const name = chunk.slice(0, chunk.indexOf("("));
        const signature = chunk.slice(0, 400);
        const routed =
          /params: VaultRouted/.test(signature) ||
          [...routedParams].some((type) => new RegExp(`params: ${type}\\b`).test(signature));
        return routed ? [name] : [];
      });
  }

  /** The source of every production module — tests may construct params freely. */
  const production = sourceFiles(SRC).filter(
    (file) => !file.includes("__e2e__") && file !== EXCHANGE
  );

  it("finds the actions it is supposed to be guarding", () => {
    // If this drops to a handful, the derivation broke and the guard below is
    // silently passing over an empty set.
    expect(routedActions().length).toBeGreaterThanOrEqual(10);
    expect(routedActions()).toContain("submitOrders");
    expect(routedActions()).toContain("updateLeverage");
  });

  it("maps a sub-account to vaultAddress in exactly one place", () => {
    // Any other spelling of the same mapping — a bare `vaultAddress:
    // x.subAccount`, a ternary, a `??` — is a second place to get it wrong.
    const offenders = production.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => {
          const code = line.replace(/\/\/.*$/, "").trim();
          if (code.startsWith("*")) return [];
          return /vaultAddress/.test(code) && /subAccount/.test(code) ? [`${file}:${i + 1}`] : [];
        })
    );
    expect(offenders).toEqual([
      `${join(SRC, "hyperliquid/core/identity.ts")}:${identityRouteLine()}`,
    ]);
  });

  it("routes every call to a routed action", () => {
    const actions = routedActions();
    const offenders: string[] = [];

    for (const file of production) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // Matched ANYWHERE in the line, not only where the line ends at the
        // opening brace. The pattern was `\bname\(\{?\s*$`, which requires the
        // argument object to start on the next line — so any routed call short
        // enough to fit on one line (well inside the 100-column width) was
        // never inspected at all. A one-line `cancelOrders({ client, cancels })`
        // missing `actingRoute` compiled, passed every guard, and signed for
        // the MASTER while a sub-account was active — the precise bug this
        // guard was written for, in the spelling it could not see.
        const action = actions.find((name) => new RegExp(`\\b${name}\\(`).test(line));
        if (!action) return;
        if (!callBlock(lines, i).includes("actingRoute(")) offenders.push(`${file}:${i + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it("SEES a one-line call — the spelling the old pattern skipped", () => {
    // The guard above is itself guarded: a pattern that silently inspects
    // nothing passes just as loudly as one that inspects everything, and this
    // one did exactly that for every single-line call site.
    const lines = [
      "const result = await cancelOrders({ client, cancels });",
      "const ok = await submitOrders({ client, orders, ...actingRoute(identity) });",
    ];
    const actions = routedActions();

    const unrouted = lines.filter((line) => {
      const action = actions.find((name) => new RegExp(`\\b${name}\\(`).test(line));
      return action !== undefined && !callBlock([line], 0).includes("actingRoute(");
    });

    // The first line is the offender; the second is correctly routed.
    expect(unrouted).toEqual(["const result = await cancelOrders({ client, cancels });"]);
  });

  /** The argument list opened on `start`, read to its matching close. */
  function callBlock(lines: string[], start: number): string {
    let depth = 0;
    const out: string[] = [];
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i]!;
      out.push(line);
      for (const ch of line) {
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
      }
      if (i > start && depth <= 0) break;
    }
    return out.join("\n");
  }

  /** Where the one legal mapping lives, so the guard names a line, not a range. */
  function identityRouteLine(): number {
    const lines = readFileSync(join(SRC, "hyperliquid/core/identity.ts"), "utf8").split("\n");
    return lines.findIndex((line) => /vaultAddress/.test(line) && /subAccount/.test(line)) + 1;
  }
});

describe("a server instant is never compared with a device instant", () => {
  /**
   * `Scoped` carries two instants on two different clocks — `serverTime` from
   * the exchange, `receivedAt` from the phone. Reaching for the raw field and
   * comparing it with a local `Date.now()` yields a number that measures clock
   * skew rather than age, and it fails in the direction that HIDES the fault: a
   * slow phone reports a dead feed as eternally live, and every `age <= maxAge`
   * gate in the app passes a negative age.
   *
   * Three modules made that mistake independently — `core/freshness.ageMs`,
   * `AccountStore.isStale` and `BookStore`'s ordering compare. Three is enough
   * to stop calling it an oversight: the translation is now named
   * (`deviceInstantOf`) and reading the raw field is allow-listed.
   *
   * To add an entry you must be comparing a server stamp with ANOTHER server
   * stamp. If the other side is `Date.now()`, a `receivedAt`, or a caller's
   * `now`, use `deviceInstantOf` instead.
   */
  const ALLOWED = new Set([
    // The stamping boundary and the translator itself.
    "hyperliquid/core/freshness.ts",
    // Server-clock monotonicity: `summary.serverTime` against `summary.serverTime`.
    "hyperliquid/state/account.ts",
  ]);

  /** Code text only — a prose mention of the field in a docstring is not a read. */
  function codeLines(source: string): { text: string; line: number }[] {
    return source.split("\n").flatMap((raw, i) => {
      const text = raw.replace(/\/\/.*$/, "").trim();
      if (text === "" || text.startsWith("*") || text.startsWith("/*")) return [];
      return [{ text, line: i + 1 }];
    });
  }

  it("reads the raw server stamp only where a server-to-server comparison needs it", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.includes("__e2e__"))
      .flatMap((file) => {
        const rel = file.slice(SRC.length + 1);
        if (ALLOWED.has(rel)) return [];
        return codeLines(readFileSync(file, "utf8"))
          .filter(({ text }) => /\.serverTime\b/.test(text))
          .map(({ line }) => `${rel}:${line}`);
      });
    expect(offenders).toEqual([]);
  });

  it("keeps the allow-list honest — every entry still reads the field", () => {
    // An entry that stopped reading `.serverTime` is a licence nobody needs;
    // left behind, it silently re-permits the next mistake in that file.
    const dead = [...ALLOWED].filter(
      (rel) =>
        !codeLines(readFileSync(join(SRC, rel), "utf8")).some(({ text }) =>
          /\.serverTime\b/.test(text)
        )
    );
    expect(dead).toEqual([]);
  });
});

describe("budget-agnostic history reads are budgeted by whoever calls them", () => {
  /**
   * `history/orders.ts`, `history/twap.ts` and `history/ledger.ts` deliberately
   * know nothing about the weight budget — they are wrapped at the composition
   * edge, so the same fetcher can serve a budgeted screen and an unbudgeted
   * test. The cost of that choice is that a new caller can simply forget.
   *
   * One did: the vault activity fan-out called all three bare, spending 20
   * weight PER FAMILY MEMBER with the tracker recording none of it. Three tabs
   * on an eight-member family burnt 480 real weight while `remaining()` still
   * reported full headroom — which is exactly the drift the gap between
   * `SOFT_WEIGHT_PER_MINUTE` (1000) and the documented 1200 exists to absorb.
   *
   * Necessary, not sufficient: this proves the caller KNOWS about the budget,
   * not that it wrapped every call. It catches the failure that actually
   * happened — a file with no notion of the budget at all.
   */
  const HISTORY_DIR = join(SRC, "hyperliquid/history");
  const BUDGET_IMPORT = /from "@\/hyperliquid\/api\/weightBudget"/;

  /** Exported `fetch*` functions from a history module that does not budget. */
  function agnosticFetchers(): string[] {
    return sourceFiles(HISTORY_DIR).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      if (BUDGET_IMPORT.test(source)) return [];
      return [...source.matchAll(/export async function (fetch\w+)/g)].map((m) => m[1]!);
    });
  }

  it("finds the fetchers it is supposed to be guarding", () => {
    const fetchers = agnosticFetchers();
    expect(fetchers).toEqual(expect.arrayContaining(["fetchOrderHistory", "fetchLedgerPage"]));
  });

  it("every module calling one knows about the weight budget", () => {
    const fetchers = agnosticFetchers();
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.startsWith(HISTORY_DIR) && !file.includes("__e2e__"))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        const calls = fetchers.filter((fn) => new RegExp(`\\b${fn}\\(`).test(source));
        if (calls.length === 0 || BUDGET_IMPORT.test(source)) return [];
        return [`${file.slice(SRC.length + 1)} calls ${calls.join(", ")}`];
      });
    expect(offenders).toEqual([]);
  });
});
