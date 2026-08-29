/**
 * Portfolio — the first real screen.
 *
 * Component policy, per the client: HeroUI **Pro** first, OSS `heroui-native`
 * where Pro has no equivalent, nothing hand-rolled. Pro carries the heavy
 * lifting: `ProgressCircle` (account-health gauges), `Segment` (switches),
 * `TrendChip` (PnL direction), `EmptyState` (genuinely-empty lists), and
 * `NumberValue` behind `Usd`/`UsdLabel`. The value/P&L history is Pro's
 * `AreaChart` one level down, inside the shared `HistoryChart` — this screen
 * and the vault detail drew the identical chart, so the anatomy lives there.
 *
 * Two places compose rather than reach for a component, each for a reason the
 * component cannot satisfy:
 *
 * - **The hero figure** is two `Text` nodes, not one `NumberValue`, because the
 *   references dim the cents and a single formatted string cannot be coloured
 *   in halves. The split — carry included — lives in `heroValue.ts`.
 * - **The action tiles** are `Pressable` over `Surface`, not `Button`: the
 *   Button root is a fixed-height pill, so an icon ABOVE a label does not fit
 *   inside it at any size.
 *
 * The states rules this screen exists to get right — every later screen will
 * be judged against them:
 *
 * - **`null` is not `[]`.** "No frame yet" renders Skeleton, never $0.00 — a
 *   zero the account does not have is the worst lie a portfolio can tell.
 * - **Stale is visibly stale.** The feed goes quiet 15s after the last frame
 *   or immediately on resume; the header says so and dims the number.
 * - **Deferred is not empty.** The portfolio history read runs through the
 *   per-IP weight budget; when the budget defers it, the chart says so and
 *   offers a retry — it does not draw a flat line.
 * - **Truncated is disclosed.** Observed real: 100 rows for a 3,196-order
 *   account. "Showing some of your orders" is true; a silent 100 is not.
 * - **Unconfirmed orders are visible** until the websocket confirms them.
 *
 * Chart series: `pnlHistory` for the P&L metric, deliberately — value deltas
 * attribute a deposit to trading performance, which `api/accountMeta.ts`
 * documents as the reason both series exist. The Value metric shows
 * `accountValueHistory`, where a deposit SHOULD move the line.
 *
 * Money: BigNumber for every derivation (sums, ratios); wire strings are
 * parsed with `Number()` only at the display leaf, feeding `NumberValue` and
 * chart points — the one place the house rules permit it.
 */

import type { JSX, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { BigNumber } from "bignumber.js";
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Send } from "lucide-react-native";
import {
  Button,
  Card,
  Chip,
  Dialog,
  Skeleton,
  Surface,
  Tabs,
  Typography,
  useThemeColor,
} from "heroui-native";
import { EmptyState, ProgressCircle, Segment } from "heroui-native-pro";

import { HistoryChart } from "@/components/charts/HistoryChart";

import { PerpSpotMove } from "@/components/money/PerpSpotMove";
import {
  FillItem,
  FundingItem,
  LedgerItem,
  OrderHistoryItem,
  TwapItem,
} from "@/components/portfolio/activity";
import { FilterMenu, type FilterOption } from "@/components/common/FilterMenu";
import { ConfirmButton } from "@/components/portfolio/ConfirmButton";
import { AccountSwitcher } from "@/components/portfolio/AccountSwitcher";
import { ActivityCard } from "@/components/portfolio/ActivityCard";
import {
  drawdownPercent,
  maxDrawdown,
  periodKey,
  pnlStats,
  type ChartPeriod,
  type ChartScope,
} from "@/components/portfolio/chartView";
import { fillsCsv, ledgerCsv } from "@/components/portfolio/exportCsv";
import { combinedPerpEquity, equityBreakdown } from "@/components/portfolio/equityView";
import { heroFigure } from "@/components/portfolio/heroValue";
import { FeeCard } from "@/components/portfolio/FeeCard";
import { StakingCard } from "@/components/portfolio/StakingCard";
import { RowDetailSheet } from "@/components/portfolio/RowDetailSheet";
import {
  fillDetail,
  fundingDetail,
  ledgerDetail,
  orderDetail,
  orderHistoryDetail,
  positionDetail,
  type RowDetail,
} from "@/components/portfolio/rowDetail";
import { FetchedList, TruncationNotice } from "@/components/portfolio/FetchedList";
import { NotificationBanner } from "@/components/portfolio/NotificationBanner";
import { Empty, LoadingCard, UsdLabel } from "@/components/portfolio/primitives";
import { displayNumber } from "@/components/common/display";
import {
  BalanceItem,
  OpenOrderItem,
  PositionItem,
  UnconfirmedOrderItem,
} from "@/components/trade/accountRows";

import { getInfoClient } from "@/hyperliquid/api/clients";
import {
  readThrough,
  restCache,
  restCacheKey,
  REST_CACHE_TTL_MS,
} from "@/hyperliquid/api/restCache";
import {
  fetchPortfolio,
  stakingIsEmpty,
  type MetaProbe,
  type PortfolioSeries,
} from "@/hyperliquid/api/accountMeta";
import {
  useAccountSummary,
  useFills,
  useOpenOrders,
  usePositions,
  useSpotState,
} from "@/hyperliquid/hooks/account";
import { useOrderActions } from "@/hyperliquid/hooks/actions";
import { realizedByCoin, summariseActivity, useActivity } from "@/hyperliquid/hooks/activity";
import {
  useFeeRates,
  useFillHistory,
  useFunding,
  useLedger,
  useOrderHistory,
  useStaking,
  useTwapHistory,
  useVaultEquity,
} from "@/hyperliquid/hooks/history";
import { useOutcomeNamer } from "@/hyperliquid/hooks/predictions";
import { useSpotPrices } from "@/hyperliquid/hooks/prices";
import { useCanTrade, useSessionAddress, useSessionState } from "@/hyperliquid/hooks/session";
import type { AccountSummary, Position } from "@/hyperliquid/types/domain";
import { useHyperliquid } from "@/providers/HyperliquidProvider";

// ---------------------------------------------------------------------------
// Portfolio history chart
// ---------------------------------------------------------------------------

