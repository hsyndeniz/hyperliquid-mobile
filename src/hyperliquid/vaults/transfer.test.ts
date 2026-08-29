import {
  MIN_VAULT_DEPOSIT_USDC,
  assertAcceptsDeposits,
  depositToVault,
  withdrawFromVault,
  type VaultDeposit,
  type VaultTransferClient,
} from "@/hyperliquid/vaults/transfer";
import { lockupState } from "@/hyperliquid/vaults/lockup";
import { canonicalAmount, toMicroUsd } from "@/hyperliquid/transfers/amount";
import { HlError } from "@/hyperliquid/core/errors";
import type { MicroUsd } from "@/hyperliquid/transfers/types";
import type { VaultAddress } from "@/hyperliquid/vaults/types";

const VAULT = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303" as VaultAddress;
const NOW = 1_770_000_000_000;
const UNLOCKED = lockupState(NOW - 1, NOW);
const LOCKED = lockupState(NOW + 3_600_000, NOW);
const UNKNOWN = lockupState(undefined, NOW);

type Call = { vaultAddress: string; isDeposit: boolean; usd: number };

function recorder(impl?: () => Promise<unknown>): {
  client: VaultTransferClient;
  calls: Call[];
  optsSeen: unknown[];
} {
  const calls: Call[] = [];
  const optsSeen: unknown[] = [];
  return {
    calls,
    optsSeen,
    client: {
      vaultTransfer: async (params, opts) => {
        calls.push(params);
        optsSeen.push(opts);
        return impl ? impl() : { status: "ok" };
      },
    },
  };
}

function apiError(message: string): Error {
  const error = new Error(message);
  error.name = "ApiRequestError";
  return error;
}

describe("signing", () => {
  it("bounds the signed action with an expiry", async () => {
    // `vaultTransfer` is an L1 action and its request schema declares
    // `expiresAfter`; this never sent one, so a signed deposit stayed valid
    // indefinitely. It matters more here than most places: the `unknown`
    // outcome carries a 15-minute window that was a guess about server
    // behaviour rather than a bound anyone set, and a deposit landing late
    // re-locks the whole balance.
    const { client, optsSeen } = recorder();
    await depositToVault({
      signer: "agent",
      client,
      vault: VAULT,
      usd: 1 as MicroUsd,
      now: () => NOW,
    });
    expect(optsSeen[0]).toMatchObject({ expiresAfter: NOW + 30_000 });
  });

  it("is agent-signable, so a deposit costs no wallet prompt", () => {
    // Settled by experiment, not inferred: a real $5 deposit into testnet HLP
    // signed by the AGENT moved the MASTER's balance 11.0 -> 6.0 and put the
    // position on the master, while the agent stayed at zero. Read-only probing
    // could not settle it — vault refusals name no address, and both accounts
    // held zero, so they were indistinguishable.
    const deposit: VaultDeposit = {
      signer: "agent",
      client: recorder().client,
      vault: VAULT,
      usd: 1 as MicroUsd,
    };
    expect(deposit.signer).toBe("agent");
    // @ts-expect-error the master marker is no longer accepted here
    const wrong: VaultDeposit = { ...deposit, signer: "master" };
    void wrong;
  });
});

describe("direction", () => {
  it("deposit and withdraw are separate functions with no shared boolean", async () => {
    // The wire is one `vaultTransfer` with an `isDeposit` flag. A flipped boolean
    // either commits funds to a third party under a lockup, or pulls them out and
    // closes a position. This mapping is stated in exactly one place.
    const { client, calls } = recorder();
    const base = {
      signer: "agent" as const,
      client,
      vault: VAULT,
      usd: 1 as MicroUsd,
      now: () => NOW,
    };

    await depositToVault(base);
    await withdrawFromVault({ ...base, lockup: UNLOCKED });

    expect(calls.map((c) => c.isDeposit)).toEqual([true, false]);
    expect(calls.every((c) => c.vaultAddress === VAULT)).toBe(true);
  });
});

