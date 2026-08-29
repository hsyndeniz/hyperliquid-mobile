/**
 * The market flow — the pages inside the native sheet.
 *
 * The parent route (`(market)` in the root layout) owns the presentation:
 * UIKit's pageSheet brings the slide-up, the dimmed backdrop, the rounded
 * corners, and a drag-to-dismiss that cooperates with scrolled content
 * natively — drag at scroll-top dismisses, anywhere else scrolls. That
 * replaced a hand-rolled card, its interpolator, and the transition-aware
 * scroll views its gesture arithmetic required.
 *
 * This layout owns what happens INSIDE: a native stack, so the back control
 * on the card's pages is the platform's, matching the routes outside it.
 * Opening a market, switching market and ordering are one errand, so they are
 * one surface; dismissing the sheet ends all of it.
 *
 * The group keeps the pages' historic hrefs — `/market/BTC`, `/order`,
 * `/pick-market` — because a group segment never appears in the path. One
 * href works from both sides of the sheet boundary: pushed from outside it
 * opens the sheet at that page, pushed from inside it moves within the stack.
 */

import type { JSX } from "react";
import { Stack } from "expo-router";

import { useStackChrome } from "@/components/common/stackChrome";

export default function MarketLayout(): JSX.Element {
  const chrome = useStackChrome();

  return (
    <Stack screenOptions={chrome}>
      {/* First page: no header. It draws its own pair pill and price, so a
          title bar here would be a second band saying the same thing. */}
      <Stack.Screen name="market/[coin]" options={{ headerShown: false }} />
      {/* The back control is the platform's, and the BAR it lives in is not
          there. `headerTransparent` keeps the real native back button — a
          UIKit bar-button item, which can only exist inside a header — while
          removing the background, and `headerShadowVisible: false` takes the
          hairline with it. No title: the screen leads with its own "Open BTC
          Position" heading. */}
      <Stack.Screen
        name="order"
        options={{ title: "", headerTransparent: true, headerShadowVisible: false }}
      />
      <Stack.Screen name="pick-market" options={{ title: "Markets" }} />
    </Stack>
  );
}
