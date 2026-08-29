/**
 * The secret vault — encrypt-then-store.
 *
 * Follows Margelo's secure-storage design: a single 32-byte **master key lives
 * in the Keychain**, and every secret is AES-256-GCM encrypted with it and
 * written to MMKV. The alternative — one Keychain entry per secret — costs a
 * native round-trip per read and grows linearly with accounts, where this costs
 * exactly one Keychain read per session.
 *
 * Three properties are enforced structurally rather than by convention, because
 * each one is a silent failure otherwise:
 *
 * 1. **The IV is generated here and never accepted from a caller.** Reusing an
 *    IV with the same key breaks GCM catastrophically — it leaks the keystream
 *    and, worse, the authentication key. Making it un-passable makes the mistake
 *    unavailable.
 * 2. **A missing master key is never silently regenerated.** Doing so would
 *    orphan every existing blob while looking like a clean first run, so the
 *    user's wallet would appear to have vanished. First-run and key-loss are
 *    distinct states and are reported as such.
 * 3. **The master key never leaves this module.** No exported function returns
 *    it, so it cannot be logged, persisted or passed somewhere less careful.
 *
 * GCM is authenticated: a failed tag check means the ciphertext was corrupted or
 * tampered with, and is surfaced as its own error rather than as a decode
 * failure — those want different responses from a caller.
 */

import * as Keychain from "react-native-keychain";

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { hlStringStorage } from "@/hyperliquid/storage/mmkv";

const logger = log.child("wallet.vault");

/** AES-256-GCM: authenticated, and what the platform accelerates. */
export const VAULT_ALGORITHM = "aes-256-gcm";
/** 256-bit master key. */
export const MASTER_KEY_BYTES = 32;
/** 96 bits — the GCM-recommended IV length, and what the guide specifies. */
export const IV_BYTES = 12;

const MASTER_KEY_SERVICE = "com.hl.vault.masterKey";
const BLOB_PREFIX = "hl:vault:";

/** The stored envelope. Base64 throughout, because MMKV holds strings. */
export interface EncryptedBlob {
  iv: string;
  tag: string;
  content: string;
}

/** Minimal cipher surface, matching Node's and quick-crypto's. */
export interface VaultCipher {
  update(data: string, inputEncoding: string, outputEncoding: string): string;
  final(outputEncoding: string): string;
  getAuthTag(): Uint8Array;
}

export interface VaultDecipher {
  setAuthTag(tag: Uint8Array): void;
  update(data: string, inputEncoding: string, outputEncoding: string): string;
  final(outputEncoding: string): string;
}

/**
 * The crypto primitives, injected.
 *
 * `react-native-quick-crypto` is a Nitro module and cannot load off-device, so
 * importing it here would make the vault untestable — and an untested vault is
 * the last thing this project should ship.
 */
export interface VaultCrypto {
  randomBytes(size: number): Uint8Array;
  createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): VaultCipher;
  createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): VaultDecipher;
}

let crypto: VaultCrypto | null = null;

/** Register the crypto backend. Called once from the app bootstrap. */
export function registerVaultCrypto(implementation: VaultCrypto | null): void {
  crypto = implementation;
}

