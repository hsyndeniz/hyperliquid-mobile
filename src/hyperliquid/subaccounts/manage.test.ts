import {
  SUB_ACCOUNT_ADMIN_EXPIRY_MS,
  canonicalSubAccountName,
  classifySubAccountFailure,
  createSubAccount,
  isDuplicateSubAccountName,
  readCreatedAddress,
  renameSubAccount,
  type SubAccountAdminClient,
} from "@/hyperliquid/subaccounts/manage";
import { parseSubAccounts } from "@/hyperliquid/subaccounts/list";
import { SUB_ACCOUNT_NAME_MAX, type SubAccountName } from "@/hyperliquid/subaccounts/types";
import { HlError } from "@/hyperliquid/core/errors";

const SUB = "0x2222222222222222222222222222222222222222";
const NEW_SUB = "0x3333333333333333333333333333333333333333";
const NOW = 1_700_000_000_000;

/** The exact string testnet returned for a zero-volume account. */
const VOLUME_REFUSAL =
  "Cannot create sub-accounts until enough volume traded. Required: $100000. Traded: $0.";

function name(value: string): SubAccountName {
  return value as SubAccountName;
}

function apiError(message: string): Error {
  const error = new Error(message);
  error.name = "ApiRequestError";
  return error;
}

function okCreate(address: string): unknown {
  return { status: "ok", response: { type: "createSubAccount", data: address } };
}

function stubClient(overrides: Partial<SubAccountAdminClient> = {}): SubAccountAdminClient {
  return {
    createSubAccount: async () => okCreate(NEW_SUB),
    subAccountModify: async () => ({ status: "ok", response: { type: "default" } }),
    ...overrides,
  };
}

describe("canonicalSubAccountName", () => {
  it("counts UTF-16 code units, not characters", () => {
    // Nine emoji is nine characters to a user and eighteen units to the wire.
    // Counting `[...name].length` here lets it through to a signature that then
    // fails with "Expected <=16 but received 18" — measured on live testnet.
    const nineEmoji = "🙂".repeat(9);
    expect([...nineEmoji]).toHaveLength(9);
    expect(() => canonicalSubAccountName(nineEmoji)).toThrow(/counts as 18/);
  });

  it("accepts a name that fits in code units", () => {
    expect(canonicalSubAccountName("🙂".repeat(8))).toBe("🙂".repeat(8));
    expect(canonicalSubAccountName("a".repeat(SUB_ACCOUNT_NAME_MAX))).toHaveLength(
      SUB_ACCOUNT_NAME_MAX
    );
  });

  it("trims, and counts what it will send", () => {
    // A trailing space is invisible; if trimming happened after the length check
    // a 17-with-space name would be rejected for a reason nobody can see.
    const padded = `  ${"a".repeat(16)}  `;
    expect(canonicalSubAccountName(padded)).toBe("a".repeat(16));
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(() => canonicalSubAccountName("")).toThrow(HlError);
    expect(() => canonicalSubAccountName("   ")).toThrow(/cannot be empty/);
  });

  it("rejects control characters", () => {
    expect(() => canonicalSubAccountName("main\nalt")).toThrow(/control characters/);
    expect(() => canonicalSubAccountName("main\u0000")).toThrow(/control characters/);
  });

  it("does NOT Unicode-normalise", () => {
    // "é" decomposed is 2 code units, composed is 1. Normalising would mean
    // validating one string and signing another — and NFC can change the count
    // that was just checked.
    const decomposed = "e\u0301";
    expect(canonicalSubAccountName(decomposed)).toBe(decomposed);
    expect(canonicalSubAccountName(decomposed)).not.toBe("\u00e9");
    expect(canonicalSubAccountName(decomposed)).toHaveLength(2);
  });
});

describe("isDuplicateSubAccountName", () => {
  const owned = parseSubAccounts([
    {
      name: "Trading",
      subAccountUser: SUB,
      master: "0x1111111111111111111111111111111111111111",
      dexToClearinghouseState: [],
      spotState: { balances: [] },
    },
  ]);

  it("matches ignoring case and surrounding space", () => {
    expect(isDuplicateSubAccountName(owned, " trading ")).toBe(true);
    expect(isDuplicateSubAccountName(owned, "savings")).toBe(false);
  });

  it("excludes the account being renamed, so a no-op rename is not a clash", () => {
    expect(isDuplicateSubAccountName(owned, "Trading", SUB.toUpperCase())).toBe(false);
  });
});

