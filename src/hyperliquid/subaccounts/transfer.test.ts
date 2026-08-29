import {
  fundSubAccount,
  fundSubAccountSpot,
  planSiblingMove,
  sweepSubAccount,
  sweepSubAccountSpot,
  type SubAccountTransferClient,
} from "@/hyperliquid/subaccounts/transfer";
import { canonicalAmount, toMicroUsd } from "@/hyperliquid/transfers/amount";
import type { MicroUsd, WireAmount, WireToken } from "@/hyperliquid/transfers/types";
import type { Hex } from "@/hyperliquid/types/domain";

const MASTER = "0x1111111111111111111111111111111111111111" as Hex;
const SUB = "0x2222222222222222222222222222222222222222" as Hex;
const SIBLING = "0x3333333333333333333333333333333333333333" as Hex;
const TOKEN = "USDC:0xeb62eee3685fc4c43992febcd9e75443" as WireToken;
const NOW = 1_700_000_000_000;

type PerpCall = { subAccountUser: string; isDeposit: boolean; usd: number };
type SpotCall = { subAccountUser: string; isDeposit: boolean; token: string; amount: string };

function recorder(): {
  client: SubAccountTransferClient;
  perp: PerpCall[];
  spot: SpotCall[];
} {
  const perp: PerpCall[] = [];
  const spot: SpotCall[] = [];
  return {
    perp,
    spot,
    client: {
      subAccountTransfer: async (params) => {
        perp.push(params);
        return { status: "ok" };
      },
      subAccountSpotTransfer: async (params) => {
        spot.push(params);
        return { status: "ok" };
      },
    },
  };
}

describe("direction", () => {
  it("fund means master → sub, sweep means the reverse", async () => {
    // The wire's `isDeposit` is from the master's point of view, so reading it
    // as "deposit into the account I am looking at" inverts every transfer.
    // These two assertions are the only place that mapping is stated.
    const { client, perp } = recorder();
    const base = { client, master: MASTER, subAccount: SUB, usd: 1 as MicroUsd, now: () => NOW };

    await fundSubAccount(base);
    await sweepSubAccount(base);

    expect(perp.map((call) => call.isDeposit)).toEqual([true, false]);
  });

  it("applies the same mapping on the spot side", async () => {
    const { client, spot } = recorder();
    const base = {
      client,
      master: MASTER,
      subAccount: SUB,
      token: TOKEN,
      amount: canonicalAmount("1"),
      now: () => NOW,
    };

    await fundSubAccountSpot(base);
    await sweepSubAccountSpot(base);

    expect(spot.map((call) => call.isDeposit)).toEqual([true, false]);
  });
});

describe("units", () => {
  it("sends perp amounts as micro-USD integers", async () => {
    const { client, perp } = recorder();
    await fundSubAccount({
      client,
      master: MASTER,
      subAccount: SUB,
      // 1058.68 is a real observed ledger amount, and `1058.68 * 1e6` is
      // 1058680000.0000001 in IEEE-754 — which the wire's integer check rejects.
      usd: toMicroUsd(canonicalAmount("1058.68")),
      now: () => NOW,
    });

    expect(perp[0].usd).toBe(1_058_680_000);
    expect(Number.isInteger(perp[0].usd)).toBe(true);
  });

  it("sends spot amounts as whole token units, NOT micro-anything", async () => {
    // The two functions sit one call apart and disagree about units. A spot
    // amount multiplied by 1e6 would move a million times too much.
    const { client, spot } = recorder();
    await fundSubAccountSpot({
      client,
      master: MASTER,
      subAccount: SUB,
      token: TOKEN,
      amount: canonicalAmount("1058.68"),
      now: () => NOW,
    });

    expect(spot[0].amount).toBe("1058.68");
    expect(spot[0].token).toBe(TOKEN);
  });
});

