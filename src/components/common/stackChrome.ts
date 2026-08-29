/**
 * The native stacks' shared chrome, from the app's own tokens.
 *
 * This replaced React Navigation's `ThemeProvider`. expo-router re-exports
 * neither it nor its theme objects, and `package.json` deliberately declares
 * no `@react-navigation/*` — expo-router vendors that layer — so the header
 * palette is handed to each `Stack` explicitly instead of through a context
 * the router happens to read.
 *
 * Same reasons as the theme it replaced: without this the native header
 * renders default light chrome no matter what the app is doing — a white bar
 * over a dark screen — because the header is the one surface the design
 * system cannot reach through a `className`. `surface` rather than
 * `background` for the bar so a header reads as chrome sitting on the page;
 * SF Pro Rounded because a system-font header would be the only place the
 * app's face is not; `contentStyle` paints the page behind a screen during
 * transitions, which is what stops the white flash in dark mode.
 *
 * ## Why the header does NOT get iOS 26's glass bar (tried, measured, reverted)
 *
 * Un-painting `headerStyle` on iOS 26 was tried (2026-08-29) on the theory
 * that the system's Liquid Glass nav bar would show through. It does not:
 * react-native-screens lays screen content BELOW a non-transparent header,
 * so there is nothing under the bar for the material to show — the un-paint
 * yields the system's default opaque bar (white + hairline in light mode),
 * a divergence from the app's chrome for zero glass. The real glass header
 * is a separate project — `headerTransparent` + a header blur effect + a
 * per-screen content-inset pass across every pushed route (the money
 * screens included, with keyboard interplay) — and stays out of scope until
 * deliberately taken on. Until then the painted surface header is the
 * intended state on every OS version.
 */

import { useThemeColor } from "heroui-native";

export function useStackChrome() {
  const [background, foreground, surface, accent] = useThemeColor([
    "background",
    "foreground",
    "surface",
    "accent",
  ]);

  return {
    headerStyle: { backgroundColor: surface },
    headerTintColor: accent,
    headerTitleStyle: { color: foreground, fontFamily: "SFProRounded-Semibold" },
    contentStyle: { backgroundColor: background },
    // Chevron only. iOS labels the back button with the PREVIOUS screen's
    // title, and a push off the tab host has no single title to show — it
    // fell back to the route name. `minimal` is what a push off a tab root
    // should look like anyway.
    headerBackButtonDisplayMode: "minimal",
  } as const;
}
