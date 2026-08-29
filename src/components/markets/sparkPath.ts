/**
 * A row sparkline as an SVG polyline, not a chart.
 *
 * The highlight cards draw with livechart (Skia); a list row must not. Twelve
 * recycled cells would mean twelve GPU surfaces and twelve Reanimated
 * SharedValue pairs for a decorative 24-point line — measured at ~1.4–2.4 ms
 * per `LiveChart` render, against essentially nothing for a native SVG path.
 * The same reasoning that banned `NumberFlow` from rows applies one layer
 * down: a row gets the cheapest thing that tells the truth.
 *
 * Truth here means the SHAPE of the last 24 hourly closes, nothing more. There
 * are no axes, no scale and no baseline, so the line says "this went up and
 * came back" and cannot be read for a value — which is why a flat or unknown
 * series must render nothing at all rather than a straight line through the
 * middle, a mark that reads as "held steady" when it means "we do not know".
 */

/** `[openTimeMs, close]` wire pairs — closes are strings until this leaf. */
export type SparkPoints = readonly (readonly [number, string])[];

/** Fewer than this cannot describe a shape; one point is not a line. */
const MIN_POINTS = 2;

/**
 * `"x,y x,y …"` for an SVG `<Polyline>`, or `null` when there is no shape to
 * draw: too few points, an unparseable close, or a series with no range at all
 * (every close identical — the flat case, which must stay blank).
 *
 * `Number()` is the display leaf the house rule permits: nothing downstream of
 * this is money, only pixels.
 */
export function sparkPath(
  points: SparkPoints | null,
  width: number,
  height: number
): string | null {
  if (points === null || points.length < MIN_POINTS) return null;

  const values: number[] = [];
  for (const [, close] of points) {
    const value = Number(close);
    // One bad close would drag the whole line to an invented extreme, so the
    // series is refused rather than plotted around the gap.
    if (!Number.isFinite(value)) return null;
    values.push(value);
  }

  let low = values[0];
  let high = values[0];
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const range = high - low;
  if (range === 0) return null;

  const stepX = width / (values.length - 1);
  return values
    .map((value, index) => {
      const x = index * stepX;
      // Inverted: SVG y grows downward, and a rising close must rise.
      const y = height - ((value - low) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

/**
 * Which way the series ran, for the line's colour.
 *
 * Compared on the FIRST and LAST close only — the same claim the row's 24h
 * change chip makes, so the line and the chip can never disagree. `null` when
 * there is no series to judge.
 */
export function sparkTrend(points: SparkPoints | null): "up" | "down" | null {
  if (points === null || points.length < MIN_POINTS) return null;
  const first = Number(points[0][1]);
  const last = Number(points[points.length - 1][1]);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === last) return null;
  return last > first ? "up" : "down";
}

/**
 * The same line, closed into a fillable area.
 *
 * Takes {@link sparkPath}'s output rather than the points again, so the fill
 * can never disagree with the stroke it sits under — one series, one geometry,
 * derived once.
 *
 * The area drops to the BOTTOM of the box, not to the first value's height: a
 * gradient that fades from the line down to the baseline reads as volume under
 * a curve, while one anchored mid-box reads as a second, meaningless line.
 */
export function sparkArea(path: string | null, width: number, height: number): string | null {
  if (path === null) return null;
  const first = path.slice(0, path.indexOf(" "));
  if (first === "") return null;
  const firstX = first.slice(0, first.indexOf(","));
  return `M${path.replace(/ /g, "L")}L${width.toFixed(2)},${height.toFixed(2)}L${firstX},${height.toFixed(2)}Z`;
}
