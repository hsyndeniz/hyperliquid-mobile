/**
 * `react-native-quick-crypto` under Jest.
 *
 * The real package is a Nitro module: importing it calls
 * `TurboModuleRegistry.getEnforcing('QuickBase64')`, which throws outside a
 * native binary. Anything downstream of `setup.ts` is therefore unimportable in
 * a test without this — the same reason `__mocks__/react-native-mmkv.js` exists.
 *
 * `pbkdf2` is backed by `@noble/hashes` rather than stubbed, so a test that
 * registers the "native" backend exercises the real derivation and the seeds
 * genuinely match the pure-JS path. Stubbing it would make the one test that
 * matters — that both paths agree — vacuous.
 */

const { pbkdf2: noblePbkdf2, pbkdf2Async } = require("@noble/hashes/pbkdf2.js");
const { sha256, sha512 } = require("@noble/hashes/sha2.js");

const DIGESTS = { sha256, sha512 };

function resolveDigest(name) {
  const digest = DIGESTS[String(name).toLowerCase()];
  if (!digest) throw new Error(`mock quick-crypto: unsupported digest ${name}`);
  return digest;
}

/** Node-style async PBKDF2. */
function pbkdf2(password, salt, iterations, keylen, digest, callback) {
  pbkdf2Async(resolveDigest(digest), password, salt, { c: iterations, dkLen: keylen })
    // Uint8Array, not Buffer: that is what the real binding hands back, and
    // `Buffer` is not a lint-visible global in this config.
    .then((derived) => callback(null, derived))
    .catch((error) => callback(error, new Uint8Array()));
}

function pbkdf2Sync(password, salt, iterations, keylen, digest) {
  return noblePbkdf2(resolveDigest(digest), password, salt, { c: iterations, dkLen: keylen });
}

function randomBytes(size) {
  const bytes = new Uint8Array(size);
  // `globalThis.crypto` exists in Jest's environment; this keeps the mock from
  // silently handing out predictable bytes if anything ever asserts on entropy.
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** No-op: the polyfill's job is done by the Jest environment already. */
function install() {}

/**
 * Real AES-GCM via Node's crypto, not a stub.
 *
 * The vault's security properties — a fresh IV per call, an authentication tag
 * that actually rejects tampered ciphertext — are only testable against a real
 * implementation. A stub would let a broken vault pass.
 */
const nodeCrypto = require("crypto");

function createCipheriv(algorithm, key, iv) {
  return nodeCrypto.createCipheriv(algorithm, key, iv);
}

function createDecipheriv(algorithm, key, iv) {
  return nodeCrypto.createDecipheriv(algorithm, key, iv);
}

module.exports = {
  install,
  pbkdf2,
  pbkdf2Sync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  default: { install, pbkdf2, pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv },
};
