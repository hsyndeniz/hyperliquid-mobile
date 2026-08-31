/**
 * Rows for the four activity sections: trades, TWAPs, transfers, past orders.
 *
 * Each of these renders a wire shape whose documented traps are easy to walk
 * into, and the comments below name the specific one rather than describing the
 * markup. The recurring theme is that a *display string* from the exchange is
 * an open set: `dir` on a fill, `type` on a ledger row and `status` on a TWAP
 * all keep gaining values, so each is rendered verbatim instead of being
 * switched on.
 */

import type { JSX } from "react";
import { BigNumber } from "bignumber.js";
import { View } from "react-native";
import { Chip, Typography } from "heroui-native";
import { ProgressBar } from "heroui-native-pro";

import { progressPercent } from "@/components/portfolio/fetchedView";
import { CoinBadge, UsdLabel } from "@/components/portfolio/primitives";
import { shortTime, signColor, useNowHourly } from "@/components/common/display";
import {
  ledgerAmount,
  ledgerDexes,
  ledgerDirection,
  type LedgerRow,
} from "@/hyperliquid/history/ledger";
import type { FundingLedgerRow } from "@/hyperliquid/api/accountMeta";
import type { OrderLifecycle } from "@/hyperliquid/history/orders";
import { twapAveragePrice, twapProgress } from "@/hyperliquid/history/twap";
import type { TwapRow } from "@/hyperliquid/hooks/history";
import type { NamedOutcome } from "@/hyperliquid/hooks/predictions";
import type { Fill } from "@/hyperliquid/types/domain";

/**
 * One execution.
 *
 * Three things here are not obvious from the payload:
 *
 * - **`side`, not `dir`, decides buy/sell colour.** `dir` is a display string
 *   with 13+ observed values, including spot ones ("Spot Dust Conversion",
 *   "Settlement") that fall through every long/short branch.
 * - **`fee` is signed** — a negative fee is a maker rebate, real on 433 of 4,000
 *   measured fills — and `feeToken` is **not always USDC**, so the fee is shown
 *   with its own token rather than as dollars.
 * - **`closedPnl` is gross of fees and per-fill.** It is only meaningful on a
 *   closing fill, so it is shown only when non-zero rather than as "$0.00" on
 *   every open.
 */
/**
 * A chip that cannot take a touch, inside a row that can.
 *
 * Every row in this file is rendered inside a `Pressable` (portfolio.tsx wraps
 * `FillItem`, `LedgerItem` and their siblings), and a heroui `Chip` steals
 * that tap TWICE over: its own `Pressable` swallows a finger, and its
 * accessibility element swallows a synthesized one. The row then looks
 * tappable and simply does nothing wherever a chip happens to sit.
 *
 * The same four props as `trade/accountRows.tsx`'s wrapper — `pointerEvents`
 * for the finger, the two AX props for the element. Only the chips are made
 * inert; the row's text stays readable.
 */
function InertChip({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <View
      className="pointer-events-none"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {children}
    </View>
  );
}

export function FillItem({
  fill,
  named,
}: {
  fill: Fill;
  /** Set for an outcome fill, whose coin is `#102251` rather than a ticker. */
  named?: NamedOutcome | null;
}): JSX.Element {
  const now = useNowHourly();
  const isClose = Number(fill.closedPnl) !== 0;
  const title = named ? named.outcome.name : fill.coin;
  return (
    <View className="flex-row items-center gap-3 py-3">
      <CoinBadge coin={fill.coin} monogram={named?.sideName ?? undefined} />
      <View className="flex-1">
        {/* `items-stretch` + a centring wrapper per child: both get the row's
            cross height and centre their own content, so text and pill share a
            centre line without a margin nudge. */}
        <View className="flex-row items-stretch gap-2">
          <View className="shrink justify-center">
            <Typography.Paragraph className="font-medium leading-5" numberOfLines={1}>
              {title}
            </Typography.Paragraph>
          </View>
          <View className="justify-center">
            <InertChip>
              <Chip size="sm" color={fill.side === "buy" ? "success" : "danger"} variant="soft">
                <Chip.Label className="font-medium">{fill.side}</Chip.Label>
              </Chip>
            </InertChip>
          </View>
          {fill.liquidation !== null ? (
            <InertChip>
              <Chip size="sm" color="danger" variant="soft">
                <Chip.Label className="font-medium">liquidation</Chip.Label>
              </Chip>
            </InertChip>
          ) : null}
          {fill.source === "twapSlice" ? (
            <InertChip>
              <Chip size="sm" variant="soft">
                <Chip.Label className="font-medium">TWAP</Chip.Label>
              </Chip>
            </InertChip>
          ) : null}
        </View>
        <Typography.Paragraph
          className="text-xs text-muted tabular-nums font-normal"
          numberOfLines={1}
        >
          {/* `dir` verbatim — an open set, never switched on. For an outcome
              fill the side name says more than "Buy" alone does. */}
          {named?.sideName ? `${named.sideName} · ` : ""}
          {fill.dir} · {shortTime(fill.time, now)}
        </Typography.Paragraph>
      </View>
      <View className="items-end">
        <Typography.Paragraph className="text-sm tabular-nums font-medium">
          {fill.sz} @ {fill.px}
        </Typography.Paragraph>
        {isClose ? (
          <Typography.Paragraph
            className={`text-xs tabular-nums font-normal ${signColor(fill.closedPnl)}`}
          >
            <UsdLabel value={fill.closedPnl} signed />
          </Typography.Paragraph>
        ) : (
          <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
            {/* Negative is a rebate; the token is shown because it is not
                always USDC and summing blind would add BTC to dollars. */}
            {fill.fee} {fill.feeToken}
          </Typography.Paragraph>
        )}
      </View>
    </View>
  );
}

