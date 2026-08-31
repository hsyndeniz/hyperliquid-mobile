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
 * system cannot reach through a `className`. The bar takes a colour a shade
 * off `background` so a header reads as chrome sitting on the page; SF Pro
 * Rounded because a system-font header would be the only place the app's face
 * is not; `contentStyle` paints the page behind a screen during transitions,
 * which is what stops the white flash in dark mode.
 *
 * ## The bar colour must be OPAQUE, and `surface` is not
 *
 * This passed `surface`, and in dark mode the vault header rendered as a WHITE
 * bar with white title text on it — unreadable (reported 2026-08-30). The
 * token is `oklch(1 0 0 / 4%)` in dark and `oklch(100% 0 0 / 0.6)` in light:
 * translucent white, by design, because every OTHER consumer lays it over a
 * View that is already painting the app background. A native header has no
 * such backdrop — it composites over UIKit's own bar material, so a 4%-white
 * fill let the system's light chrome through almost undiminished.
 *
 * `background-secondary` is the opaque form of the same idea
 * (`color-mix(background 96%, foreground 4%)`), so the header still reads as a
 * shade off the page and nothing of UIKit's can show through it. Any future
 * colour handed to a NATIVE surface has to clear the same bar: check its alpha
 * before assuming a token that looks right in the app will look right here.
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
  const [background, foreground, headerBackground, accent] = useThemeColor([
    "background",
    "foreground",
    // NOT `surface` — see the translucency note above.
    "background-secondary",
    "accent",
  ]);

  return {
    headerStyle: { backgroundColor: headerBackground },
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

/**
 * The header fill for a screen that sets `headerTransparent`.
 *
 * `surface` is translucent by design — `oklch(100% 0 0 / 0.6)` light,
 * `oklch(1 0 0 / 4%)` dark — which is exactly wrong for an opaque bar (see the
 * note above) and exactly right for one meant to let its page show through.
 * The order screen is the case: a back button floating over its own heading,
 * with the content sliding under a frosted band rather than under a solid one.
 *
 * Kept beside `useStackChrome` rather than inlined at the call site so the two
 * choices sit together — whoever changes one has to read why the other differs.
 */
export function useTransparentHeaderStyle(): { backgroundColor: string } {
  const surface = useThemeColor("surface");
  return { backgroundColor: surface };
}
