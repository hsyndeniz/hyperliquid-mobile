import {
  HlError,
  PrecisionError,
  UnknownAssetError,
  classifySdkError,
  hasErrorCode,
  isHlError,
  readSignedActionRefusal,
  toHlError,
} from "@/hyperliquid/core/errors";

/** Mimics an SDK error: the SDK sets `name`, and HTTP status hides on `response`. */
function sdkError(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${name} occurred`), { name }, extra);
}

describe("HlError", () => {
  it("defaults to the unknown code", () => {
    expect(new HlError("boom").code).toBe("unknown");
  });

  it("preserves cause for diagnosis", () => {
    const cause = new Error("root");
    expect(new HlError("wrapper", { cause }).cause).toBe(cause);
  });
});

describe("UnknownAssetError", () => {
  it("names the symbol and carries it in context", () => {
    const error = new UnknownAssetError("BTCC");
    expect(error.code).toBe("unknown_asset");
    expect(error.message).toContain("BTCC");
    expect(error.context).toMatchObject({ symbol: "BTCC" });
  });
});

describe("PrecisionError", () => {
  it("uses the precision code", () => {
    expect(new PrecisionError("bad price").code).toBe("invalid_precision");
  });
});

describe("classifySdkError", () => {
  it("passes through a code we already assigned", () => {
    expect(classifySdkError(new UnknownAssetError("X"))).toBe("unknown_asset");
  });

  it("detects a 429 from the nested response, which is where the SDK hides it", () => {
    // The SDK neither retries nor reads Retry-After, so this is the only signal.
    expect(classifySdkError(sdkError("HttpRequestError", { response: { status: 429 } }))).toBe(
      "server_rate_limited"
    );
  });

  it("treats other non-2xx HTTP failures as transport errors", () => {
    expect(classifySdkError(sdkError("HttpRequestError", { response: { status: 503 } }))).toBe(
      "transport_error"
    );
  });

  it("classifies the SDK's error families", () => {
    expect(classifySdkError(sdkError("ValidationError"))).toBe("validation_error");
    expect(classifySdkError(sdkError("ApiRequestError"))).toBe("api_error");
    expect(classifySdkError(sdkError("TransportError"))).toBe("transport_error");
    expect(classifySdkError(sdkError("WebSocketRequestError"))).toBe("transport_error");
  });

  it("falls back to unknown for anything unrecognised", () => {
    expect(classifySdkError(new Error("plain"))).toBe("unknown");
    expect(classifySdkError("a string")).toBe("unknown");
    expect(classifySdkError(null)).toBe("unknown");
    expect(classifySdkError(undefined)).toBe("unknown");
  });

  it("does not throw on a malformed response field", () => {
    expect(() => classifySdkError(sdkError("HttpRequestError", { response: null }))).not.toThrow();
    expect(classifySdkError(sdkError("HttpRequestError", { response: "nope" }))).toBe(
      "transport_error"
    );
  });
});

describe("toHlError", () => {
  it("returns an HlError unchanged rather than double-wrapping", () => {
    const original = new UnknownAssetError("X");
    expect(toHlError(original)).toBe(original);
  });

  it("wraps an SDK error with the right code and keeps the original as cause", () => {
    const original = sdkError("ApiRequestError");
    const wrapped = toHlError(original);
    expect(wrapped.code).toBe("api_error");
    expect(wrapped.cause).toBe(original);
    expect(isHlError(wrapped)).toBe(true);
  });

  it("wraps non-Error throws", () => {
    expect(toHlError("just a string").message).toBe("just a string");
  });

  it("attaches caller context", () => {
    expect(toHlError(new Error("x"), { coin: "BTC" }).context).toEqual({ coin: "BTC" });
  });
});

describe("hasErrorCode", () => {
  it("narrows by code, not by message text", () => {
    expect(hasErrorCode(new UnknownAssetError("X"), "unknown_asset")).toBe(true);
    expect(hasErrorCode(new UnknownAssetError("X"), "api_error")).toBe(false);
    expect(hasErrorCode(new Error("unknown_asset"), "unknown_asset")).toBe(false);
  });
});

describe("SDK errors that mean NOTHING WAS SENT", () => {
  // Enumerated from the SDK's own source: `grep 'this.name ='` over esm/ returns
  // exactly nine classes. These five are raised while the payload is still being
  // built, strictly before `transport.request` is called.
  it.each([
    "ValidationError",
    "FormatError",
    "CanonicalizeError",
    "AbstractWalletError",
    "HyperliquidError",
  ])("%s classifies as validation_error, not unknown", (name) => {
    // Four of these fell through to `unknown` until this was audited, and
    // `unknown` on a money path means "it may have landed; watch, never retry".
    // A wallet that failed to sign a withdrawal told the user their money might
    // be in flight for fifteen minutes.
    expect(classifySdkError(sdkError(name))).toBe("validation_error");
  });

  it.each(["HttpRequestError", "WebSocketRequestError", "TransportError"])(
    "%s stays transport_error — it may well have been sent",
    (name) => {
      expect(classifySdkError(sdkError(name))).toBe("transport_error");
    }
  );

  it("keeps a server refusal distinct from both", () => {
    expect(classifySdkError(sdkError("ApiRequestError"))).toBe("api_error");
  });
});

describe("the 429 dig-out", () => {
  it("finds a rate limit on the HTTP error's Response", () => {
    // `HttpRequestError.response` is a real HTTP Response, so `.status` is a number.
    const error = Object.assign(new Error("429 Too Many Requests"), {
      name: "HttpRequestError",
      response: { status: 429 },
    });
    expect(classifySdkError(error)).toBe("server_rate_limited");
  });

  it("does NOT read an ApiRequestError's body as an HTTP status", () => {
    // `ApiRequestError.response` is the raw JSON body, whose `status` is the
    // STRING "err". Without the typeof guard every API refusal would read as a
    // rate limit and be retried on a backoff that does not apply.
    const error = Object.assign(new Error("Insufficient balance"), {
      name: "ApiRequestError",
      response: { status: "err", response: "Insufficient balance" },
    });
    expect(classifySdkError(error)).toBe("api_error");
  });

  it("survives a transport error with no response at all", () => {
    // A timeout throws HttpRequestError with `response: undefined`.
    const error = Object.assign(new Error("Request timed out after 10000 ms"), {
      name: "HttpRequestError",
    });
    expect(classifySdkError(error)).toBe("transport_error");
  });
});

describe("offline is not the same as unknown", () => {
  /**
   * On a money path `unknown` means "it may have landed; watch, never retry".
   * A device with no connectivity provably sent nothing — reporting that as
   * unknown is the worst available answer to the commonest failure there is,
   * and it blocks the one action that would work: trying again.
   */
  it("classifies React Native's offline fetch failure", () => {
    const error = new TypeError("Network request failed");
    expect(classifySdkError(error)).toBe("offline");
  });

  it("classifies the web/undici spellings too", () => {
    expect(classifySdkError(new TypeError("Failed to fetch"))).toBe("offline");
    expect(classifySdkError(new Error("Network Error"))).toBe("offline");
  });

  it("does NOT classify a timeout as offline", () => {
    // An aborted request may have reached the exchange and had its reply lost.
    // That is genuinely unknown and must stay unknown.
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(classifySdkError(abort)).not.toBe("offline");
  });

  it("classifies the SDK-WRAPPED offline failure — the only shape production ever sees", () => {
    // The bare `TypeError` above never reaches this function. `HttpTransport`'s
    // catch-all wraps every throw: `new HttpRequestError({ cause, request })`.
    // Reading only the top-level `name` matched a shape that does not occur, so
    // the whole `offline` classification was dead code and an airplane-mode
    // money action was reported as `unknown` — "may have landed, never retry".
    const wrapped = Object.assign(new Error("HTTP request failed"), {
      name: "HttpRequestError",
      cause: new TypeError("Network request failed"),
    });
    expect(classifySdkError(wrapped)).toBe("offline");
  });

  it("does NOT call a wrapped TIMEOUT offline — that one really is unknown", () => {
    // The distinction the whole classification exists for: an aborted request
    // may have reached the exchange and had its reply lost.
    const wrapped = Object.assign(new Error("Request timed out after 15000 ms"), {
      name: "HttpRequestError",
      cause: Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    });
    expect(classifySdkError(wrapped)).not.toBe("offline");
  });

  it("survives a cyclic or deeply nested cause without hanging", () => {
    const inner: { name: string; message: string; cause?: unknown } = {
      name: "Error",
      message: "boom",
    };
    inner.cause = inner;
    expect(() => classifySdkError(inner)).not.toThrow();
    expect(classifySdkError(inner)).not.toBe("offline");
  });

  it("does NOT swallow a real programming TypeError", () => {
    // Matching `TypeError` by name alone would hide genuine bugs behind a
    // friendly "you're offline" message.
    expect(classifySdkError(new TypeError("x is not a function"))).not.toBe("offline");
  });
});

describe("readSignedActionRefusal", () => {
  it("names the refusal that means the device clock is behind", () => {
    // Verbatim from a production gateway log — this exact shape is what the
    // exchange returns, and it appears in no documentation.
    const error = new Error("Invalid nonce: nonce too low 1776584283874 < 1776584799101");
    expect(readSignedActionRefusal(error)).toBe("clock_behind");
  });

  it("names an expired action", () => {
    expect(readSignedActionRefusal(new Error("Action already expired"))).toBe("action_expired");
  });

  it("does NOT call a duplicate nonce a clock problem", () => {
    // Same-millisecond concurrency. It self-resolves in seconds, and pointing
    // the user at their clock for it would send them to fix the wrong thing.
    expect(readSignedActionRefusal(new Error("Invalid nonce: duplicate nonce 1754922717871"))).toBe(
      "duplicate_nonce"
    );
  });

  it("reads the refusal off a wrapped cause", () => {
    // The SDK wraps every throw, so the string is rarely on the outer error —
    // the same reason `looksOffline` walks the chain.
    const inner = new Error("Invalid nonce: nonce too low 1 < 2");
    const outer = new Error("request failed", { cause: inner });
    expect(readSignedActionRefusal(outer)).toBe("clock_behind");
  });

  it("reads it off a raw `response` string, which is where it actually arrives", () => {
    // An action-level refusal comes back as HTTP 200 with
    // `{"status":"err","response":"<string>"}` — not as a per-leg status.
    expect(readSignedActionRefusal({ response: "Invalid nonce: nonce too low 1 < 2" })).toBe(
      "clock_behind"
    );
  });

  it("is null for an ordinary failure", () => {
    expect(readSignedActionRefusal(new Error("Insufficient margin"))).toBeNull();
    expect(readSignedActionRefusal(null)).toBeNull();
    expect(readSignedActionRefusal(undefined)).toBeNull();
  });
});
