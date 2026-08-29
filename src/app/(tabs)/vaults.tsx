/**
 * Vaults — positions, led vaults, and the directory.
 *
 * The directory is a **CDN blob, not an info request**: 2.7 MB on testnet,
 * 14.2 MB on mainnet, un-gzipped. It is fetched on first FOCUS (never at app
 * start), held in a module store so the last snapshot outlives every TTL, and
 * this screen renders its `top` slice — open vaults, TVL descending, capped —
 * through a LegendList scroll window: 20 rows at first paint, more per
 * end-reach; even the trimmed cut is 200 rows.
 *
 * Search goes FURTHER than the rendered cut: `searchDirectory` scans the full
 * index (every vault, open or closed), so a small vault a friend named is
 * findable; index-only hits render from name + address alone and the detail
 * screen is the confirmer.
 *
 * Positions never wait for the directory — a held vault the CDN has never
 * heard of (measured: testnet HLP) renders its address where a name would go.
 * The lockup countdowns tick against SERVER timestamps on a focus-gated 15 s
 * interval; the house rule against relative time is about the server clock
 * leading the device's, and a future countdown is the safe direction.
 */

import type { JSX } from "react";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { Button, Chip, InputGroup, Typography, useThemeColor } from "heroui-native";
import { Search } from "lucide-react-native";

import { InfoRow, StatusDot } from "@/components/account/primitives";
import { TONE_TEXT } from "@/components/account/accountView";
import { AddressText } from "@/components/money/AddressText";
import { Empty, LoadingRows, Usd } from "@/components/portfolio/primitives";
import { VaultListRow } from "@/components/vaults/VaultListRow";
import { DAY_MS, lockupLine } from "@/components/vaults/vaultsView";
import { hlConfig } from "@/hyperliquid/config/env";
import { useSessionAddress, useSessionState } from "@/hyperliquid/hooks/session";
import { useStoreValue } from "@/hyperliquid/hooks/useStore";
import { useNamedVaultPositions, useVaultList, vaultDirectory } from "@/hyperliquid/hooks/vaults";
import { searchDirectory, type NamedVaultPosition } from "@/hyperliquid/vaults/directory";
import { normaliseVaultName } from "@/hyperliquid/vaults/list";
import type { VaultSummary } from "@/hyperliquid/vaults/types";
import { useHyperliquid } from "@/providers/HyperliquidProvider";

/** Clearance for the floating native tab bar — measured, not derivable. */
const TAB_BAR_CLEARANCE = 88;

/** Lockup countdown cadence. Minutes-granular labels; 15 s keeps them honest. */
const LOCKUP_TICK_MS = 15_000;

/** The scroll window: 20 rows at first paint, a page more per end-reach. */
const INITIAL_ROWS = 20;
const PAGE_ROWS = 60;

/**
 * The vault card's real height, summed rather than guessed: 12+12 padding, four
 * 12px gaps, a 32px name row, two 1px rules, a 50px APR/sparkline row (the
 * 48px spark slot is the taller of the two columns by 2), and a 40px
 * TVL-plus-age block. An `estimatedItemSize` that still said 70 would make
 * LegendList allocate roughly twice the windows it needs on every fling.
 *
 * Index-only search hits are far shorter, which is what `getItemType` is for —
 * it lets the list size and pool the two shapes separately instead of averaging
 * them into a number that fits neither.
 */
const CARD_HEIGHT = 148;

/** The gap between cards. A list has no `gap`; a separator is the spelling. */
function RowGap(): JSX.Element {
  return <View className="h-3" />;
}

type Row =
  | { kind: "summary"; vault: VaultSummary }
  | { kind: "index"; address: string; name: string; isClosed: boolean };

