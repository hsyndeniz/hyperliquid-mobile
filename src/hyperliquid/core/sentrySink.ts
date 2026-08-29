/**
 * The Sentry log sink.
 *
 * Closes a real gap rather than adding a feature: `setup.ts` registered the
 * console sink **only under `__DEV__`**, so a release build ran with no sink at
 * all and the logger discarded every event. Every carefully-worded
 * `logger.warn("submit.unknown", …)` in this codebase reached nobody in the one
 * build where it matters.
 *
 * ## Why the API is injected rather than imported
 *
 * `@sentry/react-native` is a native module. Importing it here would put it in
 * the path of `moduleImports.test.ts`, which imports every module under Jest —
 * the same hazard `react-native-mmkv` already needs an in-memory mock for. So
 * this file has no React Native dependency at all, and `setup.ts` hands it the
 * three functions it needs, exactly as it already does for the vault's crypto
 * and the native PBKDF2.
 *
 * ## Redaction is not this file's job, and that is deliberate
 *
 * `core/logger.ts` redacts **before** any sink is called (`emit()` runs
 * `redact(options.context)`), so a `LogEvent` arriving here has already had
 * private keys, mnemonics, signatures and raw EIP-712 payloads stripped by key
 * name at every depth. A sink therefore *cannot* leak them, which is the whole
 * reason the sink boundary sits where it does. Nothing here should try to
 * re-derive or enrich a context — that would reach around the guarantee.
 */

import type { LogEvent, LogSink } from "@/hyperliquid/core/logger";

/**
 * The slice of Sentry this needs.
 *
 * Three functions wide, so the real SDK, a stub, or a test double all satisfy it
 * without an adapter.
 */
export interface SentryApi {
  addBreadcrumb(breadcrumb: {
    category?: string;
    message?: string;
    level?: "debug" | "info" | "warning" | "error";
    data?: Record<string, unknown>;
  }): void;
  captureMessage(
    message: string,
    context?: { level?: "debug" | "info" | "warning" | "error"; extra?: Record<string, unknown> }
  ): void;
}

/**
 * Forward log events to Sentry.
 *
 * **Only `error` becomes an issue.** Everything below it is a breadcrumb, which
 * is what makes the trail useful: by the time an order failure is captured, the
 * preceding submit, the agent gate and the subscription churn are attached to
 * it. Capturing every `info` as an issue would bury the ones that matter and
 * burn the quota on a websocket that reconnected.
 *
 * `captureMessage` rather than `captureException`, because a `LogEvent.error` is
 * already a **serialised summary** — `serializeError` reduced the throw to a
 * plain object precisely so no raw value reaches a sink. There is no `Error` left
 * to capture, and synthesising one would produce a stack pointing at this file
 * rather than at the failure.
 *
 * The scope and event name form the issue title, so Sentry groups by them —
 * `[orders] submit.unknown` stays one issue however the message text changes.
 * That is the same reason `core/errors.ts` fingerprints on `code` and never on
 * message text.
 */
export function createSentrySink(sentry: SentryApi): LogSink {
  return {
    capture(event: LogEvent): void {
      const title = `[${event.scope}] ${event.event}`;
      const data = {
        ...event.context,
        ...(event.durationMs !== undefined && { durationMs: event.durationMs }),
      };

      if (event.level === "error") {
        sentry.captureMessage(title, {
          level: "error",
          extra: { ...data, ...(event.error && { error: event.error }) },
        });
        return;
      }

      sentry.addBreadcrumb({
        category: event.scope,
        message: event.event,
        level: event.level === "warn" ? "warning" : event.level,
        ...(Object.keys(data).length > 0 && { data }),
      });
    },
  };
}
