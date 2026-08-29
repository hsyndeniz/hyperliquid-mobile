import { HlError } from "@/hyperliquid/core/errors";
import { builderFeePercentString } from "@/hyperliquid/config/env";
import {
  approveBuilder,
  builderFeeFor,
  needsBuilderApproval,
  readBuilderApproval,
  type BuilderApproval,
} from "@/hyperliquid/orders/builderFee";
import type { Hex } from "@/hyperliquid/types/domain";

const BUILDER = "0xceF094b006B3045a89C0e7C37F0083b584C9e8AF" as Hex;
const OTHER = "0x1111111111111111111111111111111111111111" as Hex;
const USER = "0x2222222222222222222222222222222222222222" as Hex;
const config = { builderAddress: BUILDER, maxBuilderFee: 10 };

function approval(over: Partial<BuilderApproval> = {}): BuilderApproval {
  return { builder: BUILDER, approved: 10, isApproved: true, ...over };
}

describe("reading the approval", () => {
  it("reads the bare number the endpoint actually returns", async () => {
    // `maxBuilderFee` answers a number, not an object — measured live, where it
    // returned `0` for an account that had approved nothing.
    const read = await readBuilderApproval({
      probe: { maxBuilderFee: async () => 10 },
      user: USER,
      builder: BUILDER,
    });
    expect(read).toEqual({ builder: BUILDER, approved: 10, isApproved: true });
  });

  it("keeps 'approved nothing' distinct from 'could not ask'", async () => {
    // 0 is a real answer; null is not knowing. Charging on the second rejects
    // every order, so they must not collapse.
    const zero = await readBuilderApproval({
      probe: { maxBuilderFee: async () => 0 },
      user: USER,
      builder: BUILDER,
    });
    expect(zero).toMatchObject({ approved: 0, isApproved: false });

    const failed = await readBuilderApproval({
      probe: {
        maxBuilderFee: async () => Promise.reject(new Error("network down")),
      },
      user: USER,
      builder: BUILDER,
    });
    expect(failed).toMatchObject({ approved: null, isApproved: false });
  });

  it("never throws, because a fee is revenue and an order is correctness", async () => {
    await expect(
      readBuilderApproval({
        probe: { maxBuilderFee: async () => Promise.reject(new Error("boom")) },
        user: USER,
        builder: BUILDER,
      })
    ).resolves.toBeDefined();
  });

  it("treats a non-numeric answer as unknown rather than as zero", async () => {
    const read = await readBuilderApproval({
      probe: { maxBuilderFee: async () => ({ maxBuilderFee: 10 }) },
      user: USER,
      builder: BUILDER,
    });
    expect(read.approved).toBeNull();
  });
});

describe("the gate on attaching a fee", () => {
  it("attaches the fee when the approval covers it", () => {
    expect(builderFeeFor(config, approval())).toEqual({ b: BUILDER, f: 10 });
    expect(builderFeeFor(config, approval({ approved: 50 }))).toEqual({ b: BUILDER, f: 10 });
  });

  it("attaches NOTHING when the approval is short — never a reduced fee", () => {
    // A fee silently lowered to fit is revenue at a rate nobody chose, and it
    // hides the missing approval instead of surfacing it.
    expect(builderFeeFor(config, approval({ approved: 5 }))).toBeUndefined();
    expect(builderFeeFor(config, approval({ approved: 0 }))).toBeUndefined();
  });

  it("attaches nothing when the approval could not be read", () => {
    // Every order would be rejected otherwise — the measured live state was
    // `approvedBuilders: []` and `maxBuilderFee: 0`.
    expect(builderFeeFor(config, approval({ approved: null }))).toBeUndefined();
    expect(builderFeeFor(config, null)).toBeUndefined();
  });

  it("ignores an approval for a DIFFERENT builder", () => {
    // Approval is per builder. Reusing another builder's approval would attach a
    // fee the user never agreed to pay to us.
    expect(builderFeeFor(config, approval({ builder: OTHER, approved: 1000 }))).toBeUndefined();
  });

  it("compares builder addresses case-insensitively", () => {
    // The wire is lowercase and the config is checksummed. A case-sensitive
    // compare disables the fee permanently and silently.
    const lower = approval({ builder: BUILDER.toLowerCase() as Hex });
    expect(builderFeeFor(config, lower)).toEqual({ b: BUILDER, f: 10 });
  });

  it("stays disabled when no builder is configured", () => {
    expect(builderFeeFor({ builderAddress: null, maxBuilderFee: 10 }, approval())).toBeUndefined();
    expect(
      builderFeeFor({ builderAddress: BUILDER, maxBuilderFee: 0 }, approval())
    ).toBeUndefined();
  });

  it("reports when the user still needs to be asked", () => {
    expect(needsBuilderApproval(config, approval())).toBe(false);
    expect(needsBuilderApproval(config, approval({ approved: 0 }))).toBe(true);
    expect(needsBuilderApproval(config, null)).toBe(true);
    // Nothing to ask for when the feature is off.
    expect(needsBuilderApproval({ builderAddress: null, maxBuilderFee: 10 }, null)).toBe(false);
  });
});

