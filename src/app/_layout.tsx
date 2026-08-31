/**
 * The root layout — expo-router's composition root.
 *
 * The navigator is derived from this directory again: `(tabs)` holds the four
 * destinations, `order` and `pick-market` are the platform's sheets, and
 * everything else — the market detail, the money screens, a vault — is a
 * plain native push with a platform header. `(tabs)` keeps the hrefs the
 * screens have always written, because a group segment never appears in the
 * path; the market flow had a `(market)` group for the same reason until it
 * was dissolved, which is why `/market/BTC` and `/order` still resolve
 * unchanged.
 *
 * This file absorbed `src/App.tsx`. Everything below it kept its reasons; the
 * one structural change is that expo-router owns the `NavigationContainer`,
 * so the app's palette is handed over through `ThemeProvider` instead.
 */

// FIRST, before anything that can pull in viem/@noble: `@noble/hashes`
// captures `globalThis.crypto` once, at module-evaluation time, and Metro does
// not apply the `node` export condition — so if any module wins this race, key
// generation is permanently broken and produces the same mnemonic every time.
import "@/polyfills";
// Second, and not earlier: see src/sentry.ts.
import { sentry } from "@/sentry";
import "@/global.css";

import type { JSX } from "react";
import { useEffect } from "react";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { HeroUINativeConfig, HeroUINativeProvider } from "heroui-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { enableFreeze } from "react-native-screens";
import { Uniwind } from "uniwind";

import { readAppearance } from "@/components/account/appearance";
import { useStackChrome } from "@/components/common/stackChrome";
import { applyAppearance } from "@/components/account/applyAppearance";
import { setupHyperliquid } from "@/hyperliquid/setup";
import { HyperliquidProvider } from "@/providers/HyperliquidProvider";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { BottomSheetProvider } from "@swmansion/react-native-bottom-sheet";

SplashScreen.preventAutoHideAsync();

setupHyperliquid({ sentry });

// Paint the stored light/dark/system preference at MODULE scope, not in an
// effect: an effect runs after the first paint, so the app would flash the
// system theme before switching to the chosen one.
//
// This is HALF the job: it repaints, but the native `Appearance` write inside
// it is dropped this early (no window yet), so `useColorScheme()` and native
// views keep the OS value. The layout re-applies from an effect below to
// close that gap — see `applyAppearance`.
Uniwind.setTheme(readAppearance());

// Freeze background screens (react-freeze via react-native-screens). This
// covers the pushed STACK only — the native tab host hands its screens no
// `activityState`, so blurred tabs stay live; see `(tabs)/_layout.tsx` for
// why that stands unfixed.
enableFreeze(true);

/**
 * Inside `HeroUINativeProvider` because `useStackChrome` reads theme tokens,
 * and those only exist under it.
 */
function Routes(): JSX.Element {
  const chrome = useStackChrome();

  return (
    <Stack screenOptions={chrome}>
      {/* The tabs draw their own large title per tab, so the stack header
          would be a second one. */}
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />

      {/* Money screens are PUSHED from the Portfolio hero. The header is
          the platform's — back chevron, title, interruptible back-swipe. */}
      <Stack.Screen name="deposit" options={{ title: "Deposit" }} />
      <Stack.Screen name="withdraw" options={{ title: "Withdraw" }} />
      <Stack.Screen name="send" options={{ title: "Send" }} />
      <Stack.Screen name="wallet" options={{ title: "Wallet" }} />
      {/* The vault sets its own title through `setOptions` — it is the
          vault's name, which only the screen can resolve. */}
      <Stack.Screen name="vault/[address]" />

      {/* The market detail is an ORDINARY PUSHED SCREEN (user call,
          2026-08-31). It used to be the first page of a `(market)` group
          presented as one native sheet — market, picker and order together,
          on the reasoning that they were one errand. In practice the errand
          splits: reading a market is browsing, and committing money is not.
          Browsing wants a full screen with a real back stack; only the commit
          wants a sheet you can throw away. Splitting them also ended a
          recurring header problem — inside the sheet this page had to be
          chrome-less, so it had no back control of its own and its pages
          fought over one bar.

          The group is gone rather than re-presented, so each route now says
          how it appears. Hrefs are untouched: a group segment never appears
          in a path, so `/market/BTC`, `/order` and `/pick-market` still
          resolve exactly as before. The screen titles itself through
          `setOptions` — the market's name is only resolvable there. */}
      <Stack.Screen name="market/[coin]" />

      {/* The order ticket, as the PLATFORM's sheet. This is the screen that
          commits money, and a sheet is the right shape for it: it sits over
          the market it was opened from, and throwing it away is one gesture.
          `order.tsx` disables that gesture on ITSELF while a submit is in
          flight — it is the modal route now, where it used to defer to the
          group's parent screen.

          No header: a sheet's root has no back button to put in one, so a bar
          here would be an empty band with the route name in it, and the screen
          already leads with "Open BTC Position". Dismissal is the drag, which
          is the platform gesture for a sheet and the one the submit guard
          switches off. */}
      <Stack.Screen name="order" options={{ presentation: "modal", headerShown: false }} />

      {/* Picking a market is a detour from wherever you are, so it is modal
          too — and it returns its choice with `dismissTo`. */}
      <Stack.Screen name="pick-market" options={{ presentation: "modal", title: "Markets" }} />
    </Stack>
  );
}

function RootLayout(): JSX.Element | null {
  const [loaded, error] = useFonts({
    "SFProRounded-Ultralight": require("@/assets/fonts/SF-Pro-Rounded-Ultralight.otf"),
    "SFProRounded-Thin": require("@/assets/fonts/SF-Pro-Rounded-Thin.otf"),
    "SFProRounded-Light": require("@/assets/fonts/SF-Pro-Rounded-Light.otf"),
    "SFProRounded-Regular": require("@/assets/fonts/SF-Pro-Rounded-Regular.otf"),
    "SFProRounded-Medium": require("@/assets/fonts/SF-Pro-Rounded-Medium.otf"),
    "SFProRounded-Semibold": require("@/assets/fonts/SF-Pro-Rounded-Semibold.otf"),
    "SFProRounded-Bold": require("@/assets/fonts/SF-Pro-Rounded-Bold.otf"),
    "SFProRounded-Heavy": require("@/assets/fonts/SF-Pro-Rounded-Heavy.otf"),
    "SFProRounded-Black": require("@/assets/fonts/SF-Pro-Rounded-Black.otf"),
  });

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  // The native half of the theme, re-applied once a window exists. The
  // module-scope `Uniwind.setTheme` above already painted; this makes RN's
  // `Appearance` — and therefore `useColorScheme()`, native views and the
  // system keyboard — agree with what is on screen.
  useEffect(() => {
    applyAppearance(readAppearance());
  }, []);

  if (!loaded && !error) {
    return null;
  }

  const config: HeroUINativeConfig = {};

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Mounted explicitly: every screen reads `useSafeAreaInsets()`. */}
      <SafeAreaProvider>
        <KeyboardProvider>
          <HeroUINativeProvider config={config}>
            {/*
              Inside the UI providers but outside the navigator, so the session
              outlives every screen. It starts nothing on mount — see the
              provider's header for why launching a session unbidden is wrong.
            */}
            <HyperliquidProvider>
              <BottomSheetProvider>
                <Routes />
              </BottomSheetProvider>
            </HyperliquidProvider>
            <StatusBar style="auto" />
          </HeroUINativeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default sentry.wrap(RootLayout);