describe("classifySubAccountFailure", () => {
  it("reads the figures out of the real testnet refusal", () => {
    expect(classifySubAccountFailure(VOLUME_REFUSAL)).toEqual({
      kind: "insufficient_volume",
      requiredUsd: "100000",
      tradedUsd: "0",
    });
  });

  it("still classifies when the figures are missing or reworded", () => {
    // The whole point of the type: a rename upstream degrades the numbers to
    // null, never the classification into a wrong branch.
    expect(classifySubAccountFailure("not enough volume traded")).toEqual({
      kind: "insufficient_volume",
      requiredUsd: null,
      tradedUsd: null,
    });
  });

  it("tolerates thousands separators in the figures", () => {
    const reworded = "volume traded too low. Required: $100,000. Traded: $12,345.67.";
    expect(classifySubAccountFailure(reworded)).toEqual({
      kind: "insufficient_volume",
      requiredUsd: "100000",
      tradedUsd: "12345.67",
    });
  });

  it("falls back to `other` rather than guessing", () => {
    expect(classifySubAccountFailure("Something new happened")).toEqual({ kind: "other" });
  });
});

describe("readCreatedAddress", () => {
  it("extracts and lowercases the new address", () => {
    expect(readCreatedAddress(okCreate(NEW_SUB.toUpperCase().replace("0X", "0x")))).toBe(NEW_SUB);
  });

  it("returns null for anything that is not an address", () => {
    expect(readCreatedAddress({ status: "ok", response: { type: "default" } })).toBeNull();
    expect(readCreatedAddress({ response: { data: "0xnope" } })).toBeNull();
    expect(readCreatedAddress(null)).toBeNull();
  });
});

describe("createSubAccount", () => {
  it("returns the new address and bounds the signature with expiresAfter", async () => {
    const calls: { params: unknown; opts: unknown }[] = [];
    const outcome = await createSubAccount({
      client: stubClient({
        createSubAccount: async (params, opts) => {
          calls.push({ params, opts });
          return okCreate(NEW_SUB);
        },
      }),
      name: name("savings"),
      now: () => NOW,
    });

    expect(outcome).toEqual({
      kind: "settled",
      value: { address: NEW_SUB, name: "savings" },
    });
    expect(calls[0].params).toEqual({ name: "savings" });
    // Without this a request stalled in the network can land minutes later,
    // after the user gave up and pressed the button again — and the allowance
    // starts at ten.
    expect(calls[0].opts).toEqual({ expiresAfter: NOW + SUB_ACCOUNT_ADMIN_EXPIRY_MS });
  });

  it("still settles when the address cannot be parsed", async () => {
    // The sub-account exists. Reporting "not created" because a field moved is
    // how a user creates the same account twice.
    const outcome = await createSubAccount({
      client: stubClient({
        createSubAccount: async () => ({ status: "ok", response: { type: "default" } }),
      }),
      name: name("savings"),
      now: () => NOW,
    });

    expect(outcome).toEqual({ kind: "settled", value: { address: null, name: "savings" } });
  });

  it("classifies the volume refusal instead of leaking ApiRequestError", async () => {
    const outcome = await createSubAccount({
      client: stubClient({
        createSubAccount: async () => {
          throw apiError(VOLUME_REFUSAL);
        },
      }),
      name: name("savings"),
      now: () => NOW,
    });

    expect(outcome).toEqual({
      kind: "rejected_by_server",
      reason: VOLUME_REFUSAL,
      failure: { kind: "insufficient_volume", requiredUsd: "100000", tradedUsd: "0" },
    });
  });

  it("reports a transport failure as unknown, never as rejected", async () => {
    // The signed action may still land. A caller that treats this as "nothing
    // happened" and retries can spend a second slot.
    const error = new Error("socket hang up");
    error.name = "HttpRequestError";
    const outcome = await createSubAccount({
      client: stubClient({
        createSubAccount: async () => {
          throw error;
        },
      }),
      name: name("savings"),
      now: () => NOW,
    });

    expect(outcome.kind).toBe("unknown");
    if (outcome.kind === "unknown") expect(outcome.nonce).toBe(NOW);
  });
});

describe("renameSubAccount", () => {
  it("sends the address and the new name, with an expiry", async () => {
    const calls: { params: unknown; opts: unknown }[] = [];
    const outcome = await renameSubAccount({
      client: stubClient({
        subAccountModify: async (params, opts) => {
          calls.push({ params, opts });
          return { status: "ok", response: { type: "default" } };
        },
      }),
      subAccount: SUB,
      name: name("renamed"),
      now: () => NOW,
    });

    expect(outcome).toEqual({ kind: "settled", value: null });
    expect(calls[0].params).toEqual({ subAccountUser: SUB, name: "renamed" });
    expect(calls[0].opts).toEqual({ expiresAfter: NOW + SUB_ACCOUNT_ADMIN_EXPIRY_MS });
  });

  it("surfaces a server refusal with its reason", async () => {
    const outcome = await renameSubAccount({
      client: stubClient({
        subAccountModify: async () => {
          throw apiError("Sub-account does not belong to user");
        },
      }),
      subAccount: SUB,
      name: name("renamed"),
      now: () => NOW,
    });

    expect(outcome).toEqual({
      kind: "rejected_by_server",
      reason: "Sub-account does not belong to user",
      failure: { kind: "other" },
    });
  });
});
