import type { LogEvent, LogSink } from "@/hyperliquid/core/logger";
import {
  addLogSink,
  createLogger,
  redact,
  setLogLevel,
  truncateAddress,
} from "@/hyperliquid/core/logger";

function collectingSink(): LogSink & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  return { events, capture: (event) => events.push(event) };
}

describe("redact", () => {
  it("strips anything that looks like a secret, whatever the casing", () => {
    const out = redact({
      privateKey: "0xdeadbeef",
      agentPrivateKey: "0xdeadbeef",
      SECRET: "s",
      mnemonic: "twelve words",
      signature: { r: "0x1", s: "0x2", v: 27 },
    }) as Record<string, unknown>;

    expect(out.privateKey).toBe("[redacted]");
    expect(out.agentPrivateKey).toBe("[redacted]");
    expect(out.SECRET).toBe("[redacted]");
    expect(out.mnemonic).toBe("[redacted]");
    expect(out.signature).toBe("[redacted]");
  });

  it("redacts nested secrets, not just top-level ones", () => {
    const out = redact({ wallet: { nested: { privateKey: "0xdead" } } }) as any;
    expect(out.wallet.nested.privateKey).toBe("[redacted]");
  });

  it("redacts secrets inside arrays", () => {
    const out = redact({ agents: [{ privateKey: "0xdead" }] }) as any;
    expect(out.agents[0].privateKey).toBe("[redacted]");
  });

  it("keeps non-secret values intact", () => {
    const out = redact({ coin: "BTC", size: "0.1", assetId: 0 }) as Record<string, unknown>;
    expect(out).toEqual({ coin: "BTC", size: "0.1", assetId: 0 });
  });

  it("truncates addresses so logs correlate without carrying full identifiers", () => {
    const out = redact({ user: "0xabcdef0123456789abcdef0123456789abcdef01" }) as any;
    expect(out.user).toBe("0xabcd…ef01");
  });

  it("truncates an address EMBEDDED in a composite key, not only a bare one", () => {
    // The real leak this guards. Every scoping key in this codebase is a
    // composite — `identityKey` is `env|accountId|0xADDRESS|dex|subAccount`,
    // `subscriptionKey` wraps that again — and eleven call sites log one. None
    // of them EQUALS an address, so an anchored test passed while every one of
    // them shipped the full address to the sink.
    const key = "testnet|acct-1|0xabcdef0123456789abcdef0123456789abcdef01|-|-";
    const out = redact({ key }) as Record<string, unknown>;
    expect(out.key).toBe("testnet|acct-1|0xabcd…ef01|-|-");
    expect(String(out.key)).not.toContain("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  it("truncates every address in a string, not just the first", () => {
    // A sub-account key carries two: the master and the sub.
    const out = redact({
      key: "mainnet|a|0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|-|0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }) as Record<string, unknown>;
    expect(out.key).toBe("mainnet|a|0xaaaa…aaaa|-|0xbbbb…bbbb");
  });

  it("redacts a signed payload, which viem puts in the error MESSAGE", () => {
    // `errors/transaction.js:102` writes `Serialized Transaction: "0x02f8…"`
    // into the text, and `serializeError` allowlists `message`. A signed but
    // unbroadcast transaction reaching a sink is worse than a leak: anyone who
    // can read it can broadcast it.
    const raw = `0x${"a1b2".repeat(60)}`; // 240 hex chars — a real one is longer
    const out = redact({ note: `Serialized Transaction: "${raw}"` }) as Record<string, unknown>;
    expect(out.note).toBe('Serialized Transaction: "[signed payload]"');
    expect(String(out.note)).not.toContain(raw);
  });

  it("redacts a 130-char signature but keeps a 64-char hash", () => {
    // The boundary that makes this safe to apply globally: a tx hash is the one
    // long hex string a reader can actually use.
    const signature = `0x${"f".repeat(130)}`;
    const hash = `0x${"a".repeat(64)}`;
    const out = redact({ signature: signature, hash }) as Record<string, unknown>;
    // `signature` is a secret KEY name, so it redacts by name first.
    expect(out.signature).toBe("[redacted]");
    expect(out.hash).toBe(hash);
    // And by length, under a name that is not a secret.
    expect((redact({ blob: signature }) as Record<string, unknown>).blob).toBe("[signed payload]");
  });

  it("leaves a 32-byte hash whole — truncating one in place would corrupt it", () => {
    // A tx hash is `0x` + 64 hex. Without the negative lookahead the first 40
    // characters match and get replaced mid-string, turning a hash a user could
    // paste into a block explorer into something that resolves to nothing. A
    // cloid (`0x` + 32) is shorter than the run and never matches, which is
    // right: it identifies an order, not a person.
    const hash = `0x${"a".repeat(64)}`;
    const cloid = `0x${"b".repeat(32)}`;
    const out = redact({ hash, cloid }) as Record<string, unknown>;
    expect(out.hash).toBe(hash);
    expect(out.cloid).toBe(cloid);
  });

  it("truncates an address used as an object KEY", () => {
    // A map keyed by account puts the identifier in the one position redaction
    // never looked at.
    const out = redact({
      "0xabcdef0123456789abcdef0123456789abcdef01": { equity: "100" },
    }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["0xabcd…ef01"]);
  });

  it("survives circular references rather than throwing inside logging", () => {
    const cyclic: Record<string, unknown> = { coin: "BTC" };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    expect((redact(cyclic) as any).self).toBe("[circular]");
  });

  it("stops at a depth limit so a deep API response cannot stall logging", () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(() => redact(deep)).not.toThrow();
  });
});

describe("truncateAddress", () => {
  it("shortens hex addresses", () => {
    expect(truncateAddress("0xabcdef0123456789abcdef0123456789abcdef01")).toBe("0xabcd…ef01");
  });

  it("leaves non-addresses alone", () => {
    expect(truncateAddress("BTC")).toBe("BTC");
  });
});

describe("logger", () => {
  let removeSink: (() => void) | undefined;

  afterEach(() => {
    removeSink?.();
    removeSink = undefined;
    setLogLevel("debug");
  });

  it("delivers events to sinks with scope and level", () => {
    const sink = collectingSink();
    removeSink = addLogSink(sink);

    createLogger("hl.exchange").info("order.submitted", { context: { coin: "BTC" } });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      scope: "hl.exchange",
      event: "order.submitted",
      level: "info",
      context: { coin: "BTC" },
    });
  });

  it("redacts context before it reaches a sink", () => {
    const sink = collectingSink();
    removeSink = addLogSink(sink);

    createLogger("hl.agent").info("agent.approved", {
      context: { privateKey: "0xdead", agentAddress: "0xabcdef0123456789abcdef0123456789abcdef01" },
    });

    expect(sink.events[0].context).toEqual({
      privateKey: "[redacted]",
      agentAddress: "0xabcd…ef01",
    });
  });

  it("suppresses events below the configured level", () => {
    const sink = collectingSink();
    removeSink = addLogSink(sink);
    setLogLevel("warn");

    const log = createLogger("hl");
    log.debug("noisy");
    log.info("also.noisy");
    log.warn("kept");
    log.error("kept.too");

    expect(sink.events.map((e) => e.event)).toEqual(["kept", "kept.too"]);
  });

  it("reports whether a level is enabled, so hot paths can skip building context", () => {
    setLogLevel("warn");
    const log = createLogger("hl.ws");
    expect(log.enabled("debug")).toBe(false);
    expect(log.enabled("error")).toBe(true);
  });

  it("does not invoke sinks at a suppressed level", () => {
    const capture = jest.fn();
    removeSink = addLogSink({ capture });
    setLogLevel("error");

    createLogger("hl").debug("l2.tick", { context: { levels: 50 } });

    expect(capture).not.toHaveBeenCalled();
  });

  it("keeps working when a sink throws", () => {
    const good = collectingSink();
    const removeBad = addLogSink({
      capture: () => {
        throw new Error("sink exploded");
      },
    });
    removeSink = addLogSink(good);

    expect(() => createLogger("hl").info("still.works")).not.toThrow();
    expect(good.events).toHaveLength(1);
    removeBad();
  });

  it("nests scopes with child()", () => {
    const sink = collectingSink();
    removeSink = addLogSink(sink);

    createLogger("hl.exchange").child("twap").info("twap.placed");

    expect(sink.events[0].scope).toBe("hl.exchange.twap");
  });

  it("carries durationMs for latency tracking", () => {
    const sink = collectingSink();
    removeSink = addLogSink(sink);

    createLogger("hl").info("info.request", { durationMs: 42 });

    expect(sink.events[0].durationMs).toBe(42);
  });
});

