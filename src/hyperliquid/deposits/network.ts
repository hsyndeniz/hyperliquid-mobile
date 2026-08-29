/**
 * Where a deposit is actually sent.
 *
 * This is the only module in the project that names a **second chain**.
 * Everything else talks to Hyperliquid's own API, where a wrong value produces an
 * error. Here a wrong value produces a successful transaction that puts money
 * somewhere it cannot be retrieved from — so every constant below was verified
 * against the chain rather than copied, and the ones that were not are absent
 * rather than guessed.
 *
 * ## What a deposit is
 *
 * A plain ERC-20 `transfer` of USDC to the bridge address. **No approve, no
 * contract call on the bridge**, nothing Hyperliquid-specific about the
 * transaction itself — measured over 1,371 real deposits, every one of which was
 * a bare `Transfer` event. Hyperliquid's validators watch that address and credit
 * the sender; the docs put it as "credited when more than 2/3 of the staking
 * power has signed the deposit".
 *
 * ## Mainnet, verified
 *
 * | | Value | How it was checked |
 * | --- | --- | --- |
 * | chain | Arbitrum One (42161) | — |
 * | USDC | `0xaf88…5831` | `name() = "USD Coin"`, `symbol() = "USDC"`, `decimals() = 6` |
 * | bridge | `0x2Df1…3dF7` | real bytecode, holding 426,910,328.59 USDC |
 *
 * ## Testnet, verified — and the token is NOT the obvious one
 *
 * | | Value | How it was checked |
 * | --- | --- | --- |
 * | chain | Arbitrum Sepolia (421614) | — |
 * | USDC | `0x1baA…34d5` | `name() = symbol() = "USDC2"`, `decimals() = 6` |
 * | bridge | `0x08cf…6f89` | holds **988,881,236.64 USDC2**; 4 of 4 recent senders credited to the cent |
 *
 * Both addresses are named verbatim in Hyperliquid's own developer docs, in the
 * `batchedDepositWithPermit` example on the USDC API page — the one place the
 * testnet pair is written down.
 *
 * **The trap, walked into and recorded so nobody repeats it.** Circle's official
 * Sepolia USDC — `0x75fa…AA4d`, `name() = "USD Coin"` — is *not* the token this
 * bridge watches. It is the obvious candidate, it is a real 6-decimal USDC, and
 * sending it to the correct bridge silently loses it. Two transfers of 6 USDC
 * each were sent that way from this project: both confirmed on chain, neither
 * was ever credited, and the bridge now holds 1,946.10 of that token — every
 * bit of it somebody making the same mistake.
 *
 * That is precisely the failure this module's opening paragraph warns about,
 * and the diagnosis went wrong the same way: the missing credit was read as
 * *"the bridge does not work"* and the correct bridge was deleted, when the
 * evidence equally fit *"the token is wrong"*. The earlier discovery pass had
 * seen 0 of 12 senders credited across four candidate addresses and drawn the
 * same conclusion — those senders were sending Circle's USDC too. **A negative
 * result identifies a broken pair, never which half is broken.**
 *
 * Verified positively, which is what actually settles it: over ~400k blocks
 * only 4 USDC2 transfers reached the bridge, and Hyperliquid credited every one
 * exactly — 10 → 10.0, 500 → 500.0, 21.785851 → 21.785851, 100 → 100.0. Then
 * proved by doing it: a 6 USDC2 deposit sent from the app itself **arrived in
 * 8,103 ms**, inside the 5,751–9,964 ms window measured on mainnet — so the
 * latency below is no longer an assumption carried across networks.
 *
 * The permit flow's EIP-712 domain differs too (`"USDC2"` version `"1"` on
 * testnet against `"USD Coin"` version `"2"` on mainnet). Irrelevant while we
 * send a plain `transfer`, and a landmine if `batchedDepositWithPermit` is ever
 * added.
 *
 * ## The mainnet bridge is deprecated upstream
 *
 * Hyperliquid's API docs now head this contract "Legacy Bridge" and state
 * plainly: *"CCTP supports more chains and functionality. The legacy bridge is
 * deprecated."* It still works — deposits to it were observed crediting within
 * the measured window while this note was being written — and the deposit flow
 * documented for it is unchanged. But it holds under 10% of HyperCore's USDC
 * supply, and Circle's CCTP is the forward path. Tracked as a product decision,
 * not a defect.
 */

import { HlError } from "@/hyperliquid/core/errors";
import type { HlEnv, Hex } from "@/hyperliquid/types/domain";

/**
 * USDC's on-chain precision on Arbitrum: **6**, read from the contract.
 *
 * The same figure as `transfers/amount.ts`'s `AMOUNT_DECIMALS`, and not a
 * coincidence — Hyperliquid's wire amounts are USDC amounts. Kept separate
 * anyway: that one describes what the exchange accepts in a signed message, this
 * one describes how a token contract counts, and a future chain with 18-decimal
 * USDC would move one and not the other.
 */
export const USDC_DECIMALS = 6;