function requireCrypto(): VaultCrypto {
  if (!crypto) {
    throw new HlError("Vault crypto backend is not registered", {
      code: "invalid_config",
      context: { hint: "call registerVaultCrypto from setupHyperliquid" },
    });
  }
  return crypto;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Keychain options for the master key.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` for the same reason the agent key uses it:
 * the library default permits background reads after first unlock and lets the
 * item migrate to a restored device. A key that decrypts a seed phrase must not
 * travel in a backup.
 *
 * Biometric access control is deliberately **not** set. The master key is read
 * once per session and then decrypts every subsequent read, so gating it would
 * put a Face ID prompt in front of app launch rather than in front of anything
 * dangerous. Gate the operations that spend money instead — that is where a
 * user expects to be asked, and where the prompt actually means something.
 */
const KEYCHAIN_OPTIONS: Keychain.SetOptions = {
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** In-memory for the session. Never exported, never logged, never persisted here. */
let cachedMasterKey: Uint8Array | null = null;

export type MasterKeyState =
  /** A key exists and is loaded. */
  | { kind: "ready" }
  /** No key and no encrypted data: a genuine first run. Safe to create one. */
  | { kind: "uninitialised" }
  /**
   * Encrypted data exists but the key does not.
   *
   * Unrecoverable, and **never** resolved by generating a fresh key: that would
   * leave every blob undecryptable while presenting as a working empty wallet.
   * The user must re-import from their recovery phrase.
   */
  | { kind: "key_lost"; blobCount: number };

/** How many encrypted blobs are stored. Used to tell first-run from key loss. */
function blobCount(): number {
  return listVaultKeys().length;
}

/** Every vault key currently stored. */
export function listVaultKeys(): string[] {
  // MMKV's adapter exposes no enumeration, so the index is maintained alongside.
  const index = hlStringStorage.getItem(`${BLOB_PREFIX}__index`);
  if (!index) return [];
  try {
    const parsed: unknown = JSON.parse(index);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function writeIndex(keys: string[]): void {
  hlStringStorage.setItem(`${BLOB_PREFIX}__index`, JSON.stringify([...new Set(keys)]));
}

/**
 * Inspect the vault without changing it.
 *
 * Distinguishing `uninitialised` from `key_lost` is the whole point: they look
 * identical from the app's perspective and demand opposite responses.
 */
export async function inspectVault(): Promise<MasterKeyState> {
  const stored = await Keychain.getGenericPassword({ service: MASTER_KEY_SERVICE });
  if (stored) return { kind: "ready" };

  const count = blobCount();
  if (count === 0) return { kind: "uninitialised" };

  logger.warn("vault.key_lost", { context: { blobCount: count } });
  return { kind: "key_lost", blobCount: count };
}

/**
 * Create the master key. Only valid on a genuine first run.
 *
 * @throws {HlError} if a key already exists, or if encrypted data exists without
 *   one — overwriting in either case destroys access to everything stored.
 */
export async function initialiseVault(): Promise<void> {
  const state = await inspectVault();
  if (state.kind === "ready") return;
  if (state.kind === "key_lost") {
    throw new HlError(
      `Vault holds ${state.blobCount} encrypted item(s) but the master key is gone; re-import from a recovery phrase`,
      { code: "invalid_config", context: { blobCount: state.blobCount } }
    );
  }

  const key = requireCrypto().randomBytes(MASTER_KEY_BYTES);
  const ok = await Keychain.setGenericPassword("vault", toBase64(key), {
    ...KEYCHAIN_OPTIONS,
    service: MASTER_KEY_SERVICE,
  });
  if (!ok) throw new HlError("Could not store the vault master key", { code: "invalid_config" });

  cachedMasterKey = key;
  logger.info("vault.initialised");
}

/** Load the master key, caching it for the session. */
async function masterKey(): Promise<Uint8Array> {
  if (cachedMasterKey) return cachedMasterKey;

  const stored = await Keychain.getGenericPassword({ service: MASTER_KEY_SERVICE });
  if (!stored) {
    throw new HlError("Vault is locked: no master key", {
      code: "not_authorized",
      context: { blobCount: blobCount() },
    });
  }
  cachedMasterKey = fromBase64(stored.password);
  return cachedMasterKey;
}

/** Encrypt a value. A fresh IV is generated per call and never reused. */
function seal(key: Uint8Array, plaintext: string): EncryptedBlob {
  const impl = requireCrypto();
  // Generated HERE, every time. Never a parameter — an IV reused with the same
  // key breaks GCM's confidentiality and its authentication together.
  const iv = impl.randomBytes(IV_BYTES);

  const cipher = impl.createCipheriv(VAULT_ALGORITHM, key, iv);
  const content = cipher.update(plaintext, "utf8", "base64") + cipher.final("base64");

  return { iv: toBase64(iv), tag: toBase64(cipher.getAuthTag()), content };
}

function open(impl: VaultCrypto, key: Uint8Array, blob: EncryptedBlob): string {
  const decipher = impl.createDecipheriv(VAULT_ALGORITHM, key, fromBase64(blob.iv));
  decipher.setAuthTag(fromBase64(blob.tag));
  // `final` throws if the tag does not verify — that is GCM doing its job.
  return decipher.update(blob.content, "base64", "utf8") + decipher.final("utf8");
}

/** Store a secret under a name. */
export async function putSecret(name: string, value: string): Promise<void> {
  const blob = seal(await masterKey(), value);
  hlStringStorage.setItem(`${BLOB_PREFIX}${name}`, JSON.stringify(blob));
  writeIndex([...listVaultKeys(), name]);
  // The name only — never the value, and never its length, which leaks whether
  // a phrase is 12 or 24 words.
  logger.info("vault.stored", { context: { name } });
}

/**
 * Read a secret, or `null` if absent.
 *
 * @throws {HlError} `validation_error` when the authentication tag fails —
 *   corruption or tampering, and distinct from "not there".
 */
export async function getSecret(name: string): Promise<string | null> {
  const raw = hlStringStorage.getItem(`${BLOB_PREFIX}${name}`);
  if (!raw) return null;

  let blob: EncryptedBlob;
  try {
    blob = JSON.parse(raw) as EncryptedBlob;
  } catch {
    throw new HlError(`Vault entry ${name} is not readable`, {
      code: "validation_error",
      context: { name, reason: "malformed_envelope" },
    });
  }

  // Resolved BEFORE the try. A locked vault (`not_authorized`) and an
  // unregistered crypto backend (`invalid_config`) are not tamper evidence, and
  // reporting them as an integrity failure tells a user their recovery phrase
  // was altered when in fact nothing was read at all.
  // Both resolved BEFORE the try. A locked vault (`not_authorized`) and an
  // unregistered backend (`invalid_config`) are not tamper evidence, and
  // reporting them as an integrity failure tells a user their recovery phrase
  // was altered when in fact nothing was read at all. Only the decipher and its
  // tag check belong inside.
  const impl = requireCrypto();
  const key = await masterKey();

  try {
    return open(impl, key, blob);
  } catch (error) {
    // A tag failure is not a decode failure. It means the stored bytes are not
    // what we wrote, which a caller should treat as a security event rather
    // than as a corrupt-cache-clear-it situation.
    logger.warn("vault.tamper_detected", { context: { name } });
    throw new HlError(`Vault entry ${name} failed its integrity check`, {
      code: "validation_error",
      context: { name, reason: "auth_tag_mismatch" },
      cause: error,
    });
  }
}

export function hasSecret(name: string): boolean {
  return hlStringStorage.getItem(`${BLOB_PREFIX}${name}`) !== null;
}

export function deleteSecret(name: string): void {
  hlStringStorage.removeItem(`${BLOB_PREFIX}${name}`);
  writeIndex(listVaultKeys().filter((key) => key !== name));
  logger.info("vault.deleted", { context: { name } });
}

/**
 * Destroy everything: the master key and every blob.
 *
 * For "log out and forget me". Deliberately removes the blobs too — leaving
 * them behind with no key is the `key_lost` state, which would then be reported
 * as an error on the next launch.
 */
export async function destroyVault(): Promise<void> {
  for (const name of listVaultKeys()) {
    hlStringStorage.removeItem(`${BLOB_PREFIX}${name}`);
  }
  hlStringStorage.removeItem(`${BLOB_PREFIX}__index`);
  await Keychain.resetGenericPassword({ service: MASTER_KEY_SERVICE });
  cachedMasterKey = null;
  logger.info("vault.destroyed");
}

/** Drop the cached key, forcing a Keychain read next time. For lock-on-background. */
export function lockVault(): void {
  cachedMasterKey = null;
}