function VaultsTab(): JSX.Element {
  const insets = useSafeAreaInsets();
  const mutedColor = useThemeColor("muted");
  const { session } = useHyperliquid();
  const sessionState = useSessionState(session);
  const address = useSessionAddress(session);
  const env = sessionState?.config.env ?? hlConfig.env;

  // The countdown clock: focus-gated, so a backgrounded tab stops ticking.
  const [now, setNow] = useState(() => Date.now());
  useFocusEffect(
    useCallback(() => {
      setNow(Date.now());
      const timer = setInterval(() => setNow(Date.now()), LOCKUP_TICK_MS);
      return () => clearInterval(timer);
    }, [])
  );

  // The cards' age line is day-granular. Flooring the 15 s clock to the day
  // means a card's props change at midnight rather than four times a minute —
  // the lockup countdowns need the fast clock, "1199 days old" does not.
  const today = Math.floor(now / DAY_MS) * DAY_MS;

  const list = useVaultList(env);
  const positions = useNamedVaultPositions(address, now);
  const directory = useStoreValue(vaultDirectory, (store) => store.read());

  const [query, setQuery] = useState("");
  const trimmed = query.trim();

  const allRows: Row[] =
    trimmed.length > 0 && directory?.env === env
      ? searchDirectory(directory, trimmed).map((hit) =>
          hit.summary !== null
            ? { kind: "summary", vault: hit.summary }
            : { kind: "index", address: hit.address, name: hit.name, isClosed: hit.isClosed }
        )
      : list.state.kind === "ready"
        ? list.state.value.map((vault) => ({ kind: "summary" as const, vault }))
        : [];

  // The window resets when the list becomes a different list (search change),
  // adjusted during render — the derived-state pattern, as on the Markets tab.
  const [window, setWindow] = useState({ key: trimmed, count: INITIAL_ROWS });
  if (window.key !== trimmed) setWindow({ key: trimmed, count: INITIAL_ROWS });
  const rows = allRows.length > window.count ? allRows.slice(0, window.count) : allRows;

  const onEndReached = (): void => {
    setWindow((held) =>
      held.count >= allRows.length ? held : { ...held, count: held.count + PAGE_ROWS }
    );
  };

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    list.refresh();
    positions.refresh();
    setTimeout(() => setRefreshing(false), 900);
  }, [list, positions]);

  const openDetail = useCallback((vaultAddress: string, name: string, vault?: VaultSummary) => {
    router.push({
      pathname: "/vault/[address]",
      params: {
        address: vaultAddress,
        name,
        ...(vault ? { tvl: vault.tvl, apr: vault.apr, created: String(vault.createdAtMs) } : {}),
      },
    });
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: Row }) =>
      item.kind === "summary" ? (
        <VaultListRow
          vault={item.vault}
          isAmbiguous={directory?.collisions.has(normaliseVaultName(item.vault.name)) ?? false}
          nowMs={today}
          onPress={() => openDetail(item.vault.address, item.vault.name, item.vault)}
        />
      ) : (
        // An index-only search hit KEEPS THE COMPACT ROW. It carries no APR,
        // TVL, pnls or creation stamp — a card of four "--"s would be a worse
        // answer than a line of the two facts the index actually holds. The
        // detail screen is the confirmer.
        <Pressable
          accessible={false}
          className="flex-row items-center justify-between gap-3 py-3"
          onPress={() => openDetail(item.address, item.name)}
        >
          <View className="flex-1 flex-row items-center gap-2">
            <Typography.Paragraph className="font-medium leading-5" numberOfLines={1}>
              {item.name}
            </Typography.Paragraph>
            {item.isClosed ? (
              <View
                className="pointer-events-none"
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <Chip size="sm" color="danger" variant="soft">
                  <Chip.Label className="font-medium">closed</Chip.Label>
                </Chip>
              </View>
            ) : null}
          </View>
          <AddressText
            address={item.address}
            truncated
            className="text-xs tabular-nums font-normal"
          />
        </Pressable>
      ),
    [directory, openDetail, today]
  );

  const header = (
    <View className="gap-4 pb-3">
      <Typography.Heading className="font-bold">Vaults</Typography.Heading>

      {/* Your positions — from equities, never gated on the directory. */}
      {positions.state.kind === "ready" && positions.state.value.length > 0 ? (
        <View className="gap-2">
          <Typography.Paragraph className="text-xs text-muted font-normal">
            Your positions
          </Typography.Paragraph>
          {positions.state.value.map((position) => (
            <PositionCard
              key={position.vault}
              position={position}
              onPress={() => openDetail(position.vault, position.name ?? "Vault")}
            />
          ))}
        </View>
      ) : positions.state.kind === "deferred" ? (
        <View className="flex-row items-center gap-2">
          <Chip size="sm" variant="soft">
            <Chip.Label className="font-medium">positions paused for the rate limit</Chip.Label>
          </Chip>
          <Button size="sm" variant="tertiary" onPress={positions.refresh}>
            <Button.Label className="font-medium">Retry</Button.Label>
          </Button>
        </View>
      ) : null}

      {/* Led vaults: [] hides (a fact), null says so (a failed read). */}
      {sessionState !== null && sessionState.ledVaults === null ? (
        <InfoRow label="Vaults you lead" value="unknown (read failed)" />
      ) : sessionState !== null && (sessionState.ledVaults?.length ?? 0) > 0 ? (
        <View className="gap-2">
          <Typography.Paragraph className="text-xs text-muted font-normal">
            Vaults you lead
          </Typography.Paragraph>
          {sessionState.ledVaults!.map((led) => (
            <Pressable
              key={led.address}
              accessible={false}
              className="flex-row items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-3"
              onPress={() => openDetail(led.address, led.name)}
            >
              <Typography.Paragraph className="font-medium" numberOfLines={1}>
                {led.name}
              </Typography.Paragraph>
              <AddressText
                address={led.address}
                truncated
                className="text-xs tabular-nums font-normal"
              />
            </Pressable>
          ))}
        </View>
      ) : null}

      <InputGroup>
        <InputGroup.Prefix isDecorative>
          <Search size={16} color={mutedColor} />
        </InputGroup.Prefix>
        <InputGroup.Input
          value={query}
          onChangeText={setQuery}
          placeholder="Search all vaults"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          className="font-normal"
        />
      </InputGroup>

      {list.lastError !== null ? (
        <Typography.Paragraph className="text-xs text-warning font-normal">
          Refresh failed — showing the last loaded directory. {list.lastError}
        </Typography.Paragraph>
      ) : null}
    </View>
  );

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top + 8 }}>
      <LegendList
        data={rows}
        renderItem={renderItem}
        keyExtractor={(item) => (item.kind === "summary" ? item.vault.address : item.address)}
        recycleItems
        getItemType={(item) => item.kind}
        estimatedItemSize={CARD_HEIGHT}
        ItemSeparatorComponent={RowGap}
        onEndReached={onEndReached}
        onEndReachedThreshold={1}
        drawDistance={250}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
        }}
        ListHeaderComponent={header}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          trimmed.length > 0 ? (
            <Empty title="No matches" description={`No vault name contains "${trimmed}".`} />
          ) : list.state.kind === "loading" ? (
            <LoadingRows count={8} />
          ) : list.state.kind === "error" ? (
            <View className="items-start gap-2 py-6">
              <Chip size="sm" color="danger" variant="soft">
                <Chip.Label className="font-medium">could not load the directory</Chip.Label>
              </Chip>
              <Typography.Paragraph className="text-xs text-muted font-normal">
                {list.state.message}
              </Typography.Paragraph>
              <Button size="sm" variant="secondary" onPress={list.refresh}>
                <Button.Label className="font-medium">Try again</Button.Label>
              </Button>
            </View>
          ) : (
            <Empty title="No open vaults" description="The directory listed nothing open." />
          )
        }
      />
    </View>
  );
}

