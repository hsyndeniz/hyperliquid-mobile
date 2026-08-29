import {
  assertMasterSigner,
  assertNotSubAccount,
  classTransfer,
  moveWithinAccount,
  sendAssetToAccount,
  sendSpotToAccount,
  sendUsdToAccount,
  type TransferClient,
} from "@/hyperliquid/transfers/transfer";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import { requireDestination } from "@/hyperliquid/transfers/destination";
import { createIdentity } from "@/hyperliquid/core/identity";
import { HlError } from "@/hyperliquid/core/errors";
import type { WireToken } from "@/hyperliquid/transfers/types";
import type { Hex } from "@/hyperliquid/types/domain";

/** Real testnet accounts, in their correct EIP-55 form. */
const OWNER = "0x5Bf8287BAeDA8De01C88b3016D64f3875B0B4347" as Hex;
const THIRD_PARTY = "0xCC8A21B439951529281859f6aD39F279606304A7";
const SUB = "0xCC8A21B439951529281859f6aD39F279606304A7".toLowerCase() as Hex;
const AGENT = "0x82b05Bf249252fE7a1D87e9E72269507cF81DAc3" as Hex;
const TOKEN = "USDC:0xeb62eee3685fc4c43992febcd9e75443" as WireToken;
const NOW = 1_800_000_000_000;

const owner = requireDestination(OWNER).wire;

type Call = { method: string; params: Record<string, unknown> };

function recorder(): { client: TransferClient; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    async (params: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, params });
      return { status: "ok" };
    };
  return {
    calls,
    client: {
      usdSend: record("usdSend"),
      spotSend: record("spotSend"),
      sendAsset: record("sendAsset"),
      agentSendAsset: record("agentSendAsset"),
      usdClassTransfer: record("usdClassTransfer"),
    } as TransferClient,
  };
}

describe("assertMasterSigner", () => {
  it("refuses when the signer is not the owner", async () => {
    // `withdraw3` and the user-signed sends carry no `user` field: the account
    // debited is whoever the signature recovers to. Signed by the agent, they
    // act on the agent's own address.
    await expect(
      assertMasterSigner({ walletAddress: AGENT, expectedOwner: OWNER })
    ).rejects.toThrow(/account owner/);
  });

  it("refuses a signer the exchange reports as something other than a user", async () => {
    await expect(
      assertMasterSigner({
        walletAddress: OWNER,
        expectedOwner: OWNER,
        probe: { userRole: async () => ({ role: "subAccount" }) },
      })
    ).rejects.toThrow(/role "subAccount"/);
  });

  it("accepts a plain owner, and an account that does not exist yet", async () => {
    await expect(
      assertMasterSigner({
        walletAddress: OWNER.toLowerCase() as Hex,
        expectedOwner: OWNER,
        probe: { userRole: async () => ({ role: "user" }) },
      })
    ).resolves.toBeUndefined();
    await expect(
      assertMasterSigner({
        walletAddress: OWNER,
        expectedOwner: OWNER,
        probe: { userRole: async () => ({ role: "missing" }) },
      })
    ).resolves.toBeUndefined();
  });
});

describe("assertNotSubAccount", () => {
  it("refuses while a sub-account is selected", () => {
    // A sub-account has no key, and `WithdrawAction3` has no field to name one.
    // The master signs, so the MASTER's balance leaves while the screen shows
    // the sub-account's.
    const identity = createIdentity({
      env: "testnet",
      accountId: "acc",
      address: OWNER,
      subAccount: SUB,
    });
    expect(() => assertNotSubAccount(identity)).toThrow(HlError);
    expect(() => assertNotSubAccount(identity)).toThrow(/main account/);
  });

  it("allows the master", () => {
    const identity = createIdentity({ env: "testnet", accountId: "acc", address: OWNER });
    expect(() => assertNotSubAccount(identity)).not.toThrow();
  });
});