describe("approving", () => {
  it("sends a PERCENT STRING, not the configured number", async () => {
    // The confusable pair: config is tenths of a basis point (10), the wire
    // wants "0.01%". Sending `10` fails the schema loudly; sending "10%" would
    // be valid and ask the user to approve a tenth of every trade.
    const sent: { builder: Hex; maxFeeRate: string }[] = [];
    const outcome = await approveBuilder({
      signer: "master",
      client: {
        approveBuilderFee: async (p) => {
          sent.push(p);
          return { status: "ok" };
        },
      },
      config,
    });

    expect(sent[0]).toEqual({ builder: BUILDER, maxFeeRate: "0.01%" });
    expect(outcome).toEqual({ kind: "approved", rate: "0.01%", tenthsOfBasisPoint: 10 });
  });

  it("approves EXACTLY what is charged, with no headroom", async () => {
    // Approving more than is charged shows the user a bigger number than they
    // will pay. The cost of no headroom is a re-approval if the fee ever rises.
    const sent: { maxFeeRate: string }[] = [];
    await approveBuilder({
      signer: "master",
      client: {
        approveBuilderFee: async (p) => {
          sent.push(p);
          return {};
        },
      },
      config,
    });
    expect(sent[0].maxFeeRate).toBe(builderFeePercentString(config.maxBuilderFee));
  });

  it("refuses to approve when nothing is configured", async () => {
    await expect(
      approveBuilder({
        signer: "master",
        client: { approveBuilderFee: async () => ({}) },
        config: { builderAddress: null, maxBuilderFee: 10 },
      })
    ).rejects.toThrow(HlError);
  });

  it("separates a refusal from an unresolved send", async () => {
    // A declined prompt changed nothing and can be re-offered. A lost response
    // must NOT be re-signed — that is a second prompt for something that may
    // already be approved.
    const refused = Object.assign(new Error("User rejected"), { name: "ApiRequestError" });
    expect(
      (
        await approveBuilder({
          signer: "master",
          client: { approveBuilderFee: async () => Promise.reject(refused) },
          config,
        })
      ).kind
    ).toBe("rejected");

    const lost = Object.assign(new Error("timed out"), { name: "HttpRequestError" });
    expect(
      (
        await approveBuilder({
          signer: "master",
          client: { approveBuilderFee: async () => Promise.reject(lost) },
          config,
        })
      ).kind
    ).toBe("unknown");
  });

  it("exposes no retry helper", () => {
    // Re-signing is a second signature prompt, not a retry.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require("@/hyperliquid/orders/builderFee");
    expect(Object.keys(module).filter((n) => /retry|resend/i.test(n))).toEqual([]);
  });
});

describe("the unit conversion, pinned", () => {
  it("matches the configured value against the live base rates", () => {
    // 10 tenths of a basis point = 1 bp = 0.01%. Against a measured perp taker
    // fee of 0.045%, that is a 22% uplift; against the 0.015% maker fee it is
    // already 67%. The previous placeholder of 50 would have been 3.3x the
    // maker fee.
    expect(builderFeePercentString(10)).toBe("0.01%");
    expect(builderFeePercentString(50)).toBe("0.05%");
    expect(builderFeePercentString(1)).toBe("0.001%");
    expect(builderFeePercentString(0)).toBe("0%");
  });
});