describe("guards", () => {
  it("refuses a transfer to the master itself, before signing", async () => {
    // The server refuses it too, but only after a signature exists, and its
    // "Invalid sub-account transfer from X to X" reads like an app bug.
    const { client, perp } = recorder();
    const outcome = await fundSubAccount({
      client,
      master: MASTER,
      subAccount: MASTER,
      usd: 1 as MicroUsd,
      now: () => NOW,
    });

    expect(outcome.kind).toBe("rejected_locally");
    expect(perp).toHaveLength(0);
  });

  it("compares addresses case-insensitively", async () => {
    // `spot`, NOT `perp`. This drives `sweepSubAccountSpot`, which routes to
    // `subAccountSpotTransfer` and is recorded into `spot` — so asserting on
    // `perp` checked an array this path can never write to, and was vacuously
    // empty however the spot path behaved. Moving the self-transfer guard to
    // AFTER the wire call left both original assertions green while a
    // signature went out, which is the one thing the guard exists to prevent.
    const { client, spot, perp } = recorder();
    const outcome = await sweepSubAccountSpot({
      client,
      master: MASTER,
      subAccount: MASTER.toUpperCase().replace("0X", "0x") as Hex,
      token: TOKEN,
      amount: canonicalAmount("1"),
      now: () => NOW,
    });

    expect(outcome.kind).toBe("rejected_locally");
    expect(spot).toHaveLength(0);
    // Kept as well, so a spot sweep that somehow reached the PERP endpoint
    // would still be caught.
    expect(perp).toHaveLength(0);
  });
});

describe("outcomes", () => {
  it("reports a server refusal as rejected, with its reason", async () => {
    const error = new Error("Insufficient balance for sub-account transfer");
    error.name = "ApiRequestError";
    const outcome = await fundSubAccount({
      client: {
        subAccountTransfer: async () => {
          throw error;
        },
        subAccountSpotTransfer: async () => ({}),
      },
      master: MASTER,
      subAccount: SUB,
      usd: 1 as MicroUsd,
      now: () => NOW,
    });

    expect(outcome).toEqual({
      kind: "rejected_by_server",
      reason: "Insufficient balance for sub-account transfer",
    });
  });

  it("reports a transport failure as unknown, with a window to watch", async () => {
    // Never `rejected`: the action may still land, and there is no idempotency
    // key that would make a retry safe.
    const error = new Error("socket hang up");
    error.name = "HttpRequestError";
    const outcome = await sweepSubAccount({
      client: {
        subAccountTransfer: async () => {
          throw error;
        },
        subAccountSpotTransfer: async () => ({}),
      },
      master: MASTER,
      subAccount: SUB,
      usd: 1 as MicroUsd,
      now: () => NOW,
    });

    expect(outcome.kind).toBe("unknown");
    if (outcome.kind === "unknown") {
      expect(outcome.nonce).toBe(NOW);
      expect(outcome.window).toEqual({ fromMs: NOW, toMs: NOW + 900_000 });
    }
  });
});

describe("planSiblingMove", () => {
  it("returns two hops through the master, in order", () => {
    // There is no direct sub → sub action. Executing this as one call would
    // hide a state where the funds have left the source and not arrived.
    expect(planSiblingMove({ from: SUB, to: SIBLING })).toEqual([
      { step: "sweep", subAccount: SUB },
      { step: "fund", subAccount: SIBLING },
    ]);
  });

  it("refuses a move to itself", () => {
    expect(() => planSiblingMove({ from: SUB, to: SUB })).toThrow(/same/);
  });
});

describe("the perp/spot amount types do not interchange", () => {
  it("keeps MicroUsd and WireAmount apart at the type level", () => {
    // Not a runtime assertion — a compile-time one. If these ever unify, the
    // `@ts-expect-error` stops erroring and this test fails to compile.
    const micro: MicroUsd = toMicroUsd(canonicalAmount("1"));
    const wire: WireAmount = canonicalAmount("1");
    // @ts-expect-error a decimal-string amount is not micro-USD
    const wrong: MicroUsd = wire;
    void wrong;
    expect(micro).toBe(1_000_000);
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
  const base = {
    master: MASTER,
    subAccount: SUB,
    usd: 1 as MicroUsd,
    now: () => NOW,
  };

  it("is rejected_locally, not unknown", async () => {
    // `AbstractWalletError` classified as `unknown` until this was audited, so a
    // transfer that was never sent told the user it might be in flight.
    const outcome = await fundSubAccount({
      ...base,
      client: { subAccountTransfer: signingFailure, subAccountSpotTransfer: signingFailure },
    });
    expect(outcome.kind).toBe("rejected_locally");
  });

  it("still reports a lost response as unknown", async () => {
    const outcome = await fundSubAccount({
      ...base,
      client: { subAccountTransfer: timedOut, subAccountSpotTransfer: timedOut },
    });
    expect(outcome.kind).toBe("unknown");
  });
});