describe("moveWithinAccount", () => {
  const base = {
    signer: "agent" as const,
    owner,
    token: TOKEN,
    amount: canonicalAmount("25"),
    now: () => NOW,
  };

  it("stamps the expiry its own docstring calls its advantage", async () => {
    // "it is the only member of the family that accepts `expiresAfter`" — and
    // it never sent one, because the structural client type had no options
    // parameter to put it in. It is the half of the `unknown` remedy this
    // family CAN have: there is no cloid to probe by, but a bounded action is
    // safe to give up on once the window has closed.
    let opts: unknown;
    await moveWithinAccount({
      ...base,
      client: {
        agentSendAsset: async (_p: unknown, o: unknown) => {
          opts = o;
          return {};
        },
      } as never,
      from: { kind: "spot" },
      to: { kind: "perp", dex: null },
    });
    expect(opts).toMatchObject({ expiresAfter: NOW + 30_000 });
  });

  it("sends itself the funds when no sub-account is involved", async () => {
    const { client, calls } = recorder();
    const outcome = await moveWithinAccount({
      ...base,
      client,
      from: { kind: "spot" },
      to: { kind: "perp", dex: null },
    });

    expect(outcome).toEqual({ kind: "settled", nonce: NOW });
    expect(calls[0]).toEqual({
      method: "agentSendAsset",
      params: {
        destination: owner,
        sourceDex: "spot",
        destinationDex: "",
        token: TOKEN,
        amount: "25",
      },
    });
  });

  it("moves the DESTINATION to the sub-account when the source is one", async () => {
    // The whole point. Leaving `destination` on the master would turn an
    // internal move into a withdrawal out of the sub-account — same call, same
    // success response, funds in the wrong account.
    const { client, calls } = recorder();
    await moveWithinAccount({
      ...base,
      client,
      fromSubAccount: SUB,
      from: { kind: "perp", dex: null },
      to: { kind: "perp", dex: "xyz" },
    });

    expect(calls[0].params).toEqual({
      destination: SUB,
      fromSubAccount: SUB,
      sourceDex: "",
      destinationDex: "xyz",
      token: TOKEN,
      amount: "25",
    });
  });

  it("omits fromSubAccount entirely rather than sending an empty string", async () => {
    const { client, calls } = recorder();
    await moveWithinAccount({
      ...base,
      client,
      from: { kind: "spot" },
      to: { kind: "perp", dex: null },
    });
    expect("fromSubAccount" in calls[0].params).toBe(false);
  });

  it("refuses a move whose source and destination bucket are the same", async () => {
    const { client, calls } = recorder();
    const outcome = await moveWithinAccount({
      ...base,
      client,
      from: { kind: "perp", dex: null },
      to: { kind: "perp", dex: null },
    });

    expect(outcome.kind).toBe("rejected_locally");
    expect(calls).toHaveLength(0);
  });
});

describe("sendAssetToAccount", () => {
  it("debits the sub-account without redirecting the destination", async () => {
    // Unlike the in-account move: sending a sub-account's funds to a third party
    // is a legitimate thing to want, and the caller already said where.
    const { client, calls } = recorder();
    await sendAssetToAccount({
      signer: "master",
      client,
      destination: requireDestination(THIRD_PARTY).wire,
      fromSubAccount: SUB,
      from: { kind: "perp", dex: null },
      to: { kind: "spot" },
      token: TOKEN,
      amount: canonicalAmount("5"),
      now: () => NOW,
    });

    expect(calls[0].params).toMatchObject({
      destination: THIRD_PARTY.toLowerCase(),
      fromSubAccount: SUB,
      sourceDex: "",
      destinationDex: "spot",
    });
  });
});

describe("the outward sends", () => {
  it("pass the gross amount and lowercase destination through untouched", async () => {
    const { client, calls } = recorder();
    const destination = requireDestination(THIRD_PARTY).wire;

    await sendUsdToAccount({
      signer: "master",
      client,
      destination,
      amount: canonicalAmount("1.5"),
      now: () => NOW,
    });
    await sendSpotToAccount({
      signer: "master",
      client,
      destination,
      token: TOKEN,
      amount: canonicalAmount("1.5"),
      now: () => NOW,
    });

    expect(calls.map((c) => c.method)).toEqual(["usdSend", "spotSend"]);
    expect(calls[0].params).toEqual({ destination, amount: "1.5" });
    expect(calls[1].params).toEqual({ destination, token: TOKEN, amount: "1.5" });
  });

  it("sends toPerp as a real boolean", async () => {
    // The schema rejects "true" and 1, after the signature exists.
    const { client, calls } = recorder();
    await classTransfer({
      signer: "master",
      client,
      amount: canonicalAmount("2"),
      toPerp: true,
      now: () => NOW,
    });
    expect(calls[0].params).toEqual({ amount: "2", toPerp: true });
  });
});