/**
 * The minimum deposit, in USDC.
 *
 * **Measured, and stronger than the docs.** Across 1,371 consecutive mainnet
 * deposits spanning about 25 hours: **zero below 5**, and the twelve smallest
 * were all exactly `5.00`. That clustering at a round number is what an enforced
 * floor looks like.
 *
 * What is still unknown is what happens *below* it — no sub-5 deposit exists in
 * the observed population to learn from, and the widely-repeated claim that such
 * a deposit is lost rather than refunded has not been reproduced here. The
 * preflight therefore **blocks**, rather than warning: an unrecoverable loss that
 * nobody has disproved is not a risk to leave to the user's judgement.
 */
export const MIN_DEPOSIT_USDC = "5";

export interface DepositNetwork {
  readonly env: HlEnv;
  /** EVM chain id. Checked against the wallet before sending. */
  readonly chainId: number;
  readonly chainName: string;
  /** The ERC-20 whose `transfer` is the deposit. */
  readonly usdc: Hex;
  /**
   * The token's on-chain `symbol()`, for anything that INSTRUCTS a user.
   *
   * Not cosmetic, and not always `"USDC"`. On testnet the bridge watches a
   * token whose symbol is **`USDC2`**, while Circle's own Sepolia USDC is a
   * real 6-decimal token on the same chain reporting `name() = "USD Coin"`.
   * A screen that hardcodes "USDC" therefore tells a testnet user to send
   * exactly the token this bridge silently keeps — the unrecoverable loss this
   * module already paid 12 USDC to learn.
   *
   * Measured from the contracts, like every other value here.
   */
  readonly usdcSymbol: string;
  readonly usdcDecimals: number;
  /** The recipient. **Never user-supplied.** */
  readonly bridge: Hex;
}

const MAINNET: DepositNetwork = {
  env: "mainnet",
  chainId: 42_161,
  chainName: "Arbitrum One",
  usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  usdcSymbol: "USDC",
  usdcDecimals: USDC_DECIMALS,
  bridge: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7",
};

const TESTNET: DepositNetwork = {
  env: "testnet",
  chainId: 421_614,
  chainName: "Arbitrum Sepolia",
  // **USDC2**, not Circle's Sepolia USDC (`0x75fa…AA4d`) — sending that here is
  // a silent, unrecoverable loss; see the module note. Deliberately elided:
  // a test asserts the full address appears nowhere in this file, so it cannot
  // creep back as a constant or a "fallback". Both values below come from the
  // docs' `batchedDepositWithPermit` example.
  usdc: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5",
  // `name() = symbol() = "USDC2"`, read from the contract. The whole reason
  // this field exists.
  usdcSymbol: "USDC2",
  usdcDecimals: USDC_DECIMALS,
  bridge: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89",
};

/**
 * The network a deposit for this environment goes to.
 *
 * @throws {HlError} for an environment with no configured addresses. Throwing is
 *   the point: the alternative is a plausible address, and a transfer to a
 *   plausible address is indistinguishable from a transfer to the right one
 *   until the money does not arrive.
 */
export function depositNetwork(env: HlEnv): DepositNetwork {
  if (env === "mainnet") return MAINNET;
  if (env === "testnet") return TESTNET;
  throw new HlError(`Deposits are not configured for ${String(env)}`, {
    code: "invalid_config",
    context: { env, reason: "bridge_unverified" },
  });
}

/** Whether deposits can be made at all in this environment. */
export function depositsAvailable(env: HlEnv): boolean {
  return env === "mainnet" || env === "testnet";
}

/**
 * Which balance a deposit credits: **perp, measured.**
 *
 * Tested on first-time depositors, whose entire history is a single
 * `{type:"deposit"}` ledger row so nothing else can be confused for the arrival:
 * 1000.3367 sent -> perp `accountValue` 1000.3367 with `balances: []`; likewise
 * 5.94957 and 10.1967. Three of four matched to the cent.
 *
 * It matters because `state/spot.ts` asserted the opposite until this was
 * measured, and a "deposit received" screen watching the spot store waits
 * forever.
 */
export const DEPOSIT_CREDITS = "perp" as const;

/**
 * How long crediting took, measured: **5.7 s to 10.0 s** over five mainnet
 * deposits, and **8,103 ms** for this project's own testnet deposit — sent from
 * the app, landing inside the same window. Both networks, one range.
 *
 * A measurement, not a guarantee — crediting is a validator quorum, so it is a
 * consensus latency rather than a fixed delay. Used to decide when a client may
 * stop saying "waiting" and start saying "this is taking longer than usual", and
 * for nothing that would declare a deposit lost.
 */
export const DEPOSIT_CREDIT_MS = { observedMin: 5_751, observedMax: 9_964 } as const;

/**
 * There is **no deposit fee.** Measured: `262.001324` sent, `"262.001324"`
 * credited, to the cent.
 *
 * Asymmetric with withdrawals, which deduct 1 USDC from the signed amount — so
 * the two directions must not share a "fee" concept, and a screen that shows one
 * for deposits is inventing it.
 */
export const DEPOSIT_FEE_USDC = "0";
