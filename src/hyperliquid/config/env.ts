/**
 * Runtime configuration.
 *
 * Resolution order is deliberately a chain: **overrides → env → defaults**.
 * Today only env and defaults exist, but the client plans a config service
 * later; when it arrives it becomes another link in `resolveHlConfig` and no
 * call site changes.
 *
 * Everything here is public. `EXPO_PUBLIC_*` values are inlined into the
 * shipped bundle, so no secret may ever be read through this module — agent
 * keys live in the device Keychain (see `@/hyperliquid/auth`).
 */

import type { Hex, HlEnv } from "@/hyperliquid/types/domain";

export interface HlConfig {
  /** Which network to talk to. Drives transport URLs and the signed `hyperliquidChain` field. */
  env: HlEnv;
  isTestnet: boolean;
  /**
   * Builder that receives builder fees on each order, and the maximum fee the
   * user approves once via `approveBuilderFee`.
   *
   * `null` disables builder fees entirely — the safe default, since shipping
   * someone else's builder address routes this app's revenue to them.
   *
   * Units are **tenths of a basis point**: 1 = 0.001%, so the default 50 =
   * 0.05%. Confirmed against Hyperliquid's info-endpoint docs ("maximum fee
   * approved in tenths of a basis point i.e. 1 means 0.001%"). Convert with
   * {@link builderFeePercentString} — never pass this number straight into
   * `approveBuilderFee`, which wants a percent *string*.
   */
  builderAddress: Hex | null;
  maxBuilderFee: number;
  /** Referral code applied to new accounts; `null` skips referral setup. */
  referralCode: string | null;
  /**
   * EIP-712 domain `chainId` for **user-signed actions only** — `approveAgent`,
   * `approveBuilderFee`, `withdraw3`, `usdSend`.
   *
   * It does **not** affect order signing: L1 actions pin their own domain
   * (`chainId: 1337`) inside the SDK, so orders are unaffected by this value.
   *
   * Pinned rather than derived because a viem local account has no chain and
   * the SDK would otherwise default to `0x1`; hardware wallets also display it.
   * The SDK fills in `hyperliquidChain` (Mainnet/Testnet) itself from the
   * transport's `isTestnet`.
   */
  signatureChainId: Hex;
}

/**
 * Raw env values, read once at module load.
 *
 * `process.env.EXPO_PUBLIC_*` is **inlined at build time** by babel-preset-expo
 * — it is a compile-time literal, not a runtime lookup. Two consequences:
 *  1. Mutating `process.env` later has no effect, so parsing is tested by
 *     passing `HlEnvVars` explicitly rather than by poking `process.env`.
 *  2. Editing `.env` requires a Metro restart with a cleared cache
 *     (`bun run start --clear`) before the new value is picked up.
 */
export interface HlEnvVars {
  env?: string;
  builderAddress?: string;
  maxBuilderFee?: string;
  referralCode?: string;
}

const ENV_VARS: HlEnvVars = {
  env: process.env.EXPO_PUBLIC_HL_ENV,
  builderAddress: process.env.EXPO_PUBLIC_HL_BUILDER_ADDRESS,
  maxBuilderFee: process.env.EXPO_PUBLIC_HL_MAX_BUILDER_FEE,
  referralCode: process.env.EXPO_PUBLIC_HL_REFERRAL_CODE,
};

/** Arbitrum One. */
const ARBITRUM_CHAIN_ID_HEX = "0xa4b1" as Hex;

const DEFAULTS: HlConfig = {
  env: "testnet",
  isTestnet: true,
  builderAddress: null,
  maxBuilderFee: 50,
  referralCode: null,
  signatureChainId: ARBITRUM_CHAIN_ID_HEX,
};

function readString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readAddress(value: string | undefined, field: string): Hex | null {
  const raw = readString(value);
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    // Loud, not silent: a malformed builder address would otherwise surface as
    // an opaque signature rejection at order time.
    throw new Error(`${field} must be a 0x-prefixed 20-byte address, got: ${raw}`);
  }
  return raw.toLowerCase() as Hex;
}

function readNumber(value: string | undefined, fallback: number, field: string): number {
  const raw = readString(value);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a number, got: ${raw}`);
  }
  return parsed;
}

function readEnv(value: string | undefined, fallback: HlEnv): HlEnv {
  const raw = readString(value);
  if (!raw) return fallback;
  if (raw !== "mainnet" && raw !== "testnet") {
    throw new Error(`EXPO_PUBLIC_HL_ENV must be "mainnet" or "testnet", got: ${raw}`);
  }
  return raw;
}

/**
 * Resolve configuration.
 *
 * @param overrides The seam a future server-driven config source plugs into.
 * @param envVars Raw env values; defaults to the build-time inlined ones.
 *   Passed explicitly by tests, since `process.env` cannot be mutated at
 *   runtime under the Expo babel transform.
 */
export function resolveHlConfig(
  overrides: Partial<HlConfig> = {},
  envVars: HlEnvVars = ENV_VARS
): HlConfig {
  const env = readEnv(envVars.env, DEFAULTS.env);

  const fromEnv: HlConfig = {
    env,
    isTestnet: env === "testnet",
    builderAddress: readAddress(envVars.builderAddress, "EXPO_PUBLIC_HL_BUILDER_ADDRESS"),
    maxBuilderFee: readNumber(
      envVars.maxBuilderFee,
      DEFAULTS.maxBuilderFee,
      "EXPO_PUBLIC_HL_MAX_BUILDER_FEE"
    ),
    referralCode: readString(envVars.referralCode),
    signatureChainId: DEFAULTS.signatureChainId,
  };

  const resolved = { ...fromEnv, ...overrides };
  // Keep the derived flag consistent when `env` is overridden on its own.
  return { ...resolved, isTestnet: resolved.env === "testnet" };
}

/** The process-wide config. Prefer this; use `resolveHlConfig` for tests. */
export const hlConfig: HlConfig = resolveHlConfig();

/**
 * Convert a builder fee in tenths of a basis point to the percent string
 * `approveBuilderFee` requires.
 *
 * The action's schema is strict — `/^[0-9]+(\.[0-9]+)?%$/`, unsigned, no space,
 * trailing `%` — and the two representations use different units, so this
 * conversion exists to stop the raw number being passed through by mistake.
 *
 * ```
 * builderFeePercentString(50) // "0.05%"
 * builderFeePercentString(1)  // "0.001%"
 * ```
 */
export function builderFeePercentString(tenthsOfBasisPoint: number): string {
  if (!Number.isFinite(tenthsOfBasisPoint) || tenthsOfBasisPoint < 0) {
    throw new Error(`Builder fee must be a non-negative number, got: ${tenthsOfBasisPoint}`);
  }
  // Fixed-point rather than float division: 0.1/1000 must not surface as 1e-7.
  const percent = (tenthsOfBasisPoint / 1000).toFixed(6).replace(/\.?0+$/, "");
  return `${percent || "0"}%`;
}
