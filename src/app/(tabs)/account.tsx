/**
 * Account — identity, session, connection health, wallet, appearance, and the
 * app's facts.
 *
 * The designed successor to the Phase-14 diagnostics screen. What survived the
 * migration: the five device probes (now the Connection section), the session
 * controls, and the wallet lifecycle. What did not: the transfer / round-trip
 * / order / sub-account rehearsal cards — those journeys shipped as real
 * screens (deposit, withdraw, send, move), and a debug button that moves real
 * money has no place on a designed surface.
 *
 * **Shape: a hero plus a status list.** This was five stacked cards, each a
 * couple of hundred points tall and each mostly detail you read once; the
 * screen was three viewports of scrolling to reach "Version". Now the identity
 * and its four actions sit up top, and everything else is an accordion whose
 * closed rows still carry their state (`connectionMeasure`, `walletMeasure`,
 * `sessionPhase`) — so the collapsed screen is a health summary and expanding
 * is opt-in.
 *
 * The hero wears the MASTER wallet address even when the session acts as a
 * sub-account — its QR is a receive address, and sub-accounts cannot receive
 * bridge deposits. The Session section is where acting-as differs.
 *
 * Nothing interactive sits in the top-right corner: expo-dev-menu's floating
 * gear is a 72pt overlay window there, and a control under it renders
 * perfectly and never fires.
 */

