/**
 * HD key derivation.
 *
 * Cheap, unlike the seed step that precedes it: BIP32 is HMAC-SHA512 per level,
 * so a five-level path is five HMACs rather than 2048 iterations. Measured at
 * roughly the same total as the PBKDF2 step on desktop, but it does not scale
 * with iteration count, so it stays cheap on a phone. There is no native
 * fast-path to reach for here and none is needed.
 *
 * The derivation path is Ethereum's standard `m/44'/60'/0'/0/index`. Hyperliquid
 * is an EVM-signature chain — an account is an EVM address and actions are
 * signed EIP-712 — so a phrase imported here resolves to the same addresses the
 * user's other Ethereum wallets show them. Deviating from the standard path
 * silently produces a *different, empty* account from the same phrase, which
 * reads to a user as "my funds are gone".
 */

import { HDKey } from "@scure/bip32";
import { privateKeyToAccount } from "viem/accounts";

import { HlError } from "@/hyperliquid/core/errors";
import type { Hex } from "@/hyperliquid/types/domain";
import type { IViemLocalAccount } from "@/hyperliquid/types/sdk";

/**
 * BIP44 for Ethereum: purpose 44', coin type 60', account 0', external chain.
 *
 * The `index` is appended. Every mainstream wallet uses this, so it is what
 * makes an imported phrase show the addresses the user expects.
 */
export const ETH_DERIVATION_PREFIX = "m/44'/60'/0'/0";

/** The path for one account index. */
export function derivationPath(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new HlError("Account index must be a non-negative integer", {
      code: "validation_error",
      context: { index },
    });
  }
  return `${ETH_DERIVATION_PREFIX}/${index}`;
}

export interface DerivedKey {
  /** 0x-prefixed, 32 bytes. Secret — never logged, never persisted outside the Keychain. */
  privateKey: Hex;
  address: Hex;
  path: string;
  index: number;
}

function toHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out as Hex;
}

/**
 * Derive one account from a seed.
 *
 * Takes the seed rather than the mnemonic on purpose: it keeps the phrase out of
 * this module entirely, so the one place that handles it is the one that must.
 */
export function deriveAccount(seed: Uint8Array, index = 0): DerivedKey {
  if (seed.length !== 64) {
    throw new HlError(`Seed must be 64 bytes, received ${seed.length}`, {
      code: "validation_error",
      context: { length: seed.length },
    });
  }

  const path = derivationPath(index);
  const node = HDKey.fromMasterSeed(seed).derive(path);
  if (!node.privateKey) {
    throw new HlError("Derivation produced no private key", {
      code: "invalid_config",
      context: { path },
    });
  }

  const privateKey = toHex(node.privateKey);
  return {
    privateKey,
    address: privateKeyToAccount(privateKey).address as Hex,
    path,
    index,
  };
}

/**
 * Derive several accounts at once.
 *
 * One `fromMasterSeed` for the lot rather than per account — the master node is
 * the expensive part, and an account picker wants ten addresses at once.
 */
export function deriveAccounts(seed: Uint8Array, count: number, startIndex = 0): DerivedKey[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new HlError("Count must be a positive integer", {
      code: "validation_error",
      context: { count },
    });
  }
  const master = HDKey.fromMasterSeed(seed);

  return Array.from({ length: count }, (_unused, offset) => {
    const index = startIndex + offset;
    const path = derivationPath(index);
    const node = master.derive(path);
    if (!node.privateKey) {
      throw new HlError("Derivation produced no private key", {
        code: "invalid_config",
        context: { path },
      });
    }
    const privateKey = toHex(node.privateKey);
    return { privateKey, address: privateKeyToAccount(privateKey).address as Hex, path, index };
  });
}

/**
 * A viem account from a raw private key.
 *
 * The SDK's wallet interface is structurally just `{ signTypedData, address }`,
 * which a viem local account satisfies — so no wrapper class is needed, and the
 * reference implementation's two proxy classes collapse to this one call.
 */
export function accountFromPrivateKey(privateKey: Hex): IViemLocalAccount {
  return privateKeyToAccount(privateKey) as unknown as IViemLocalAccount;
}

/**
 * Validate an imported private key.
 *
 * A user pasting a key gets it from somewhere else, so the failure modes are a
 * missing `0x`, stray whitespace, and the 64-vs-66 character confusion.
 */
export function normalisePrivateKey(input: string): Hex {
  const trimmed = input.trim();
  const body = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;

  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new HlError("Private key must be 64 hexadecimal characters", {
      code: "validation_error",
      // No context: the value is the secret.
    });
  }
  // Zero is not a valid secp256k1 scalar, and it is what an all-zeroes paste
  // produces — which viem accepts far enough to yield a deterministic address.
  if (/^0+$/.test(body)) {
    throw new HlError("Private key cannot be zero", { code: "validation_error" });
  }
  return `0x${body.toLowerCase()}` as Hex;
}
