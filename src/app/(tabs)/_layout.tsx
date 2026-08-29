/**
 * The four destinations, on expo-router's native tabs.
 *
 * This drives a real `UITabBarController` through `react-native-screens` — the
 * same native control the hand-declared `TabNavigator` used — so the
 * liquid-glass bar, scroll-to-minimize and SF Symbols are the platform's, and
 * the bar floats over the content, which is what the `insets.bottom +
 * TAB_BAR_CLEARANCE` in all four tab screens reserves for.
 *
 * Icons: SF Symbols on iOS; Material glyphs on Android — which the previous
 * navigator could not declare at all (its icon type had no Material variant,
 * so Android rendered a labelled bar with no icons).
 *
 * The native tab host keeps every visited tab live — a blurred tab re-renders
 * on every store tick (measured: PortfolioTab 15× while the user sat on
 * Markets), and nothing here can stop it yet. `enableFreeze(true)` cannot
 * reach these screens, RNS's tabs have no freeze prop, and the react-freeze
 * wrapper this app tried KILLED TOUCH on every non-initial tab (suspending a
 * blurred tab's subtree leaves an empty `UIViewControllerWrapperView` over
 * the tab controller that swallows every tap; found by native hit-testing).
 * Accepted cost until upstream grows a freeze mechanism — do not reintroduce
 * a Suspense-based one.
 */

import type { JSX } from "react";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useThemeColor } from "heroui-native";

export default function TabsLayout(): JSX.Element {
  const accent = useThemeColor("accent");

  return (
    <NativeTabs
      tintColor={accent}
      // The bar minimises as the user scrolls down and comes back on the way
      // up — iOS 26+ only, ignored below it.
      minimizeBehavior="onScrollDown"
      // The rest of the app is SF Pro Rounded; the system font here would be
      // the only place it is not.
      labelStyle={{ fontFamily: "SFProRounded-Medium", fontSize: 11 }}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf="chart.line.uptrend.xyaxis" md="monitoring" />
        <NativeTabs.Trigger.Label>Markets</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="portfolio">
        <NativeTabs.Trigger.Icon
          sf={{ default: "chart.pie", selected: "chart.pie.fill" }}
          md="pie_chart"
        />
        <NativeTabs.Trigger.Label>Portfolio</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="vaults">
        <NativeTabs.Trigger.Icon
          sf={{ default: "building.columns", selected: "building.columns.fill" }}
          md="account_balance"
        />
        <NativeTabs.Trigger.Label>Vaults</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="account">
        <NativeTabs.Trigger.Icon
          sf={{ default: "person.crop.circle", selected: "person.crop.circle.fill" }}
          md="account_circle"
        />
        <NativeTabs.Trigger.Label>Account</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
