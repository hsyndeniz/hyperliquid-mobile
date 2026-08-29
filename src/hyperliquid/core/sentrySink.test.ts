import { createSentrySink, type SentryApi } from "@/hyperliquid/core/sentrySink";
import { addLogSink, log, setLogLevel } from "@/hyperliquid/core/logger";

function recorder() {
  const breadcrumbs: Record<string, unknown>[] = [];
  const messages: { message: string; context?: Record<string, unknown> }[] = [];
  const sentry: SentryApi = {
    addBreadcrumb: (b) => breadcrumbs.push(b as Record<string, unknown>),
    captureMessage: (message, context) => messages.push({ message, context }),
  };
  return { sentry, breadcrumbs, messages };
}

describe("what becomes an issue", () => {
  it("captures only errors, and breadcrumbs everything else", () => {
    // Capturing every info as an issue buries the ones that matter and burns
    // the quota on a websocket that reconnected.
    const { sentry, breadcrumbs, messages } = recorder();
    const sink = createSentrySink(sentry);

    sink.capture({ scope: "orders", event: "submit.settled", level: "info" });
    sink.capture({ scope: "orders", event: "submit.partial", level: "warn" });
    sink.capture({ scope: "orders", event: "submit.unknown", level: "error" });

    expect(breadcrumbs).toHaveLength(2);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toBe("[orders] submit.unknown");
  });

  it("titles an issue by scope and event, so Sentry groups on those", () => {
    // Same reason `core/errors.ts` fingerprints on `code` and never on message
    // text: the words change, the identity should not.
    const { sentry, messages } = recorder();
    createSentrySink(sentry).capture({
      scope: "deposits.send",
      event: "deposit.unknown",
      level: "error",
      error: { name: "HttpRequestError", message: "timed out" },
    });
    expect(messages[0].message).toBe("[deposits.send] deposit.unknown");
    expect(messages[0].context?.extra).toMatchObject({
      error: { name: "HttpRequestError", message: "timed out" },
    });
  });

  it("maps warn to Sentry's 'warning', which is a different word", () => {
    const { sentry, breadcrumbs } = recorder();
    createSentrySink(sentry).capture({ scope: "s", event: "e", level: "warn" });
    expect(breadcrumbs[0].level).toBe("warning");
  });

  it("omits an empty data bag rather than attaching {}", () => {
    const { sentry, breadcrumbs } = recorder();
    const sink = createSentrySink(sentry);
    sink.capture({ scope: "s", event: "bare", level: "info" });
    sink.capture({ scope: "s", event: "timed", level: "info", durationMs: 12 });
    expect(breadcrumbs[0]).not.toHaveProperty("data");
    expect(breadcrumbs[1].data).toEqual({ durationMs: 12 });
  });
});

describe("secrets never reach the sink", () => {
  it("receives an ALREADY-REDACTED context when driven through the real logger", () => {
    // The guarantee lives in `logger.emit`, which redacts before any sink is
    // called — so this asserts the boundary end to end rather than trusting the
    // sink to be careful. If redaction ever moved after the sink, this fails.
    const { sentry, breadcrumbs } = recorder();
    setLogLevel("debug");
    const remove = addLogSink(createSentrySink(sentry));

    try {
      log.child("wallet").warn("import.failed", {
        context: {
          privateKey: "0xdeadbeef",
          mnemonic: "test test test",
          recoveryPhrase: "abandon abandon",
          address: "0x1111111111111111111111111111111111111111",
        },
      });
    } finally {
      remove();
    }

    const data = breadcrumbs.at(-1)?.data as Record<string, unknown>;
    expect(data.privateKey).toBe("[redacted]");
    expect(data.mnemonic).toBe("[redacted]");
    expect(data.recoveryPhrase).toBe("[redacted]");
    // A non-secret survives, or the sink would be useless.
    expect(String(data.address)).toContain("0x1111");
    expect(JSON.stringify(breadcrumbs)).not.toContain("deadbeef");
  });
});

describe("a broken Sentry never breaks the caller", () => {
  it("does not throw out of the logger when the SDK does", () => {
    // A sink that throws would take down whatever was being logged — including
    // an order submission.
    const remove = addLogSink(
      createSentrySink({
        addBreadcrumb: () => {
          throw new Error("sentry is down");
        },
        captureMessage: () => {
          throw new Error("sentry is down");
        },
      })
    );
    try {
      expect(() => log.child("x").info("still.fine")).not.toThrow();
      expect(() => log.child("x").error("also.fine")).not.toThrow();
    } finally {
      remove();
    }
  });
});