type Metric = "value" | "pnl";
/**
 * Scope, as a filter rather than a segment. `all` is the id `FilterMenu`
 * treats as unset, which is exactly right here: everything included is this
 * control's neutral state, not a selection.
 */
const SCOPE_OPTIONS: readonly FilterOption[] = [
  { id: "all", label: "All" },
  { id: "perp", label: "Perps" },
];

const PERIOD_LABELS: [ChartPeriod, string][] = [
  ["day", "1D"],
  ["week", "1W"],
  ["month", "1M"],
  ["allTime", "All"],
];

type ChartFetch =
  | { kind: "loading" }
  | { kind: "deferred" }
  | { kind: "error"; message: string }
  | { kind: "ready"; periods: Map<string, PortfolioSeries> };

function PortfolioChart({ user }: { user: string }): JSX.Element {
  const [metric, setMetric] = useState<Metric>("value");
  const [period, setPeriod] = useState<ChartPeriod>("day");
  // "Perps" narrows to the perp-only series the endpoint already returns
  // (`perpDay`…`perpAllTime`) — the web app's "Perps PNL" scope. The cached
  // map holds all eight keys, so toggling costs no fetch.
  const [scope, setScope] = useState<ChartScope>("all");
  // Seeded from the cache, so returning to this tab redraws the chart on the
  // first frame rather than flashing a skeleton.
  const [fetch, setFetch] = useState<ChartFetch>(() => {
    const hit = restCache.read<{ value: Map<string, PortfolioSeries> | null }>(
      restCacheKey("portfolio", user),
      Date.now(),
      REST_CACHE_TTL_MS
    );
    return hit?.value ? { kind: "ready", periods: hit.value } : { kind: "loading" };
  });

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // No synchronous setState on this path: the initial state IS `loading`, so
  // the mount effect only ever writes after an await. Retries reset to
  // `loading` from a button press, where a cascade cannot happen. An account
  // switch remounts the component (`key={user}` at the call site), so a stale
  // chart never shows another account's history while the new one loads.
  const run = useCallback(
    async (force: boolean) => {
      try {
        // Through the cache: this is the single most expensive read on the screen
        // and it was refetched on every mount, so a few tab switches were enough
        // to exhaust the shared budget and leave the chart showing "deferred".
        const { value: result } = await readThrough<Awaited<ReturnType<typeof fetchPortfolio>>>({
          key: restCacheKey("portfolio", user),
          ttlMs: force ? 0 : REST_CACHE_TTL_MS,
          now: Date.now(),
          fetch: async () => {
            const fetched = await fetchPortfolio({
              probe: getInfoClient() as unknown as MetaProbe,
              user,
            });
            // Do not cache a deferral — `readThrough` skips `null` for exactly
            // this reason, so hand it one rather than a "deferred" object.
            return fetched.deferred || fetched.value === null ? null : fetched;
          },
        });
        if (!live.current) return;
        if (result === null) {
          setFetch({ kind: "deferred" });
          return;
        }
        // Deferred is the weight budget protecting the shared per-IP allowance —
        // a state to SHOW, not an empty chart. `value` is null exactly when
        // deferred, so the null branch folds into the same state.
        setFetch(
          result.value === null ? { kind: "deferred" } : { kind: "ready", periods: result.value }
        );
      } catch (error) {
        if (!live.current) return;
        setFetch({ kind: "error", message: error instanceof Error ? error.message : "failed" });
      }
    },
    [user]
  );

  const load = useCallback(() => {
    setFetch({ kind: "loading" });
    void run(true);
  }, [run]);

  useEffect(() => {
    // Deferred a tick: the compiler lint cannot see through the async
    // boundary inside `run`, and a zero-timeout makes the "no synchronous
    // setState in effects" guarantee structural rather than argued.
    const timer = setTimeout(() => void run(false), 0);
    return () => clearTimeout(timer);
  }, [run]);

  const selected = fetch.kind === "ready" ? fetch.periods.get(periodKey(scope, period)) : null;
  const series = selected?.[metric === "value" ? "accountValueHistory" : "pnlHistory"] ?? [];
  // Always over account VALUE, whichever metric is charted: drawdown against
  // the P&L series would measure a decline from the best cumulative P&L, a
  // different (and stranger) number than "how far the account fell".
  const drawdown = maxDrawdown(selected?.accountValueHistory ?? []);
  // And these always over P&L, whichever metric is charted — value deltas
  // would attribute a deposit to trading performance. The line says "P&L".
  const stats = pnlStats(selected?.pnlHistory ?? []);

  return (
    <Card className="gap-3">
      <View className="flex-row items-center justify-between">
        <Segment size="sm" value={metric} onValueChange={(value) => setMetric(value as Metric)}>
          <Segment.Group>
            <Segment.Indicator />
            <Segment.Item value="value">
              <Segment.Label className="font-medium">Value</Segment.Label>
            </Segment.Item>
            <Segment.Item value="pnl">
              <Segment.Label className="font-medium">P&L</Segment.Label>
            </Segment.Item>
          </Segment.Group>
        </Segment>
        {/* Scope moved up here as a pill, which is what emptied the row
            below. It is the LOW-frequency control of the three — you pick a
            metric and a window constantly, and you pick "all money" vs "perps
            only" once — and this component's own comment used to concede the
            cost of treating it like the others: "the row above already carries
            two Segments, and a third makes every label truncate."

            No `alwaysShowSelection`: `all` is genuinely this control's UNSET
            state and is also literally the id `FilterMenu` treats as unset, so
            the pill reads "Scope" while everything is included and switches to
            an accent-tinted "Perps" once it is filtering. That is more
            informative than a segment, which showed a highlighted "All" that
            looked like an active choice. */}
        <FilterMenu
          label="Scope"
          options={SCOPE_OPTIONS}
          selected={scope}
          onSelect={(value) => setScope(value as ChartScope)}
        />
        <Segment
          size="sm"
          value={period}
          onValueChange={(value) => setPeriod(value as ChartPeriod)}
        >
          <Segment.Group>
            <Segment.Indicator />
            {PERIOD_LABELS.map(([key, label]) => (
              <Segment.Item key={key} value={key}>
                <Segment.Label className="font-medium">{label}</Segment.Label>
              </Segment.Item>
            ))}
          </Segment.Group>
        </Segment>
      </View>

      {/* Every statistic about the selected series on ONE muted line, drawdown
          included. It used to be two: drawdown rode the scope row and the rest
          sat below it, so the chart was preceded by three control rows and two
          annotation rows — five bands of chrome, seven numbers, before the
          picture they describe. They annotate the chart rather than compete
          with it, and that is easier to believe when they are one line.

          Best/worst day are absent inside a single UTC day, where a
          day-over-day delta does not exist; drawdown is absent when null,
          because "not measured" and a 0% claiming a flat history are different
          statements. */}
      {stats !== null || drawdown !== null ? (
        <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
          {stats !== null ? (
            <>
              P&L <UsdLabel value={stats.change} signed />
            </>
          ) : null}
          {stats?.bestDay != null ? (
            <>
              {" "}
              · best day <UsdLabel value={stats.bestDay} signed />
            </>
          ) : null}
          {stats?.worstDay != null ? (
            <>
              {" "}
              · worst day <UsdLabel value={stats.worstDay} signed />
            </>
          ) : null}
          {drawdown !== null ? (
            <>
              {stats !== null ? " · " : ""}
              drawdown {drawdownPercent(drawdown)}
            </>
          ) : null}
        </Typography.Paragraph>
      ) : null}

      {fetch.kind === "loading" ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : fetch.kind === "deferred" ? (
        <EmptyState className="py-6">
          <EmptyState.Header>
            <EmptyState.Title className="font-semibold">History deferred</EmptyState.Title>
            <EmptyState.Description className="font-normal">
              The request budget is protecting the connection. Try again shortly.
            </EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            <Button size="sm" variant="tertiary" onPress={() => void load()}>
              <Button.Label className="font-medium">Retry</Button.Label>
            </Button>
          </EmptyState.Content>
        </EmptyState>
      ) : fetch.kind === "error" ? (
        <EmptyState className="py-6">
          <EmptyState.Header>
            <EmptyState.Title className="font-semibold">Could not load history</EmptyState.Title>
            <EmptyState.Description className="font-normal">{fetch.message}</EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            <Button size="sm" variant="tertiary" onPress={() => void load()}>
              <Button.Label className="font-medium">Retry</Button.Label>
            </Button>
          </EmptyState.Content>
        </EmptyState>
      ) : (
        <HistoryChart
          series={series}
          period={period}
          emptyDescription={`This account has no ${
            metric === "value" ? "value" : "P&L"
          } history for this period yet.`}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Stat tiles + account health
// ---------------------------------------------------------------------------

/** BigNumber sum of signed uPnL across positions. Arithmetic stays BigNumber. */
function totalUnrealizedPnl(positions: readonly Position[]): string {
  return positions
    .reduce((total, position) => total.plus(position.unrealizedPnl), new BigNumber(0))
    .toFixed(2);
}

/**
 * One part of the equity split: label over value, `--` while its source has
 * not spoken. The same uniform Surface tile as the Activity card's grid.
 */
function EquityTile({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string | null;
  /** Makes the tile a doorway — the Vaults tile opens the Vaults tab. */
  onPress?: () => void;
}): JSX.Element {
  const tile = (
    <Surface variant="secondary" className="flex-1 gap-1 rounded-xl px-3 py-3">
      <Typography.Paragraph className="text-xs text-muted font-normal">
        {label}
      </Typography.Paragraph>
      <Typography.Paragraph className="text-sm font-semibold tabular-nums">
        {value === null ? "--" : <UsdLabel value={value} />}
      </Typography.Paragraph>
    </Surface>
  );
  if (onPress === undefined) return tile;
  return (
    <Pressable accessible={false} className="flex-1" onPress={onPress}>
      {tile}
    </Pressable>
  );
}

/** Icon size inside an action tile — one constant so the four tiles cannot drift apart. */
const ACTION_ICON_PX = 20;

/**
 * One of the four equal actions under the hero: icon over label.
 *
 * Composed rather than a `Button` because `Button`'s root is a fixed-height
 * pill — its children lay out in a row inside a set height, so an icon ABOVE a
 * label does not fit at any `size`. `Surface variant="secondary"` is the same
 * tile the equity split above uses, which is what makes the two rows read as
 * one card rather than as a card plus a toolbar.
 *
 * The label is not decoration: the Send action shipped as a bare glyph, and a
 * paper-plane on a money screen is equally readable as "share" or "message".
 */
function ActionTile({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon: ReactNode;
  onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      className="flex-1"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
    >
      <Surface variant="secondary" className="items-center gap-1.5 rounded-xl px-2 py-3">
        {icon}
        <Typography.Paragraph className="text-xs font-medium">{label}</Typography.Paragraph>
      </Surface>
    </Pressable>
  );
}

/**
 * Account health, from the numbers the exchange itself risk-manages on.
 *
 * Every ratio is BigNumber; only the final gauge value is a number. A zero
 * account value renders "—" rather than a 0% that reads as perfectly healthy.
 */
function AccountHealth({ summary }: { summary: AccountSummary }): JSX.Element {
  const accountValue = new BigNumber(summary.total.accountValue);
  const usable = accountValue.gt(0);

  const leverage = usable
    ? new BigNumber(summary.total.totalNotional).dividedBy(accountValue)
    : null;
  const marginPct = usable
    ? new BigNumber(summary.total.totalMarginUsed).dividedBy(accountValue).times(100)
    : null;
  // Cross liquidation approaches as maintenance margin approaches equity, so
  // this ratio IS the liquidation-proximity meter.
  const mmrPct = usable
    ? new BigNumber(summary.crossMaintenanceMarginUsed).dividedBy(accountValue).times(100)
    : null;

  const gauge = (
    label: string,
    value: BigNumber | null,
    format: (value: BigNumber) => string,
    max: number,
    // Only the maintenance gauge earns a colour: it IS the liquidation
    // proximity meter, so warning/danger there is genuine caution rather than
    // decoration. Leverage and margin-used stay neutral — colouring every
    // gauge would make the one that matters unremarkable.
    color: "default" | "accent" | "warning" | "danger" = "default"
  ): JSX.Element => (
    <View className="items-center gap-2">
      <ProgressCircle
        value={value === null ? 0 : Math.min(value.toNumber(), max)}
        maxValue={max}
        size="lg"
        color={color}
      >
        <ProgressCircle.Indicator />
        <ProgressCircle.ValueLabel className="font-medium">
          {value === null ? "—" : format(value)}
        </ProgressCircle.ValueLabel>
      </ProgressCircle>
      <Typography.Paragraph className="text-xs text-muted font-normal">
        {label}
      </Typography.Paragraph>
    </View>
  );

  /** Liquidation proximity: neutral until it is worth looking at. */
  const maintenanceColor: "default" | "warning" | "danger" =
    mmrPct === null
      ? "default"
      : mmrPct.gte(80)
        ? "danger"
        : mmrPct.gte(50)
          ? "warning"
          : "default";

  return (
    <Card className="gap-3">
      <Typography.Paragraph className="text-xs text-muted font-normal">
        Account health
      </Typography.Paragraph>
      <View className="flex-row justify-around py-1">
        {gauge("Leverage", leverage, (v) => `${v.toFixed(1)}x`, 25)}
        {gauge("Margin used", marginPct, (v) => `${v.toFixed(0)}%`, 100)}
        {gauge("Maintenance", mmrPct, (v) => `${v.toFixed(0)}%`, 100, maintenanceColor)}
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

type Section =
  "balances" | "positions" | "outcomes" | "orders" | "twap" | "trades" | "transfers" | "funding";

/**
 * Clearance for the floating native tab bar, in points.
 *
 * Not derivable: `useSafeAreaInsets().bottom` reports the home indicator only,
 * and `NativeTabs` exposes no height hook.
 */
const TAB_BAR_CLEARANCE = 88;

/**
 * Caps on the longest lists.
 *
 * Not a truncation the user is lied to about: both sources are already capped
 * upstream (100 open orders observed for a 3,196-order account), and these
 * bound the RENDER so a busy account does not lay out thousands of rows inside
 * a ScrollView. The notices above the lists say the data is partial.
 */
const FILL_ROWS = 100;
const ORDER_HISTORY_ROWS = 100;
/**
 * The same bound, for the three sections that were missing it.
 *
 * TWAP, funding and transfers rendered their ENTIRE fetched list into the same
 * ScrollView the caps above exist to protect. Each row is a real component —
 * `TwapItem` alone mounts a CoinBadge (an SvgXml parse), up to three Chips, four
 * Typography stacks and an optional ProgressBar, roughly 25 elements — so a
 * funding history of 12,806 rows laid out ~300k elements synchronously with
 * nothing on screen to show for it.
 */
const TWAP_ROWS = 100;
const FUNDING_ROWS = 100;
const LEDGER_ROWS = 100;

/** Order matters: this is the left-to-right order of the scrollable tab bar. */
const SECTIONS: [Section, string][] = [
  ["balances", "Balances"],
  ["positions", "Positions"],
  ["outcomes", "Outcomes"],
  ["orders", "Orders"],
  ["trades", "Trades"],
  ["twap", "TWAP"],
  ["transfers", "Transfers"],
  ["funding", "Funding"],
];

function PortfolioTab(): JSX.Element {
  // NativeTabs renders no header, so scroll content starts under the status
  // bar without this.
  const insets = useSafeAreaInsets();
  const { session, status, error, start } = useHyperliquid();
  const sessionState = useSessionState(session);
  const summary = useAccountSummary(session.stores.account);
  const positions = usePositions(session.stores.account);
  const orders = useOpenOrders(session.stores.openOrders);
  const spot = useSpotState(session.stores.spot);
  // Outcome shares are spot-shaped on the wire but a different KIND of thing —
  // whole-share sizes, `oN` settlement, no token id — so they get their own
  // tab, exactly as the exchange's own UI separates them.
  // Zero-total rows are filtered HERE, not in the store: the wire really does
  // send them (buying one side of a market lists the other side at 0.0), and
  // the store's job is to preserve the wire. Holding zero is not a holding.
  const held = (spot?.balances ?? []).filter((balance) => displayNumber(balance.total) > 0);
  const tokenBalances = held.filter((balance) => balance.kind === "token");
  const outcomeBalances = held.filter((balance) => balance.kind === "outcome");

  const { prices, refresh: refreshPrices } = useSpotPrices();
  const actions = useOrderActions(session);
  // Trading is gated on the agent. Without one, Close and Cancel would fail at
  // the exchange, so they are disabled rather than offered and refused.
  const canTrade = useCanTrade(session);
  const nameOutcome = useOutcomeNamer();
  const fills = useFills(session.stores.fills);
  const activity = useActivity(session.stores.fills);

  // The three REST-backed histories. They fetch on mount rather than on tab
  // selection: each is one call, they share the weight budget with everything
  // else on the screen, and a tab that starts loading only when tapped shows a
  // spinner every single time it is opened.
  // `useSessionAddress`, NOT `session.address()`: the latter is a plain method
  // call that React Compiler memoises for the life of the component, so a
  // screen first rendered while signed out keeps reading `null` forever after
  // the session starts — which is exactly how the chart went missing. It also
  // resolves to the SUB-ACCOUNT when one is selected, which is whose history
  // the chart and the transfer list must show.
  const address = useSessionAddress(session);
  const ledger = useLedger(address);
  const funding = useFunding(address);
  const feeRates = useFeeRates(address);
  const orderHistory = useOrderHistory(address);
  const twaps = useTwapHistory(address);
  const vaultEquity = useVaultEquity(address);
  const fillHistory = useFillHistory(address);
  const staking = useStaking(address);

  // Activity: the full REST walk when it is ready, the live store until then.
  // The walk is what lets the caption say "all history" honestly; the store
  // fallback keeps the card populated (and live) rather than skeletal.
  const walked = fillHistory.state.kind === "ready" ? fillHistory.state.value : null;
  const shownActivity = walked !== null ? summariseActivity(walked.fills) : activity;
  const activityScope =
    walked !== null
      ? `${walked.complete ? "all history" : "recent history"} · ${walked.fills.length} fill${walked.fills.length === 1 ? "" : "s"}`
      : activity.fillCount > 0
        ? `over ${activity.fillCount} fill${activity.fillCount === 1 ? "" : "s"}`
        : null;
  const pnlByCoin = walked !== null ? realizedByCoin(walked.fills) : null;

  // The hero's big number: perp + spot + vaults, or null until every part is
  // known. The perp value ALONE labelled "Account value" was the subtle form
  // of the zero-the-account-does-not-have lie — see `equityView.ts`.
  const equity = equityBreakdown({
    perpValue: summary?.total.accountValue ?? null,
    balances: spot?.balances ?? null,
    prices,
    vaultPositions: vaultEquity.state.kind === "ready" ? vaultEquity.state.value : null,
  });
  // Units bright, cents dim — two strings because one formatted string cannot
  // be coloured in halves. `null` covers both "not summed yet" and "the total
  // is not a number", and both render the Skeleton rather than a zero.
  const hero = equity.total === null ? null : heroFigure(equity.total);

  // Colour for the action icons. `Surface variant="secondary"` has its own
  // foreground token; lucide defaults to `currentColor`, which react-native-svg
  // cannot resolve, so the icon must be handed a real value.
  const actionIconColor = useThemeColor("surface-secondary-foreground");

  const [section, setSection] = useState<Section>("balances");
  // One sheet for the whole screen: the rows differ, the presentation does not.
  const [detail, setDetail] = useState<RowDetail | null>(null);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);

  // The perp<->spot move, from the Move tile. A Dialog rather than a route:
  // it is a two-field form over balances this screen already holds, and
  // `PerpSpotMove` is the same control the deposit and withdraw screens mount.
  const [isMoving, setIsMoving] = useState(false);
  // `--`, never 0: an unread balance is unknown, and `PerpSpotMove` renders the
  // distinction itself. Withdrawable, not accountValue — a move can only send
  // what is not posted as margin.
  // `available`, NOT `total`. A spot balance's `hold` is money already
  // committed to resting orders — `total` includes it, and the mover was
  // offering it: Max filled more than could move, the overdraw gate waved it
  // through, and the exchange refused. With no agent that costs a real wallet
  // prompt the user approves before learning it cannot work. `sendView.ts`
  // states this rule and `sendableTokens` obeys it; these three call sites did
  // not, and the perp leg one line away had the identical bug fixed in Phase 6.
  const spotUsdc = spot?.balances.find((balance) => balance.coin === "USDC")?.available ?? null;
  const perpUsdc = summary?.withdrawable ?? null;

  // Staleness is time-based, so something has to re-ask; a 5s tick against a
  // 15s threshold is the cheapest honest answer.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  const stale = summary !== null && session.stores.account.isStale(now);

  // Pull-to-refresh drives the REST reads only. The websocket-backed stores
  // need no refresh — they are pushed — and re-subscribing them on a pull would
  // tear down and rebuild live feeds to fix nothing.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    ledger.refresh();
    funding.refresh();
    feeRates.refresh();
    orderHistory.refresh();
    twaps.refresh();
    vaultEquity.refresh();
    fillHistory.refresh();
    staking.refresh();
    refreshPrices();
    // The reads settle independently and none of them reports back here, so
    // the spinner is time-boxed rather than tied to a promise it cannot see.
    // A spinner that outlives the fetch is better than one that never stops.
    setTimeout(() => setRefreshing(false), 900);
  }, [
    ledger,
    funding,
    feeRates,
    orderHistory,
    twaps,
    vaultEquity,
    fillHistory,
    staking,
    refreshPrices,
  ]);

  // Switching account is a session RESTART, not a filter: `start({ subAccount })`
  // rebuilds the identity, re-targets every store and re-opens the
  // subscriptions. `useSessionAddress` then follows it, which is what makes the
  // chart and every history read below track the switch instead of freezing on
  // the master.
  const onSelectAccount = useCallback(
    (subAccount: string | null) => {
      void start({ subAccount });
    },
    [start]
  );

  const onStart = useCallback(() => {
    // Read-only: a portfolio needs no agent, and prompting for a signature
    // from a "view your balances" button would be the wrong surprise.
    void start();
  }, [start]);

  // ------------------------------------------------------------ no session
  if (sessionState === null) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Title className="font-semibold">No session</EmptyState.Title>
            <EmptyState.Description className="font-normal">
              {status === "error" && error
                ? `Could not start: ${error.message}`
                : "Start a session to see balances and positions."}
            </EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            <Button onPress={onStart} isDisabled={status === "starting"}>
              <Button.Label className="font-medium">
                {status === "starting" ? "Starting…" : "Start session"}
              </Button.Label>
            </Button>
          </EmptyState.Content>
        </EmptyState>
      </View>
    );
  }

  // The address this session ACTS AS — the sub-account when one is selected,
  // which is also the address whose portfolio history the chart must show.
  const actingAs = address;

  return (
    <ScrollView
      className="flex-1 bg-background"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      contentContainerClassName="px-4 gap-4"
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        // `insets.bottom` is the home indicator, NOT the tab bar. `NativeTabs`
        // renders a real UIKit bar that FLOATS over the content on iOS 26, and
        // nothing reports its height to this screen — so the last row sat under
        // it until you scrolled. Measured against the rendered bar; it is a
        // constant rather than a guess dressed up as arithmetic.
        paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
      }}
    >
      {/* ------------------------------------------------ notifications */}
      {/* Above everything: this channel carries liquidation warnings, the one
          thing the exchange pushes that a user cannot read off their own
          numbers. Renders nothing when there is nothing pending. */}
      <NotificationBanner store={session.stores.notifications} />

      {/* -------------------------------------------------- account */}
      {/* Named even when there is nothing to switch to: a balance shown
          without an owner is exactly the confusion this screen must avoid. */}
      <AccountSwitcher
        master={sessionState.identity.address}
        actingAs={address}
        subAccounts={sessionState.subAccounts}
        combinedPerp={
          // Only when VIEWING the master: acting as a sub makes `summary` the
          // sub's clearinghouse, and master + subs would double-count it while
          // missing the actual master.
          address !== null && address.toLowerCase() === sessionState.identity.address.toLowerCase()
            ? combinedPerpEquity(summary?.total.accountValue ?? null, sessionState.subAccounts)
            : null
        }
        isSwitching={status === "starting"}
        onSelect={onSelectAccount}
      />

      {/* ------------------------------------------------------ hero */}
      {summary === null ? (
        // No frame yet is NOT zero. Skeleton until the websocket speaks.
        <LoadingCard />
      ) : (
        <Card className="gap-2">
          <View className="flex-row items-center justify-between">
            <Typography.Paragraph className="text-xs text-muted font-normal">
              Account value
            </Typography.Paragraph>
            {stale ? (
              <Chip size="sm" color="warning" variant="soft">
                <Chip.Label className="font-medium">stale</Chip.Label>
              </Chip>
            ) : null}
          </View>
          {hero === null ? (
            // A part of the split is still unknown; a big number summed over
            // two of three parts would be a confident understatement.
            <Skeleton className="h-10 w-44 rounded-lg" />
          ) : (
            // Opacity on the ROW, not on a half: a stale read is stale in both
            // directions, and dimming only the cents would read as the design
            // rather than as a warning.
            <View className={stale ? "flex-row items-center opacity-50" : "flex-row items-center"}>
              {/* Both halves are the same `Typography.Heading` so their font
                  size — and therefore their line boxes — are identical by
                  construction. `items-center` centres boxes, so two different
                  sizes here would centre to two different baselines and the
                  cents would float. The only difference permitted is colour,
                  and the weight rides on `font-bold` rather than on a style:
                  SF Pro Rounded resolves through the font-* classes alone. */}
              <Typography.Heading className="font-bold tabular-nums">
                {hero.major}
              </Typography.Heading>
              {hero.minor === "" ? null : (
                <Typography.Heading className="text-muted font-bold tabular-nums">
                  {hero.minor}
                </Typography.Heading>
              )}
            </View>
          )}
          <View className="flex-1 flex-row gap-2">
            <EquityTile label="Perps" value={equity.perp} />
            <EquityTile label="Spot" value={equity.spot} />
            <EquityTile
              label="Vaults"
              value={equity.vaults}
              onPress={() => router.push("/vaults")}
            />
          </View>
          {equity.unpriced.length > 0 ? (
            <Chip size="sm" variant="soft" className="self-start">
              {/* Without this the totals read as complete while a holding
                  with no quote is silently missing from them. */}
              <Chip.Label className="font-medium">
                no price for {equity.unpriced.join(", ")} — not in totals
              </Chip.Label>
            </Chip>
          ) : null}
          <View className="flex-row items-center justify-between">
            <Typography.Paragraph className="text-xs text-muted font-normal">
              Withdrawable
            </Typography.Paragraph>
            <Typography.Paragraph className="text-sm font-normal">
              <UsdLabel value={summary.withdrawable} />
            </Typography.Paragraph>
          </View>
          {/* Four EQUAL tiles, not two buttons and a glyph. The old row ranked
              them by chrome — a filled Deposit, an outlined Withdraw, an
              unlabelled Send — which said "deposit is what you came for". They
              are four destinations; the row should not argue about which. */}
          <View className="flex-row gap-2 pt-1">
            <ActionTile
              label="Deposit"
              icon={<ArrowDownToLine size={ACTION_ICON_PX} color={actionIconColor} />}
              onPress={() => router.push("/deposit")}
            />
            <ActionTile
              label="Withdraw"
              icon={<ArrowUpFromLine size={ACTION_ICON_PX} color={actionIconColor} />}
              onPress={() => router.push("/withdraw")}
            />
            <ActionTile
              label="Send"
              icon={<Send size={ACTION_ICON_PX} color={actionIconColor} />}
              onPress={() => router.push("/send")}
            />
            {/* NOT gated on `canTrade`: without an agent the move is signed by
                the master wallet instead, which works — it just prompts, and
                `moveCaption` already appends "· asks you to sign" so the
                prompt is announced before it appears. Disabling this would
                refuse an action the user can actually complete. */}
            <ActionTile
              label="Move"
              icon={<ArrowLeftRight size={ACTION_ICON_PX} color={actionIconColor} />}
              onPress={() => setIsMoving(true)}
            />
          </View>
        </Card>
      )}

      {/* ------------------------------------------------------ chart */}
      {actingAs !== null ? <PortfolioChart key={actingAs} user={actingAs} /> : null}

      {/* ------------------------------------------------- health */}
      {summary !== null ? <AccountHealth summary={summary} /> : null}

      {/* ------------------------------------- positions + activity */}
      <ActivityCard
        activity={shownActivity}
        scope={activityScope}
        byCoin={pnlByCoin}
        unrealizedPnl={totalUnrealizedPnl(positions)}
        openPositions={positions.length}
      />

      {/* --------------------------------------------------- fee rates */}
      {/* Only when ready: a deferred read rendering as 0.00% would claim a
          fee tier the budget merely declined to fetch. */}
      {feeRates.state.kind === "ready" ? <FeeCard fees={feeRates.state.value} /> : null}

      {/* Staking: only when something is actually staked, undelegated, or in
          withdrawal — a never-staked account reports genuine zeros, and a card
          of zeros asserts nothing. */}
      {staking.state.kind === "ready" && !stakingIsEmpty(staking.state.value) ? (
        <StakingCard summary={staking.state.value} />
      ) : null}

      {/* ----------------------------------------------------- sections */}
      <Tabs
        variant="secondary"
        value={section}
        onValueChange={(value) => setSection(value as Section)}
      >
        {/* Seven sections do not fit a phone. `Tabs.ScrollView` must be the
            List's ONLY child — the component detects it by displayName and
            silently falls back to a fixed row otherwise. */}
        <Tabs.List>
          <Tabs.ScrollView scrollAlign="center">
            <Tabs.Indicator />
            {SECTIONS.map(([value, label]) => (
              <Tabs.Trigger key={value} value={value}>
                <Tabs.Label className="font-medium">{label}</Tabs.Label>
              </Tabs.Trigger>
            ))}
          </Tabs.ScrollView>
        </Tabs.List>
      </Tabs>

      {actions.state.lastError !== null ? (
        <Chip size="sm" color="danger" variant="soft" className="self-start">
          <Chip.Label className="font-medium">
            {actions.state.lastError.code}: {actions.state.lastError.message}
          </Chip.Label>
        </Chip>
      ) : null}

      <Card>
        {section === "balances" &&
          (spot === null ? (
            <LoadingCard />
          ) : tokenBalances.length === 0 ? (
            <Empty title="No spot balances" description="Spot holdings appear here live." />
          ) : (
            tokenBalances.map((balance) => (
              <BalanceItem key={balance.coin} balance={balance} prices={prices} />
            ))
          ))}

        {section === "positions" &&
          (summary === null ? (
            <LoadingCard />
          ) : positions.length === 0 ? (
            <Empty title="No open positions" description="Positions you open appear here live." />
          ) : (
            <>
              {/* The bulk close moved HERE when the market sheet's tabs
                  retired (2026-08-29): Portfolio is where every position is
                  in view, which is the only honest place for a button that
                  closes all of them. Dialog-confirmed — a batch market close
                  deserves one read-and-confirm. */}
              {canTrade && positions.length > 1 ? (
                <View className="flex-row justify-end">
                  <Button size="sm" variant="tertiary" onPress={() => setConfirmCloseAll(true)}>
                    <Button.Label className="font-medium text-danger">Close All</Button.Label>
                  </Button>
                </View>
              ) : null}
              {positions.map((position) => (
                <PositionItem
                  key={position.coin}
                  position={position}
                  canTrade={canTrade}
                  isBusy={actions.isBusy(actions.positionKey(position))}
                  onClose={() => void actions.closePosition(position)}
                  onOpenDetail={() => setDetail(positionDetail(position))}
                />
              ))}
            </>
          ))}

        {section === "outcomes" &&
          (spot === null ? (
            <LoadingCard />
          ) : outcomeBalances.length === 0 ? (
            <Empty
              title="No outcome shares"
              description="Prediction-market holdings appear here live."
            />
          ) : (
            outcomeBalances.map((balance) => (
              <BalanceItem
                key={balance.coin}
                balance={balance}
                named={nameOutcome(balance.coin)}
                prices={prices}
              />
            ))
          ))}

        {section === "orders" && (
          <>
            {orders.truncated ? (
              <Chip size="sm" color="warning" variant="soft" className="self-start">
                <Chip.Label className="font-medium">
                  showing some of your orders — the list was truncated
                </Chip.Label>
              </Chip>
            ) : null}
            {orders.unconfirmed.map((unconfirmed) => (
              <UnconfirmedOrderItem key={unconfirmed.cloid} order={unconfirmed} />
            ))}
            {orders.rows.length === 0 && orders.unconfirmed.length === 0 ? (
              <Empty title="No open orders" description="Resting orders appear here live." />
            ) : (
              <>
                {/* One bulk call, honest about partial-batch semantics: what
                    remains in the list after the socket refresh is what
                    actually survived. Armed two-tap like the per-row Cancel —
                    resting orders are recoverable in a way a market close is
                    not, so no Dialog. */}
                {canTrade && orders.rows.length > 1 ? (
                  <View className="flex-row justify-end">
                    <ConfirmButton
                      label="Cancel all"
                      confirmLabel={`Cancel ${orders.rows.length} orders?`}
                      onConfirm={() => void actions.cancelAll(orders.rows)}
                      isBusy={false}
                      isDisabled={!canTrade}
                    />
                  </View>
                ) : null}
                {orders.rows.map((row) => (
                  <OpenOrderItem
                    key={row.oid}
                    row={row}
                    named={nameOutcome(row.coin)}
                    onOpenDetail={() => setDetail(orderDetail(row))}
                    onCancel={() => void actions.cancelOrder(row)}
                    isBusy={actions.isBusy(actions.orderKey(row))}
                    canTrade={canTrade}
                  />
                ))}
              </>
            )}

            {/* Past orders, from a different source than the live list above:
                REST history rather than the websocket. Kept in the same tab
                because it is the same subject, and separated by a heading so
                the two are not mistaken for one list. */}
            <View className="gap-1 border-t border-border pt-4">
              <Typography.Paragraph className="text-xs font-semibold uppercase text-muted">
                Order history
              </Typography.Paragraph>
            </View>
            <FetchedList
              state={orderHistory.state}
              refresh={orderHistory.refresh}
              isEmpty={(view) => view.orders.length === 0}
              emptyTitle="No past orders"
              emptyDescription="Filled and cancelled orders appear here."
            >
              {(view) => (
                <View className="gap-2">
                  {view.truncated ? (
                    <TruncationNotice label="showing recent activity — older orders are unreachable" />
                  ) : null}
                  {view.orders.slice(0, ORDER_HISTORY_ROWS).map((order) => (
                    <Pressable
                      accessible={false}
                      key={order.oid}
                      onPress={() => setDetail(orderHistoryDetail(order))}
                    >
                      <OrderHistoryItem order={order} named={nameOutcome(order.coin)} />
                    </Pressable>
                  ))}
                </View>
              )}
            </FetchedList>
          </>
        )}

        {section === "trades" && (
          <>
            {/* The share sheet is the phone's CSV download. The export prefers
                the WALKED history (complete) over the windowed store, so the
                file can honestly carry everything, not just what is rendered. */}
            {(walked?.fills.length ?? fills.length) > 0 ? (
              <Button
                size="sm"
                variant="tertiary"
                className="self-start"
                onPress={() =>
                  void Share.share({
                    title: "fills.csv",
                    message: fillsCsv(walked?.fills ?? fills),
                  })
                }
              >
                <Button.Label className="font-medium">Export CSV</Button.Label>
              </Button>
            ) : null}
            {fills.length === 0 ? (
              <Empty
                title="No trades yet"
                description="Executions appear here live as they fill."
              />
            ) : (
              // Newest first. The store keeps wire order, which is oldest-first
              // for the REST seed — reversing here rather than in the store keeps
              // the store a faithful mirror of the wire.
              [...fills]
                .sort((a, b) => b.time - a.time)
                .slice(0, FILL_ROWS)
                .map((fill) => (
                  // An outcome fill's coin is `#102251`; the namer accepts that
                  // spelling as well as the `+` one a balance uses.
                  <Pressable
                    accessible={false}
                    key={fill.key}
                    onPress={() => setDetail(fillDetail(fill))}
                  >
                    <FillItem fill={fill} named={nameOutcome(fill.coin)} />
                  </Pressable>
                ))
            )}
          </>
        )}

        {section === "twap" && (
          <FetchedList
            state={twaps.state}
            refresh={twaps.refresh}
            isEmpty={(rows) => rows.length === 0}
            emptyTitle="No TWAP orders"
            emptyDescription="Time-weighted orders you run appear here."
          >
            {(rows) => (
              <>
                {rows.length > TWAP_ROWS ? (
                  <TruncationNotice label={`showing the most recent ${TWAP_ROWS}`} />
                ) : null}
                {rows.slice(0, TWAP_ROWS).map((row, i) => (
                  // Index key, deliberately: `twapId` is ABSENT from every one
                  // of 12,806 measured history rows, so there is no id to use.
                  <TwapItem key={`${row.time}:${i}`} row={row} />
                ))}
              </>
            )}
          </FetchedList>
        )}

        {section === "funding" && (
          <FetchedList
            state={funding.state}
            refresh={funding.refresh}
            isEmpty={(rows) => rows.length === 0}
            emptyTitle="No funding yet"
            emptyDescription="Hourly funding on open perp positions appears here."
          >
            {(rows) => (
              <View className="gap-2">
                {/* The read is windowed, and saying so keeps the list from
                    reading as the whole history. */}
                <TruncationNotice
                  label={
                    rows.length > FUNDING_ROWS
                      ? `last ${funding.windowDays} days — showing the most recent ${FUNDING_ROWS}`
                      : `last ${funding.windowDays} days`
                  }
                />
                {rows.slice(0, FUNDING_ROWS).map((row, i) => (
                  <Pressable
                    accessible={false}
                    key={`${row.time}:${row.coin}:${i}`}
                    onPress={() => setDetail(fundingDetail(row))}
                  >
                    <FundingItem row={row} />
                  </Pressable>
                ))}
                {/* Pagination lives BELOW the rows — where a reader arrives
                    when they run out of history. Each press widens the window
                    another 30 days; the spend stays deliberate. */}
                <Button size="sm" variant="tertiary" onPress={funding.loadOlder}>
                  <Button.Label className="font-medium">Load 30 more days</Button.Label>
                </Button>
              </View>
            )}
          </FetchedList>
        )}

        {section === "transfers" && (
          <FetchedList
            state={ledger.state}
            refresh={ledger.refresh}
            isEmpty={(view) => view.rows.length === 0}
            emptyTitle="No transfers"
            emptyDescription="Deposits, withdrawals and internal moves appear here."
          >
            {(view) => (
              <View className="gap-2">
                {view.hasMore ? (
                  <TruncationNotice label="showing your most recent transfers" />
                ) : null}
                {view.rows.length > 0 ? (
                  <Button
                    size="sm"
                    variant="tertiary"
                    className="self-start"
                    onPress={() =>
                      void Share.share({
                        title: "transfers.csv",
                        message: ledgerCsv(view.rows, address ?? ""),
                      })
                    }
                  >
                    <Button.Label className="font-medium">Export CSV</Button.Label>
                  </Button>
                ) : null}
                {[...view.rows]
                  .sort((a, b) => b.time - a.time)
                  .slice(0, LEDGER_ROWS)
                  .map((row, i) => (
                    // `hash` is NOT unique and is all-zero on rows with no L1
                    // transaction, so it cannot key the list on its own.
                    <Pressable
                      accessible={false}
                      key={`${row.time}:${row.hash}:${i}`}
                      onPress={() => setDetail(ledgerDetail(row, address ?? ""))}
                    >
                      <LedgerItem row={row} viewer={address ?? ""} />
                    </Pressable>
                  ))}
                {view.hasMore ? (
                  // Pagination BELOW the rows — where a reader arrives when
                  // they run out. Disappears once the walk meets the list.
                  <Button
                    size="sm"
                    variant="tertiary"
                    isDisabled={ledger.isLoadingOlder}
                    onPress={ledger.loadOlder}
                  >
                    <Button.Label className="font-medium">
                      {ledger.isLoadingOlder ? "Loading…" : "Load older"}
                    </Button.Label>
                  </Button>
                ) : null}
              </View>
            )}
          </FetchedList>
        )}
      </Card>

      {/* One sheet for every row type; the content comes from `rowDetail.ts`,
          which is where the rules about what each field means live. */}
      <RowDetailSheet detail={detail} onClose={() => setDetail(null)} />

      {/* The Move tile's destination. Same control the deposit and withdraw
          screens mount — its props are read here, never re-derived. */}
      {/* The Close All confirm. A batch market close deserves one
          read-and-confirm; the per-row Close already has its own armed
          state. Each closes with a reduce-only IOC priced at the live mid. */}
      <Dialog isOpen={confirmCloseAll} onOpenChange={setConfirmCloseAll}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="gap-4 bg-background">
            <Dialog.ContentBackground className="bg-surface" />
            <View className="gap-1">
              <Dialog.Title className="font-semibold">
                Close {positions.length} positions at market?
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
                    void actions.closeAll(positions);
                  }}
                >
                  <Button.Label className="font-medium">Close All</Button.Label>
                </Button>
              </View>
            </View>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      <Dialog isOpen={isMoving} onOpenChange={setIsMoving}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="gap-4 bg-background">
            <Dialog.ContentBackground className="bg-surface" />
            <Dialog.Title className="font-semibold">Move USDC</Dialog.Title>
            {/* `toSpot` because a deposit credits PERP: money accumulates
                there, and spot is where prediction and spot trading spend it.
                A fixed default rather than one derived from the balances —
                a direction that changes between openings is exactly the
                silent wrong-way move `moveView.ts` is written to prevent. */}
            <PerpSpotMove
              session={session}
              canTrade={canTrade}
              initialDirection="toSpot"
              availableSpot={spotUsdc}
              availablePerp={perpUsdc}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </ScrollView>
  );
}

export default PortfolioTab;
