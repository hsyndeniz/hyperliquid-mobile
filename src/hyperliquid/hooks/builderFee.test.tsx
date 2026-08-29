import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { JSX } from "react";

import { useBuilderFee, type UseBuilderFeeParams } from "@/hyperliquid/hooks/builderFee";
import type { Hex } from "@/hyperliquid/types/domain";

const BUILDER = "0xceF094b006B3045a89C0e7C37F0083b584C9e8AF" as Hex;
const USER = "0x2222222222222222222222222222222222222222" as Hex;
const config = { builderAddress: BUILDER, maxBuilderFee: 10 };

/** Renders the hook and exposes its latest state to the test. */
function harness(params: Partial<UseBuilderFeeParams> = {}) {
  const seen: ReturnType<typeof useBuilderFee>[] = [];
  const resolved: UseBuilderFeeParams = {
    config,
    user: USER,
    probe: { maxBuilderFee: async () => 0 },
    client: { approveBuilderFee: async () => ({}) },
    ...params,
  };

  function Probe(): JSX.Element | null {
    const state = useBuilderFee(resolved);
    seen.push(state);
    return null;
  }

  let tree: ReactTestRenderer | null = null;
  act(() => {
    tree = create(<Probe />);
  });
  return { seen, tree, latest: () => seen[seen.length - 1] };
}

/** Flush the effect's pending read. The hook fetches on mount. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("what the prompt is told to do", () => {
  it("asks when nothing is approved", async () => {
    const { latest } = harness();
    await settle();
    expect(latest().status).toBe("needed");
    expect(latest().rate).toBe("0.01%");
  });

  it("stays quiet when the approval already covers the fee", async () => {
    const { latest } = harness({ probe: { maxBuilderFee: async () => 10 } });
    await settle();
    expect(latest().status).toBe("approved");
  });

  it("is disabled with no builder configured, so no prompt is ever shown", async () => {
    const { latest } = harness({ config: { builderAddress: null, maxBuilderFee: 10 } });
    await settle();
    expect(latest().status).toBe("disabled");
  });

  it("is disabled before a session gives it a user", async () => {
    const { latest } = harness({ user: null });
    await settle();
    expect(latest().status).toBe("disabled");
  });
});

describe("approving", () => {
  it("RE-READS after the signature is accepted, rather than trusting it", async () => {
    // The exchange accepting a signature is not the same as the approval being
    // readable. Reporting `approved` on the resolve would attach a fee to orders
    // the exchange then rejects.
    let approved = 0;
    const reads: number[] = [];
    const { latest } = harness({
      probe: {
        maxBuilderFee: async () => {
          reads.push(approved);
          return approved;
        },
      },
      client: {
        approveBuilderFee: async () => {
          approved = 10;
          return {};
        },
      },
    });

    await settle();
    expect(latest().status).toBe("needed");
    await act(async () => {
      await latest().approve();
    });

    await settle();
    expect(latest().status).toBe("approved");
    // Read once on mount, once after approving.
    expect(reads).toEqual([0, 10]);
  });

  it("lets a declined approval be offered again", async () => {
    const refused = Object.assign(new Error("User rejected"), { name: "ApiRequestError" });
    const { latest } = harness({
      client: { approveBuilderFee: async () => Promise.reject(refused) },
    });

    await settle();
    expect(latest().status).toBe("needed");
    await act(async () => {
      await latest().approve();
    });
    expect(latest().status).toBe("declined");
  });

  it("does NOT return to 'needed' on an unknown outcome", async () => {
    // The critical branch. It may have landed — offering to sign again asks the
    // user to approve something they may already have approved.
    const lost = Object.assign(new Error("timed out"), { name: "HttpRequestError" });
    const { latest } = harness({
      client: { approveBuilderFee: async () => Promise.reject(lost) },
    });

    await settle();
    expect(latest().status).toBe("needed");
    await act(async () => {
      await latest().approve();
    });

    expect(latest().status).toBe("unknown");
    expect(latest().status).not.toBe("needed");
    expect(latest().status).not.toBe("declined");
  });

  it("recovers from unknown by re-reading, without a second signature", async () => {
    let approved = 0;
    let signatures = 0;
    const lost = Object.assign(new Error("timed out"), { name: "HttpRequestError" });
    const { latest } = harness({
      probe: { maxBuilderFee: async () => approved },
      client: {
        approveBuilderFee: async () => {
          signatures += 1;
          approved = 10; // it DID land
          return Promise.reject(lost);
        },
      },
    });

    await settle();
    expect(latest().status).toBe("needed");
    await act(async () => {
      await latest().approve();
    });
    expect(latest().status).toBe("unknown");

    await act(async () => {
      await latest().refresh();
    });
    await settle();
    expect(latest().status).toBe("approved");
    expect(signatures).toBe(1);
  });
});