/**
 * One TWAP, as history reports it.
 *
 * `state` is nullable because a history row's state can fail to parse, and the
 * row still carries a real time and status worth showing — dropping it would
 * hide a TWAP that ran. `twapId` is absent from history rows entirely (measured
 * on 12,806), so there is nothing to key on but the index.
 */
export function TwapItem({ row }: { row: TwapRow }): JSX.Element {
  const now = useNowHourly();
  const state = row.state;
  const progress = state === null ? null : twapProgress(state);
  const average = state === null ? null : twapAveragePrice(state);

  // Only a RUNNING TWAP earns a live bar; finished and terminated rows state
  // their percentage and stop drawing attention.
  const running = row.status === "activated" && progress !== null;

  return (
    <View className="gap-2 py-3">
      <View className="flex-row items-center gap-3">
        <CoinBadge coin={state?.coin ?? "?"} />
        <View className="flex-1">
          <View className="flex-row items-stretch gap-2">
            <View className="justify-center">
              <Typography.Paragraph className="font-medium leading-5">
                {state?.coin ?? "TWAP"}
              </Typography.Paragraph>
            </View>
            {state !== null ? (
              <View className="justify-center">
                <InertChip>
                  <Chip size="sm" color={state.isBuy ? "success" : "danger"} variant="soft">
                    <Chip.Label className="font-medium">{state.isBuy ? "buy" : "sell"}</Chip.Label>
                  </Chip>
                </InertChip>
              </View>
            ) : null}
            {/* `status` verbatim: "activated", "finished", "terminated", and
                whatever the exchange adds next. */}
            <InertChip>
              <Chip size="sm" variant="soft">
                <Chip.Label className="font-medium">{row.status}</Chip.Label>
              </Chip>
            </InertChip>
          </View>
          <Typography.Paragraph
            className="text-xs text-muted tabular-nums font-normal"
            numberOfLines={1}
          >
            {state === null
              ? shortTime(row.time, now)
              : `${state.durationMinutes}m${state.reduceOnly ? " · reduce-only" : ""}${
                  state.randomize ? " · randomized" : ""
                } · ${shortTime(row.time, now)}`}
          </Typography.Paragraph>
        </View>
        <View className="items-end">
          <Typography.Paragraph className="text-sm tabular-nums font-medium">
            {/* `progressPercent`, NOT the raw fraction: `twapProgress` returns
                "0.5" for half-done, and a bare % suffix rendered that as
                0.5% — wrong by two orders of magnitude. */}
            {progress === null ? "--" : progressPercent(progress)}
          </Typography.Paragraph>
          <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
            {/* Average is null before anything executed — division by zero, not
                a price of zero. */}
            {average === null ? `${state?.size ?? "--"}` : `avg ${average}`}
          </Typography.Paragraph>
        </View>
      </View>
      {running ? (
        <ProgressBar value={Number(progress) * 100} size="sm">
          <ProgressBar.Track>
            <ProgressBar.TrackBackground />
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      ) : null}
    </View>
  );
}

/**
 * One transfer, deposit or withdrawal.
 *
 * `viewer` is required, not optional: direction is computed from the viewer's
 * address, and a row where both sides are the account is `internal` — 45.7% of
 * `send` rows — which is neither in nor out. Guessing from the type alone would
 * label every internal move as a withdrawal.
 *
 * `type` is rendered verbatim for the same reason as `dir`: new types keep
 * appearing, and `history/ledger.ts` keeps `delta` unparsed to survive that.
 */
