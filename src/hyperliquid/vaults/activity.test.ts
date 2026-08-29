/**
 * The family fan-out.
 *
 * The distinction under test throughout is **declined vs empty**. A member that
 * returns `[]` genuinely has no rows; a member that was refused by the budget
 * has rows we did not see. Collapsing the two would show a market maker's
 * trade feed as "no trades" with nothing on screen to say otherwise.
 */

import {
  activityCost,
  ACTIVITY_WEIGHT,
  fanOutFamily,
  type Sourced,
} from "@/hyperliquid/vaults/activity";
import type { Hex } from "@/hyperliquid/types/domain";

interface Row {
  id: string;
  time: number;
}

const A = "0xaaa" as Hex;
const B = "0xbbb" as Hex;
const C = "0xccc" as Hex;

const timeOf = (row: Row): number => row.time;

describe("ACTIVITY_WEIGHT / activityCost", () => {
  it("prices balances at zero — it is derived, not fetched", () => {
    expect(ACTIVITY_WEIGHT.balances).toBe(0);
    expect(activityCost("balances", 8)).toBe(0);
  });

  it("multiplies a feed's per-member weight by the family size", () => {
    // The number the UI discloses before the tap: HLP is 8 members.
    expect(activityCost("trades", 8)).toBe(160);
    // 40, not 20: `fetchOpenOrders` fires TWO weighted endpoints per member
    // (`frontendOpenOrders` for the trigger detail, `openOrders` for the true
    // count). This surface exists to disclose cost honestly, and it was
    // quoting half.
    expect(activityCost("openOrders", 1)).toBe(40);
    expect(activityCost("openOrders", 8)).toBe(320);
  });
});

describe("fanOutFamily", () => {
  it("tags every row with the member that produced it", async () => {
    const result = await fanOutFamily<Row>(
      [A, B],
      async (address) => (address === A ? [{ id: "a1", time: 1 }] : [{ id: "b1", time: 2 }]),
      timeOf
    );
    expect(result.rows.map((row) => [row.id, row.sourceAddress])).toEqual([
      ["b1", B],
      ["a1", A],
    ]);
    expect(result.missing).toEqual([]);
  });

  it("merges newest-first across members", async () => {
    const result = await fanOutFamily<Row>(
      [A, B],
      async (address) =>
        address === A
          ? [
              { id: "a-old", time: 10 },
              { id: "a-new", time: 40 },
            ]
          : [
              { id: "b-mid", time: 20 },
              { id: "b-newest", time: 50 },
            ],
      timeOf
    );
    expect(result.rows.map((row) => row.id)).toEqual(["b-newest", "a-new", "b-mid", "a-old"]);
  });

  it("breaks timestamp ties on the source so rows do not shuffle between renders", async () => {
    // The strategies quote the same markets in the same millisecond, so this
    // is the common case, not an edge one.
    const result = await fanOutFamily<Row>(
      [C, A, B],
      async () => [{ id: "same", time: 100 }],
      timeOf
    );
    expect(result.rows.map((row) => row.sourceAddress)).toEqual([A, B, C]);
  });

  it("keeps a DECLINED member apart from an empty one", async () => {
    // A returns nothing (a fact); B was refused (a gap).
    const result = await fanOutFamily<Row>(
      [A, B],
      async (address) => (address === A ? [] : null),
      timeOf
    );
    expect(result.rows).toEqual([]);
    expect(result.missing).toEqual([B]);
  });

  it("reports no gap when every member simply has nothing", async () => {
    const result = await fanOutFamily<Row>([A, B], async () => [], timeOf);
    expect(result.rows).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("survives one member throwing, keeping the rest and naming the loss", async () => {
    const result = await fanOutFamily<Row>(
      [A, B],
      async (address) => {
        if (address === B) throw new Error("boom");
        return [{ id: "a1", time: 1 }];
      },
      timeOf
    );
    expect(result.rows.map((row) => row.id)).toEqual(["a1"]);
    expect(result.missing).toEqual([B]);
  });

  it("handles an empty family without calling the reader", async () => {
    let calls = 0;
    const result = await fanOutFamily<Row>(
      [],
      async () => {
        calls += 1;
        return [];
      },
      timeOf
    );
    expect(calls).toBe(0);
    expect(result).toEqual({ rows: [], missing: [] });
  });

  it("preserves the row's own fields alongside the tag", async () => {
    const result = await fanOutFamily<Row>([A], async () => [{ id: "x", time: 7 }], timeOf);
    const row: Sourced<Row> = result.rows[0]!;
    expect(row).toEqual({ id: "x", time: 7, sourceAddress: A });
  });
});