describe("error serialization", () => {
  let removeSink: (() => void) | undefined;
  afterEach(() => {
    removeSink?.();
    removeSink = undefined;
    setLogLevel("debug");
  });

  it("never passes the raw error through — SDK errors carry the signed action", () => {
    const sink = collectingSink();
    removeSink = addLogSink(sink);

    const sdkError = Object.assign(new Error("Order failed"), {
      name: "ApiRequestError",
      // What the SDK actually attaches, and must never reach a sink.
      request: { action: { type: "order" }, signature: { r: "0xrr", s: "0xss", v: 27 } },
      response: { status: 429, body: { secret: "leak" } },
    });

    createLogger("hl").error("submit.failed", { error: sdkError });

    const captured = JSON.stringify(sink.events[0].error);
    expect(captured).not.toContain("0xrr");
    expect(captured).not.toContain("signature");
    expect(captured).not.toContain("leak");
    expect(captured).not.toContain("action");
  });

  it("keeps the diagnostic fields that make an error useful", () => {
    const sink = collectingSink();
    removeSink = addLogSink(sink);
    createLogger("hl").error("x", {
      error: Object.assign(new Error("boom"), {
        name: "HttpRequestError",
        response: { status: 503 },
      }),
    });
    expect(sink.events[0].error).toMatchObject({
      name: "HttpRequestError",
      message: "boom",
      status: 503,
    });
  });

  it("scrubs addresses out of the error MESSAGE — the likeliest thing a sink ever sees", () => {
    // The message was copied verbatim, never through `redact`, and the exchange
    // writes addresses into its own prose. This is the error path, which is
    // exactly the path a crash reporter uploads.
    const sink = collectingSink();
    const off = addLogSink(sink);
    createLogger("t").warn("failed", {
      error: new Error("User 0xabcdef0123456789abcdef0123456789abcdef01 does not exist"),
    });
    off();
    const message = String((sink.events[0]?.error as { message?: unknown } | undefined)?.message);
    expect(message).toBe("User 0xabcd…ef01 does not exist");
  });

  it("follows the cause chain without copying its payload", () => {
    const sink = collectingSink();
    removeSink = addLogSink(sink);
    const inner = Object.assign(new Error("inner"), {
      name: "ValidationError",
      signature: "0xdead",
    });
    createLogger("hl").error("x", { error: new Error("outer", { cause: inner }) });
    const captured = sink.events[0].error as Record<string, unknown>;
    expect((captured.cause as Record<string, unknown>).name).toBe("ValidationError");
    expect(JSON.stringify(captured)).not.toContain("0xdead");
  });

  it("scrubs a NON-OBJECT throw too — the one branch that still copied verbatim", () => {
    // `serializeError` returns early for a thrown string, and that early return
    // was the last place text reached a sink unscrubbed after the rest of the
    // module learned to truncate.
    const sink = collectingSink();
    const off = addLogSink(sink);
    createLogger("t").warn("failed", {
      error: "rejected for 0xabcdef0123456789abcdef0123456789abcdef01",
    });
    off();
    const message = String((sink.events[0]?.error as { message?: unknown } | undefined)?.message);
    expect(message).toBe("rejected for 0xabcd…ef01");
  });

  it("handles non-Error throws and cycles without breaking logging", () => {
    const sink = collectingSink();
    removeSink = addLogSink(sink);
    createLogger("hl").error("a", { error: "just a string" });
    const cyclic: Record<string, unknown> = { name: "Cyclic" };
    cyclic.cause = cyclic;
    expect(() => createLogger("hl").error("b", { error: cyclic })).not.toThrow();
    expect(sink.events[0].error).toEqual({ message: "just a string" });
  });
});

