/**
 * In-memory Keychain for tests.
 *
 * `react-native-keychain` calls into the platform Keychain/Keystore, so any
 * module that touches it is unimportable under Jest — which is why the agent
 * lifecycle was split into a pure `agentPolicy.ts` and a device-only
 * `keychain.ts`. The vault cannot be split that way: reading and writing the
 * master key IS its behaviour, so it needs a real store to test against.
 *
 * A working key-value store rather than no-op stubs, keyed by `service` exactly
 * as the real library is — so "one credential per service" round-trips for real,
 * and a test that stores under one service cannot accidentally read another.
 */

const store = new Map();

const ACCESSIBLE = {
  WHEN_UNLOCKED: "AccessibleWhenUnlocked",
  AFTER_FIRST_UNLOCK: "AccessibleAfterFirstUnlock",
  ALWAYS: "AccessibleAlways",
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: "AccessibleWhenPasscodeSetThisDeviceOnly",
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "AccessibleWhenUnlockedThisDeviceOnly",
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "AccessibleAfterFirstUnlockThisDeviceOnly",
};

const ACCESS_CONTROL = {
  USER_PRESENCE: "UserPresence",
  BIOMETRY_ANY: "BiometryAny",
  BIOMETRY_CURRENT_SET: "BiometryCurrentSet",
  DEVICE_PASSCODE: "DevicePasscode",
  APPLICATION_PASSWORD: "ApplicationPassword",
  BIOMETRY_ANY_OR_DEVICE_PASSCODE: "BiometryAnyOrDevicePasscode",
  BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE: "BiometryCurrentSetOrDevicePasscode",
};

const BIOMETRY_TYPE = {
  TOUCH_ID: "TouchID",
  FACE_ID: "FaceID",
  FINGERPRINT: "Fingerprint",
  FACE: "Face",
  IRIS: "Iris",
};

/** Matches the real library, which uses this string when no service is given. */
function serviceOf(options) {
  return (options && options.service) || "__default__";
}

/**
 * A test-controlled write failure, or null.
 *
 * The presence gate decides whether to demand biometry by trying an
 * access-controlled write and reading what happens, so "the write fails" is a
 * state the gate's own logic branches on — and there was no way to produce it
 * here. A spy cannot supply it either: Babel's ESM interop makes the namespace
 * bindings non-writable, so `jest.spyOn` on this module silently does nothing.
 *
 * Set via `__setWriteFailure(fn)`; `fn(options)` returns an Error to throw or
 * null to allow. The whole `options` object is passed so a test can fail only
 * the ACCESS-CONTROLLED write and let a plain one through — the exact shape
 * that distinguishes "this device has no passcode" from "the keychain is
 * unavailable".
 */
let writeFailure = null;

/** Every write's options, in order — so a test can assert the protection asked for. */
const writes = [];

async function setGenericPassword(username, password, options) {
  writes.push({ service: serviceOf(options), options: options ?? {} });
  if (writeFailure) {
    const error = writeFailure(options ?? {});
    if (error) throw error;
  }
  store.set(serviceOf(options), {
    username,
    password,
    service: serviceOf(options),
    // Kept, not discarded: the protection a caller ASKED for is the whole
    // security property, and a mock that drops it lets a test pass while the
    // real item is written unprotected.
    accessible: options && options.accessible,
    accessControl: options && options.accessControl,
  });
  return { service: serviceOf(options), storage: "mock" };
}

/**
 * Auth prompts this mock has been asked to show.
 *
 * The presence gate proves the user is present by writing an access-controlled
 * item and reading it back, then DELETING it in a `finally` — so the item
 * itself is unobservable by the time a test looks. The prompt is the only
 * lasting evidence the gate ran, so the mock records it.
 */
const authPrompts = [];

async function getGenericPassword(options) {
  const title = options && options.authenticationPrompt && options.authenticationPrompt.title;
  if (title) authPrompts.push(title);
  return store.get(serviceOf(options)) || false;
}

async function resetGenericPassword(options) {
  return store.delete(serviceOf(options));
}

async function getAllGenericPasswordServices() {
  return [...store.keys()];
}

/**
 * Was missing until a test needed it, which meant `hasAgentKey` had never run
 * under test at all — a mock gap reads as "no coverage", not as a failure.
 */
async function hasGenericPassword(options) {
  return store.has(serviceOf(options));
}

async function getSupportedBiometryType() {
  return BIOMETRY_TYPE.FACE_ID;
}

/** Test helper: wipe everything between cases. */
function __reset() {
  store.clear();
  authPrompts.length = 0;
  writes.length = 0;
  // A leaked failure mode would make every later suite look broken in a way
  // that points at the code under test rather than at the test that set it.
  writeFailure = null;
}

/** Test helper: the auth prompts shown since the last reset. */
function __authPrompts() {
  return [...authPrompts];
}

/** Test helper: make writes fail. `fn(options) => Error | null`, or null to clear. */
function __setWriteFailure(fn) {
  writeFailure = fn;
}

/** Test helper: every write's `{service, options}`, in order. */
function __writes() {
  return writes.map((entry) => ({ ...entry }));
}

module.exports = {
  ACCESSIBLE,
  ACCESS_CONTROL,
  BIOMETRY_TYPE,
  setGenericPassword,
  getGenericPassword,
  resetGenericPassword,
  getAllGenericPasswordServices,
  hasGenericPassword,
  getSupportedBiometryType,
  __reset,
  __authPrompts,
  __setWriteFailure,
  __writes,
};
