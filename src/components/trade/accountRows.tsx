/**
 * Account items shared by the Portfolio screen and the market sheet: the
 * position, the balance, and the open order.
 *
 * One component set, two screens — a fork drifts the moment one screen gets a
 * fix while the other keeps rendering yesterday's row for the same datum.
 * Items are presentation only: every datum and every callback arrives as a
 * prop — no hook call, no store read.
 *
 * ## Design language (third pass, 2026-08-29)
 *
 * The reference is HL's own web app at phone width, and the user's standing
 * rule is on record twice: *plain heroui components, no custom styling beyond
 * size*. So a position is a stack of **label-left / value-right lines** — the
 * exact anatomy the market Info list and the order form already use — under a
 * plain header (coin + side chip, PnL right). No rails, no uppercase
 * micro-labels, no bespoke grids: the first "richer" attempt shipped all three
 * and read as generated filler.
 *
 * ## Fourth pass, 2026-08-30
 *
 * Two things the user called out, and the rule that decided both: **add
 * information, never ornament.**
 *
 * The actions now span the card. They were small right-aligned pills, which on
 * a cross position — the majority — meant a single 70pt button marooned under
 * a full-width card.
 *
 * Liquidation became a bar. It had been a sixth fact line printed in red on
 * every position, which is not a warning: a colour that never varies carries
 * no information. `liquidationBuffer` computes the room left and the bar is
 * tinted by it, so red now means close. It reuses the partial-fill bar's
 * anatomy from the open-order row below rather than inventing a device, and it
 * draws nothing at all when the position has no liquidation price — which is
 * the common case, and where a bar would be exactly the filler that got the
 * first attempt rejected.
 */

import type { JSX } from "react";
import { Pressable, View } from "react-native";
import { Button, Chip, Typography } from "heroui-native";
import { ProgressBar } from "heroui-native-pro";

import { ConfirmButton } from "@/components/portfolio/ConfirmButton";
import { CoinBadge, Usd, UsdLabel } from "@/components/portfolio/primitives";
import { displayNumber, formatWirePrice, trendOf } from "@/components/common/display";
import { liquidationBuffer } from "@/components/trade/tradeView";
import type { NamedOutcome } from "@/hyperliquid/hooks/predictions";
import { pnlOf, valueOf, type SpotPrices } from "@/hyperliquid/hooks/prices";
import type { UnconfirmedOrder } from "@/hyperliquid/state/openOrders";
import type { OpenOrderRow, Position, SpotBalance } from "@/hyperliquid/types/domain";

/** The four-prop inert wrapper — chips inside row pressables must not eat
 *  taps (heroui Chip's internal Pressable takes finger taps AND its AX
 *  element takes synthesized ones — both observed live). */
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

/**
 * One fact: label muted on the left, value tabular on the right — the same
 * line the market Info card and the order form draw, so a position reads in
 * the app's own voice.
 */
function FactLine({
  label,
  value,
  tone,
}: {
  label: string;
  value: JSX.Element | string;
  tone?: "danger";
}): JSX.Element {
  return (
    <View className="flex-row items-center justify-between gap-4">
      <Typography.Paragraph className="text-sm text-muted font-normal">
        {label}
      </Typography.Paragraph>
      <Typography.Paragraph
        className={`text-sm tabular-nums font-medium ${tone === "danger" ? "text-danger" : ""}`}
        numberOfLines={1}
      >
        {value}
      </Typography.Paragraph>
    </View>
  );
}

