/**
 * The vault's activity feeds — the official page's seven bottom tabs.
 *
 * **Nothing loads until a tab is opened.** Every feed except Balances is 20
 * weight per family member (160 for HLP's eight), and mounting all seven would
 * spend most of a minute's allowance before the reader asked for anything. The
 * cost of the tab you are about to open is printed under the strip, because
 * the budget is shared with the rest of the app and a 160-weight tap is worth
 * knowing about.
 *
 * The desktop page renders each feed as a wide table with eight to eleven
 * columns. That does not survive a phone, so each row here is the app's
 * two-line shape — identity and time on the left, the figure on the right —
 * and the columns that do not fit become the subtitle. Nothing is dropped
 * silently: a truncated feed says so.
 *
 * Rows are tagged with the strategy that produced them whenever the family has
 * more than one member, since "which of the seven did this" is otherwise
 * unanswerable from a merged feed.
 */

import type { JSX } from "react";
import { useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import {
  Button,
  Popover,
  Skeleton,
  Switch,
  TagGroup,
  Tabs,
  Typography,
  useThemeColor,
} from "heroui-native";
import { EmptyState } from "heroui-native-pro";
import { ExternalLink, SlidersHorizontal } from "lucide-react-native";

import { FilterMenu } from "@/components/common/FilterMenu";
import { AddressText } from "@/components/money/AddressText";
import {
  applyFlag,
  distinctFlags,
  explorerTxUrl,
  FEED_SORTS,
  FEED_WINDOWS,
  sortFeed,
  type FeedSort,
  type FeedWindow,
} from "@/components/vaults/activityView";
import {
  ASSET_FILTERS,
  MARKET_TYPE_FILTERS,
  marketOptions,
  matchesFilters,
  FUNDING_SIDE_FILTERS,
  ORDER_SIDE_FILTERS,
  POSITION_SIDE_FILTERS,
  roleOf,
  ROLE_FILTERS,
  TWAP_VIEWS,
  type FilterOption,
  type TwapView,
  type FilterState,
} from "@/components/vaults/feedFilters";
import type { HlEnv } from "@/hyperliquid/types/domain";
import { compactUsd } from "@/components/portfolio/fetchedView";
import { CoinBadge, UsdLabel } from "@/components/portfolio/primitives";
import { toBigNumber } from "@/hyperliquid/core/precision";
import type { Fetched } from "@/hyperliquid/hooks/history";
import { WINDOWED_KINDS } from "@/hyperliquid/hooks/vaults";
import type { VaultActivityView } from "@/hyperliquid/hooks/vaults";
import { ACTIVITY_LABEL, activityCost, type ActivityKind } from "@/hyperliquid/vaults/activity";

import { ACTIVITY_ORDER } from "@/hyperliquid/vaults/activity";

/** A phone list, not a desktop table — the tail is counted, never silent. */
const VISIBLE_ROWS = 12;

export function VaultActivityCard({
  kind,
  onSelect,
  state,
  retry,
  members,
  env,
  window,
  onWindow,
  aggregate,
  onAggregate,
  counts,
  twapView,
  onTwapView,
}: {
  kind: ActivityKind;
  onSelect: (kind: ActivityKind) => void;
  state: Fetched<VaultActivityView>;
  retry: () => void;
  /** Family size — drives both the cost disclosure and the source tags. */
  members: number;
  /** Chooses the explorer host for L1 links. */
  env: HlEnv;
  window: FeedWindow;
  onWindow: (window: FeedWindow) => void;
  aggregate: boolean;
  onAggregate: (aggregate: boolean) => void;
  twapView: TwapView;
  onTwapView: (view: TwapView) => void;
  /**
   * Counts for the tabs whose size is known WITHOUT fetching.
   *
   * Strings, not numbers, so a capped feed can say `"100+"` — the followers
   * page is truncated at 100 by the API, and printing a flat `100` would
   * assert the vault has exactly that many depositors.
   *
   * Only the three derived feeds appear here. A fetched tab gets no count
   * until it is opened, because the only way to learn it is to spend the 160
   * weight — and a guessed number on a tab nobody has opened is a claim about
   * data this app has not read.
   */
  counts: Partial<Record<ActivityKind, string>>;
}): JSX.Element {
  const cost = activityCost(kind, members);

  // Sort and flag are LOCAL: both re-arrange rows already in memory, so
  // neither re-fetches. The window and aggregation do, which is why they are
  // the screen's state and arrive as props.
  const [sort, setSort] = useState<FeedSort>("newest");
  const [flag, setFlag] = useState<string | null>(null);
  // Keyed by filter id so a tab without a given control simply never sets it,
  // and `matchesFilters` reads a missing id as "all".
  const [filters, setFilters] = useState<FilterState>({});

  // Selections do NOT survive a tab switch. They looked shared but are not:
  // a market chosen on Positions silently emptied Open Orders, which showed
  // "nothing here" while its own filter row still listed the markets it had
  // (observed live). Adjusting state during render is React's own reset
  // pattern — no effect, no extra commit.
  const [filteredKind, setFilteredKind] = useState(kind);
  if (filteredKind !== kind) {
    setFilteredKind(kind);
    setFilters({});
    setFlag(null);
  }

  return (
    <View className="gap-3 rounded-3xl bg-surface p-5">
      <Typography.Paragraph className="text-xs text-muted font-normal">
        Activity
      </Typography.Paragraph>

      <Tabs
        variant="secondary"
        value={kind}
        onValueChange={(next) => onSelect(next as ActivityKind)}
      >
        <Tabs.List>
          {/* The ScrollView wrapper is load-bearing: the plain-List variant's
              indicator ignores a controlled value change (observed live). */}
          <Tabs.ScrollView>
            <Tabs.Indicator />
            {ACTIVITY_ORDER.map((tab) => (
              <Tabs.Trigger key={tab} value={tab}>
                <Tabs.Label className="font-medium">
                  {ACTIVITY_LABEL[tab]}
                  {counts[tab] === undefined ? "" : ` (${counts[tab]})`}
                </Tabs.Label>
              </Tabs.Trigger>
            ))}
          </Tabs.ScrollView>
        </Tabs.List>
      </Tabs>

      <ActivityBody
        state={state}
        retry={retry}
        members={members}
        env={env}
        sort={sort}
        flag={flag}
        onFlag={setFlag}
        kind={kind}
        filters={filters}
        onFilter={(id, value) => setFilters((prev) => ({ ...prev, [id]: value }))}
        caption={
          cost === 0
            ? "Derived from data already loaded — no request."
            : `${cost} weight across ${members} ${members === 1 ? "strategy" : "strategies"} · last ${
                FEED_WINDOWS.find(([value]) => value === window)?.[1] ?? ""
              }`
        }
        twapView={twapView}
        onTwapView={onTwapView}
        settings={
          // Sort, window and aggregation ride in the same row as the filters:
          // they are all "narrow what I am looking at" controls, and a gear
          // stranded on the caption line cost a whole row for one button.
          cost === 0 ? null : (
            <FeedSettings
              kind={kind}
              sort={sort}
              onSort={setSort}
              window={window}
              onWindow={onWindow}
              aggregate={aggregate}
              onAggregate={onAggregate}
            />
          )
        }
      />
    </View>
  );
}

/** The dropdowns, folded into one popover. */
function FeedSettings({
  kind,
  sort,
  onSort,
  window,
  onWindow,
  aggregate,
  onAggregate,
}: {
  kind: ActivityKind;
  sort: FeedSort;
  onSort: (sort: FeedSort) => void;
  window: FeedWindow;
  onWindow: (window: FeedWindow) => void;
  aggregate: boolean;
  onAggregate: (aggregate: boolean) => void;
}): JSX.Element {
  const mutedColor = useThemeColor("muted");

  return (
    <Popover>
      {/* A plain View inside the trigger, NOT a Button: `Popover.Trigger` is
          itself the pressable, and a nested Button captures the tap and the
          accessibility identity — the trigger then never fires (observed
          live). The same nested-pressable trap the chips taught us. */}
      <Popover.Trigger accessibilityLabel="Feed options">
        <View className="h-8 w-8 items-center justify-center rounded-full bg-background">
          <SlidersHorizontal size={16} color={mutedColor} />
        </View>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Overlay />
        <Popover.Content presentation="popover" className="gap-4 bg-background">
          <Popover.ContentBackground className="bg-surface" />

          <View className="gap-2">
            <Typography.Paragraph className="text-xs text-muted font-normal">
              Sort
            </Typography.Paragraph>
            <TagGroup
              size="sm"
              selectionMode="single"
              selectedKeys={[sort]}
              onSelectionChange={(keys) => {
                const next = [...(keys as Set<string>)][0];
                if (next !== undefined) onSort(next as FeedSort);
              }}
            >
              <TagGroup.List>
                {FEED_SORTS.map(([value, label]) => (
                  <TagGroup.Item key={value} id={value}>
                    {({ isSelected }) => (
                      <>
                        <TagGroup.ItemBackground />
                        <TagGroup.ItemLabel
                          className={
                            isSelected ? "text-accent font-semibold" : "text-muted font-medium"
                          }
                        >
                          {label}
                        </TagGroup.ItemLabel>
                      </>
                    )}
                  </TagGroup.Item>
                ))}
              </TagGroup.List>
            </TagGroup>
          </View>

          {/* Only for the feeds that HAVE a window. `readActivity` applies
              `since` to trades, funding and ledger alone; open orders, order
              history and TWAP call their probes with no time bound, so this
              control changed nothing about their rows — while still invalidating
              their cache and respending the family's weight. Gated the way
              Aggregate already is, rather than left visible and inert. */}
          {WINDOWED_KINDS.has(kind) ? (
            <View className="gap-2">
              <Typography.Paragraph className="text-xs text-muted font-normal">
                History window
              </Typography.Paragraph>
              <TagGroup
                size="sm"
                selectionMode="single"
                selectedKeys={[window]}
                onSelectionChange={(keys) => {
                  const next = [...(keys as Set<string>)][0];
                  if (next !== undefined) onWindow(next as FeedWindow);
                }}
              >
                <TagGroup.List>
                  {FEED_WINDOWS.map(([value, label]) => (
                    <TagGroup.Item key={value} id={value}>
                      {({ isSelected }) => (
                        <>
                          <TagGroup.ItemBackground />
                          <TagGroup.ItemLabel
                            className={
                              isSelected ? "text-accent font-semibold" : "text-muted font-medium"
                            }
                          >
                            {label}
                          </TagGroup.ItemLabel>
                        </>
                      )}
                    </TagGroup.Item>
                  ))}
                </TagGroup.List>
              </TagGroup>
              <Typography.Paragraph className="text-xs text-muted font-normal">
                A longer window re-fetches — same weight, more rows.
              </Typography.Paragraph>
            </View>
          ) : null}

          {/* Aggregation is a property of the FILLS endpoint alone; offering
              it on a feed it cannot affect would be a dead switch. */}
          {kind === "trades" ? (
            <View className="flex-row items-center justify-between gap-4">
              <View className="flex-1 gap-0.5">
                <Typography.Paragraph className="text-sm font-medium">
                  Aggregate
                </Typography.Paragraph>
                <Typography.Paragraph className="text-xs text-muted font-normal">
                  Merge partial fills of one order.
                </Typography.Paragraph>
              </View>
              <Switch isSelected={aggregate} onSelectedChange={onAggregate}>
                <Switch.Background />
                <Switch.Thumb />
              </Switch>
            </View>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}

function ActivityBody({
  state,
  retry,
  members,
  env,
  sort,
  flag,
  onFlag,
  kind,
  filters,
  onFilter,
  settings,
  caption,
  twapView,
  onTwapView,
}: {
  state: Fetched<VaultActivityView>;
  retry: () => void;
  members: number;
  env: HlEnv;
  sort: FeedSort;
  flag: string | null;
  onFlag: (flag: string | null) => void;
  kind: ActivityKind;
  filters: FilterState;
  onFilter: (id: string, value: string) => void;
  /** The feed-options control, rendered at the end of the controls row. */
  settings: JSX.Element | null;
  /** The weight/window line, rendered UNDER the controls. */
  caption: string;
  twapView: TwapView;
  onTwapView: (view: TwapView) => void;
}): JSX.Element {
  // Rows only exist once the feed is ready; everything below tolerates an
  // empty list so the controls and caption can render in every state rather
  // than vanishing behind a spinner.
  const ready = state.kind === "ready";
  const everything = ready ? renderRows(state.value.data, members) : [];
  const missing = ready ? state.value.missing : [];
  // Distinct from `missing`: that is "a strategy could not be read at all",
  // this is "we read it and the exchange holds more than fits one page". The
  // flag was being computed upstream and discarded here, so a vault with more
  // rows than a page showed a subset while the card implied completeness.
  const truncated = ready && state.value.truncated;

  // Four tabs have a REAL taxonomy the official page spells out; the rest get
  // the adaptive flag filter, whose categories are whatever the wire sent.
  const markets = {
    id: "market",
    label: "Market",
    options: marketOptions(everything.flatMap((row) => (row.coin === null ? [] : [row.coin]))),
  };
  const typeFilter = { id: "type", label: "Type", options: MARKET_TYPE_FILTERS };
  const orderSide = { id: "side", label: "Side", options: ORDER_SIDE_FILTERS };
  const fixed: { id: string; label: string; options: readonly FilterOption[] }[] =
    kind === "balances"
      ? [{ id: "asset", label: "Asset", options: ASSET_FILTERS }]
      : kind === "positions"
        ? [{ id: "side", label: "Side", options: POSITION_SIDE_FILTERS }, markets]
        : kind === "openOrders" || kind === "orderHistory"
          ? [typeFilter, orderSide, markets]
          : kind === "trades"
            ? [typeFilter, orderSide, { id: "role", label: "Role", options: ROLE_FILTERS }, markets]
            : kind === "funding"
              ? [{ id: "side", label: "Side", options: FUNDING_SIDE_FILTERS }, markets]
              : // Deposits/Withdrawals and Depositors have no dropdowns on the
                // official page either — there is no axis to slice them on.
                [];

  const all =
    fixed.length === 0 ? everything : everything.filter((row) => matchesFilters(row, filters));
  const flags = fixed.length === 0 ? distinctFlags(all) : [];
  // A flag that vanished when the feed refreshed must not silently filter
  // everything away — fall back to "all" rather than an empty list.
  const active = flag !== null && flags.includes(flag) ? flag : null;
  const rows = sortFeed(applyFlag(all, active), sort);

  return (
    <View className="gap-2.5">
      {/* ONE row for every control on every tab — filters, TWAP's view switch
          and the options button alike. Trade History carries four pills plus
          the button, which will not fit a 390pt screen, so the pills scroll
          horizontally and the button is pinned outside the scroller where it
          stays reachable. Wrapping would push the button to a second line
          exactly when a tab has the most to configure. */}
      <View className="flex-row items-center gap-2">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="grow flex-row items-center justify-end gap-2 pr-2"
          keyboardShouldPersistTaps="handled"
        >
          {/* TWAP's three views change WHICH endpoint is read, so they lead
              the row — but they are still one pill, like everything else. */}
          {kind === "twap" ? (
            <FilterMenu
              label="View"
              options={TWAP_VIEWS.map(([value, label]) => ({ id: value, label }))}
              selected={twapView}
              onSelect={(value) => onTwapView(value as TwapView)}
              alwaysShowSelection
            />
          ) : null}

          {fixed.map((group) => (
            <FilterMenu
              key={group.id}
              label={group.label}
              options={group.options}
              selected={filters[group.id] ?? "all"}
              onSelect={(value) => onFilter(group.id, value)}
            />
          ))}

          {/* Feeds with no official taxonomy keep the adaptive filter, in the
              same pill so every tab's controls sit on one line. */}
          {flags.length > 1 ? (
            <FilterMenu
              label="Filter"
              options={[
                { id: "all", label: "All" },
                ...flags.map((one) => ({ id: one, label: one })),
              ]}
              selected={active ?? "all"}
              onSelect={(value) => onFlag(value === "all" ? null : value)}
            />
          ) : null}
        </ScrollView>

        {settings}
      </View>

      {/* Under the controls, not above them: it describes what the controls
          just fetched, and leading with a cost line pushed the things you
          actually press down the card. */}
      <Typography.Paragraph className="text-xs text-muted font-normal">
        {caption}
      </Typography.Paragraph>

      {state.kind === "idle" || state.kind === "loading" ? (
        <Skeleton className="h-24 w-full rounded-lg" />
      ) : state.kind === "deferred" || state.kind === "error" ? (
        <EmptyState className="py-6">
          <EmptyState.Header>
            <EmptyState.Title className="font-semibold">
              {state.kind === "deferred" ? "Deferred" : "Could not load"}
            </EmptyState.Title>
            <EmptyState.Description className="font-normal">
              {state.kind === "deferred"
                ? "The request budget is protecting the connection. Try again shortly."
                : state.message}
            </EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            <Button size="sm" variant="tertiary" onPress={retry}>
              <Button.Label className="font-medium">Retry</Button.Label>
            </Button>
          </EmptyState.Content>
        </EmptyState>
      ) : (
        <>
          {missing.length > 0 ? (
            <Typography.Paragraph className="text-xs text-warning font-normal">
              {missing.length} {missing.length === 1 ? "strategy" : "strategies"} could not be read
              — this feed is incomplete.
            </Typography.Paragraph>
          ) : null}

          {truncated ? (
            <Typography.Paragraph className="text-xs text-muted font-normal">
              Showing the most recent rows — there are more than fit one page.
            </Typography.Paragraph>
          ) : null}

          {rows.length === 0 ? (
            <Typography.Paragraph className="text-sm text-muted font-normal">
              {/* A filtered-empty list is not an empty feed. Saying "nothing
                  here" over rows the reader's own filter is hiding sends them
                  looking for a data problem that does not exist. */}
              {everything.length > 0
                ? "No rows match these filters."
                : missing.length > 0
                  ? "Nothing in the strategies we could read."
                  : "Nothing in this window."}
            </Typography.Paragraph>
          ) : (
            rows
              .slice(0, VISIBLE_ROWS)
              .map((row) => <ActivityRow key={row.id} row={row} env={env} />)
          )}

          {rows.length > VISIBLE_ROWS ? (
            <Typography.Paragraph className="text-xs text-muted font-normal">
              and {rows.length - VISIBLE_ROWS} more
            </Typography.Paragraph>
          ) : null}
        </>
      )}
    </View>
  );
}

/** The one row shape every feed collapses into. */
interface Row {
  id: string;
  title: string;
  subtitle: string;
  /** Right-hand figure; `null` when the feed has none. */
  amount: string | null;
  /** Signed money renders through `UsdLabel`; anything else is plain text. */
  amountIsUsd: boolean;
  /** A second, smaller figure under the amount (a ratio, a percentage). */
  badge: string | null;
  tone: "success" | "danger" | "muted";
  source: string | null;
  /** Renders the token's artwork when the feed is per-coin. */
  coin: string | null;
  timeMs: number;
  sortValue: number | null;
  flag: string | null;
  /** Long/short for a position, buy/sell for an order. */
  sideId: "long" | "short" | "buy" | "sell" | null;
  /** Balances only: does this member hold anything? */
  isActive: boolean;
  /** Trade History only: which side of the spread. */
  roleId?: "maker" | "taker" | null;
  /** L1 transaction, when the row has one. */
  hash: string | null;
}

function ActivityRow({ row, env }: { row: Row; env: HlEnv }): JSX.Element {
  const { title, subtitle, amount, amountIsUsd, tone, source, coin } = row;
  const toneClass =
    tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-foreground";
  const txUrl = explorerTxUrl(env, row.hash);
  const mutedColor = useThemeColor("muted");

  return (
    <View className="flex-row items-center gap-3">
      {coin === null ? null : <CoinBadge coin={coin} />}
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center justify-between gap-3">
          <Typography.Paragraph className="shrink text-sm font-semibold" numberOfLines={1}>
            {title}
          </Typography.Paragraph>
          {/* Only the ledger feed carries an L1 hash, and `explorerTxUrl`
              returns null for the all-zero one — a row with no transaction
              gets no link rather than a link to a 404. */}
          {txUrl === null ? null : (
            <Pressable
              accessible
              accessibilityRole="link"
              accessibilityLabel="Open the L1 transaction"
              onPress={() => void Linking.openURL(txUrl)}
              hitSlop={8}
            >
              <ExternalLink size={13} color={mutedColor} />
            </Pressable>
          )}
          <View className="flex-1" />
          {amount === null ? null : (
            <Typography.Paragraph className={`text-sm tabular-nums font-semibold ${toneClass}`}>
              {amountIsUsd ? <UsdLabel value={amount} signed /> : amount}
            </Typography.Paragraph>
          )}
        </View>
        <View className="flex-row items-center justify-between gap-3">
          {/* Two lines, not one: these subtitles now carry six or seven of
              the desktop table's columns, and a single clipped line dropped
              everything past "mark" (observed live). */}
          <Typography.Paragraph
            className="flex-1 text-xs text-muted tabular-nums font-normal"
            numberOfLines={2}
          >
            {subtitle}
          </Typography.Paragraph>
          {row.badge === null ? null : (
            <Typography.Paragraph className={`text-xs tabular-nums font-medium ${toneClass}`}>
              {row.badge}
            </Typography.Paragraph>
          )}
          {source === null ? null : (
            <AddressText address={source} truncated className="text-xs text-muted font-normal" />
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * The official page's wording for the ledger actions we can name.
 *
 * Anything absent falls back to the wire's own `type` verbatim — new types
 * keep appearing, and inventing a friendly name for one we have not seen is
 * how a transfer gets mislabelled.
 */
const LEDGER_ACTIONS: Record<string, string> = {
  vaultDeposit: "Vault Deposit",
  vaultWithdraw: "Vault Withdrawal",
  deposit: "Deposit",
  withdraw: "Withdrawal",
  internalTransfer: "Internal Transfer",
  spotTransfer: "Spot Transfer",
  accountClassTransfer: "Perp/Spot Transfer",
  subAccountTransfer: "Sub-account Transfer",
};

/**
 * A derived price at a readable width.
 *
 * Marks, entries and liquidation prices all arrive as exact decimals that can
 * run to twenty places; six significant digits keeps a sub-cent meme coin's
 * leading digits and a five-figure coin's cents alike.
 */
function sigDigits(value: string): string {
  const parsed = toBigNumber(value);
  return parsed.isFinite() ? parsed.precision(6).toFixed() : "—";
}

/** `"0.0238"` → `"+2.38%"`. */
function percent(fraction: string): string {
  const parsed = toBigNumber(fraction);
  if (!parsed.isFinite()) return "—";
  const scaled = parsed.multipliedBy(100);
  return `${scaled.gt(0) ? "+" : ""}${scaled.toFixed(2)}%`;
}

/** Local time-of-day + date, short enough for a subtitle. */
/**
 * Two formatters, built ONCE.
 *
 * `toLocaleDateString`/`toLocaleTimeString` construct a fresh
 * `Intl.DateTimeFormat` on every call, and that construction — not the
 * formatting — is the expensive part under Hermes' Apple ICU binding. `stamp`
 * is called for every row in the fetched feed, not just the twelve rendered:
 * on mainnet HLP's trade history that was ~16,000 rows x 2 calls = ~32,000
 * formatter constructions, synchronously inside render, to paint 12 rows.
 *
 * Hoisting is the cheap half of the fix and takes the dominant term out.
 *
 * **The expensive half was then measured, and the premise did not hold.**
 * Profiled on device (testnet HLP, Trade History, 8 strategies, last 7d): the
 * tab switch costs one 268 ms commit, and `ActivityBody` is 102.77 ms of it —
 * but the CPU profile under that commit contains no `renderRows`, no `stamp`
 * and no `sigDigits`. What it contains is `ReactElement` (30 ms) and
 * `reconcileChildFibersImpl` (24 ms) — MOUNTING the twelve visible rows, which
 * are genuinely heavy (9 `SvgXml`, 137 `Path`, 170 `Text`, 76 `HeroText`) — plus
 * `getChangeDescription` (27 ms), which is React DevTools' own instrumentation
 * and does not exist in production.
 *
 * So the restructure is NOT justified by this evidence, and doing it would have
 * been a large, risky change to a money-adjacent display for no measured gain.
 *
 * Two honest caveats, so nobody reads this as settled: the sampler took only 22
 * samples at ~18 ms over that window, so a diffuse cost could hide between
 * them; and this is testnet's 7-day feed, not the ~16,000-row mainnet HLP case
 * the concern was written about. The O(n) term is real, it is simply not the
 * dominant one at the scale reachable here. Re-measure on mainnet before
 * spending anything on it.
 */
const STAMP_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const STAMP_TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

function stamp(timeMs: number): string {
  if (!Number.isFinite(timeMs) || timeMs <= 0) return "—";
  const at = new Date(timeMs);
  return `${STAMP_DATE.format(at)} ${STAMP_TIME.format(at)}`;
}

/**
 * Each feed's own fields, mapped to the shared row.
 *
 * Deliberately here and not in the hook: these are presentation decisions
 * (which column becomes the subtitle, which figure is the headline), and the
 * fetch layer keeps the wire's shapes intact so nothing is lost before it.
 */
function renderRows(data: VaultActivityView["data"], members: number): Row[] {
  const tag = (address: string): string | null => (members > 1 ? address : null);

  switch (data.kind) {
    case "balances":
      return data.rows.map((row) => ({
        id: row.address,
        title: "USDC (Perps)",
        subtitle: `${row.positions} position${row.positions === 1 ? "" : "s"} · ${compactUsd(
          row.withdrawable
        )} withdrawable`,
        amount: compactUsd(row.accountValue),
        amountIsUsd: false,
        badge: null,
        tone: "muted" as const,
        source: tag(row.address),
        coin: null,
        timeMs: 0,
        sortValue: Number(row.accountValue),
        flag: null,
        hash: null,
        sideId: null,
        isActive: Number(row.accountValue) > 0 || row.positions > 0,
      }));

    case "positions":
      return data.rows.map((row) => ({
        id: row.coin,
        // The official page puts the leverage badge beside the market.
        title: row.leverage === null ? row.coin : `${row.coin}  ${row.leverage}x`,
        subtitle: [
          row.isFlat ? "net flat" : `${row.side} ${row.netSize}`,
          `${compactUsd(row.grossNotional)} gross`,
          row.markPx === null ? null : `mark ${sigDigits(row.markPx)}`,
          row.entryPx === null ? "entry —" : `entry ${sigDigits(row.entryPx)}`,
          // `liquidationPx: null` on a single leg is the wire's own "cannot be
          // liquidated by price at current equity"; on a merged row it is our
          // refusal. Both render as a dash rather than an invented number.
          row.liquidationPx === null ? "liq —" : `liq ${sigDigits(row.liquidationPx)}`,
          row.marginUsed === null
            ? "margin —"
            : `margin ${compactUsd(row.marginUsed)}${row.marginMode === null ? "" : ` (${row.marginMode})`}`,
          row.legs > 1 ? `${row.legs} legs${row.conflicted ? " opposed" : ""}` : null,
        ]
          .filter((part) => part !== null)
          .join(" · "),
        amount: row.unrealizedPnl,
        amountIsUsd: true,
        // Return on the margin POSTED — not the official page's ROE, which
        // divides by entry equity and is per-leg. Named accordingly.
        badge: row.returnOnMargin === null ? null : `${percent(row.returnOnMargin)} on margin`,
        tone:
          Number(row.unrealizedPnl) > 0
            ? ("success" as const)
            : Number(row.unrealizedPnl) < 0
              ? ("danger" as const)
              : ("muted" as const),
        source: null,
        coin: row.coin,
        timeMs: 0,
        sortValue: Number(row.grossNotional),
        flag: row.isFlat ? "Hedged" : row.side === "long" ? "Long" : "Short",
        hash: null,
        sideId: row.isFlat ? null : row.side,
        isActive: true,
      }));

    case "depositors":
      return data.rows.map((row, index) => ({
        // `user` is nullable on the wire — the leader row and a few others
        // arrive without one — so the index keeps the key stable rather than
        // collapsing every anonymous row onto one.
        id: row.user ?? `follower-${index}`,
        // Bold-ends truncation, the house address rendering: a 42-character
        // hex string would eat the whole row and push the equity off it.
        title: row.user === null ? "—" : `${row.user.slice(0, 6)}…${row.user.slice(-4)}`,
        // Vault Amount · Unrealized PNL · All-time PNL · Days Following.
        subtitle: `unrealized ${row.pnl} · all-time ${row.allTimePnl} · ${row.daysFollowing} day${
          row.daysFollowing === 1 ? "" : "s"
        }`,
        amount: row.vaultEquity,
        amountIsUsd: true,
        badge: null,
        tone: "muted" as const,
        source: null,
        coin: null,
        timeMs: row.entryTimeMs,
        sortValue: Number(row.vaultEquity),
        flag: row.isLeader ? "Leader" : "Follower",
        hash: null,
        sideId: null,
        isActive: true,
      }));

    case "openOrders":
      return data.rows.map((row) => ({
        id: `${row.sourceAddress}:${row.oid}`,
        title: row.coin,
        subtitle: [
          `${row.side === "buy" ? "Long/Buy" : "Short/Sell"} ${row.remainingSz}`,
          // Size vs Original Size — only worth saying when they differ.
          row.remainingSz === row.originalSz ? null : `of ${row.originalSz}`,
          `@ ${row.limitPx}`,
          `${row.orderType}${row.tif === null ? "" : ` ${row.tif}`}`,
          row.reduceOnly ? "reduce-only" : null,
          row.isTrigger && row.triggerPx !== null
            ? `trigger ${row.triggerCondition} ${row.triggerPx}`
            : null,
          row.isPositionTpsl ? "TP/SL" : null,
          stamp(row.placedAt),
        ]
          .filter((part) => part !== null)
          .join(" · "),
        // Order Value, the column the official page sorts on.
        amount: compactUsd(String(Number(row.remainingSz) * Number(row.limitPx))),
        amountIsUsd: false,
        badge: null,
        tone: row.side === "buy" ? ("success" as const) : ("danger" as const),
        source: tag(row.sourceAddress),
        coin: row.coin,
        timeMs: row.placedAt,
        sortValue: Number(row.remainingSz) * Number(row.limitPx),
        flag: row.side === "buy" ? "Buy" : "Sell",
        hash: null,
        sideId: row.side,
        isActive: true,
      }));

    case "trades":
      return data.rows.map((row) => ({
        id: `${row.sourceAddress}:${row.oid}:${row.tid}`,
        title: row.coin,
        // Price · Size · Trade Value · Fee, the official columns in order.
        subtitle: `${row.dir} ${row.sz} @ ${row.px} · ${compactUsd(
          String(Number(row.px) * Number(row.sz))
        )} · fee ${row.fee} ${row.feeToken} · ${roleOf(row.crossed)} · ${stamp(row.time)}`,
        // Closed PnL is the figure the official Trade History leads with.
        amount: row.closedPnl,
        amountIsUsd: true,
        badge: null,
        tone:
          Number(row.closedPnl) > 0
            ? ("success" as const)
            : Number(row.closedPnl) < 0
              ? ("danger" as const)
              : ("muted" as const),
        source: tag(row.sourceAddress),
        coin: row.coin,
        timeMs: row.time,
        sortValue: Number(row.closedPnl),
        flag: row.dir,
        // Fills carry an L1 hash too — the official page links every row.
        hash: row.hash,
        sideId: row.side,
        isActive: true,
        roleId: roleOf(row.crossed),
      }));

    case "funding":
      return data.rows.map((row, index) => ({
        id: `${row.sourceAddress}:${row.time}:${row.coin}:${index}`,
        title: row.coin,
        // Funding is charged on a POSITION, so the side comes from the signed
        // size — the ledger has no side field.
        subtitle: `${Number(row.szi) < 0 ? "Short" : "Long"} ${Math.abs(
          Number(row.szi)
        ).toLocaleString()} · rate ${(Number(row.fundingRate) * 100).toFixed(4)}% · ${stamp(row.time)}`,
        // Positive is funding RECEIVED, negative is PAID — the wire's own
        // sign convention, which is opposite to `cumFunding`.
        amount: row.usdc,
        amountIsUsd: true,
        badge: null,
        tone: Number(row.usdc) > 0 ? ("success" as const) : ("danger" as const),
        source: tag(row.sourceAddress),
        coin: row.coin,
        timeMs: row.time,
        sortValue: Number(row.usdc),
        flag: Number(row.usdc) > 0 ? "Received" : "Paid",
        hash: null,
        sideId: Number(row.szi) < 0 ? ("short" as const) : ("long" as const),
        isActive: true,
      }));

    case "orderHistory":
      return data.rows.map((row) => ({
        id: `${row.sourceAddress}:${row.oid}`,
        title: row.coin,
        subtitle: `${row.side} · ${row.finalStatus} · #${row.oid} · ${stamp(row.lastAt)}`,
        amount: null,
        amountIsUsd: false,
        badge: null,
        tone: "muted" as const,
        source: tag(row.sourceAddress),
        coin: row.coin,
        timeMs: row.lastAt,
        sortValue: null,
        flag: row.finalStatus,
        hash: null,
        // `side` here is the wire's own spelling ("A"/"B" or a word); only a
        // clean buy/sell can answer the Side filter, so anything else stays
        // null rather than being guessed into a bucket.
        sideId:
          row.side.toLowerCase() === "buy" || row.side.toLowerCase() === "b"
            ? ("buy" as const)
            : row.side.toLowerCase() === "sell" || row.side.toLowerCase() === "a"
              ? ("sell" as const)
              : null,
        isActive: true,
      }));

    case "twap":
      return data.rows.map((row, index) => ({
        id: `${row.sourceAddress}:${row.time}:${index}`,
        title: row.coin,
        subtitle: [
          row.isBuy === null ? null : row.isBuy ? "Buy" : "Sell",
          row.size === null
            ? null
            : `${row.executedSize ?? "0"} of ${row.size}${
                row.durationMinutes === null ? "" : ` over ${row.durationMinutes}m`
              }`,
          row.reduceOnly === true ? "reduce-only" : null,
          row.status,
          stamp(row.time),
        ]
          .filter((part) => part !== null)
          .join(" · "),
        amount: row.executedNotional === null ? null : compactUsd(row.executedNotional),
        amountIsUsd: false,
        badge: null,
        tone: "muted" as const,
        source: tag(row.sourceAddress),
        coin: row.coin === "—" ? null : row.coin,
        timeMs: row.time,
        sortValue: row.executedNotional === null ? null : Number(row.executedNotional),
        flag: row.status,
        hash: null,
        sideId: null,
        isActive: true,
      }));

    case "ledger":
      return data.rows.map((row, index) => ({
        id: `${row.sourceAddress}:${row.time}:${index}`,
        // Action, in the official page's wording where we can spell it.
        title: LEDGER_ACTIONS[row.type] ?? row.type,
        // Status · Source → Destination · Fee. The wire has no status field on
        // a settled row — it is in the ledger BECAUSE it completed — so the
        // official "Completed" is a restatement of that, not a read.
        subtitle: `Completed · ${stamp(row.time)}${
          typeof row.delta.fee === "string" ? ` · fee ${row.delta.fee}` : ""
        }`,
        // Account Value Change.
        amount: typeof row.delta.usdc === "string" ? row.delta.usdc : null,
        amountIsUsd: true,
        badge: null,
        tone:
          typeof row.delta.usdc === "string"
            ? Number(row.delta.usdc) > 0
              ? ("success" as const)
              : ("danger" as const)
            : ("muted" as const),
        source: tag(row.sourceAddress),
        coin: null,
        timeMs: row.time,
        sortValue: typeof row.delta.usdc === "string" ? Number(row.delta.usdc) : null,
        flag: row.type,
        hash: row.hash,
        sideId: null,
        isActive: true,
      }));
  }
}