export function LedgerItem({ row, viewer }: { row: LedgerRow; viewer: string }): JSX.Element {
  const now = useNowHourly();
  const direction = ledgerDirection(row, viewer);
  const amount = ledgerAmount(row);
  const dexes = ledgerDexes(row);

  const color =
    direction === "in" ? "success" : direction === "out" ? "danger" : ("default" as const);
  const sign = direction === "in" ? "+" : direction === "out" ? "-" : "";

  return (
    <View className="flex-row items-center gap-3 py-3">
      <View className="flex-1">
        <View className="flex-row items-stretch gap-2">
          <View className="shrink justify-center">
            <Typography.Paragraph className="font-medium leading-5" numberOfLines={1}>
              {row.type}
            </Typography.Paragraph>
          </View>
          <View className="justify-center">
            <InertChip>
              <Chip size="sm" color={color} variant="soft">
                <Chip.Label className="font-medium">{direction}</Chip.Label>
              </Chip>
            </InertChip>
          </View>
        </View>
        <Typography.Paragraph
          className="text-xs text-muted tabular-nums font-normal"
          numberOfLines={1}
        >
          {/* An empty dex string is the DEFAULT PERP dex, a real value — not a
              missing field. Eight distinct dexes were measured, so this is not
              a spot-vs-perp toggle. */}
          {dexes === null
            ? shortTime(row.time, now)
            : `${dexes.from === "" ? "perp" : dexes.from} → ${
                dexes.to === "" ? "perp" : dexes.to
              } · ${shortTime(row.time, now)}`}
        </Typography.Paragraph>
      </View>
      <Typography.Paragraph
        className={`text-sm tabular-nums font-medium ${
          direction === "in" ? "text-success" : direction === "out" ? "text-danger" : ""
        }`}
      >
        {/* `null` when the type carries no money field at all — a real state
            for the gas auctions, not a zero. */}
        {amount === null ? "--" : `${sign}${amount}`}
      </Typography.Paragraph>
    </View>
  );
}

/**
 * One past order, collapsed from its event stream.
 *
 * `isTerminal === false` does **not** mean the order is live — it means the
 * history simply ends there, which is why the chip says "no final status"
 * rather than "open". An order that is genuinely resting shows in the live
 * open-orders list above, from a different source.
 */
export function OrderHistoryItem({
  order,
  named,
}: {
  order: OrderLifecycle;
  /** Set for an outcome order, whose coin is `#102251` rather than a ticker. */
  named?: NamedOutcome | null;
}): JSX.Element {
  const now = useNowHourly();
  return (
    <View className="flex-row items-center gap-3 py-3">
      <CoinBadge coin={order.coin} monogram={named?.sideName ?? undefined} />
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Typography.Paragraph className="font-medium leading-5" numberOfLines={1}>
            {named ? named.outcome.name : order.coin}
          </Typography.Paragraph>
          <InertChip>
            <Chip size="sm" color={order.side === "buy" ? "success" : "danger"} variant="soft">
              <Chip.Label className="font-medium">{order.side}</Chip.Label>
            </Chip>
          </InertChip>
        </View>
        <Typography.Paragraph
          className="text-xs text-muted tabular-nums font-normal"
          numberOfLines={1}
        >
          {/* `placedAt` is the FIRST event, deliberately — `order.timestamp`
              holds the fire time for a trigger order that fired. */}
          {shortTime(order.placedAt, now)}
          {order.events.length > 1 ? ` · ${order.events.length} events` : ""}
        </Typography.Paragraph>
      </View>
      <InertChip>
        <Chip size="sm" variant="soft" color={order.isTerminal ? "default" : "warning"}>
          <Chip.Label className="font-medium">
            {order.isTerminal ? order.finalStatus : "no final status"}
          </Chip.Label>
        </Chip>
      </InertChip>
    </View>
  );
}

/**
 * One funding tick.
 *
 * The `usdc` sign is the account's cash delta — verified by exact
 * reconciliation against `cumFunding` (see `FundingLedgerRow`) — so this row
 * may honestly say "paid" or "received" where the ledger tab must stay neutral.
 * The rate renders as a percent because `0.0000125` is not information and
 * `0.00125%` is; BigNumber does the ×100, never a float.
 */
export function FundingItem({ row }: { row: FundingLedgerRow }): JSX.Element {
  const now = useNowHourly();
  const received = !row.usdc.startsWith("-");

  return (
    <View className="flex-row items-center gap-3 py-3">
      <CoinBadge coin={row.coin} />
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Typography.Paragraph className="font-medium leading-5" numberOfLines={1}>
            {row.coin}
          </Typography.Paragraph>
          <InertChip>
            <Chip size="sm" color={received ? "success" : "danger"} variant="soft">
              <Chip.Label className="font-medium">{received ? "received" : "paid"}</Chip.Label>
            </Chip>
          </InertChip>
        </View>
        <Typography.Paragraph
          className="text-xs text-muted tabular-nums font-normal"
          numberOfLines={1}
        >
          rate {fundingRatePercent(row.fundingRate)} · {shortTime(row.time, now)}
        </Typography.Paragraph>
      </View>
      <Typography.Paragraph
        className={`text-sm tabular-nums font-medium ${received ? "text-success" : "text-danger"}`}
      >
        {/* The RAW wire value, not the 2dp money formatter: hourly funding on a
            small position is routinely sub-cent, and "-$0.00" says nothing. */}
        {received ? `+${row.usdc}` : row.usdc}
      </Typography.Paragraph>
    </View>
  );
}

/** `"0.0000125"` → `"0.00125%"`. BigNumber ×100; trailing zeros trimmed. */
function fundingRatePercent(rate: string): string {
  const ratio = new BigNumber(rate);
  if (!ratio.isFinite()) return "--";
  return `${ratio.multipliedBy(100).toFixed()}%`;
}