describe("units", () => {
  it("sends micro-USD integers, matching subAccountTransfer exactly", async () => {
    // 1058.68 is a real observed ledger amount, and `1058.68 * 1e6` is
    // 1058680000.0000001 in IEEE-754 — which the wire's SafeInteger check rejects.
    const { client, calls } = recorder();
    await depositToVault({
      signer: "agent",
      client,
      vault: VAULT,
      usd: toMicroUsd(canonicalAmount("1058.68")),
      now: () => NOW,
    });

    expect(calls[0].usd).toBe(1_058_680_000);
    expect(Number.isInteger(calls[0].usd)).toBe(true);
  });

  it("keeps the advisory deposit floor out of the gate", async () => {
    // $5 is measured — testnet refused $0.000001, $0.01, $1 and $4.99 alike with
    // "Vault deposits must be at least $5." It still warns rather than gates: the
    // number is Hyperliquid's to change, and a floor set too high blocks a deposit
    // the exchange would have taken, while one set too low just lets it refuse.
    expect(MIN_VAULT_DEPOSIT_USDC).toBe("5");

    const { client, calls } = recorder();
    const outcome = await depositToVault({
      signer: "agent",
      client,
      vault: VAULT,
      usd: toMicroUsd(canonicalAmount("1")),
      now: () => NOW,
    });

    expect(outcome.kind).toBe("settled");
    expect(calls).toHaveLength(1);
  });
});

