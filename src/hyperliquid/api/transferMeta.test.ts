import { checkDestination, fetchUserRole } from "@/hyperliquid/api/transferMeta";
import { WeightBudget } from "@/hyperliquid/api/weightBudget";
import type { ValidatedAddress } from "@/hyperliquid/transfers/types";

const DEST = "0x5bf8287baeda8de01c88b3016d64f3875b0b4347" as ValidatedAddress;
const SOURCE = "0xcc8a21b439951529281859f6ad39f279606304a7";
const NOW = 1_800_000_000_000;

function probeReturning(response: unknown) {
  const calls: { user: string; source: string }[] = [];
  return {
    calls,
    probe: {
      preTransferCheck: async (params: { user: string; source: string }) => {
        calls.push(params);
        return response;
      },
      userRole: async () => ({ role: "user" }),
    },
  };
}

describe("checkDestination", () => {
  it("reads the three signals off a live-shaped response", async () => {
    const { probe } = probeReturning({
      fee: "0.0",
      isSanctioned: false,
      userExists: true,
      userHasSentTx: true,
    });

    const { value } = await checkDestination({
      probe,
      destination: DEST,
      source: SOURCE,
      now: () => NOW,
    });

    expect(value).toEqual({
      userExists: true,
      userHasSentTx: true,
      isSanctioned: false,
      activationFee: "0.0",
    });
  });

  it("reports a new account, the strongest typo signal available", async () => {
    // Caught 14/14 single-character substitutions and 9/9 transpositions of a
    // real address in live testing.
    const { probe } = probeReturning({
      fee: "1.0",
      isSanctioned: false,
      userExists: false,
      userHasSentTx: false,
    });

    const { value } = await checkDestination({
      probe,
      destination: DEST,
      source: SOURCE,
      now: () => NOW,
    });

    expect(value?.userExists).toBe(false);
    expect(value?.activationFee).toBe("1.0");
  });

  it("defaults a MISSING field to the cautious reading, not the reassuring one", async () => {
    // An absent `userExists` must report a new account — which warns — rather
    // than an established one, which would silently reassure.
    const { probe } = probeReturning({});

    const { value } = await checkDestination({
      probe,
      destination: DEST,
      source: SOURCE,
      now: () => NOW,
    });

    expect(value?.userExists).toBe(false);
    expect(value?.userHasSentTx).toBe(false);
    expect(value?.isSanctioned).toBe(false);
  });

  it("sends the sender address as source, which the schema requires to be hex", async () => {
    // Live: a label like "hyperliquid" is rejected with a format error, while
    // different valid sources return byte-identical answers.
    const { probe, calls } = probeReturning({ userExists: true });

    await checkDestination({ probe, destination: DEST, source: SOURCE, now: () => NOW });

    // Schema-enforced: a descriptive label is rejected outright by the SDK.
    expect(calls[0].source).toBe(SOURCE);
    expect(calls[0].source).toMatch(/^0x[0-9a-f]{40}$/);
    expect(calls[0].user).toBe(DEST);
  });

  it("returns null rather than throwing when the endpoint fails", async () => {
    // A preflight that cannot reach the endpoint must still produce a quote —
    // with the `checks_incomplete` warning that absence generates. Throwing
    // would make a network blip indistinguishable from a bad destination.
    const probe = {
      preTransferCheck: async () => {
        throw new Error("ECONNRESET");
      },
      userRole: async () => ({ role: "user" }),
    };

    const result = await checkDestination({
      probe,
      destination: DEST,
      source: SOURCE,
      now: () => NOW,
    });

    expect(result.value).toBeNull();
    expect(result.deferred).toBe(false);
  });

  it("reports deferred when the weight budget refuses", async () => {
    const budget = new WeightBudget(0);
    const { probe } = probeReturning({ userExists: true });

    const result = await checkDestination({
      probe,
      destination: DEST,
      source: SOURCE,
      budget,
      now: () => NOW,
    });

    expect(result.deferred).toBe(true);
    expect(result.value).toBeNull();
  });
});

describe("fetchUserRole", () => {
  it("reads the role string", async () => {
    const { probe } = probeReturning({});
    const { value } = await fetchUserRole({ probe, user: DEST, now: () => NOW });
    expect(value).toBe("user");
  });

  it("returns null for an unrecognised shape rather than guessing", async () => {
    const probe = {
      preTransferCheck: async () => ({}),
      userRole: async () => "unexpected",
    };
    const { value } = await fetchUserRole({ probe, user: DEST, now: () => NOW });
    expect(value).toBeNull();
  });
});