import type { JSX } from "react";
import { useCallback, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Constants from "expo-constants";
import { useFocusEffect } from "expo-router";
import { Accordion, Typography } from "heroui-native";

import { AccountSection } from "@/components/account/AccountSection";
import { connectionMeasure, sessionPhase, walletMeasure } from "@/components/account/accountView";
import { appearanceMeasure, resolveChoice } from "@/components/account/appearance";
import { AppearanceCard } from "@/components/account/AppearanceCard";
import { HealthCard } from "@/components/account/HealthCard";
import { IdentityHero } from "@/components/account/IdentityHero";
import { InfoRow } from "@/components/account/primitives";
import { SessionCard } from "@/components/account/SessionCard";
import { useHealthTick } from "@/components/account/useHealthTick";
import { WalletCard } from "@/components/account/WalletCard";
import { AddressText } from "@/components/money/AddressText";
import { weightBudget } from "@/hyperliquid/api/weightBudget";
import { hlConfig } from "@/hyperliquid/config/env";
import { useSessionAddress, useSessionState } from "@/hyperliquid/hooks/session";
import { walletState, type WalletState } from "@/hyperliquid/wallet/accounts";
import { useHyperliquid } from "@/providers/HyperliquidProvider";
import { useUniwind } from "uniwind";

/** Clearance for the floating native tab bar — measured, not derivable. */
const TAB_BAR_CLEARANCE = 88;

/**
 * The agent name used when approving from this screen.
 *
 * `"probe2"` deliberately MATCHES an existing named agent on the shared
 * testnet account: Hyperliquid allows 1 unnamed + 3 named agents, all three
 * named slots are taken, and approving with a matching name replaces that
 * agent rather than failing on a fourth. A fresh name here would be refused —
 * or worse, silently evict something it shouldn't.
 */
const AGENT_LABEL = "probe2";

function AccountTab(): JSX.Element {
  const insets = useSafeAreaInsets();
  const { session, status, error, lastResume, start, stop } = useHyperliquid();
  const sessionState = useSessionState(session);
  const actingAs = useSessionAddress(session);

  // Polled once for the whole screen: the Connection section's gauge and its
  // collapsed measure read the same two fields, and two intervals would drift.
  const { used, socket } = useHealthTick();

  // Read here as well as in the card so the COLLAPSED header can report the
  // live theme — the section's whole contract is that closing it hides detail,
  // never state. Both reads come from the same Uniwind singleton, so there is
  // no second source of truth to drift.
  const { theme, hasAdaptiveThemes } = useUniwind();

  // The Keychain read is async and owned here so the hero and the wallet
  // section agree about what exists. `null` is "still reading". Re-read on
  // FOCUS, not mount: the `/wallet` screen replaces the wallet underneath this
  // tab, and NativeTabs never remounts it.
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const refreshWallet = useCallback(() => {
    void walletState().then(setWallet, () => setWallet({ kind: "locked" }));
  }, []);
  useFocusEffect(refreshWallet);

  // Master address: the session's identity when live, the vault's first
  // account otherwise — same wallet, two moments of its lifecycle.
  const masterAddress =
    sessionState?.identity.address ??
    (wallet?.kind === "ready" ? (wallet.metadata.accounts[0]?.address ?? null) : null);

  const env = sessionState?.config.env ?? hlConfig.env;

  const stopSession = useCallback(async () => {
    await stop();
  }, [stop]);

  const resumeNote =
    lastResume === null
      ? "not backgrounded yet"
      : `away ${Math.round(lastResume.awayMs / 1000)}s · ${
          lastResume.shouldResubscribe ? "resubscribed" : "kept subscriptions"
        }`;

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-4 px-4"
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
      }}
    >
      <Typography.Heading className="font-bold">Account</Typography.Heading>

      <IdentityHero
        address={masterAddress}
        env={env}
        phase={sessionPhase(status)}
        isLive={status === "ready"}
        busy={status === "starting"}
        onSignIn={() => void start()}
        onSignOut={() => void stop()}
      />

      {/* `multiple`, not `single`: comparing the session's agent state against
          the connection's budget is a real thing to do while debugging, and a
          single-open accordion closes one to answer the other. */}
      <Accordion variant="surface" selectionMode="multiple">
        <AccountSection value="session" title="Session" measure={sessionPhase(status)}>
          <SessionCard
            status={status}
            error={error}
            sessionState={sessionState}
            actingAs={actingAs}
            busy={status === "starting"}
            onStartApprove={() => void start({ approveAgent: true, agentLabel: AGENT_LABEL })}
          />
        </AccountSection>

        <AccountSection
          value="connection"
          title="Connection"
          measure={connectionMeasure(socket, used, weightBudget.capacity())}
        >
          <HealthCard used={used} resumeNote={resumeNote} />
        </AccountSection>

        <AccountSection value="wallet" title="Wallet" measure={walletMeasure(wallet)}>
          <WalletCard wallet={wallet} onWalletChanged={refreshWallet} stopSession={stopSession} />
        </AccountSection>

        {/* Above About and below Wallet: this is the one section here the user
            changes for themselves rather than reads, and About is the screen's
            footer — the build's own facts, which nothing follows. */}
        <AccountSection
          value="appearance"
          title="Appearance"
          measure={appearanceMeasure(
            resolveChoice(theme, hasAdaptiveThemes),
            theme === "light" ? "light" : "dark"
          )}
        >
          <AppearanceCard />
        </AccountSection>

        <AccountSection
          value="about"
          title="About"
          measure={{ label: Constants.expoConfig?.version ?? "dev", tone: "muted" }}
        >
          <InfoRow label="Network" value={env === "testnet" ? "Testnet" : "Mainnet"} />
          <View className="flex-row items-start justify-between gap-4">
            <Typography.Paragraph className="text-sm text-muted font-normal">
              Builder
            </Typography.Paragraph>
            {hlConfig.builderAddress === null ? (
              <Typography.Paragraph className="text-sm font-normal">
                not configured
              </Typography.Paragraph>
            ) : (
              <AddressText
                address={hlConfig.builderAddress}
                truncated
                className="text-sm tabular-nums font-normal"
              />
            )}
          </View>
          <InfoRow label="Max builder fee" value={`${hlConfig.maxBuilderFee} tenths of a bp`} />
          <InfoRow label="Referral" value={hlConfig.referralCode ?? "none"} />
        </AccountSection>
      </Accordion>
    </ScrollView>
  );
}

export default AccountTab;