export function PositionItem({
  position,
  onClose,
  onOpenDetail,
  onAdjustMargin,
  isBusy,
  canTrade,
}: {
  position: Position;
  onClose: () => void;
  onOpenDetail: () => void;
  /**
   * Isolated positions only — a compact button, because only they have margin
   * of their own to move. Cross rows never render it. Omit to render nothing
   * (the Portfolio surface, which has its own detail).
   */
  onAdjustMargin?: () => void;
  isBusy: boolean;
  /** Trading is gated on the agent; without one the button would always fail. */
  canTrade: boolean;
}): JSX.Element {
  const pnlTrend = trendOf(position.unrealizedPnl);
  const pnlClass = pnlTrend === "down" ? "text-danger" : "text-success";
  const roe = (displayNumber(position.returnOnEquity) * 100).toFixed(1);
  const buffer = liquidationBuffer(position);

  return (
    <Pressable accessible={false} className="gap-3 py-3" onPress={onOpenDetail}>
      {/* Header: identity left, result right — the only line with colour. */}
      <View className="flex-row items-center gap-2">
        <CoinBadge coin={position.coin} />
        <View className="flex-1 flex-row items-center gap-2">
          <Typography.Paragraph className="font-semibold leading-5">
            {position.coin}
          </Typography.Paragraph>
          <InertChip>
            <Chip size="sm" color={position.side === "long" ? "success" : "danger"} variant="soft">
              <Chip.Label className="font-medium">
                {position.side} {position.leverage}x
              </Chip.Label>
            </Chip>
          </InertChip>
        </View>
        <View className="items-end">
          <Typography.Paragraph className={`tabular-nums font-semibold ${pnlClass}`}>
            <UsdLabel value={position.unrealizedPnl} signed />
          </Typography.Paragraph>
          <Typography.Paragraph className={`text-xs tabular-nums font-normal ${pnlClass}`}>
            {roe}%
          </Typography.Paragraph>
        </View>
      </View>

      {/* The facts, one per line, the way the reference (and the rest of this
          app) states a fact. Mode rides here rather than as a second chip —
          "cross" is a fact about margin, not a status. */}
      <View className="gap-1.5">
        <FactLine label="Size" value={position.size} />
        <FactLine label="Value" value={<UsdLabel value={position.notionalValue} />} />
        <FactLine label="Entry price" value={position.entryPxDisplay} />
        <FactLine
          label={`Margin (${position.marginMode})`}
          value={<UsdLabel value={position.marginUsed} />}
        />
      </View>

      {/* Liquidation, as room left rather than a number to interpret.
          This was a sixth fact line, permanently red. Red on every position
          including one 40% clear of liquidation is crying wolf — the colour
          stopped carrying information the moment it never varied. So the
          price keeps its line, and a bar under it says how close that price
          actually is, tinted by `liquidationBuffer`'s severity.

          The bar is the SAME anatomy the partial-fill bar below already uses,
          not a new device — and it renders only when the buffer is real. A
          position with no liquidation price (the common case) draws nothing;
          an invented bar there would be the decoration this file's header
          warns about. */}
      {buffer === null ? (
        <FactLine label="Liq. price" value="--" />
      ) : (
        <View className="gap-1.5">
          <FactLine
            label="Liq. price"
            // Significant figures, never a fixed fraction cap — see
            // `formatWirePrice`. A `maximumFractionDigits: 1` used to sit here
            // and rendered a real 0.1534 liquidation price as "0.2" (and 0.04
            // as "0", i.e. no risk at all) on the one row where a trader
            // decides whether to add margin or close; rendering the wire value
            // raw instead gave "66879.2151898734", because a server-computed
            // price carries the whole float.
            value={formatWirePrice(position.liquidationPx ?? "")}
            // Red for danger ONLY. The bar already carries warning in amber,
            // and a red number over an amber bar states two different
            // severities for one fact.
            tone={buffer.severity === "danger" ? "danger" : undefined}
          />
          <ProgressBar value={buffer.room} size="sm" color={buffer.severity}>
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
          <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
            {`${(buffer.fraction * 100).toFixed(1)}% from liquidation`}
          </Typography.Paragraph>
        </View>
      )}

      {/* Full width, split evenly. These were small right-aligned pills, and
          on a cross position — where the Margin button never renders — that
          left one 70pt button alone under a full-width card with a hand's
          width of empty space beside it (user call, 2026-08-30). A card action
          spans its card; two of them share it. The `flex-1` wrappers are what
          stretch the buttons, since neither takes a width of its own.

          The armed label still names the size: "Close?" beside several rows
          does not say which one is armed. */}
      <View className="flex-row items-center gap-2">
        {onAdjustMargin === undefined || position.marginMode !== "isolated" || !canTrade ? null : (
          <View className="flex-1">
            <Button size="sm" variant="tertiary" onPress={onAdjustMargin}>
              <Button.Label className="font-medium">Margin</Button.Label>
            </Button>
          </View>
        )}
        <View className="flex-1">
          <ConfirmButton
            label="Close"
            confirmLabel={`Close ${position.size}?`}
            onConfirm={onClose}
            isBusy={isBusy}
            isDisabled={!canTrade}
          />
        </View>
      </View>
    </Pressable>
  );
}

/**
 * Left: name over amount. Right: USD value over PnL.
 *
 * Value and PnL are only shown when they are KNOWN — `valueOf`/`pnlOf` return
 * `null` for a token with no quote and for a holding with no cost basis, and
 * both render "--" rather than a `$0.00` that would read as "worthless" for
 * something that merely has no price. The dashes are the honest state.
 *
 * `named` is what turns `+102251` into *"June Fed rate change · No Change"*. It
 * is `null` while the catalog loads and permanently for a settled market, which
 * falls back to the encoding — true, if unhelpful — never to an invented label.
 */
