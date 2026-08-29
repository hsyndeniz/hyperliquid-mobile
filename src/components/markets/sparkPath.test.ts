import { sparkArea, sparkPath, sparkTrend, type SparkPoints } from "@/components/markets/sparkPath";

function series(closes: string[]): SparkPoints {
  return closes.map((close, index) => [index * 3_600_000, close] as const);
}

describe("sparkPath", () => {
  it("spans the full box and inverts y so a rising close rises", () => {
    const path = sparkPath(series(["10", "20"]), 100, 40);
    // First point at the low → the BOTTOM of the box (y = height); last at the
    // high → the top (y = 0). Inverted, because SVG y grows downward.
    expect(path).toBe("0.00,40.00 100.00,0.00");
  });

  it("places a midpoint proportionally", () => {
    expect(sparkPath(series(["0", "5", "10"]), 100, 40)).toBe("0.00,40.00 50.00,20.00 100.00,0.00");
  });

  it("draws NOTHING for a flat series rather than a line through the middle", () => {
    // The honest failure: a mid-height line reads as "held steady" when the
    // truth is "no movement to show".
    expect(sparkPath(series(["7", "7", "7"]), 100, 40)).toBeNull();
  });

  it("refuses too few points, a null series, and an unparseable close", () => {
    expect(sparkPath(null, 100, 40)).toBeNull();
    expect(sparkPath(series(["7"]), 100, 40)).toBeNull();
    // One bad close would drag the whole line to an invented extreme.
    expect(sparkPath(series(["1", "oops", "3"]), 100, 40)).toBeNull();
  });

  it("keeps a real move visible against a huge absolute price", () => {
    // The range is normalised, so BTC moving 63000 → 63100 is as legible as a
    // meme coin moving 0.001 → 0.002.
    const path = sparkPath(series(["63000", "63100"]), 100, 40);
    expect(path).toBe("0.00,40.00 100.00,0.00");
  });
});

describe("sparkTrend", () => {
  it("judges first against last, matching the row's 24h claim", () => {
    expect(sparkTrend(series(["1", "5", "3"]))).toBe("up");
    expect(sparkTrend(series(["5", "1", "3"]))).toBe("down");
  });

  it("is null when there is nothing to judge", () => {
    expect(sparkTrend(null)).toBeNull();
    expect(sparkTrend(series(["4"]))).toBeNull();
    expect(sparkTrend(series(["4", "4"]))).toBeNull();
    expect(sparkTrend(series(["4", "nope"]))).toBeNull();
  });
});

describe("sparkArea", () => {
  const points: [number, string][] = [
    [0, "10"],
    [1, "20"],
    [2, "15"],
  ];

  it("closes the line down to the baseline, not to the first value", () => {
    // A gradient anchored mid-box reads as a second line rather than as volume
    // under the curve.
    const line = sparkPath(points, 60, 24);
    const area = sparkArea(line, 60, 24);
    expect(area).not.toBeNull();
    expect(area).toMatch(/^M0\.00,/);
    expect(area).toContain("L60.00,24.00");
    expect(area?.endsWith("Z")).toBe(true);
  });

  it("traces the SAME geometry as the stroke", () => {
    // Derived from the stroke's own output, so the two cannot drift apart.
    const line = sparkPath(points, 60, 24);
    const area = sparkArea(line, 60, 24);
    for (const pair of line!.split(" ")) expect(area).toContain(pair);
  });

  it("is null when there is no line to close", () => {
    expect(sparkArea(null, 60, 24)).toBeNull();
  });
});
