# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`hl` — a **Hyperliquid mobile client** built with Expo SDK 57 / React Native 0.86 (New Architecture, Hermes, React 19.2). It was scaffolded from the `create-heroui-native-app` template (see [README.md](README.md)).

The app is built out — Markets, the market/order sheets, Portfolio, Vaults and Account are all real screens against live data. (This line read "the UI is still template scaffolding" for a long time after it stopped being true; if it looks stale again, it is.)

[src/hyperliquid/](src/hyperliquid/) is the headless client underneath, and the part to read first: a complete Hyperliquid implementation with no React in it. It began as a reference-informed port of the OneKey monorepo's Perps module but targets parity with Hyperliquid's own web app rather than with OneKey. (The phase-by-phase design record lived in a `MIGRATION.md` outside this repository and is not part of the published tree; the reasoning that outlived it is in the Gotchas below.)

```
src/hyperliquid/
  config/       env resolution (build-time inlined), protocol constants
  core/         assetIds · precision · identity · errors · logger
  api/          clients/transports · rate-limit budget
  auth/         agent lifecycle · Keychain storage
  storage/      MMKV instance · jotai persistence
  orders/       building · submission · reconciliation
  state/        stores · channels · subscription registry · notifications
  transfers/    amounts · destinations · withdrawals · ledger
  subaccounts/  listing · management · internal transfers
  vaults/       directory · details · lockup · vault deposits
  deposits/     Arbitrum bridge — the ONLY second-chain path in the module
  history/      ledger · order history · TWAP state
  predictions/  HIP-4 outcome markets — catalog · holdings · conversions
```

Rules that hold across the module:

- **Only `core/assetIds` does asset-ID arithmetic.** A signed order carries `a: number`; a wrong ID places an order on a different market rather than failing.
- **Only `core/identity` builds scoping keys** — `{ accountId, address, dex, subAccount }`. `dex` and `subAccount` are key dimensions, not metadata.
- **Only `core/logger` logs.** Redaction is centralised there; never log at hot-path tick rates.
- Wire prices/sizes stay **strings**; `BigNumber` for maths, never `Number` in a trading path.
- **Prediction markets are spot-shaped, not perp-shaped.** An outcome holding lives in `spotClearinghouseState.balances`, never in `assetPositions` — `state/accountWire.ts` cannot see them at all. One market side has three live wire spellings: `#N` for book/candles/trades, `+N` for the balance row, `oN` for settled shares where `N` is the **outcome id, not the encoding**.
- **A deposit is not a Hyperliquid action.** It is an ERC-20 transfer to the bridge on **Arbitrum One**, so every failure mode _succeeds_: wrong chain, wrong token, wrong decimals and below-minimum all confirm on-chain and are unrecoverable. `deposits/network.ts` is the only place those addresses live. **On testnet the token is `USDC2` (`0x1baA…34d5`), not Circle's Sepolia USDC** — the bridge silently keeps Circle's token (12 USDC of this project's went that way), and a guard test bans Circle's address from the module so the substitution cannot recur. Deposits credit **perp**, take no fee, and land 5.7–10.0 s after the transaction.
- **Import via the `@/` alias, never relative paths** — `@/hyperliquid/core/errors`, not `../core/errors`. Resolved by TypeScript (`paths`), Jest (`moduleNameMapper`) and Metro alike; a bundle has been verified end to end.

[src/hyperliquid/setup.ts](src/hyperliquid/setup.ts) is the module bootstrap, called once from the root layout. It registers the logger's console sink — **without it the logger has no sink and silently discards every event.** Sentry becomes a second sink here.

Treat the dependency set as the intended architecture — when building a feature, reach for the library already installed for that job rather than adding a new one.

Package manager is **bun** (`bun.lock` is the only lockfile — do not introduce npm/yarn/pnpm lockfiles).

## Commands

```bash
bun run start        # Metro / Expo dev server on port 8081
bun run ios          # expo run:ios   — builds and launches the dev client
bun run android      # expo run:android
bun run typecheck    # tsc --noEmit
bun run lint         # eslint .   (bun run lint:fix to autofix)
bun run format       # prettier --write .   (format:check to verify)
```

```bash
bun run test         # Jest — THE test runner. Not `bun test`.
bun run test:watch
bun run smoke        # live testnet smoke test (read-only, no wallet needed)
bun run smoke:vaults # live vault smoke — mainnet read-only + a testnet signer probe
HL_E2E=1 bun run test:e2e   # the composition root, end to end, on live testnet
```

`bun run test:e2e` drives `HyperliquidSession` for real: import a key -> vault -> `signerFor`
-> `session.start` -> agent gate -> six live subscriptions -> `placeOrders` -> the order appears
in the store over the websocket -> cancel -> teardown. It places one resting limit far from the
mid so it cannot fill, then cancels it. Skips unless `HL_E2E=1`.

**Running it:** all ten suites back to back saturate Hyperliquid's per-IP allowance (1200
weight/minute; a single `session.start()` spends 42 before any test runs), so a full pass wants
~60 s of quiet beforehand and can still 429. `withRateLimitRetry` covers session start, but the
reliable invocation for a single area is
`HL_E2E=1 bun run test:e2e --testPathPattern <suite>`. A 429 in a `beforeAll` fails **every** test
in that file, and Jest attributes it to each one — so tests named "without touching the transport"
report an HTTP error. That is the rate limit, not a defect.