export function BalanceItem({
  balance,
  named,
  prices,
}: {
  balance: SpotBalance;
  named?: NamedOutcome | null;
  prices: SpotPrices;
}): JSX.Element {
  const value = valueOf(balance.coin, balance.total, prices);
  const pnl = pnlOf(value, balance.costBasisNtl);

  // An outcome row's own line is its side ("No Change"); the title above is the
  // market. A token row has no such split, so the amount carries the free/held
  // breakdown instead.
  const title = named ? named.outcome.name : balance.coin;
  const amount = `${balance.total}${displayNumber(balance.hold) > 0 ? ` · ${balance.available} free` : ""}`;
  const subtitle = named
    ? `${named.sideName ?? `side ${balance.coin}`} · ${balance.total} shares`
    : amount;

  return (
    <View className="flex-row items-center gap-3 py-3">
      <CoinBadge coin={balance.coin} monogram={named?.sideName ?? undefined} />
      <View className="flex-1">
        <Typography.Paragraph className="font-semibold" numberOfLines={1}>
          {title}
        </Typography.Paragraph>
        <Typography.Paragraph
          className="text-xs text-muted tabular-nums font-normal"
          numberOfLines={1}
        >
          {subtitle}
        </Typography.Paragraph>
      </View>
      <View className="items-end">
        <Typography.Paragraph className="tabular-nums font-semibold">
          {value === null ? "--" : <Usd value={value} />}
        </Typography.Paragraph>
        {pnl === null ? (
          <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
            --
          </Typography.Paragraph>
        ) : (
          <Typography.Paragraph
            className={`text-xs tabular-nums font-normal ${displayNumber(pnl) < 0 ? "text-danger" : "text-success"}`}
          >
            <UsdLabel value={pnl} signed />
          </Typography.Paragraph>
        )}
      </View>
    </View>
  );
}

/**
 * One confirmed resting order.
 *
 * The fill bar renders only when something HAS filled — remaining vs placed
 * is then the fact a cancel acts on, and the track makes the proportion
 * legible where "0.3 of 1.0" asks for arithmetic. A fresh order shows its
 * size plainly; a whole-position bracket shows "Position", because its wire
 * size is the literal "0" that means "track the position".
 */
export function OpenOrderItem({
  row,
  named,
  onOpenDetail,
  onCancel,
  isBusy,
  canTrade,
}: {
  row: OpenOrderRow;
  named?: NamedOutcome | null;
  onOpenDetail: () => void;
  onCancel: () => void;
  isBusy: boolean;
  /** Trading is gated on the agent; without one the button would always fail. */
  canTrade: boolean;
}): JSX.Element {
  const placed = displayNumber(row.originalSz);
  const remaining = displayNumber(row.remainingSz);
  const filled = placed > 0 ? Math.max(0, Math.min(1, 1 - remaining / placed)) : 0;
  const isPartial = !row.isPositionTpsl && row.remainingSz !== row.originalSz && placed > 0;

  return (
    <Pressable accessible={false} onPress={onOpenDetail}>
      <View className="gap-2 py-3">
        <View className="flex-row items-center gap-3">
          <CoinBadge coin={row.coin} monogram={named?.sideName ?? undefined} />
          <View className="flex-1">
            <View className="flex-row items-center gap-2">
              <Typography.Paragraph className="font-semibold leading-5" numberOfLines={1}>
                {/* A resting outcome order names its market too — the coin is
                    `#102251`, not a ticker. */}
                {named?.outcome.name ?? row.coin}
              </Typography.Paragraph>
              <InertChip>
                <Chip size="sm" color={row.side === "buy" ? "success" : "danger"} variant="soft">
                  <Chip.Label className="font-medium">{row.side}</Chip.Label>
                </Chip>
              </InertChip>
              {row.isTrigger ? (
                <InertChip>
                  <Chip size="sm" variant="soft">
                    <Chip.Label className="font-medium">trigger</Chip.Label>
                  </Chip>
                </InertChip>
              ) : null}
            </View>
            <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
              {/* A trigger order's `limitPx` is where it RESTS once fired, not
                  what fires it — the trigger is the number the user set, so
                  the trigger is what it shows. */}
              {row.isPositionTpsl ? "Position" : row.remainingSz} @{" "}
              {row.isTrigger ? (row.triggerPx ?? row.limitPx) : row.limitPx}
            </Typography.Paragraph>
          </View>
          <ConfirmButton
            label="Cancel"
            confirmLabel="Cancel?"
            onConfirm={onCancel}
            isBusy={isBusy}
            isDisabled={!canTrade}
          />
        </View>
        {isPartial ? (
          <View className="gap-1">
            <ProgressBar value={filled * 100} size="sm">
              <ProgressBar.Track>
                <ProgressBar.Fill />
              </ProgressBar.Track>
            </ProgressBar>
            <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
              {row.remainingSz} of {row.originalSz} remaining
            </Typography.Paragraph>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * An order this client submitted that no snapshot has confirmed yet.
 *
 * Rendered distinctly — dimmed, with a "confirming…" chip — because it is a
 * claim, not a fact (the store's own words). The overlay is why a just-placed
 * order appears immediately; a list that hid it would make the order form
 * look like it did nothing for the ~5s until the websocket confirms.
 */
export function UnconfirmedOrderItem({ order }: { order: UnconfirmedOrder }): JSX.Element {
  return (
    <View className="flex-row items-center justify-between py-3 opacity-60">
      <Typography.Paragraph className="font-normal">{order.label ?? "order"}</Typography.Paragraph>
      <Chip size="sm" variant="soft">
        <Chip.Label className="font-medium">confirming…</Chip.Label>
      </Chip>
    </View>
  );
}
