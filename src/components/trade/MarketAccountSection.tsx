/**
 * Your account on the market sheet — the regular tabs, back (user call,
 * 2026-08-29), with the reference's per-tab filter row.
 *
 * The reference is HL's own web app at phone width: a tab strip
 * (`Balances | Positions | Open Orders | …`), then a filter row per tab
 * (`Side ⌄ Market ⌄ … Close All`), then the rows. The first replacement for
 * the old tabs monolith dropped the strip for stacked "contextual" sections
 * and a bespoke card — rejected on sight. This one copies the reference's
 * STRUCTURE with plain heroui components and nothing custom.
 *
 * Kept lean where the monolith was not: three LIVE tabs only. The history
 * tabs (trades, funding, orders, TWAP) are REST surfaces the Portfolio
 * already owns — a market sheet holds what moves with the socket.
 *
 * The write affordances survive: per-row Close/Cancel, bulk Close All
 * (Dialog-confirmed) and Cancel all (armed), all gated on the agent and
 * sharing one `useOrderActions` busy state; tapping a position opens the
 * TP/SL sheet, Margin (isolated only) the margin sheet.
 */

import type { JSX } from "react";
import { useState } from "react";
import { View } from "react-native";
import { Button, Card, Chip, Dialog, Tabs, Typography } from "heroui-native";

import {
  BalanceItem,
  OpenOrderItem,
  PositionItem,
  UnconfirmedOrderItem,
} from "@/components/trade/accountRows";
import { ConfirmButton } from "@/components/portfolio/ConfirmButton";
import { FilterMenu } from "@/components/common/FilterMenu";
import { ControlCheckbox } from "@/components/trade/formPrimitives";
import { MarginAdjustSheet } from "@/components/trade/MarginAdjustSheet";
import { PositionTpslSheet } from "@/components/trade/PositionTpslSheet";
import { priceDecimalsOf } from "@/components/trade/orderForm";
import type { TradableKind } from "@/components/trade/tradeView";
import { displayNumber } from "@/components/common/display";
import { useOpenOrders, usePositions, useSpotState } from "@/hyperliquid/hooks/account";
import { useOrderActions } from "@/hyperliquid/hooks/actions";
import { useSpotPrices } from "@/hyperliquid/hooks/prices";
import { useOutcomeNamer } from "@/hyperliquid/hooks/predictions";
import { useCanTrade, useSessionState } from "@/hyperliquid/hooks/session";
import type { Position } from "@/hyperliquid/types/domain";
import { useHyperliquid } from "@/providers/HyperliquidProvider";

type AccountTab = "positions" | "orders" | "balances";

const SIDE_FILTERS = [
  { id: "all", label: "All sides" },
  { id: "long", label: "Long" },
  { id: "short", label: "Short" },
];
const ORDER_SIDE_FILTERS = [
  { id: "all", label: "All sides" },
  { id: "buy", label: "Buy" },
  { id: "sell", label: "Sell" },
];
const ORDER_TYPE_FILTERS = [
  { id: "all", label: "All types" },
  { id: "limit", label: "Limit" },
  { id: "trigger", label: "Trigger" },
];
const MARKET_FILTERS = [
  { id: "all", label: "All markets" },
  { id: "market", label: "This market" },
];

/** A balance too small to act on — same threshold Portfolio's toggle uses. */
const SMALL_BALANCE_USD = 1;

function Empty({ text }: { text: string }): JSX.Element {
  return (
    <Typography.Paragraph className="py-6 text-center text-sm text-muted font-normal">
      {text}
    </Typography.Paragraph>
  );
}

function Divided({ children }: { children: JSX.Element[] }): JSX.Element {
  return (
    <View>
      {children.map((child, index) => (
        <View key={index} className={index === 0 ? "" : "border-t border-border"}>
          {child}
        </View>
      ))}
    </View>
  );
}

