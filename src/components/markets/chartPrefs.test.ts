import {
  BARS_MAX,
  BARS_MIN,
  BARS_STEP,
  DEFAULT_CHART_PREFS,
  readChartPrefs,
  writeChartPrefs,
  type ChartPrefs,
} from "@/components/markets/chartPrefs";
import { hlStringStorage } from "@/hyperliquid/storage/mmkv";

const KEY = "hl.chart.prefs.v2";

beforeEach(() => {
  hlStringStorage.removeItem(KEY);
});

describe("readChartPrefs", () => {
  it("opens on the defaults", () => {
    expect(readChartPrefs()).toEqual(DEFAULT_CHART_PREFS);
    expect(DEFAULT_CHART_PREFS.bars).toBe(25);
  });

  it("round-trips every field", () => {
    // Every flag inverted at once — a per-field read that dropped one would
    // return the default for it and fail here.
    const flipped: ChartPrefs = {
      volume: !DEFAULT_CHART_PREFS.volume,
      momentum: !DEFAULT_CHART_PREFS.momentum,
      leftEdgeFade: !DEFAULT_CHART_PREFS.leftEdgeFade,
      gradient: !DEFAULT_CHART_PREFS.gradient,
      timeAxis: !DEFAULT_CHART_PREFS.timeAxis,
      priceLine: !DEFAULT_CHART_PREFS.priceLine,
      scrub: !DEFAULT_CHART_PREFS.scrub,
      zoom: !DEFAULT_CHART_PREFS.zoom,
      timeScroll: !DEFAULT_CHART_PREFS.timeScroll,
      bars: BARS_MAX,
    };
    writeChartPrefs(flipped);
    expect(readChartPrefs()).toEqual(flipped);
  });

  it("round-trips every position the slider can stop on", () => {
    for (let bars = BARS_MIN; bars <= BARS_MAX; bars += BARS_STEP) {
      writeChartPrefs({ ...DEFAULT_CHART_PREFS, bars });
      expect(readChartPrefs().bars).toBe(bars);
    }
  });

  it("keeps an off-step count rather than resetting the framing", () => {
    // The step only constrains the slider. A value carried over from the old
    // four-button set, or from a future step change, is still renderable.
    writeChartPrefs({ ...DEFAULT_CHART_PREFS, bars: 37 });
    expect(readChartPrefs().bars).toBe(37);
  });

  it("keeps the fields it understands and defaults the rest", () => {
    // Schema drift: a v2 entry written before a field existed. The known field
    // must survive — falling back wholesale would silently reset the user's
    // other settings every time one was added.
    hlStringStorage.setItem(KEY, JSON.stringify({ volume: false }));
    expect(readChartPrefs()).toEqual({ ...DEFAULT_CHART_PREFS, volume: false });
  });

  it("rejects a wrongly-typed field without losing the others", () => {
    hlStringStorage.setItem(KEY, JSON.stringify({ volume: "no", momentum: false }));
    expect(readChartPrefs()).toEqual({ ...DEFAULT_CHART_PREFS, momentum: false });
  });

  it("rejects a bar count the slider could not reach", () => {
    // Out of range, fractional, or not a number at all: each would put the
    // thumb off the track and frame the chart on a count nobody chose.
    for (const bad of [0, BARS_MIN - 1, BARS_MAX + 1, -30, 42.5, "60", null]) {
      hlStringStorage.setItem(KEY, JSON.stringify({ bars: bad }));
      expect(readChartPrefs().bars).toBe(DEFAULT_CHART_PREFS.bars);
    }
  });

  it("survives a corrupt entry rather than crashing the chart", () => {
    for (const raw of ["", "{", "null", "[]", '"nope"', "7"]) {
      hlStringStorage.setItem(KEY, raw);
      expect(readChartPrefs()).toEqual(DEFAULT_CHART_PREFS);
    }
  });
});