describe("the lockup gate on withdrawal", () => {
  it("refuses locally while funds are locked, without reaching the wire", async () => {
    // `maxWithdrawable` reports full equity while the funds are locked, so every
    // other signal a caller might consult says "go".
    const { client, calls } = recorder();
    const outcome = await withdrawFromVault({
      signer: "agent",
      client,
      vault: VAULT,
      usd: 1 as MicroUsd,
      lockup: LOCKED,
      now: () => NOW,
    });

    expect(outcome.kind).toBe("rejected_locally");
    expect(calls).toHaveLength(0);
    if (outcome.kind === "rejected_locally") {
      expect(outcome.error.context).toMatchObject({ remainingMs: 3_600_000 });
    }
  });

  it("refuses an UNKNOWN lockup too — a missing timestamp is not permission", async () => {
    const { client, calls } = recorder();
    const outcome = await withdrawFromVault({
      signer: "agent",
      client,
      vault: VAULT,
      usd: 1 as MicroUsd,
      lockup: UNKNOWN,
      now: () => NOW,
    });

    expect(outcome.kind).toBe("rejected_locally");
    expect(calls).toHaveLength(0);
  });

  it("proceeds once the lockup has passed", async () => {
    const { client, calls } = recorder();
    const outcome = await withdrawFromVault({
      signer: "agent",
      client,
      vault: VAULT,
      usd: 1 as MicroUsd,
      lockup: UNLOCKED,
      now: () => NOW,
    });

    expect(outcome).toEqual({ kind: "settled", nonce: NOW });
    expect(calls).toHaveLength(1);
  });

  it("does not gate deposits on the lockup", async () => {
    // Depositing into a locked position is legitimate — and it restarts the clock
    // on the whole balance, which is a disclosure, not a refusal.
    const { calls, client } = recorder();
    await depositToVault({
      signer: "agent",
      client,
      vault: VAULT,
      usd: 1 as MicroUsd,
      now: () => NOW,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("outcomes", () => {
  it("reports a server refusal as rejected, with its reason", async () => {
    const { client } = recorder(async () => {
      throw apiError("Insufficient balance for vault transfer");
    });
    const outcome = await depositToVault({
      signer: "agent",
      client,
      vault: VAULT,
      usd: 1 as MicroUsd,
      now: () => NOW,
    });

    expect(outcome).toEqual({
      kind: "rejected_by_server",
      reason: "Insufficient balance for vault transfer",
    });
  });

  it("reports a transport failure as unknown, with a window and no retry advice", async () => {
    // A repeated deposit is not a retry — it is a second deposit, and it restarts
    // the lockup on the whole balance.
    const error = new Error("socket hang up");
    error.name = "HttpRequestError";
    const { client } = recorder(async () => {
      throw error;
    });

    const outcome = await depositToVault({
      signer: "agent",
      client,
      vault: VAULT,
      usd: 1 as MicroUsd,
      now: () => NOW,
    });

    expect(outcome.kind).toBe("unknown");
    if (outcome.kind === "unknown") {
      expect(outcome.window).toEqual({ fromMs: NOW, toMs: NOW + 900_000 });
      expect(outcome).not.toHaveProperty("retryable");
    }
  });
});

describe("assertAcceptsDeposits", () => {
  it("requires BOTH flags, because they are independent axes", () => {
    // `allowDeposits` stays true on the large majority of closed vaults, so
    // checking only the friendlier-sounding one passes a closed vault straight
    // through.
    expect(() => assertAcceptsDeposits({ isClosed: false, allowDeposits: true })).not.toThrow();
    expect(() => assertAcceptsDeposits({ isClosed: true, allowDeposits: true })).toThrow(/closed/);
    expect(() => assertAcceptsDeposits({ isClosed: false, allowDeposits: false })).toThrow(
      /not accepting/
    );
  });

  it("names which axis failed, so a UI can say why", () => {
    try {
      assertAcceptsDeposits({ isClosed: true, allowDeposits: true });
      throw new Error("unreachable");
    } catch (error) {
      expect((error as HlError).context).toMatchObject({ reason: "vault_closed" });
    }
  });
});

describe("types", () => {
  it("keeps MicroUsd and a decimal amount apart at compile time", () => {
    const micro: MicroUsd = toMicroUsd(canonicalAmount("1"));
    // @ts-expect-error a decimal-string amount is not micro-USD
    const wrong: MicroUsd = canonicalAmount("1");
    void wrong;
    expect(micro).toBe(1_000_000);
  });

  it("keeps a raw address out of the vault slot", () => {
    // `vaultDetails` answers null with HTTP 200 for a non-vault address, so an
    // unchecked one produces an empty page rather than an error — and a deposit
    // to it is irreversible.
    // @ts-expect-error a bare hex string is not a confirmed vault address
    const wrong: VaultAddress = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
    void wrong;
    expect(VAULT).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

describe("a failure that never reached the exchange", () => {
  /** A wallet that cannot sign. The SDK raises this BEFORE `transport.request`. */
  const signingFailure = () =>
    Promise.reject(
      Object.assign(new Error("Failed to sign the typed data using the wallet"), {
        name: "AbstractWalletError",
      })
    );

  it("is rejected_locally, not unknown", async () => {
    // Before this was audited, `AbstractWalletError` classified as `unknown`, so
    // a deposit that was never sent told the user it might be in flight and
    // forbade a retry — for fifteen minutes, on an action that does not exist.
    const { client } = recorder(signingFailure);
    const outcome = await depositToVault({
      signer: "agent",
      client,
      vault: VAULT,
      usd: toMicroUsd(canonicalAmount("10")),
      now: () => NOW,
    });
    expect(outcome.kind).toBe("rejected_locally");
  });

  it("still reports a transport failure as unknown", async () => {
    // The distinction is the whole point: this one may well have landed.
    const { client } = recorder(() =>
      Promise.reject(
        Object.assign(new Error("Request timed out after 10000 ms"), {
          name: "HttpRequestError",
        })
      )
    );
    const outcome = await depositToVault({
      signer: "agent",
      client,
      vault: VAULT,
      usd: toMicroUsd(canonicalAmount("10")),
      now: () => NOW,
    });
    expect(outcome.kind).toBe("unknown");
  });

  it("reports an OFFLINE-shaped failure as unknown too", async () => {
    // The section title promises to cover "never reached the exchange", and it
    // only ever encoded the wallet-signing member of that family. The offline
    // one behaves differently and belongs here explicitly: RN raises the same
    // `TypeError: Network request failed` whether the socket never opened or
    // the request was transmitted and then lost its connection, so it cannot
    // be treated as proof nothing was sent. Unknown is correct — and the order
    // and transfer paths were changed to match this one, not the reverse
    // (2026-08-29).
    const { client } = recorder(() =>
      Promise.reject(
        Object.assign(new Error("Request failed"), {
          name: "HttpRequestError",
          cause: new TypeError("Network request failed"),
        })
      )
    );
    const outcome = await depositToVault({
      signer: "agent",
      client,
      vault: VAULT,
      usd: toMicroUsd(canonicalAmount("10")),
      now: () => NOW,
    });
    expect(outcome.kind).toBe("unknown");
  });
});
