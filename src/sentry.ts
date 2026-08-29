/**
 * Crash and diagnostic reporting.
 *
 * A side-effect module, like [polyfills.ts](polyfills.ts): importing it runs
 * `Sentry.init`. It lives here rather than in the root layout because a layout
 * component should not own SDK configuration, and because init must happen at
 * module-evaluation time — before any component renders — for a crash during
 * startup to be reported at all.
 *
 * **Import order matters, and this goes second.** `polyfills.ts` must still run
 * first: `@noble/hashes` captures `globalThis.crypto` once at module-evaluation
 * time, so anything pulling in `viem`/`@noble` ahead of the shim permanently
 * breaks key generation. Sentry is imported immediately after it.
 *
 * `setupHyperliquid({ sentry })` in the root layout then hands {@link sentry} to
 * the Hyperliquid module as a log sink. That is what gives a **release build**
 * any diagnostics at all — its console sink is registered only under `__DEV__`,
 * so before this the logger discarded every event in the one build where a log
 * is the only way to learn what happened.
 */

import * as Sentry from "@sentry/react-native";

/**
 * The project this build reports to, from the environment.
 *
 * `EXPO_PUBLIC_` because it is read on the device: babel-preset-expo inlines it
 * at build time, so it ships inside the bundle either way. That is fine and is
 * what a DSN is for — it is a write-only ingest endpoint, not a credential, and
 * every mobile app that reports crashes ships one. The token that CAN do
 * damage is `SENTRY_AUTH_TOKEN`, which uploads source maps at BUILD time, has
 * never been `EXPO_PUBLIC_`, and must never become it.
 *
 * Out of the source so a fork reports to its own project rather than silently
 * to this one, and so the repository names no infrastructure it does not have
 * to. **Empty is a supported state**: `Sentry.init` with no DSN disables
 * transport and every call becomes a no-op, which is exactly right for a
 * contributor who has not set one up. The Hyperliquid module then simply has
 * no remote log sink — `setupHyperliquid` already treats that as normal.
 */
const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN ?? "";

Sentry.init({
  // `undefined`, not `""` — the SDK treats an empty string as a malformed DSN
  // and warns on every launch, where omitting it is the documented way to run
  // disabled.
  dsn: DSN === "" ? undefined : DSN,

  // Both of these arrived from `@sentry/wizard` and neither survives a look at
  // what this app handles.
  //
  // `sendDefaultPii` attaches the IP address and user context to every event.
  // For a wallet that ties a network location to on-chain activity, which is a
  // linkage worth not creating. The diagnostics that matter here — which
  // action, which outcome, which channel — travel in the log events themselves.
  sendDefaultPii: false,
  //
  // `enableLogs: true` installs `consoleLoggingIntegration()` with NO level
  // filter (verified in the installed package: `integrations/default.js:45`
  // pushes it, and `logs/console-integration.js:19` falls back to every
  // `CONSOLE_LEVELS` entry). That ships every `console.*` in the process —
  // React Native's own warnings, viem's, the Hyperliquid SDK's — straight to
  // Sentry WITHOUT passing `core/logger`.
  //
  // Which is precisely the boundary this project's sink architecture exists to
  // hold. `core/sentrySink.ts` states it: "`core/logger.ts` redacts BEFORE any
  // sink is called … A sink therefore *cannot* leak them, which is the whole
  // reason the sink boundary sits where it does." A console integration is a
  // second sink on the other side of that line, and viem in particular embeds
  // request payloads in the warnings it emits.
  //
  // Nothing is lost by removing it: the deliberate sink is registered through
  // `setupHyperliquid({ sentry })` and uses `addBreadcrumb`/`captureMessage`,
  // not the console.
  enableLogs: false,
  // Session Replay is OFF — it was measured, not assumed, to cost real main-
  // thread time. Instruments on the Markets tab (2026-08-27): 7.3% of the main
  // thread in a 39 s session — `SentrySessionReplay.newFrame` 394 ms plus
  // `SentryViewRendererV2.render` 330 ms — serialising a view tree that holds a
  // windowed 1,300-row list. On a trading screen every main-thread millisecond
  // is a tick the ladder does not paint, so replay lost its seat.
  //
  // If it ever returns: `mobileReplayIntegration` masks all text/images/vectors
  // by default, and `screenGuards.test.ts` bans `unmask` from `src/` outright —
  // the recovery-phrase screen renders real words, and one stray `unmask` for a
  // chart would put them in a sampled replay. That ban stays enforced even with
  // replay off, deliberately: it is the cheaper half of the protection.
  integrations: [Sentry.feedbackIntegration()],
  // uncomment to enable Spotlight (https://spotlightjs.com)
  spotlight: __DEV__,
});

/**
 * The initialised SDK.
 *
 * Re-exported so the one call site that needs it — `setupHyperliquid` — takes it
 * as an argument rather than importing `@sentry/react-native` itself. The
 * Hyperliquid module stays free of React Native imports, which is what keeps it
 * out of the path of `moduleImports.test.ts`.
 */
export { Sentry as sentry };
