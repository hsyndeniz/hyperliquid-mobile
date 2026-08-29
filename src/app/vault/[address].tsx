/**
 * One vault: chart, stats, your position, followers, and the two transfers.
 *
 * Where each number comes from — the split matters because the two sources
 * have different costs:
 *
 * - **Route params** (`name`, `tvl`, `apr`) ride from the list row so the
 *   header and hero render before anything is fetched. TVL stays a param
 *   fact: `vaultDetails` has no TVL field, and `maxDistributable` is free
 *   margin, not TVL.
 * - **`useVaultDetail`** (weight 60, server-throttled ~1/s) fills the chart,
 *   description, followers, commission and the caller's `followerState`. A
 *   deferral renders a neutral notice + Retry button — never an auto-retry
 *   (it prolongs the server penalty), never an empty chart.
 * - **`useNamedVaultPositions`** (weight 20, usually cached) is the position
 *   panel's PREFERRED source: after a transfer the equities re-read heals
 *   what the detail's 60 would re-buy.
 *
 * The chart is the shared `HistoryChart` — a vault's portfolio wire shape is
 * identical to the account's, so both the component and `chartView.ts`'s
 * drawdown/stat helpers reuse unchanged.
 */

import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { router, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { Button, Card, Chip, Skeleton, Typography, useThemeColor } from "heroui-native";
import { Check, Copy } from "lucide-react-native";
import { EmptyState, Segment } from "heroui-native-pro";

import { HistoryChart } from "@/components/charts/HistoryChart";

import { StatusDot } from "@/components/account/primitives";
import { TONE_TEXT } from "@/components/account/accountView";
import { AddressText } from "@/components/money/AddressText";
import { compactUsd } from "@/components/portfolio/fetchedView";
import { maxDrawdown, drawdownPercent, type ChartPeriod } from "@/components/portfolio/chartView";
import { Usd } from "@/components/portfolio/primitives";
import { StatTileGrid } from "@/components/markets/StatTile";
import { VaultActivityCard } from "@/components/vaults/VaultActivityCard";
import { windowMs, type FeedWindow } from "@/components/vaults/activityView";
import type { TwapView } from "@/components/vaults/feedFilters";
import { VaultTransferSheet } from "@/components/vaults/VaultTransferSheet";
import {
  periodOf,
  periodPnl,
  periodReturn,
  periodVolume,
  returnPercent,
} from "@/components/vaults/vaultPerformance";
import {
  aprLabel,
  commissionLabel,
  followerCountLabel,
  lockupLine,
  sinceLabel,
} from "@/components/vaults/vaultsView";
import { hlConfig } from "@/hyperliquid/config/env";
import { useSessionAddress, useSessionState } from "@/hyperliquid/hooks/session";
import {
  useNamedVaultPositions,
  useVaultActivity,
  useVaultDetail,
  useVaultFamily,
} from "@/hyperliquid/hooks/vaults";
import type { ActivityKind } from "@/hyperliquid/vaults/activity";
import { acceptsDeposits } from "@/hyperliquid/vaults/details";
import type { LockupState } from "@/hyperliquid/vaults/lockup";
import type { Hex } from "@/hyperliquid/types/domain";
import type { VaultDetail } from "@/hyperliquid/vaults/types";
import { useHyperliquid } from "@/providers/HyperliquidProvider";

/** Wire period keys for the four plain windows (the `perp*` set is out of scope). */
const PERIODS: [ChartPeriod, string][] = [
  ["day", "1D"],
  ["week", "1W"],
  ["month", "1M"],
  ["allTime", "All"],
];

type ChartMetric = "value" | "pnl";

/** The lockup countdown cadence, focus-gated. */
const LOCKUP_TICK_MS = 15_000;

/** How long the copied confirmation stays up. */
const COPIED_MS = 2_000;

function first(param: string | string[] | undefined): string | null {
  if (Array.isArray(param)) return param[0] ?? null;
  return param ?? null;
}

/**
 * The month tiles.
 *
 * All four read the `month` window of the portfolio the detail already
 * fetched, so the card costs nothing. `null` stays `null` all the way to
 * `StatTileGrid`, which renders it as `--` — a period the wire did not send is
 * not a zero.
 */
function monthPnlLabel(vault: VaultDetail): string | null {
  const pnl = periodPnl(periodOf(vault.portfolio, "month"));
  return pnl === null ? null : usdSigned(pnl);
}

function monthReturnLabel(vault: VaultDetail): string | null {
  return returnPercent(periodReturn(periodOf(vault.portfolio, "month")));
}

function monthVolumeLabel(vault: VaultDetail): string | null {
  const volume = periodVolume(periodOf(vault.portfolio, "month"));
  return volume === null ? null : compactUsd(volume);
}

function monthDrawdownLabel(vault: VaultDetail): string | null {
  const entry = periodOf(vault.portfolio, "month");
  if (entry === null) return null;
  const fraction = maxDrawdown(entry.accountValueHistory);
  return fraction === null ? null : drawdownPercent(fraction);
}

/** `"6188.27"` → `"+$6,188.27"`. Signed, because a vault's month can lose. */
function usdSigned(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "--";
  const body = Math.abs(amount).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
  return amount < 0 ? `-${body}` : `+${body}`;
}

export default function VaultDetailScreen(): JSX.Element {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    address: string;
    name?: string;
    tvl?: string;
    apr?: string;
    created?: string;
  }>();
  const address = (first(params.address)?.toLowerCase() ?? null) as Hex | null;
  const paramName = first(params.name);
  const paramTvl = first(params.tvl);
  const paramApr = first(params.apr);
  const paramCreated = Number(first(params.created) ?? "0");

  const { session } = useHyperliquid();
  const sessionState = useSessionState(session);
  const user = useSessionAddress(session);
  const env = sessionState?.config.env ?? hlConfig.env;
  const successColor = useThemeColor("success");
  const mutedColor = useThemeColor("muted");

  const [now, setNow] = useState(() => Date.now());
  useFocusEffect(
    useCallback(() => {
      setNow(Date.now());
      const timer = setInterval(() => setNow(Date.now()), LOCKUP_TICK_MS);
      return () => clearInterval(timer);
    }, [])
  );

  const detail = useVaultDetail(address, user, env);
  const positions = useNamedVaultPositions(user, now);
  const vault = detail.state.kind === "ready" ? detail.state.value : null;

  const [sheet, setSheet] = useState<"deposit" | "withdraw" | null>(null);

  const [copied, setCopied] = useState(false);
  const copyAddress = useCallback(async () => {
    if (address === null) return;
    if (!(await Clipboard.setStringAsync(address))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  }, [address]);

  // Runs after the detail lands — the child addresses come from it. 2 weight
  // per family member: 2 for a plain vault, 16 for mainnet HLP.
  const family = useVaultFamily(vault);
  const familyView = family.state.kind === "ready" ? family.state.value : null;

  // Opens on Balances, which is derived from the family snapshot and costs
  // nothing; every other tab spends 20 weight per member when SELECTED.
  const [activityTab, setActivityTab] = useState<ActivityKind>("positions");
  // The window and the aggregate switch change WHAT IS FETCHED, so they live
  // here beside the hook; sort and the flag filter only re-arrange rows
  // already in memory and stay inside the card.
  const [feedWindow, setFeedWindow] = useState<FeedWindow>("week");
  const [aggregate, setAggregate] = useState(false);
  // TWAP's sub-tab changes WHICH ENDPOINT is read, so it lives here with the
  // other fetch-shaping state rather than inside the card.
  const [twapView, setTwapView] = useState<TwapView>("active");
  const activityOptions = { windowMs: windowMs(feedWindow), aggregate, twapView };
  const activity = useVaultActivity(vault, activityTab, familyView, env, activityOptions);

  const title = vault?.name ?? paramName ?? "Vault";
  const apr = aprLabel(paramApr);
  const held =
    positions.state.kind === "ready" && address !== null
      ? (positions.state.value.find((position) => position.vault === address) ?? null)
      : null;

  // The title is the vault's NAME, which only this screen can resolve — so it
  // is pushed to the native header rather than declared in the navigator. The
  // hero below still renders it in full and wrapping; see the note there for
  // why both exist.
  const navigation = useNavigation();
  useEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  const body = (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-4 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {/* Hero: params first, detail facts as they land.

            The name appears here AND in the header bar above, and that is
            deliberate rather than an oversight to tidy away. They do different
            jobs: the native header title is a single truncating line, so it
            gives persistent orientation while you scroll but CANNOT show the
            whole name — and the verbatim name is the impersonation defence's
            other half. 222 vaults share a
            normalised name, one of them a live HLP impostor a single space
            apart, so the one place that shows the name in full, wrapping,
            unabbreviated, has to stay.

            `text-2xl` rather than the default h1 `text-4xl`: at 36pt this name
            took two lines of 40pt each and pushed its own chips onto a third
            row, spending 80pt before a single fact about the vault. A typical
            name now fits one line beside its chips, which is what the
            `flex-wrap` here was for; a genuinely long one still wraps, and
            should. */}
        <View className="gap-2">
          <View className="flex-row flex-wrap items-center gap-2">
            <Typography.Heading className="text-2xl font-bold">{title}</Typography.Heading>
            {vault?.isClosed ? (
              <Chip size="sm" color="danger" variant="soft">
                <Chip.Label className="font-medium">Closed</Chip.Label>
              </Chip>
            ) : null}
            {vault !== null && !vault.isClosed && !vault.allowDeposits ? (
              <Chip size="sm" color="warning" variant="soft">
                <Chip.Label className="font-medium">Deposits paused</Chip.Label>
              </Chip>
            ) : null}
            {vault?.relationship.kind === "parent" ? (
              <Chip size="sm" variant="soft">
                <Chip.Label className="font-medium">
                  Parent · {vault.relationship.childAddresses.length} children
                </Chip.Label>
              </Chip>
            ) : vault?.relationship.kind === "child" ? (
              <Chip size="sm" variant="soft">
                <Chip.Label className="font-medium">Child vault</Chip.Label>
              </Chip>
            ) : null}
          </View>
          {/* The vault's OWN address, with a copy — the one identity a
            depositor needs to verify they are looking at the right vault, and
            the only one the transfer echo will show them later. The leader is
            a separate fact and sits beside it. */}
          {address !== null ? (
            <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
              <Pressable
                accessible
                accessibilityRole="button"
                accessibilityLabel="Copy vault address"
                onPress={() => void copyAddress()}
                className="flex-row items-center gap-1.5"
              >
                <AddressText
                  address={address}
                  truncated
                  className="text-xs tabular-nums font-normal"
                />
                {copied ? (
                  <Check size={12} color={successColor} />
                ) : (
                  <Copy size={12} color={mutedColor} />
                )}
              </Pressable>
              {vault !== null ? (
                <View className="flex-row items-center gap-2">
                  <Typography.Paragraph className="text-xs text-muted font-normal">
                    Leader
                  </Typography.Paragraph>
                  <AddressText
                    address={vault.leader}
                    truncated
                    className="text-xs tabular-nums font-normal"
                  />
                </View>
              ) : null}
            </View>
          ) : null}
          {/* Deposit / Withdraw sit at the TOP, beside the identity they act
            on — the official page puts them in its header for the same
            reason. Buried under the feeds they were four screens of scrolling
            from the vault's name. They still gate on the DETAIL, because the
            sheet needs detail-grade facts (name, checksummed address) to
            build the preflight echo at all. */}
          {vault !== null && sessionState !== null ? (
            <View className="flex-row gap-2 pt-1">
              <View className="flex-1">
                <Button onPress={() => setSheet("deposit")} isDisabled={!acceptsDeposits(vault)}>
                  <Button.Label className="font-medium">Deposit</Button.Label>
                </Button>
              </View>
              {held !== null ? (
                <View className="flex-1">
                  <Button variant="secondary" onPress={() => setSheet("withdraw")}>
                    <Button.Label className="font-medium">Withdraw</Button.Label>
                  </Button>
                </View>
              ) : null}
            </View>
          ) : null}
          {vault !== null && !acceptsDeposits(vault) ? (
            <Typography.Paragraph className="text-xs text-muted font-normal">
              {vault.isClosed ? "This vault is closed." : "The leader has paused deposits."}
            </Typography.Paragraph>
          ) : null}

          <View className="flex-row gap-3">
            {/* Always rendered, `--` when unknown. TVL and APR both ride in as
              route params from the list row, so a deep link (or a reload)
              arrives without them — hiding the tile made APR stretch to full
              width and the hero jump between entry paths. */}
            <View className="flex-1 gap-1 rounded-xl bg-surface px-3 py-3">
              <Typography.Paragraph className="text-xs text-muted font-normal">
                TVL
              </Typography.Paragraph>
              <Typography.Paragraph className="text-sm tabular-nums font-semibold">
                {paramTvl === null ? "--" : compactUsd(paramTvl)}
              </Typography.Paragraph>
            </View>
            <View className="flex-1 gap-1 rounded-xl bg-surface px-3 py-3">
              <Typography.Paragraph className="text-xs text-muted font-normal">
                APR
              </Typography.Paragraph>
              <Typography.Paragraph
                className={`text-sm tabular-nums font-semibold ${TONE_TEXT[apr.tone]}`}
              >
                {apr.label}
              </Typography.Paragraph>
            </View>
          </View>
        </View>

        <VaultChart state={detail.state} retry={detail.refresh} />

        {/* Vault performance — every figure below comes out of the portfolio
          series the detail already paid for, so this whole card is free. */}
        {vault !== null ? (
          <Card className="gap-3">
            <Typography.Paragraph className="text-xs text-muted font-normal">
              Vault performance · past month
            </Typography.Paragraph>
            <StatTileGrid
              tiles={[
                { label: "P&L", value: monthPnlLabel(vault) },
                // Named for its denominator: the official app's "Past Month
                // Return" uses an undocumented one, and the obvious guess prints
                // −26% for a month HLP made money in (see `vaultPerformance.ts`).
                { label: "Return on start equity", value: monthReturnLabel(vault) },
                { label: "Volume", value: monthVolumeLabel(vault) },
                { label: "Max drawdown", value: monthDrawdownLabel(vault) },
              ]}
            />
          </Card>
        ) : null}

        {/* The strategies a parent actually runs — each one navigable, since a
          child holds the book the parent does not. */}
        {vault !== null && vault.relationship.kind === "parent" ? (
          <Card className="gap-3">
            <Typography.Paragraph className="text-xs text-muted font-normal">
              Component strategies · {vault.relationship.childAddresses.length}
            </Typography.Paragraph>
            {vault.relationship.childAddresses.map((child) => (
              <Pressable
                key={child}
                accessible={false}
                onPress={() => router.push(`/vault/${child}`)}
                className="flex-row items-center justify-between gap-3 py-1.5"
              >
                <AddressText
                  address={child}
                  truncated
                  className="text-sm tabular-nums font-normal"
                />
                <Typography.Paragraph className="text-xs text-muted font-normal">
                  View ›
                </Typography.Paragraph>
              </Pressable>
            ))}
          </Card>
        ) : null}

        {vault !== null ? (
          <Card className="gap-3">
            <Typography.Paragraph className="text-xs text-muted font-normal">
              Vault stats
            </Typography.Paragraph>
            <StatTileGrid
              tiles={[
                { label: "Profit share", value: commissionLabel(vault.leaderCommission) },
                {
                  label: "Free margin",
                  value:
                    vault.maxDistributable === null
                      ? null
                      : `≈ ${compactUsd(vault.maxDistributable)}`,
                },
                { label: "Followers", value: followerCountLabel(vault.followers) },
                // Creation time is directory-grade data the detail lacks — it
                // rides as a param and is honestly absent on a deep link.
                { label: "Since", value: sinceLabel(paramCreated) },
              ]}
            />
          </Card>
        ) : null}

        {vault !== null ? (
          <VaultActivityCard
            kind={activityTab}
            onSelect={setActivityTab}
            state={activity.state}
            retry={activity.refresh}
            members={familyView?.members.length ?? 1}
            counts={{
              ...(familyView === null
                ? {}
                : {
                    balances: String(familyView.members.length),
                    positions: String(familyView.positions.length),
                  }),
              ...(vault === null
                ? {}
                : {
                    // The API caps this page at 100; a flat "100" would assert
                    // the vault has exactly that many depositors.
                    depositors: vault.followers.truncated
                      ? `${vault.followers.rows.length}+`
                      : String(vault.followers.rows.length),
                  }),
            }}
            env={env}
            window={feedWindow}
            onWindow={setFeedWindow}
            aggregate={aggregate}
            onAggregate={setAggregate}
            twapView={twapView}
            onTwapView={setTwapView}
          />
        ) : null}

        {vault !== null && vault.description.length > 0 ? (
          <DescriptionCard text={vault.description} />
        ) : null}

        {/* Your position — equities preferred, followerState as the fallback. */}
        {held !== null || vault?.followerState ? (
          <Card className="gap-3">
            <Typography.Paragraph className="text-xs text-muted font-normal">
              Your position
            </Typography.Paragraph>
            {held !== null ? (
              <>
                <View className="flex-row items-center justify-between">
                  <Typography.Paragraph className="text-sm text-muted font-normal">
                    Equity
                  </Typography.Paragraph>
                  <Usd value={held.equity} />
                </View>
                <PositionLockupRow lockup={held.lockup} />
              </>
            ) : null}

            {/* The earned figures come only from `followerState`, which arrives
              only when the detail was fetched WITH a user — so they ride
              alongside the equities row rather than replacing it. */}
            {vault?.followerState ? (
              <StatTileGrid
                tiles={[
                  { label: "Your deposits", value: `$${vault.followerState.vaultEquity}` },
                  { label: "All-time earned", value: usdSigned(vault.followerState.allTimePnl) },
                  { label: "Unrealized P&L", value: usdSigned(vault.followerState.pnl) },
                  {
                    label: "Days following",
                    value: String(vault.followerState.daysFollowing),
                  },
                ]}
              />
            ) : null}
          </Card>
        ) : null}
      </ScrollView>
    </View>
  );

  return (
    <>
      {body}

      {/* OUTSIDE the ScrollView, deliberately. The sheets used to live inside
          it, which worked only because gorhom teleported them out through a
          portal; this library renders where it is mounted, so an in-scroll
          sheet laid itself out as the last item of the page — content at the
          bottom of the document, no scrim, no surface (observed live). A modal
          sheet is a sibling of the screen's content, never a child of it.

          Both mount together and gate on the DETAIL: each needs the vault's
          verbatim name and checksummed address to build the preflight echo,
          which `confirmVaultTransfer` throws without. */}
      {vault !== null ? (
        <>
          <VaultTransferSheet
            session={session}
            kind="deposit"
            vault={vault}
            isOpen={sheet === "deposit"}
            onOpenChange={(open) => setSheet(open ? "deposit" : null)}
          />
          <VaultTransferSheet
            session={session}
            kind="withdraw"
            vault={vault}
            isOpen={sheet === "withdraw"}
            onOpenChange={(open) => setSheet(open ? "withdraw" : null)}
          />
        </>
      ) : null}
    </>
  );
}

function PositionLockupRow({ lockup }: { lockup: LockupState }): JSX.Element {
  const line = lockupLine(lockup);
  return (
    <View className="flex-row items-center gap-2">
      <StatusDot tone={line.tone} />
      <Typography.Paragraph className={`text-xs font-medium ${TONE_TEXT[line.tone]}`}>
        {line.label}
      </Typography.Paragraph>
    </View>
  );
}

/** The chart card — five render branches, portfolio-style, never an empty chart. */
function VaultChart({
  state,
  retry,
}: {
  state: { kind: string } & (
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "deferred" }
    | { kind: "error"; message: string }
    | { kind: "ready"; value: VaultDetail | null }
  );
  retry: () => void;
}): JSX.Element {
  const [metric, setMetric] = useState<ChartMetric>("value");
  const [period, setPeriod] = useState<ChartPeriod>("week");

  if (state.kind === "loading" || state.kind === "idle") {
    return (
      <Card className="gap-3">
        <Skeleton className="h-40 w-full rounded-lg" />
      </Card>
    );
  }
  if (state.kind === "deferred") {
    return (
      <Card className="gap-3">
        <EmptyState className="py-8">
          <EmptyState.Header>
            <EmptyState.Title className="font-semibold">Chart deferred</EmptyState.Title>
            <EmptyState.Description className="font-normal">
              This read is the heaviest on the screen; the budget is protecting the connection.
            </EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            <Button size="sm" variant="tertiary" onPress={retry}>
              <Button.Label className="font-medium">Retry</Button.Label>
            </Button>
          </EmptyState.Content>
        </EmptyState>
      </Card>
    );
  }
  if (state.kind === "error") {
    return (
      <Card className="gap-3">
        <EmptyState className="py-8">
          <EmptyState.Header>
            <EmptyState.Title className="font-semibold">Could not load</EmptyState.Title>
            <EmptyState.Description className="font-normal">{state.message}</EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            <Button size="sm" variant="tertiary" onPress={retry}>
              <Button.Label className="font-medium">Retry</Button.Label>
            </Button>
          </EmptyState.Content>
        </EmptyState>
      </Card>
    );
  }

  const vault = state.value;
  if (vault === null) {
    return (
      <Card className="gap-3">
        <EmptyState className="py-8">
          <EmptyState.Header>
            <EmptyState.Title className="font-semibold">Not a vault</EmptyState.Title>
            <EmptyState.Description className="font-normal">
              This address is not a vault on this network.
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      </Card>
    );
  }

  const selected = vault.portfolio.find((entry) => entry.period === period) ?? null;
  const series =
    selected === null
      ? []
      : metric === "value"
        ? selected.accountValueHistory
        : selected.pnlHistory;
  const drawdown = selected === null ? null : maxDrawdown(selected.accountValueHistory);

  return (
    <Card className="gap-3">
      <View className="flex-row items-center gap-2">
        <Segment
          size="sm"
          value={metric}
          onValueChange={(value) => setMetric(value as ChartMetric)}
        >
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
        <View className="flex-1" />
        <Segment
          size="sm"
          value={period}
          onValueChange={(value) => setPeriod(value as ChartPeriod)}
        >
          <Segment.Group>
            <Segment.Indicator />
            {PERIODS.map(([value, label]) => (
              <Segment.Item key={value} value={value}>
                <Segment.Label className="font-medium">{label}</Segment.Label>
              </Segment.Item>
            ))}
          </Segment.Group>
        </Segment>
      </View>

      <HistoryChart
        series={series}
        period={period}
        emptyDescription="This window has fewer than two points."
      />

      {drawdown !== null ? (
        <Typography.Paragraph className="text-xs text-muted font-normal">
          Max drawdown {drawdownPercent(drawdown)} over this window
        </Typography.Paragraph>
      ) : null}
    </Card>
  );
}

/** Verbatim description, clamped at four lines with a More toggle. */
function DescriptionCard({ text }: { text: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card className="gap-2">
      <Typography.Paragraph className="text-xs text-muted font-normal">About</Typography.Paragraph>
      <Typography.Paragraph className="font-normal" numberOfLines={expanded ? undefined : 4}>
        {text}
      </Typography.Paragraph>
      <Pressable accessible={false} onPress={() => setExpanded((value) => !value)}>
        <Typography.Paragraph className="text-xs text-accent font-medium">
          {expanded ? "Less" : "More"}
        </Typography.Paragraph>
      </Pressable>
    </Card>
  );
}