It exists because unit tests verify modules **in isolation**; nothing else verifies that they work
**together**. That gap is what hid the Phase 8 `vaultAddress` bug — every module individually
correct, the composition broken. It uses [jest.e2e.config.js](jest.e2e.config.js), which
deliberately does **not** use the `jest-expo` preset: that preset installs React Native's
`whatwg-fetch` over Node's native `fetch`, and the polyfill needs an `XMLHttpRequest` that does not
exist outside RN — the symptom is a `fetch` that resolves to `undefined`. Overriding `setupFiles`
does not help, because Jest _merges_ that key with the preset's instead of replacing it.

`bun run smoke` runs [scripts/smoke-testnet.ts](scripts/smoke-testnet.ts) against the **real
Hyperliquid testnet**: resolves assets, formats prices against live `szDecimals`, opens a real
`l2Book` subscription, switches market, and verifies teardown. Read-only — no wallet, no funds,
nothing written — so it is safe to run any time, and it catches the class of bug unit tests cannot:
wrong assumptions about live payload shapes. Run it after touching anything in `state/` or `api/`.

> **Use `bun run test`, never `bun test`.** They are different runners. `bun test` is Bun's
> built-in runner: it ignores [jest.config.js](jest.config.js) entirely, so it applies no Babel
> transform (react-native's Flow-typed source fails to parse), has no `__DEV__`, and skips
> [`__mocks__/`](__mocks__). Pure-logic suites happen to pass under it; anything touching
> react-native, MMKV, or Keychain fails with errors that look like code bugs but are not.

Tests run on **Jest** with the `jest-expo` preset. Two things in that config are load-bearing and
easy to break:

- `transformIgnorePatterns` must allowlist **`@nktkas/*`, `@noble/*`, `@scure/*`, `viem` and `ox`** —
  all ESM. Allowlisting only `@nktkas/hyperliquid` is not enough: the failure surfaces one level
  deeper in a transitive `@noble/hashes` import, and its stack trace points at sourcemapped
  `@nktkas/src/*.ts` paths that do not exist on disk.
- [`__mocks__/react-native-mmkv.js`](__mocks__/react-native-mmkv.js) is an in-memory store, applied
  automatically. MMKV initialises Nitro at _import_ time, so without it any module downstream of
  storage cannot even be imported under test.

[src/hyperliquid/moduleImports.test.ts](src/hyperliquid/moduleImports.test.ts) guards both: it
imports every module and fails loudly if one stops loading. Add new modules to its list.

There is no Detox/Maestro and no CI. The feedback loop is `typecheck` + `lint` + `test` plus manual
verification on a simulator.

This is a **dev-client / prebuilt** project, not Expo Go: `ios/` and `android/` are checked in, and `expo-dev-client` is a dependency. Anything that adds native code requires a rebuild via `bun run ios` / `bun run android`.

## Architecture

**Routing** — expo-router. The navigator is derived from [src/app/](src/app/); the entry point is `expo-router/entry` (`main` in package.json), and there is no `src/navigation/` — the hand-declared React Navigation layer that briefly lived there went back out with `react-native-screen-transitions`, once the market card became a native sheet and the library had nothing left to do.

- [src/app/_layout.tsx](src/app/_layout.tsx) — the composition root (it absorbed the old `src/App.tsx`). `@/polyfills` is its FIRST import and must stay first; then sentry, then `global.css`. Loads the nine SF Pro Rounded weights, gates render on font load, hides the splash. Provider order is `GestureHandlerRootView` → `SafeAreaProvider` → `KeyboardProvider` → `HeroUINativeProvider` → `HyperliquidProvider` → `BottomSheetProvider` → the `Stack`. expo-router owns the container, and the app declares no `@react-navigation/*` at all — so the header palette is handed to each `Stack` explicitly via `useStackChrome()` ([src/components/common/stackChrome.ts](src/components/common/stackChrome.ts), built from HeroUI tokens; without it the native header renders default light chrome over a dark screen). The root `Stack` declares: `(tabs)` headerless, the money screens (`deposit`/`withdraw`/`send`/`wallet`) as plain native pushes with titles, `vault/[address]` (titles itself via `setOptions` — the name only the screen can resolve), `market/[coin]` as a plain push (titling itself the same way), and `order` + `pick-market` with `presentation: "modal"`.
- [src/app/(tabs)/_layout.tsx](<src/app/(tabs)/_layout.tsx>) — the four destinations on expo-router's `NativeTabs` (`expo-router/unstable-native-tabs`): a real `UITabBarController` through `react-native-screens`, so the liquid-glass bar, scroll-to-minimize and SF Symbols are the platform's, and the bar **floats over the content** — which is what the `insets.bottom + TAB_BAR_CLEARANCE` in all four tab screens reserves for. Icons declare `sf` + `md` pairs (the type requires an Android source alongside an SF Symbol). Blurred tabs stay live and re-render on store ticks — see the freeze gotcha below for why that is accepted rather than fixed.
- **The market flow is three ROOT routes, not a group** (2026-08-31). `market/[coin]` is an ordinary pushed screen with the platform header; `order` and `pick-market` are `presentation: "modal"`. They were one `(market)` group presented as a single native sheet, on the reasoning that opening a market, switching market and ordering are one errand. The errand splits: reading a market is browsing and wants a full screen with a real back stack, while only the commit wants a sheet you can throw away. Dissolving the group also ended a recurring header problem — inside the sheet the market page had to be chrome-less, so it had no back control and the pages fought over one bar. **Hrefs did not change**: a group segment never appears in a path, so `/market/BTC`, `/order` and `/pick-market` resolve exactly as before, and `router.dismissTo({ pathname: "/order", params })` still returns the picker's choice to a mounted ticket. The order sheet is headerless — a sheet root has no back button to put in a bar, and the screen leads with its own "Open BTC Position" heading — so it carries its own top gap instead. The market screen puts its IDENTITY in the native bar — `headerTitle` is the badge + pair + kind, `headerRight` the pin — and keeps only the ticking price in the page; the split follows what changes, since the bar is fixed per market and set once through `setOptions` while the price would otherwise cross to a native navigation item several times a second. Pass `title` alongside `headerTitle`: the component owns what is drawn, the string is what accessibility reads, and without it the header announced itself as "market/[coin]".
- Hrefs are expo-router's own again — `router.push/replace/back/dismissTo`, `useLocalSearchParams`, `useFocusEffect` all import from `expo-router`. The market picker still returns its choice with `router.dismissTo({ pathname: "/order", params })`: popping back to the mounted `/order` keeps its ticket state and only swaps the coin.
- A wire coin can CONTAIN a slash (`PURR/USDC`), and `[coin]` is a single segment — expo-router percent-encodes the param on push and decodes it in `useLocalSearchParams`, so spot pairs round-trip. Verified on device; if a market page ever opens blank on a spot pair, look here first.

Composition root and providers:

- [src/providers/HyperliquidProvider.tsx](src/providers/HyperliquidProvider.tsx) — owns the app's single `HyperliquidSession` and forwards `AppState` to it. The session is a **module-level singleton, not a `useRef`**: a ref is recreated whenever the provider remounts, which Fast Refresh does routinely, and a second session means a second websocket with two identities on one transport. It **starts nothing on mount** — a start reads the wallet, may prompt for a signature, and opens a socket — and **does not stop on unmount**, since Fast Refresh and teardown are indistinguishable from there. Read it with `useHyperliquid()`.

**Styling** — Uniwind (Tailwind CSS v4 for React Native), wired in [metro.config.js](metro.config.js) via `withUniwindConfig` pointing at `./src/global.css`. Style components with `className`, not `StyleSheet`. [src/global.css](src/global.css) imports the HeroUI Native and HeroUI Native Pro style layers plus the `glass` theme, `@source`-registers both packages' `lib` dirs so their classes get scanned, and maps Tailwind's `--font-*` weight tokens onto the SF Pro Rounded family names registered in the root layout. Colors come from HeroUI semantic tokens (`bg-background`, `text-foreground`, …) or the `useThemeColor("accent" | "foreground" | …)` hook when a raw color value is needed for a native prop.

**Native controls** — `@expo/ui` renders real SwiftUI on iOS. The order sheet's side segment, size slider, order-type menu and reduce-only toggle are platform controls, each inside a `Host matchContents={{ vertical: true }}` so the host takes its HEIGHT from the native content and its WIDTH from the RN layout (plain `matchContents` sizes both axes and collapses a slider to a stub). Hosts sit INSIDE the order screen's ScrollView rather than replacing it — `FieldGroup` scrolls itself and would fight the sheet's drag-to-dismiss. Two things deliberately stayed RN: the **leverage slider**, because `@expo/ui`'s `Slider` has only `onValueChange` and no release event, and its release commits an on-chain write; and the **hold-to-confirm submit**, which has no native equivalent and is the money-path safeguard. The segmented side control needs SwiftUI's `pickerStyle('segmented')` (the universal `Picker` offers only `menu`/`wheel` and takes no `modifiers`), so it lives in `SideSegment.ios.tsx` with a universal fallback sibling — platform-split files must sit in `components/`, never in `app/`.

**Components** — `heroui-native` and `heroui-native-pro`. Prefer these over hand-rolled primitives; both use compound-component APIs (e.g. `Typography.Paragraph`).

**State/persistence** — `zustand` with `react-native-mmkv`. [src/lib/storage.ts](src/lib/storage.ts) exports `zustandStorage`, a `StateStorage` adapter to pass to zustand's `persist` middleware.

**Path aliases** — `@/*` → `./src/*` and `@/assets/*` → `./assets/*` ([tsconfig.json](tsconfig.json)). TypeScript is `strict`.

**React Compiler** is enabled (`experiments.reactCompiler`), so manual `useMemo`/`useCallback`/`memo` wrapping is usually unnecessary.

## Library map

### Hyperliquid API

`@nktkas/hyperliquid` (0.33) — ESM-only TypeScript SDK. Composition is _transport + client_:

```ts
import {
  HttpTransport,
  WebSocketTransport,
  InfoClient,
  ExchangeClient,
  SubscriptionClient,
} from "@nktkas/hyperliquid";
```

- `InfoClient` — read state (mids, book, positions, fills). `ExchangeClient` — place/cancel orders, transfers; takes a wallet. `SubscriptionClient` over `WebSocketTransport` — live feeds. `ExplorerClient` — chain data.
- Tree-shakeable subpath exports exist for low-level use: `@nktkas/hyperliquid/api/{info,exchange,subscription,explorer}`, plus `/signing` (signing helpers) and `/utils` (formatting, symbol conversion). Prefer these subpaths over the barrel import in hot paths.
- Wire prices and sizes are **strings** (`{ p: "30000", s: "0.1" }`), not numbers — keep them as strings end-to-end and only parse for display, so tick/lot precision is never lost to float rounding.

### Wallet / signing

- `viem` — accounts, EIP-712 signing; the wallet object `ExchangeClient` expects.
- `permissionless` — ERC-4337 account abstraction (peer-depends on `viem` + `ox`).
- `react-native-passkeys` — WebAuthn passkeys on iOS/Android, for passkey-derived or passkey-gated keys.
- `react-native-keychain` — Keychain/Keystore for secrets. Never put keys or session data in MMKV, which is unencrypted by default.
- `react-native-quick-crypto` — JSI/Nitro implementation of Node's `crypto`. The shim is installed in [src/polyfills.ts](src/polyfills.ts) and imported first in [src/app/\_layout.tsx](src/app/_layout.tsx). **Ordering is load-bearing**: `@noble/hashes` captures `globalThis.crypto` once at module-evaluation time, and Metro does not apply the `node` export condition, so if any module imports `viem`/`@noble` before the shim runs, `generatePrivateKey()` is permanently broken. Key _generation_ needs it; signing does not.

### Charts and market data display

Three chart-capable libraries are installed; pick by use case:

- `react-native-livechart` — live line and candlestick charts on Skia + Reanimated, purpose-built for streaming price feeds. **This is the right one for price/candle views.** Exports `LiveChart`, `LiveChartSeries`, `LiveChartTransition`, the `useTradeStream` / `useDegen` hooks, `usePriceY` / `useTimeX` for custom `renderOverlay` content, and `formatTime` / `formatValue`.
- `victory-native` (41, Skia-based) — general charting (bars, areas, axes). Present largely as a `heroui-native-pro` peer dependency.
- `@shopify/react-native-skia` — the rendering engine under both; drop to it only for custom drawing.
- `number-flow-react-native` — animated rolling-digit counters for live prices/PnL.
- `@internationalized/number` and `@internationalized/date` — locale-aware number/date formatting and parsing (also `heroui-native-pro` peers).

### UI

- `heroui-native` + `heroui-native-pro` (beta) — the component library. Pro peer-depends on `heroui-native`, `@shopify/react-native-skia`, `victory-native`, `react-native-screens`, and the two `@internationalized/*` packages, which is why several of those appear in `package.json`.
- `@gorhom/bottom-sheet` — sheets (also a `heroui-native` peer).
- `react-native-keyboard-controller` — keyboard-aware layout for order-entry forms.
- Icons: `@web3icons/core` for token/network/wallet/exchange SVGs (subpath exports: `@web3icons/core/svgs/tokens/*`, `/networks/*`, `/wallets/*`, `/exchanges/*`), `lucide-react-native` for general UI icons, `@expo/vector-icons` for the template's Ionicons.
- `react-native-qrcode-styled` — QR codes (deposit addresses / WalletConnect payloads).
- `react-native-pulsar` — haptics; use it for order confirmations and other tactile feedback.
- `expo-blur`, `expo-clipboard` — blur surfaces and copy-to-clipboard.
- `@callstack/liquid-glass` — iOS 26's Liquid Glass material as a view (`LiquidGlassView`, `interactive` press shimmer, `effect: "clear" | "regular"`). Native code (needs a rebuild, Xcode ≥ 26); renders a plain View below iOS 26, so every use gates styling on `isLiquidGlassSupported` and keeps the `bg-surface` skin as the fallback. Trial surface: `MarketHighlightCard` — the Markets strip.

### State and storage

`zustand` for stores, `react-native-mmkv` (v4) for persistence, bridged by the `zustandStorage` adapter in [src/lib/storage.ts](src/lib/storage.ts) — pass it to zustand's `persist` middleware rather than instantiating MMKV again.

### Navigation extras

expo-router (v6, SDK-aligned) carries all screen-level navigation. **No `@react-navigation/*` package is declared in `package.json`** — SDK 57's expo-router is built on `standard-navigation` (a `"type": "module"` package; see the Jest allowlist note in [jest.config.js](jest.config.js)), not on `@react-navigation/native-stack`, and the app imports navigation APIs only from `expo-router`. Two APIs expo-router does not re-export are re-derived locally instead of imported: the stack chrome ([src/components/common/stackChrome.ts](src/components/common/stackChrome.ts) replaces `ThemeProvider`) (`useIsFocused` has no consumer left after the freeze wrapper was withdrawn). In-screen segmented tabs (positions / open orders / fills) are heroui `Tabs`, not a navigator. expo-router has a pod, which is why adding or removing it is a dev-client rebuild.

### Nitro modules

`react-native-mmkv` v4 and `react-native-quick-crypto` are both built on `react-native-nitro-modules` (statically compiled JSI bindings). Changes to them require a native rebuild, not just a Metro reload.

## Conventions

- Prettier: double quotes, semicolons, 100-col width, `es5` trailing commas. Run `bun run format` rather than hand-formatting.
- Screen and layout components are default exports with an explicit `JSX.Element` return type annotation.
- **A conditional section gets a NAME, not an inline ternary.** Build it as a `const` above the return and reference it — `{perpSection}`, `{heroSection}` — so the return reads as the list of sections the screen actually is. The market screen's return was ~190 lines in which each block opened `{x !== null ? (` and closed forty lines later with `) : null}`, and the portfolio's hero ran to ~100; at that length neither end of a branch tells you what the other end belonged to. Short guards inside a row (`{isStale ? <Chip/> : null}`) stay inline — the rule is about blocks big enough to hide the shape of the page, not about every conditional. Prefer a named boolean too when the condition needs explaining: `canTrade` says why a prediction has no button; `kind !== "prediction"` at the call site does not.

## Gotchas

- Dependency bumps in `package.json` are not always followed by a `pod install`. Before assuming a native feature works after a version bump, check that its podspec is present in `ios/Podfile.lock`. This has bitten twice: the `ExpoRouter` pod during the NativeTabs migration, and later `expo-glass-effect` — installed in `node_modules`, absent from `Podfile.lock`, and the resulting `Cannot find native module 'ExpoGlassEffect'` surfaced as _every route_ "missing required default export", which looks nothing like a linking failure. The inverse also bites: a pod present in `Podfile.lock` but a **binary built before it** throws `TurboModuleRegistry.getEnforcing: '<Name>' could not be found` at import time (`@callstack/liquid-glass`, 2026-08-30) — the lockfile proves the pod install, not the rebuild.
- `expo-env.d.ts` is generated and **gitignored**. It is what pulls in `expo/types`, and without it the `@/global.css` side-effect import fails to typecheck with `TS2882` — a confusing error for a CSS file.
- The order screen turns its own dismissal off while a submit is in flight, by setting `gestureEnabled` on ITSELF — it is the modal route now, and used to reach `navigation.getParent()` when the `(market)` group's screen owned the presentation. That is not a correctness guard — `placeOrders` journals before it sends, so a dismissed submit still reconciles — it is there because swiping a half-placed order off screen is a horrible thing to do to someone.
- Metro re-bundles after a navigator change take long enough that the app shows a **black screen and swallows taps** while it works. That looks exactly like a render bug and is not one — check for "Bundling %" on the splash before diagnosing. It cost a wrong bisect and a premature revert of three good changes.
- `heroui-native-pro` is on a `1.0.0-beta` release; its API can break between betas.
- **The native bottom tabs never freeze a blurred tab — and the obvious fix breaks touch.** `enableFreeze(true)` covers the native _stack_ only; the tab host renders each tab through `@react-navigation/elements`' `Screen` with no `activityState`, so a blurred tab re-renders on every store tick (measured: `PortfolioTab` 15× / ≈356 ms during 60 s spent on Markets — it subscribes to the account store). A react-freeze wrapper per tab screen fixed the renders and **killed every touch on the non-initial tabs**: suspending a blurred tab's subtree leaves an empty `UIViewControllerWrapperView` over the tab controller that swallows taps meant for the tab in front (diagnosed with `native-user-interactable-view-at-point`; symptom is silent — no error, no log, handlers simply never fire, while the screen keeps rendering live data). RNS's tabs and expo-router's `NativeTabs` expose no freeze mechanism as of screens 4.26 / router 57.0.17. The re-render cost is ACCEPTED until upstream provides one — do not reintroduce a Suspense-based wrapper.
- **An SVG filter is a main-thread rasterisation, not a style.** `@web3icons/core` ships some icons with Figma's shadow stack intact (`feFlood`/`feBlend`/`feGaussianBlur`/`feColorMatrix`); `ape` alone carried nine. react-native-svg runs each one through an offscreen buffer inside `-[RNSVGSvgView drawRect:]`, which cost a **1045 ms** UI hang on the Markets tab. [scripts/svgFilters.ts](scripts/svgFilters.ts) strips them during `bun run icons:generate` so a regeneration cannot bring them back. **Masks are kept** — a Figma shadow export often uses the mask to define the visible shape. Still unaddressed in that file: `rug` is 73.8 KB with 669 `<path>` elements drawn into a 32 pt badge, and `SvgXml` memoises its parse per instance, so a recycled row re-parses.
- **`ios/` and `android/` are NOT checked in — they are gitignored prebuild output.** Verified: zero tracked files in each. So every native file is regenerated from `app.json` by the next `expo prebuild`, which CI and EAS run because the directories are absent from the repo. Editing `AndroidManifest.xml`, `Info.plist` or `hl.entitlements` directly is a trap of the worst kind: the change is correct, survives local testing, and is silently discarded on the next build. Native security settings live in `app.json` and are asserted by [src/nativeConfigGuards.test.ts](src/nativeConfigGuards.test.ts). Note `expo run:ios` only prebuilds iOS — an `app.json` change to `android.*` needs an Android build before it lands.
- **`offline` does NOT mean "nothing was sent", and no money path may treat it that way.** The whole discriminator is a substring match on React Native's `TypeError: Network request failed`, which `xhr.onerror` raises for ANY network-layer failure — including a connection that opened, transmitted the signed order in full, and then reset before the reply (a Wi-Fi→cellular handover; prompt enough that no transport timeout sees it). Reading it as a definite local rejection told the user their order was not sent, resolved the journal entry that is the reconciler's only handle, and invited a retry that placed a SECOND real order. `orders/exchange.ts` (both `submitOrders` and `placeTwapOrder`), `transfers/transfer.ts` and `vaults/transfer.ts` all classify it as `unknown`; airplane mode is less helpfully but honestly reported. Proving "nothing was sent" is only possible BEFORE dispatch, via a reachability check at the call site.
- **A guard is worth what it MATCHES, and this repo has shipped five that matched nothing.** `JSON.stringify(error)` is `"{}"` for an Error — `message`, `stack` and `cause` are all non-enumerable — so both secret-redaction guards passed whatever the error said. `/Rejected$/` is case-sensitive and missed the SDK's bare `"rejected"`. The vaultAddress routing guard only inspected call sites whose line ENDED at the opening brace, so every single-line call was skipped. The env-secret guard required an `0x` prefix and end-anchored the name, so a bare 64-hex key under `EXPO_PUBLIC_SIGNER_KEY` sailed through. A sub-account test asserted on the recorder array the path under test never writes to. **Revert-verify every guard** — reintroduce the bug and watch the test fail — and give pattern-matching guards a self-test on the spellings they are meant to catch, because the real files are (correctly) clean and exercise nothing.
- **MMKV stays in `Documents/`, and that is a decision.** The store is inside the iCloud/iTunes backup, which sounds worse than it is: the master key that decrypts every vault blob is a Keychain item marked `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, and Apple never includes `ThisDeviceOnly` items in a backup. So a backup yields encrypted blobs nobody can open, plus activity metadata (withdrawal journal, pending orders, addresses) — a privacy exposure, not key compromise. The two available JS alternatives are both worse: `expo-file-system`'s `cache` can be **purged by the OS**, which would destroy the encrypted vault, and `document` is where it already sits. The real fix is a config plugin setting the backup-exclusion attribute on the `mmkv/` directory; until someone takes that on, this is accepted and the Keychain accessibility class is what carries the security (pinned by a test in `wallet/vault.test.ts`).
- **Sentry Session Replay is disabled, on measurement.** It cost 7.3% of the main thread on the Markets tab (`SentrySessionReplay.newFrame` + `SentryViewRendererV2.render`, Instruments 2026-08-27) serialising a windowed 1,300-row view tree. The `unmask` ban in `screenGuards.test.ts` stays enforced anyway — it is the cheap half of the recovery-phrase protection if replay ever returns.
- **The nine SF Pro Rounded faces are bundled and tracked, deliberately.** Apple's embedded licence (readable in the font's own `name` table, ID 13) says the font may be used "solely for creating mock-ups of user interfaces" and that "you may not embed the Apple Font in any software programs" — so shipping it inside the bundle, and committing it here, is a position the project takes knowingly rather than an oversight. Do not silently "fix" it by deleting the files: the app gates its first render on all nine loading, and `require()` resolves them at bundle time, so a missing weight breaks the build rather than degrading.
- **The licence-clean alternative is `ui-rounded`, and it does NOT work through Uniwind's tokens — tested both ways, 2026-08-29.** RN 0.86 maps the CSS generic families to `UIFontDescriptorSystemDesign` natively (`RCTFontUtils.mm`), so an inline `style={{ fontFamily: "ui-rounded", fontWeight: "700" }}` renders real SF Pro Rounded from the OS with nothing embedded — verified on device. Setting `--font-*: ui-rounded` in `global.css` does **not**, quoted or bare: text falls back to the default sans and every weight collapses, because this project's `--font-*` tokens are FAMILY names (a deliberate hijack of Tailwind's weight utilities) and Uniwind will not emit a generic family through them. Switching would mean returning `font-*` to real weight utilities and setting the family at each of ~625 call sites across 68 files — by parser, never by regex (see the font-guard entry below).
- **`LiveChart`'s custom font field is `typeface`, not `fontAsset`.** It takes a `require("…otf")` for Skia's `useFont`; the misspelling compiles when the config object is pre-declared (excess-property checks only fire on inline literals) and renders INVISIBLE axis labels. Do not set `fontFamily` to an expo-font face either — Skia's `matchFont` only sees OS-installed fonts, so leave it unset and let Menlo cover the one frame while the asset loads.
- **`LiveChart`'s Y axis cannot be switched back ON over loaded candles.** `useYAxis` seeds `useSharedValue<Record<number, number>>({})` and then mutates that object in place from a worklet (`labelAlphas[key] = …` in `draw/grid.ts`); Reanimated freezes a payload once it crosses the JS/UI boundary, so the write throws `cannot add a new property`. It survives a normal mount only because the first frame has no data and therefore no keys to add — remount it with a seeded chart and it red-boxes immediately. `useXAxis` carries the copy-on-write fix for exactly this (its own comment: "SharedValue payloads may be frozen after crossing the JS/UI boundary"), and it was never applied to the Y one. So `xAxis` is safe to toggle at runtime and `yAxis` is not, and there is no config that hides the axis without unmounting it — `YAxisConfig` has no opacity or hidden field, and `count: 0` means auto. That asymmetry is why the chart settings sheet offers a **Time axis** toggle and no price-axis one (livechart 4.20, verified on device 2026-08-29). Re-check on the next bump; if the fix is copied across, `priceAxis` returns as a plain `yAxis` pass-through.
- **The weight table must agree with the published rate limits, or the budget is worse than none.** Docs (rate-limits-and-user-limits): weight 2 for exactly `l2Book, allMids, clearinghouseState, orderStatus, spotClearinghouseState, exchangeStatus`; **60** for `userRole`; **20 for every other documented info request**. Sixteen entries were keyed at 2, so a session start plus one Markets sweep was charged ~12 locally against ~160 for real — the local tracker stayed green while the per-IP budget emptied, turning the quiet deferrals this module exists to produce into hard 429s. The per-page surcharge applies only to the listed endpoints, and `candleSnapshot` counts in **60s** where the rest count in 20s. Asserted in `api/weightBudget.test.ts`.
- **`core/clock` takes its storage by INJECTION, not import.** It is pulled in by `core/freshness` and therefore by nearly everything, so a static `import` of `storage/mmkv` puts `react-native-mmkv` — and through it all of react-native — in the path of every consumer. That is invisible inside the app and fatal outside it: the smoke scripts run under bun, which cannot parse react-native's Flow-typed source, and `bun run smoke` died the day that import was added, with an error naming react-native and nothing to do with the clock. `setupHyperliquid` calls `registerClockStorage`; absent storage is a supported state (the offset relearns from the feed in seconds). Same reasoning the file already gives for the Sentry SDK.
- **VirtualizedList nesting is judged by REACT CONTEXT, not by the native tree.** A `WheelPicker` (FlatList-backed) in the chart settings sheet raised "VirtualizedLists should never be nested inside plain ScrollViews" because the market screen renders its page in a `ScrollView` and the sheet is a descendant in the React tree — even though the sheet carries `nativeOverlay` and presents in a window of its own. Moving the list around INSIDE the sheet changes nothing; the context comes from the page's scroller several components up, so the only real fixes are to render the sheet as that scroller's sibling (which means hoisting its state to the screen) or to not use a virtualized control. That sheet took the second: a Pro `NumberStepper`. Worth knowing before putting any list inside a modal on a scrolling screen.
- **A translucent token on a NATIVE surface composites over UIKit, not over the app.** `useStackChrome` handed the native header `surface`, which is `oklch(1 0 0 / 4%)` in dark — translucent white, correct for every other consumer because they all lay it over a View already painting `background`. A native header has no such backdrop: it blended over UIKit's own bar material, so 4% white let the system's LIGHT chrome through and the vault screen rendered a white bar with white title text on it. Fixed by taking `background-secondary`, which is the opaque form of the same idea (`color-mix(background 96%, foreground 4%)`). Check a token's alpha before handing it to anything native — the glass tints are deliberately translucent and correct, because tinting a material is what they are for.
- **For the painted theme, read `useUniwind()` — not `useColorScheme()`.** They are two systems, and `components/account/appearance.ts` documents them going out of sync: Uniwind paints, while RN's `Appearance` (what `useColorScheme` reads) is a separate JS cache. `ScreenGradient` was built on `useColorScheme` and painted the LIGHT wash over the dark theme — measured rgb(128,129,129) at the top of a dark Markets tab whose background is rgb(10,11,12). `applyAppearance` does set both, and after a reload they agree (the chart, `glass.tsx`, `MarketHighlightCard` and `VaultListRow` all still read `useColorScheme` and were verified correct through a runtime light↔dark switch), so this is not a standing breakage — but `useUniwind().theme` is the value that cannot disagree with what is on screen, and it is what `AppearanceCard` already uses.
- **`src/fontClasses.test.ts` enforces the font rule** (every text tag names a `font-*` class, a `fontFamily`, or forwards `className={className}`), with a brace-aware JSX attribute parser — a regex sweep cannot see template-literal classNames, and an attempt to patch from one flattened conditional tones across eighteen files. Never rewrite JSX attributes with a regex.
- Several packages are pinned to exact versions in `package.json` (`@shopify/react-native-skia`, `react-native-reanimated`, `react-native-worklets`, `react-native-svg`, `react-native-keyboard-controller`, `react`, `react-native`) because they are native or Expo-SDK-aligned. Don't loosen those ranges casually — run `bunx expo install --check` to see what Expo considers compatible.
