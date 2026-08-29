/**
 * What a deposit screen must tell the user before they send anything.
 *
 * Pure, so it can be tested — rendering a heroui component under Jest pulls in
 * Reanimated, Worklets and Skia, none of which have native modules there. Same
 * split as `components/portfolio/rowDetail.ts`.
 *
 * ## Why this is a list of warnings and not a paragraph
 *
 * A deposit is an ERC-20 transfer on Arbitrum, not a Hyperliquid action, and
 * `deposits/preflight.ts` records the consequence: **every way of getting it
 * wrong succeeds.**
 *
 * | Mistake | What happens |
 * | --- | --- |
 * | Wrong chain | The transfer confirms. Nothing watches that address there. |
 * | Wrong token | Confirms. The bridge takes USDC and nothing else. |
 * | Below the floor | Confirms. Not credited, and nobody has shown it comes back. |
 * | Wrong decimals | Confirms, for a millionth of the intended amount. |
 *
 * There is no failed transaction to learn from, no revert, and no support
 * channel. The warnings are the only defence, so each one is tied to a specific
 * unrecoverable outcome rather than being general caution.
 *
 * The 12 USDC this project lost to the wrong-token case is why the token line
 * names the contract rather than saying "USDC".
 */

import {
  DEPOSIT_CREDITS,
  DEPOSIT_FEE_USDC,
  MIN_DEPOSIT_USDC,
  type DepositNetwork,
} from "@/hyperliquid/deposits/network";

export interface DepositFact {
  label: string;
  value: string;
  /** The unrecoverable outcome this line exists to prevent. */
  consequence?: string;
  /** `true` for the lines that lose money if ignored. */
  critical: boolean;
}

/**
 * The facts, in the order they should be read.
 *
 * The SENDING address comes first, because this screen's primary flow is the
 * one that gets it wrong: the file header says the funds are usually "on an
 * exchange or in another wallet", and the obvious move is to copy the bridge
 * address into an exchange's withdrawal form. An exchange broadcasts from its
 * own omnibus wallet, and `deposits/network.ts` records what the validators
 * actually do — they "credit the sender". So that deposit credits the
 * exchange's Hyperliquid account, and the screen's own arrival watcher, which
 * polls the user's ledger, shows "watching" forever. It reads as a slow
 * confirmation rather than a total loss.
 *
 * Chain and token follow, because they are the two that silently consume the
 * funds. The fee line is present and says **none** — `deposits/network.ts`
 * notes that a deposit screen showing a fee is inventing one, and the absence
 * is worth stating because the withdrawal side does charge.
 *
 * `from` is the session address. It is optional so the module stays callable
 * without a session, and the row is omitted rather than guessed when absent —
 * a "Must be sent from" line with the wrong address would be worse than none.
 */
export function depositFacts(network: DepositNetwork, from?: string | null): DepositFact[] {
  return [
    ...(from
      ? [
          {
            label: "Must be sent from",
            value: from,
            consequence:
              "The bridge credits whichever address sent the funds. A withdrawal from an exchange credits the exchange, not you.",
            critical: true,
          },
        ]
      : []),
    {
      label: "Network",
      value: `${network.chainName} (chain ${network.chainId})`,
      consequence: "Sent on any other chain, it confirms and nothing watches for it.",
      critical: true,
    },
    {
      label: "Token",
      // The SYMBOL from the network, never the literal "USDC" — on testnet the
      // bridge watches `USDC2`, and Circle's own Sepolia USDC is a real
      // 6-decimal token on the same chain that this bridge silently keeps.
      // The contract address follows, because a symbol can be spoofed and this
      // is the value a user pastes into an exchange's withdraw form.
      value: `${network.usdcSymbol} — ${network.usdc}`,
      consequence: "Only this exact contract is credited. Any other token is kept.",
      critical: true,
    },
    {
      label: "Minimum",
      value: `${MIN_DEPOSIT_USDC} ${network.usdcSymbol}`,
      consequence: "Below this it confirms, is not credited, and does not come back.",
      critical: true,
    },
    {
      label: "Fee",
      // Stated, because withdrawals charge one and a user reasonably assumes
      // symmetry. Measured: 262.001324 sent, "262.001324" credited.
      value: DEPOSIT_FEE_USDC === "0" ? "None" : `${DEPOSIT_FEE_USDC} ${network.usdcSymbol}`,
      critical: false,
    },
    {
      label: "Credited to",
      // Not spot. `state/spot.ts` used to claim otherwise, and a screen
      // watching the spot balance for a deposit waits forever.
      value: DEPOSIT_CREDITS === "perp" ? "Your perps balance" : DEPOSIT_CREDITS,
      critical: false,
    },
  ];
}

/**
 * Address in 4-character groups.
 *
 * The same treatment `transfers/destination.ts` gives a withdrawal
 * destination, for the same reason: an unbroken 42-character string cannot be
 * checked by eye, and this is the one address a user must verify themselves.
 */
export function chunkForDisplay(address: string): string[] {
  return (address.match(/.{1,4}/g) ?? []).slice();
}

/** Whether anything is worth watching for yet. */
export function hasCredits(credits: readonly { at: number }[]): boolean {
  return credits.length > 0;
}