describe("redaction covers the words this codebase actually uses", () => {
  it.each(["phrase", "recoveryPhrase", "passphrase", "recovery"])(
    "redacts a key named %p",
    (key) => {
      // The module promised "a call site that forgets is the normal case; this
      // makes forgetting harmless". It covered `mnemonic` and `seed` but not
      // `phrase` — while the module's own API says `revealRecoveryPhrase` and
      // `importMnemonic(phrase)`, so `phrase` is the likelier accidental key.
      const out = JSON.stringify(redact({ [key]: "abandon abandon about" }));
      expect(out).not.toContain("abandon");
    }
  );

  it("still does not redact ordinary keys ending in Key", () => {
    // Redacting `key` wholesale would blank identityKey, storageKey and
    // cacheKey, destroying the diagnostics the logger exists for.
    const out = JSON.stringify(redact({ identityKey: "testnet|acc|0xabc" }));
    expect(out).toContain("testnet|acc|0xabc");
  });
});

describe("a real viem failure reaching a sink", () => {
  let removeSink: (() => void) | null = null;
  afterEach(() => {
    removeSink?.();
    removeSink = null;
  });

  /** Everything a sink would actually receive for one logged error. */
  function captureError(error: unknown): string {
    const sink = collectingSink();
    removeSink = addLogSink(sink);
    createLogger("hl.deposits").warn("deposit.unknown", { error });
    return JSON.stringify(sink.events);
  }

  it("carries no address and no calldata out of a viem deposit failure", () => {
    // The deposit path hands `toHlError` viem's raw error, and viem writes the
    // request INTO the message rather than only onto properties. This is the
    // shape a failed ERC-20 transfer to the bridge actually produces.
    const message = [
      'The contract function "transfer" reverted.',
      "Contract Call:",
      "  address:   0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      "  args:              (0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7, 6000000)",
      "  sender:    0x5bf8287baeda8de01c88b3016d64f3875b0b4347",
      "Request Arguments:",
      "  data:  0xa9059cbb0000000000000000000000002df1c51e09aecf9cacb7bc98cb1742757f163df700000000000000000000000000000000000000000000000000000000005b8d80",
    ].join("\n");
    const viemError = Object.assign(new Error(message), {
      name: "ContractFunctionExecutionError",
    });

    const text = captureError(viemError);

    // No 40-hex address survives — not the token, not the bridge, not the user.
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/);
    // Nor the calldata, which is where the destination and amount are encoded.
    expect(text).not.toContain("0xa9059cbb");
    // And it still says enough to debug with.
    expect(text).toContain("reverted");
  });

  it("scrubs the message on a WRAPPED cause, which is how the SDK throws", () => {
    const inner = new Error("sender: 0x5bf8287baeda8de01c88b3016d64f3875b0b4347");
    const text = captureError(new Error("request failed", { cause: inner }));
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/);
  });

  it("keeps a transaction hash, which is the handle that resolves an unknown", () => {
    // The line redaction must not cross: a tx hash is exactly 64 hex and is the
    // one value that makes a lost deposit findable.
    const hash = `0x${"a".repeat(64)}`;
    expect(captureError(new Error(`deposit sent: ${hash}`))).toContain(hash);
  });
});
