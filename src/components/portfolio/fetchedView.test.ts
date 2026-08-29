/**
 * The five states, and the four that must not read as "you have none".
 *
 * The screen's own header states the rule: *deferred is not empty*. This is
 * where it is enforced.
 */

import { compactUsd, describeFetched } from "@/components/portfolio/fetchedView";
import type { Fetched } from "@/hyperliquid/hooks/history";

const OPTIONS = {
  isEmpty: (value: { rows: number[] }) => value.rows.length === 0,
  emptyTitle: "No transfers",
  emptyDescription: "Deposits and withdrawals appear here.",
};

describe("describeFetched", () => {
  it("distinguishes all five states", () => {
    const states: Fetched<{ rows: number[] }>[] = [
      { kind: "idle" },
      { kind: "loading" },
      { kind: "deferred" },
      { kind: "error", message: "boom" },
      { kind: "ready", value: { rows: [] } },
      { kind: "ready", value: { rows: [1] } },
    ];
    const kinds = states.map((state) => describeFetched(state, OPTIONS).kind);

    // Six inputs, and only ONE of them is `empty`.
    expect(kinds).toEqual(["idle", "loading", "notice", "notice", "empty", "rows"]);
    expect(kinds.filter((kind) => kind === "empty")).toHaveLength(1);
  });

  it("does not use the empty copy for a missing session", () => {
    const view = describeFetched({ kind: "idle" }, OPTIONS);

    // "No transfers" is a claim about the ACCOUNT. There is no account here.
    expect(view.kind).toBe("idle");
    expect(JSON.stringify(view)).not.toContain("No transfers");
  });

  it("styles a deferral as neutral, not as an error", () => {
    // The budget declining is the app protecting a shared allowance and it
    // resolves on its own. A red banner teaches the user to distrust a working
    // client.
    const view = describeFetched({ kind: "deferred" }, OPTIONS);

    expect(view).toMatchObject({ kind: "notice", tone: "neutral" });
  });

  it("styles a failed read as an error and shows its reason", () => {
    const view = describeFetched({ kind: "error", message: "network down" }, OPTIONS);

    expect(view).toMatchObject({ kind: "notice", tone: "danger", detail: "network down" });
  });

  it("uses the caller's empty copy only for a successful, genuinely empty read", () => {
    expect(describeFetched({ kind: "ready", value: { rows: [] } }, OPTIONS)).toMatchObject({
      kind: "empty",
      title: "No transfers",
    });
  });

  it("asks the caller what empty means rather than assuming a shape", () => {
    // The ledger view wraps its rows in `{ rows, hasMore }`; order history in
    // `{ orders, truncated }`. A length check here would only fit one of them.
    const view = describeFetched(
      { kind: "ready", value: { rows: [] } },
      { ...OPTIONS, isEmpty: () => false }
    );

    expect(view.kind).toBe("rows");
  });
});

describe("compactUsd", () => {
  it("compacts a NEGATIVE figure instead of spelling it out in full", () => {
    // The gates used to read the signed value, so every `gte` failed for a
    // negative and it fell through to the plain branch: `$-351818.09`. A loss
    // or a net outflow is exactly where the compact form is needed.
    expect(compactUsd("-351818.09")).toBe("-$351.8K");
    expect(compactUsd("-2500000")).toBe("-$2.5M");
    expect(compactUsd("-4000000000")).toBe("-$4B");
  });

  it("rounds the MAGNITUDE down, so a negative is never overstated either", () => {
    // -4.97M is "-$4.9M", not "-$5M": the same "never claim more than is
    // there" rule, applied to the absolute value rather than to the number
    // line (where DOWN would mean away from zero).
    expect(compactUsd("-4970000")).toBe("-$4.9M");
    expect(compactUsd("-15.279")).toBe("-$15.27");
  });

  it("does not invent a minus for zero", () => {
    // bignumber.js keeps the sign of `-0`, and "-$0" is not a thing.
    expect(compactUsd("-0")).toBe("$0");
    expect(compactUsd("0")).toBe("$0");
  });

  it("leaves the positive ladder exactly as it was", () => {
    // The sign guard must be invisible on every figure that has no sign.
    expect(compactUsd("5000000.0")).toBe("$5M");
    expect(compactUsd("4970000")).toBe("$4.9M");
    expect(compactUsd("1500")).toBe("$1.5K");
    expect(compactUsd("15.27")).toBe("$15.27");
    expect(compactUsd("abc")).toBe("--");
  });
});
