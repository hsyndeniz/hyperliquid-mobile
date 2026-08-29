/**
 * Which account the numbers on this screen belong to, and how to change it.
 *
 * ## Why this is not just a dropdown
 *
 * Switching account is a **session restart** — `start({ subAccount })` rebuilds
 * the identity, re-targets every store and re-opens the subscriptions. It is not
 * a filter over data already on screen. So the control has to survive the
 * moment where the old account's numbers are gone and the new ones have not
 * arrived, and it must never leave the user unsure whose money they are looking
 * at.
 *
 * ## The three states of `subAccounts`, which are NOT two
 *
 * - a non-empty list — offer the switch
 * - `[]` — this wallet has no sub-accounts, so there is nothing to switch to
 * - **`null` — the list could not be read.** A deferred weight budget or a
 *   failed call. Rendering this as "no sub-accounts" tells the user something
 *   about their wallet that was never established, so it says so instead.
 *
 * `session.ts` is explicit that the two must not be collapsed, and this is the
 * screen where collapsing them would be visible.
 *
 * ## Always says whose account it is
 *
 * The header names the account even when there is nothing to switch to. A
 * balance shown without an owner is the confusion `useSessionAddress` exists to
 * prevent, and a switcher that only appears when a sub-account is selected
 * would be least visible exactly when it matters most.
 */

import type { JSX } from "react";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { Button, Card, Chip, Typography } from "heroui-native";

import { compactUsd } from "@/components/portfolio/fetchedView";
import { UsdLabel } from "@/components/portfolio/primitives";
import type { SubAccountSummary } from "@/hyperliquid/subaccounts/types";

/** `0x1234…abcd`. Enough to tell two accounts apart without a line wrap. */
function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function AccountSwitcher({
  master,
  actingAs,
  subAccounts,
  combinedPerp,
  isSwitching,
  onSelect,
}: {
  master: string;
  /** The address whose numbers are on screen — the sub-account when selected. */
  actingAs: string | null;
  /** `null` means "could not be read", NOT "none". */
  subAccounts: readonly SubAccountSummary[] | null;
  /**
   * Master + subs perp equity, from `combinedPerpEquity`. Rendered only when
   * sub-accounts exist — for a lone master "combined" would just repeat the
   * hero's number with a grander name.
   */
  combinedPerp: string | null;
  isSwitching: boolean;
  /** `null` selects the master. */
  onSelect: (subAccount: string | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  const onMaster = actingAs === null || actingAs.toLowerCase() === master.toLowerCase();
  const selected = onMaster
    ? null
    : (subAccounts?.find((a) => a.address.toLowerCase() === actingAs?.toLowerCase()) ?? null);

  const label = onMaster ? "Main account" : (selected?.name ?? shortAddress(actingAs ?? ""));

  const choose = useCallback(
    (address: string | null) => {
      setOpen(false);
      onSelect(address);
    },
    [onSelect]
  );

  return (
    <Card className="gap-3">
      <View className="flex-row items-stretch justify-between gap-3">
        <View className="shrink justify-center gap-1">
          <Typography.Paragraph className="text-xs text-muted font-normal">
            Viewing
          </Typography.Paragraph>
          <View className="flex-row items-stretch gap-2">
            <View className="shrink justify-center">
              <Typography.Paragraph className="font-semibold leading-5" numberOfLines={1}>
                {label}
              </Typography.Paragraph>
            </View>
            {!onMaster ? (
              <View className="justify-center">
                <Chip size="sm" variant="soft">
                  <Chip.Label className="font-medium">sub-account</Chip.Label>
                </Chip>
              </View>
            ) : null}
          </View>
          <Typography.Paragraph className="text-xs text-muted font-normal">
            {shortAddress(actingAs ?? master)}
          </Typography.Paragraph>
          {subAccounts !== null && subAccounts.length > 0 && combinedPerp !== null ? (
            <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
              {/* Perps only, and said so — sub spot cannot be valued here. */}
              Combined perps <UsdLabel value={combinedPerp} /> across {subAccounts.length + 1}{" "}
              accounts
            </Typography.Paragraph>
          ) : null}
        </View>

        <View className="justify-center">
          {subAccounts === null ? (
            // Not "no sub-accounts" — that would be a claim about the wallet.
            <Chip size="sm" color="warning" variant="soft">
              <Chip.Label className="font-medium">accounts unavailable</Chip.Label>
            </Chip>
          ) : subAccounts.length === 0 ? (
            <Chip size="sm" variant="soft">
              <Chip.Label className="font-medium">no sub-accounts</Chip.Label>
            </Chip>
          ) : (
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={isSwitching}
              onPress={() => setOpen((value) => !value)}
            >
              <Button.Label className="font-medium">
                {isSwitching ? "Switching…" : open ? "Close" : "Switch"}
              </Button.Label>
            </Button>
          )}
        </View>
      </View>

      {open && subAccounts !== null && subAccounts.length > 0 ? (
        <View className="gap-2 border-t border-border pt-3">
          <AccountRow
            name="Main account"
            address={master}
            equity={null}
            isActive={onMaster}
            onPress={() => choose(null)}
          />
          {subAccounts.map((account) => (
            <AccountRow
              key={account.address}
              name={account.name}
              address={account.address}
              // `perpEquityTotal`, NOT the main-dex entry. `SubAccountSummary`
              // documents this exact mistake against this exact field: "Reading
              // only the main dex is how a picker shows $0.01 for an account
              // holding $50m on a HIP-3 dex — a user reads 'empty' and abandons
              // it." The map is also sparse — 48 of 67 sampled sub-accounts had
              // no main-dex entry at all — so the old read returned "0" for
              // most accounts even before HIP-3 entered the picture, while the
              // "Combined perps" line one card up counted the money it denied.
              equity={account.perpEquityTotal}
              isActive={!onMaster && account.address.toLowerCase() === actingAs?.toLowerCase()}
              onPress={() => choose(account.address)}
            />
          ))}
        </View>
      ) : null}
    </Card>
  );
}

function AccountRow({
  name,
  address,
  equity,
  isActive,
  onPress,
}: {
  name: string;
  address: string;
  equity: string | null;
  isActive: boolean;
  onPress: () => void;
}): JSX.Element {
  return (
    <Button
      variant={isActive ? "secondary" : "tertiary"}
      isDisabled={isActive}
      onPress={onPress}
      className="justify-between"
    >
      {/* Formatted, not concatenated raw. The wire string is a full-precision
          decimal ("50555968.0"), which read as a bare number spliced onto an
          address rather than as money. */}
      <Button.Label className="font-medium">
        {name} · {shortAddress(address)}
        {equity === null ? "" : ` · ${compactUsd(equity)}`}
      </Button.Label>
    </Button>
  );
}