export function MarketAccountSection({
  kind,
  coin,
}: {
  kind: TradableKind;
  /** The screen's wire coin — what the Market filter's "This market" means. */
  coin: string;
}): JSX.Element | null {
  const { session } = useHyperliquid();
  const sessionState = useSessionState(session);

  const actions = useOrderActions(session);
  const canTrade = useCanTrade(session);

  const positions = usePositions(session.stores.account);
  const orders = useOpenOrders(session.stores.openOrders);
  const spot = useSpotState(session.stores.spot);
  const { prices } = useSpotPrices();
  const nameOutcome = useOutcomeNamer();

  const [tab, setTab] = useState<AccountTab>("positions");
  const [sideFilter, setSideFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [marketOnly, setMarketOnly] = useState(false);
  const [hideSmall, setHideSmall] = useState(false);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);

  // Filters reset per tab: Side means long/short on one tab and buy/sell on
  // the next, so a held value would filter the wrong axis silently. The
  // render-phase adjustment is the sanctioned derived-state pattern.
  const [adoptedTab, setAdoptedTab] = useState(tab);
  if (adoptedTab !== tab) {
    setAdoptedTab(tab);
    setSideFilter("all");
    setTypeFilter("all");
  }

  const [tpslTarget, setTpslTarget] = useState<Position | null>(null);
  const [marginTarget, setMarginTarget] = useState<Position | null>(null);

  // Signed out: the sheet stays a market screen — the order screen's CTA
  // ladder owns the connect journey.
  if (sessionState === null) return null;

  // The bulk actions act on exactly what the body SHOWS — a Close All wider
  // than the filtered list would close positions the user cannot see.
  const shownPositions = positions
    .filter((position) => !marketOnly || position.coin === coin)
    .filter((position) => sideFilter === "all" || position.side === sideFilter);
  const shownOrders = orders.rows
    .filter((row) => !marketOnly || row.coin === coin)
    .filter((row) => sideFilter === "all" || row.side === sideFilter)
    .filter(
      (row) => typeFilter === "all" || (typeFilter === "trigger" ? row.isTrigger : !row.isTrigger)
    );
  const heldBalances = (spot?.balances ?? []).filter((balance) => displayNumber(balance.total) > 0);
  const shownBalances = heldBalances.filter((balance) => {
    if (!hideSmall) return true;
    const coinPrice = prices.get(balance.coin);
    if (coinPrice === undefined) return true;
    return displayNumber(balance.total) * displayNumber(coinPrice) >= SMALL_BALANCE_USD;
  });

  return (
    <View className="gap-2">
      <Tabs
        key={kind}
        variant="secondary"
        value={tab}
        onValueChange={(next) => setTab(next as AccountTab)}
      >
        <Tabs.List>
          <Tabs.ScrollView>
            <Tabs.Indicator />
            <Tabs.Trigger value="positions">
              <Tabs.Label className="font-medium">Positions ({positions.length})</Tabs.Label>
            </Tabs.Trigger>
            <Tabs.Trigger value="orders">
              <Tabs.Label className="font-medium">Open Orders ({orders.rows.length})</Tabs.Label>
            </Tabs.Trigger>
            <Tabs.Trigger value="balances">
              <Tabs.Label className="font-medium">Balances</Tabs.Label>
            </Tabs.Trigger>
          </Tabs.ScrollView>
        </Tabs.List>
      </Tabs>

      {/* The reference's filter row: dropdowns left, the bulk action right. */}
      <View className="flex-row flex-wrap items-center gap-2">
        {tab === "positions" ? (
          <FilterMenu
            label="Side"
            options={SIDE_FILTERS}
            selected={sideFilter}
            onSelect={setSideFilter}
          />
        ) : null}
        {tab === "orders" ? (
          <>
            <FilterMenu
              label="Type"
              options={ORDER_TYPE_FILTERS}
              selected={typeFilter}
              onSelect={setTypeFilter}
            />
            <FilterMenu
              label="Side"
              options={ORDER_SIDE_FILTERS}
              selected={sideFilter}
              onSelect={setSideFilter}
            />
          </>
        ) : null}
        {tab === "balances" ? (
          <ControlCheckbox
            label="Hide small"
            isSelected={hideSmall}
            onSelectedChange={setHideSmall}
            isCompact
          />
        ) : (
          <FilterMenu
            label="Market"
            options={MARKET_FILTERS}
            selected={marketOnly ? "market" : "all"}
            onSelect={(value) => setMarketOnly(value === "market")}
          />
        )}

        <View className="flex-1" />

        {tab === "positions" && canTrade && shownPositions.length > 1 ? (
          <Button size="sm" variant="tertiary" onPress={() => setConfirmCloseAll(true)}>
            <Button.Label className="font-medium text-danger">Close All</Button.Label>
          </Button>
        ) : null}
        {tab === "orders" && canTrade && shownOrders.length > 1 ? (
          <ConfirmButton
            label="Cancel all"
            confirmLabel={`Cancel ${shownOrders.length}?`}
            onConfirm={() => void actions.cancelAll(shownOrders)}
            isBusy={false}
            isDisabled={!canTrade}
          />
        ) : null}
      </View>

      {actions.state.lastError !== null ? (
        <Chip size="sm" color="danger" variant="soft" className="self-start">
          <Chip.Label className="font-medium">
            {actions.state.lastError.code}: {actions.state.lastError.message}
          </Chip.Label>
        </Chip>
      ) : null}

      <Card className="py-0">
        {tab === "positions" ? (
          shownPositions.length === 0 ? (
            <Empty text="No open positions." />
          ) : (
            <Divided>
              {shownPositions.map((position) => (
                <PositionItem
                  key={`${position.coin}:${position.marginMode}`}
                  position={position}
                  canTrade={canTrade}
                  isBusy={actions.isBusy(actions.positionKey(position))}
                  onClose={() => void actions.closePosition(position)}
                  onOpenDetail={() => setTpslTarget(position)}
                  onAdjustMargin={() => setMarginTarget(position)}
                />
              ))}
            </Divided>
          )
        ) : null}

        {tab === "orders" ? (
          shownOrders.length === 0 && orders.unconfirmed.length === 0 ? (
            <Empty text="No open orders." />
          ) : (
            <Divided>
              {[
                ...orders.unconfirmed.map((order) => (
                  <UnconfirmedOrderItem key={`unconfirmed:${order.cloid}`} order={order} />
                )),
                ...shownOrders.map((row) => (
                  <OpenOrderItem
                    key={`order:${row.oid}`}
                    row={row}
                    named={nameOutcome(row.coin)}
                    onOpenDetail={() => {}}
                    onCancel={() => void actions.cancelOrder(row)}
                    isBusy={actions.isBusy(actions.orderKey(row))}
                    canTrade={canTrade}
                  />
                )),
              ]}
            </Divided>
          )
        ) : null}

        {tab === "balances" ? (
          shownBalances.length === 0 ? (
            <Empty text="No spot balances." />
          ) : (
            <Divided>
              {shownBalances.map((balance) => (
                <BalanceItem
                  key={balance.coin}
                  balance={balance}
                  named={nameOutcome(balance.coin)}
                  prices={prices}
                />
              ))}
            </Divided>
          )
        ) : null}
      </Card>

      <PositionTpslSheet
        isOpen={tpslTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTpslTarget(null);
        }}
        position={tpslTarget}
        // Permissive by design: the field only filters keystrokes, and
        // `buildTriggerOrder` snaps the trigger onto the real grid anyway.
        priceDecimals={priceDecimalsOf(null, "perp")}
        apply={(prices_) =>
          tpslTarget === null
            ? Promise.resolve({ kind: "failed" as const, error: new Error("no position") })
            : actions.setPositionTpsl(tpslTarget, prices_)
        }
        applying={tpslTarget !== null && actions.isBusy(actions.positionKey(tpslTarget))}
      />
      <MarginAdjustSheet
        isOpen={marginTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMarginTarget(null);
        }}
        position={marginTarget}
        apply={(amountUsd) =>
          marginTarget === null
            ? Promise.resolve({ kind: "failed" as const, error: new Error("no position") })
            : actions.adjustIsolatedMargin(marginTarget, amountUsd)
        }
        applying={marginTarget !== null && actions.isBusy(actions.positionKey(marginTarget))}
      />

      {/* The Close All confirm — a batch market close deserves one
          read-and-confirm; the per-row Close has its own armed state. */}
      <Dialog isOpen={confirmCloseAll} onOpenChange={setConfirmCloseAll}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="gap-4 bg-background">
            <Dialog.ContentBackground className="bg-surface" />
            <View className="gap-1">
              <Dialog.Title className="font-semibold">
                Close {shownPositions.length} positions at market?
              </Dialog.Title>
              <Dialog.Description className="text-sm font-normal">
                Each closes with a reduce-only IOC priced at the live mid.
              </Dialog.Description>
            </View>
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button variant="tertiary" onPress={() => setConfirmCloseAll(false)}>
                  <Button.Label className="font-medium">Cancel</Button.Label>
                </Button>
              </View>
              <View className="flex-1">
                <Button
                  variant="danger"
                  onPress={() => {
                    setConfirmCloseAll(false);
                    void actions.closeAll(shownPositions);
                  }}
                >
                  <Button.Label className="font-medium">Close All</Button.Label>
                </Button>
              </View>
            </View>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </View>
  );
}
