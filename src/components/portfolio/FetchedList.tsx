/**
 * The five states of a one-shot read, rendered so they cannot be confused.
 *
 * The screen's own header states this as a rule: *deferred is not empty*. Four
 * of the five cases below would render as an empty list in a naive version, and
 * each would say something false about the account:
 *
 * - `idle` — nothing was asked for. Not "you have none".
 * - `loading` — skeleton rows, not "no transfers yet" for an account with 400.
 * - `deferred` — the per-IP weight budget declined the call. A retry works, so
 *   the user is offered one.
 * - `error` — a failed read is not an empty account.
 * - `ready` + zero rows — the ONLY case that is genuinely empty.
 *
 * `deferred` is deliberately not styled as an error. It is the app protecting a
 * shared allowance, it is expected on a busy screen, and it resolves on its
 * own; a red banner would train the user to distrust a working client.
 */

import type { JSX, ReactNode } from "react";
import { View } from "react-native";
import { Button, Chip, Typography } from "heroui-native";

import { describeFetched } from "@/components/portfolio/fetchedView";
import { Empty, LoadingRows } from "@/components/portfolio/primitives";
import type { Fetched } from "@/hyperliquid/hooks/history";

export function FetchedList<T>({
  state,
  refresh,
  isEmpty,
  emptyTitle,
  emptyDescription,
  children,
}: {
  state: Fetched<T>;
  refresh: () => void;
  /** Whether a READY value should render as the empty state. */
  isEmpty: (value: T) => boolean;
  emptyTitle: string;
  emptyDescription: string;
  children: (value: T) => ReactNode;
}): JSX.Element {
  // The five-way decision lives in `describeFetched`, which is testable
  // without mounting a component — rendering `heroui-native` under Jest pulls
  // in Reanimated and Skia, which have no native modules there.
  const view = describeFetched(state, { isEmpty, emptyTitle, emptyDescription });

  switch (view.kind) {
    case "idle":
      return <Empty title={view.title} description={view.description} />;

    case "loading":
      return <LoadingRows />;

    case "notice":
      return (
        <View className="items-start gap-2 py-6">
          <Chip size="sm" variant="soft" {...(view.tone === "danger" ? { color: "danger" } : {})}>
            <Chip.Label className="font-medium">{view.label}</Chip.Label>
          </Chip>
          <Typography.Paragraph className="text-xs text-muted font-normal">
            {view.detail}
          </Typography.Paragraph>
          <Button size="sm" variant="secondary" onPress={refresh}>
            <Button.Label className="font-medium">Try again</Button.Label>
          </Button>
        </View>
      );

    case "empty":
      return <Empty title={view.title} description={view.description} />;

    case "rows":
      return <>{children(state.kind === "ready" ? state.value : ({} as T))}</>;
  }
}

/**
 * "This list is not everything."
 *
 * Rendered above a capped list. `history/orders.ts` is explicit that older
 * history is unreachable past the cap — there is no cursor — so the wording
 * says "recent", never "all".
 */
export function TruncationNotice({ label }: { label: string }): JSX.Element {
  // No margin: the caller separates it from the list with its own `gap`, so
  // this component asserts nothing about its neighbours.
  return (
    <Chip size="sm" color="warning" variant="soft" className="self-start">
      <Chip.Label className="font-medium">{label}</Chip.Label>
    </Chip>
  );
}