/** One held vault: name (or the address — testnet HLP is unlisted), equity, lockup. */
function PositionCard({
  position,
  onPress,
}: {
  position: NamedVaultPosition;
  onPress: () => void;
}): JSX.Element {
  const lockup = lockupLine(position.lockup);
  return (
    <Pressable
      accessible={false}
      className="gap-2 rounded-2xl bg-surface px-4 py-3"
      onPress={onPress}
    >
      <View className="flex-row items-center justify-between gap-3">
        {position.name === null ? (
          <AddressText
            address={position.vault}
            truncated
            className="text-sm tabular-nums font-medium"
          />
        ) : (
          <Typography.Paragraph className="font-medium" numberOfLines={1}>
            {position.name}
          </Typography.Paragraph>
        )}
        <Usd value={position.equity} />
      </View>
      <View className="flex-row items-center gap-2">
        <StatusDot tone={lockup.tone} />
        <Typography.Paragraph className={`text-xs font-medium ${TONE_TEXT[lockup.tone]}`}>
          {lockup.label}
        </Typography.Paragraph>
        {position.isClosed === true ? (
          <Typography.Paragraph className="text-xs text-danger font-normal">
            · vault closed
          </Typography.Paragraph>
        ) : null}
      </View>
    </Pressable>
  );
}

export default VaultsTab;
