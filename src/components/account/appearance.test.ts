import {
  APPEARANCE_OPTIONS,
  DEFAULT_APPEARANCE,
  appearanceMeasure,
  readAppearance,
  resolveChoice,
  writeAppearance,
} from "@/components/account/appearance";
import { hlStringStorage } from "@/hyperliquid/storage/mmkv";

const KEY = "hl:app:appearance";

beforeEach(() => {
  hlStringStorage.removeItem(KEY);
});

describe("readAppearance", () => {
  it("follows the OS until the user says otherwise", () => {
    expect(readAppearance()).toBe("system");
    expect(DEFAULT_APPEARANCE).toBe("system");
  });

  it("round-trips every option", () => {
    for (const option of APPEARANCE_OPTIONS) {
      writeAppearance(option.value);
      expect(readAppearance()).toBe(option.value);
    }
  });

  it("falls back rather than returning a theme Uniwind would throw on", () => {
    // `Uniwind.setTheme()` throws on an unregistered theme, so a drifted or
    // hand-edited entry reaching it would be a crash at startup.
    hlStringStorage.setItem(KEY, "solarized");
    expect(readAppearance()).toBe("system");

    hlStringStorage.setItem(KEY, "");
    expect(readAppearance()).toBe("system");
  });
});

describe("resolveChoice", () => {
  it("reports system whenever the theme is adaptive, whatever it resolved to", () => {
    // The regression this guards: reading `theme` alone lights up "Dark" for
    // every default-setting user on a dark phone.
    expect(resolveChoice("dark", true)).toBe("system");
    expect(resolveChoice("light", true)).toBe("system");
  });

  it("reports the explicit theme once adaptive is off", () => {
    expect(resolveChoice("light", false)).toBe("light");
    expect(resolveChoice("dark", false)).toBe("dark");
  });

  it("treats an unknown non-adaptive theme as dark rather than widening the type", () => {
    expect(resolveChoice("midnight", false)).toBe("dark");
  });
});

describe("appearanceMeasure", () => {
  it("names what the system resolved to, so the closed row still reports state", () => {
    expect(appearanceMeasure("system", "dark")).toEqual({ label: "System · Dark", tone: "muted" });
    expect(appearanceMeasure("system", "light")).toEqual({
      label: "System · Light",
      tone: "muted",
    });
  });

  it("names the choice itself when it is explicit", () => {
    expect(appearanceMeasure("dark", "dark").label).toBe("Dark");
    expect(appearanceMeasure("light", "light").label).toBe("Light");
  });

  it("stays muted — appearance is never a health signal", () => {
    for (const option of APPEARANCE_OPTIONS) {
      expect(appearanceMeasure(option.value, "dark").tone).toBe("muted");
    }
  });
});