describe("outcomes", () => {
  it("reports a server refusal as rejected", async () => {
    const error = new Error("Insufficient balance");
    error.name = "ApiRequestError";
    const outcome = await sendUsdToAccount({
      signer: "master",
      client: {
        ...recorder().client,
        usdSend: async () => {
          throw error;
        },
      },
      destination: requireDestination(THIRD_PARTY).wire,
      amount: canonicalAmount("1"),
      now: () => NOW,
    });

    expect(outcome).toEqual({ kind: "rejected_by_server", reason: "Insufficient balance" });
  });

  it("reports anything else as unknown, with a window and no retry advice", async () => {
    const error = new Error("socket hang up");
    error.name = "HttpRequestError";
    const outcome = await sendUsdToAccount({
      signer: "master",
      client: {
        ...recorder().client,
        usdSend: async () => {
          throw error;
        },
      },
      destination: requireDestination(THIRD_PARTY).wire,
      amount: canonicalAmount("1"),
      now: () => NOW,
    });

    expect(outcome.kind).toBe("unknown");
    if (outcome.kind === "unknown") {
      expect(outcome.window).toEqual({ fromMs: NOW, toMs: NOW + 900_000 });
      expect(outcome).not.toHaveProperty("retryable");
    }
  });
});

/** A wallet that cannot sign. The SDK raises this BEFORE `transport.request`. */
const signingFailure = () =>
  Promise.reject(
    Object.assign(new Error("Failed to sign the typed data using the wallet"), {
      name: "AbstractWalletError",
    })
  );

/** A lost response. This one may well have landed. */
const timedOut = () =>
  Promise.reject(
    Object.assign(new Error("Request timed out after 10000 ms"), { name: "HttpRequestError" })
  );

describe("a failure that never reached the exchange", () => {
  function failing(impl: () => Promise<unknown>): TransferClient {
    return {
      usdSend: impl,
      spotSend: impl,
      sendAsset: impl,
      agentSendAsset: impl,
      usdClassTransfer: impl,
    } as unknown as TransferClient;
  }

  it("is rejected_locally, not unknown", async () => {
    const outcome = await sendUsdToAccount({
      client: failing(signingFailure),
      signer: "master",
      destination: requireDestination(THIRD_PARTY).wire,
      amount: canonicalAmount("1"),
      now: () => NOW,
    });
    expect(outcome.kind).toBe("rejected_locally");
  });

  it("still reports a lost response as unknown", async () => {
    const outcome = await sendUsdToAccount({
      client: failing(timedOut),
      signer: "master",
      destination: requireDestination(THIRD_PARTY).wire,
      amount: canonicalAmount("1"),
      now: () => NOW,
    });
    expect(outcome.kind).toBe("unknown");
  });

  it("reports an OFFLINE-shaped failure as unknown — the message cannot prove nothing was sent", async () => {
    // This asserted `rejected_locally` until 2026-08-29, and nothing tested it
    // either way — deleting the branch left every suite green.
    //
    // The classifier's whole basis is a substring match on RN's
    // `TypeError: Network request failed`, which `xhr.onerror` raises just as
    // readily for a request that was transmitted in full and then lost its
    // connection as for one that never opened. On a send there is no
    // idempotency key, so a definite "not sent" that happens to be wrong costs
    // the user the amount twice. The production shape is the SDK's wrapper
    // around RN's bare TypeError, which is why the cause chain matters.
    const offline = () =>
      Promise.reject(
        Object.assign(new Error("Request failed"), {
          name: "HttpRequestError",
          cause: new TypeError("Network request failed"),
        })
      );

    const outcome = await sendUsdToAccount({
      client: failing(offline),
      signer: "master",
      destination: requireDestination(THIRD_PARTY).wire,
      amount: canonicalAmount("1"),
      now: () => NOW,
    });

    expect(outcome.kind).toBe("unknown");
    if (outcome.kind !== "unknown") throw new Error("unreachable");
    // The window is what lets the ledger reconciler settle it later.
    expect(outcome.nonce).toBe(NOW);
  });
});
