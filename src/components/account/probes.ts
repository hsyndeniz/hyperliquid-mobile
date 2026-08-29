/**
 * Device health checks — migrated from the Phase-14 diagnostics screen when it
 * was deleted, because these five verify what Jest structurally cannot:
 *
 * - **The crypto shim.** `@noble/hashes` captures `globalThis.crypto` once at
 *   module-evaluation time, and Metro does not apply the `node` export
 *   condition. If anything imports viem/@noble before `src/polyfills` runs,
 *   key generation is permanently broken — and broken *silently*.
 * - **Nitro modules.** MMKV compiles to JSI bindings that exist only in a
 *   native build; under Jest they are mocked away entirely.
 * - **Keychain.** Same — no test has ever touched the real one.
 * - **The ESM SDK under Metro**, and a real websocket on a real radio.
 *
 * Plain async functions, no React, so each can be lifted into a script.
 *
 * One interaction worth knowing: the websocket probe opens the module's shared
 * transport, and `session.start()` closes it via `configureClients`. Running
 * the probe and then starting a session kills the probe's subscription — that
 * is correct behaviour, not a defect.
 */

import {
  getConnectionState,
  getInfoClient,
  getSubscriptionClient,
} from "@/hyperliquid/api/clients";
import { CLOCK_SKEW_LIMIT_MS, clockSkew } from "@/hyperliquid/core/clock";
import { hlStorage } from "@/hyperliquid/storage/mmkv";
import { deriveAccount } from "@/hyperliquid/wallet/derive";
import { generateMnemonic, hasNativePbkdf2, mnemonicToSeed } from "@/hyperliquid/wallet/mnemonic";
import { walletState } from "@/hyperliquid/wallet/accounts";

export interface ProbeOutcome {
  ok: boolean;
  detail: string;
}

/**
 * The documented highest-risk path: randomness → BIP39 → BIP32 → secp256k1.
 *
 * Generating **two** mnemonics is the point. A missing CSPRNG does not throw:
 * Hermes' `Math.random`-backed fallbacks and a zero-filled `getRandomValues`
 * both return a perfectly well-formed phrase, and the same one every time. A
 * probe that generated one and checked it parsed would pass against the worst
 * bug this app can have.
 */
async function probeCrypto(): Promise<ProbeOutcome> {
  const hasGetRandomValues = typeof globalThis.crypto?.getRandomValues === "function";
  if (!hasGetRandomValues) {
    return { ok: false, detail: "globalThis.crypto.getRandomValues is missing — shim did not run" };
  }

  const first = generateMnemonic();
  const second = generateMnemonic();
  if (first === second) {
    return {
      ok: false,
      detail: "generateMnemonic() returned the SAME phrase twice — the CSPRNG is not installed",
    };
  }

  // Never persisted, never logged. Only the derived address is shown.
  const account = deriveAccount(await mnemonicToSeed(first), 0);
  return {
    ok: true,
    detail: `two distinct phrases · native pbkdf2 ${hasNativePbkdf2() ? "yes" : "NO (slow JS fallback)"} · derived ${account.address}`,
  };
}

/** MMKV v4 is a Nitro module; under Jest it is replaced by an in-memory mock. */
async function probeStorage(): Promise<ProbeOutcome> {
  const store = hlStorage();
  const key = "hl:diagnostics:probe";
  const written = `probe-${Date.now()}`;
  store.set(key, written);
  // `remove`, not `delete` — MMKV's own naming, as `storage/mmkv.ts` warns.
  const read = store.getString(key);
  store.remove(key);
  if (read !== written) {
    return { ok: false, detail: `wrote ${written}, read back ${String(read)}` };
  }
  return { ok: true, detail: `round trip ok · ${store.getAllKeys().length} keys held` };
}

/**
 * Keychain, through the vault.
 *
 * `locked` — encrypted blobs whose master key is unavailable — is exactly the
 * state worth surfacing loudly, because creating a fresh wallet on top of it
 * is the one unrecoverable move.
 */
async function probeKeychain(): Promise<ProbeOutcome> {
  const state = await walletState();
  if (state.kind === "ready") {
    return {
      ok: true,
      detail: `wallet ready · ${state.metadata.kind} · ${state.metadata.accounts.length} account(s) · backed up ${state.metadata.backedUp}`,
    };
  }
  return { ok: true, detail: `no wallet on this device (${state.kind}) — Keychain readable` };
}

/** REST, and with it the ESM SDK's bundle under Metro. */
async function probeRest(): Promise<ProbeOutcome> {
  // Together, not one after the other: neither read feeds the other, and this
  // probe is timing the REST path — running them in sequence measures two
  // round trips and reports it as one.
  const [meta, mids] = await Promise.all([getInfoClient().meta(), getInfoClient().allMids()]);
  return {
    ok: true,
    detail: `${meta.universe.length} perp assets · ${Object.keys(mids).length} mids · BTC ${mids.BTC ?? "?"}`,
  };
}

const WS_PROBE_WINDOW_MS = 4_000;

/**
 * A real socket on a real radio.
 *
 * Frames are counted rather than awaited once: a subscription that confirms and
 * then delivers nothing is a distinct failure from one that never confirms, and
 * only the count tells them apart.
 */
async function probeWebsocket(): Promise<ProbeOutcome> {
  let frames = 0;
  let btc: string | null = null;

  const handle = await getSubscriptionClient().allMids({}, (data: unknown) => {
    frames += 1;
    const mids = (data as { mids?: Record<string, string> }).mids;
    if (mids && typeof mids.BTC === "string") btc = mids.BTC;
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, WS_PROBE_WINDOW_MS));
  } finally {
    await handle.unsubscribe().catch(() => undefined);
  }

  if (frames === 0) {
    return { ok: false, detail: `subscribed, but no frame arrived in ${WS_PROBE_WINDOW_MS}ms` };
  }
  return {
    ok: true,
    detail: `${frames} frames in ${WS_PROBE_WINDOW_MS}ms · BTC ${btc ?? "absent from payload"} · socket ${getConnectionState()}`,
  };
}

/**
 * The device's clock against the exchange's.
 *
 * Worth a probe because the failure it causes names nothing: every signed
 * action carries an `expiresAfter` deadline, and a phone running slow stamps one
 * that has already passed — so orders come back "Action already expired" with
 * the phone's Settings, not the app, as the actual fix. (Which clock the
 * exchange checks it against is undocumented; see `core/clock`.) `core/clock`
 * now corrects for it, which makes the symptom *invisible* — this is the only
 * place the measurement surfaces at all.
 *
 * Measured against the round-trip midpoint rather than the send time, so what
 * is reported is clock skew and not the network's latency.
 */
async function probeClock(): Promise<ProbeOutcome> {
  const sentAt = Date.now();
  const book = await getInfoClient().l2Book({ coin: "BTC" });
  const roundTripMs = Date.now() - sentAt;
  // `null` means the market does not exist — a delisting, not a clock fault.
  if (book === null)
    return { ok: false, detail: "l2Book(BTC) returned null — no snapshot to time" };

  const skewMs = Math.round(book.time - (sentAt + roundTripMs / 2));
  const passive = clockSkew();
  // With no samples the offset is either nothing or a value restored from the
  // last launch — two very different states, and saying "no frames sampled yet"
  // for both would hide the seed exactly when someone is looking for it.
  const live =
    passive.samples > 0
      ? `${passive.rawOffsetMs}ms over ${passive.samples} frames, correcting by ${passive.offsetMs}ms`
      : passive.offsetMs === 0
        ? "no frames sampled yet"
        : `no frames yet, seeded at ${passive.offsetMs}ms from the last launch`;
  const detail = `device ${skewMs >= 0 ? "behind" : "ahead"} by ${Math.abs(skewMs)}ms · round trip ${roundTripMs}ms · live: ${live}`;

  if (Math.abs(skewMs) >= CLOCK_SKEW_LIMIT_MS) {
    return { ok: false, detail: `${detail} — set the device clock to update automatically` };
  }
  return { ok: true, detail };
}

export interface Probe {
  key: string;
  label: string;
  run: () => Promise<ProbeOutcome>;
}

export const PROBES: Probe[] = [
  { key: "crypto", label: "Crypto shim", run: probeCrypto },
  { key: "storage", label: "MMKV storage", run: probeStorage },
  { key: "keychain", label: "Keychain vault", run: probeKeychain },
  { key: "rest", label: "REST API", run: probeRest },
  { key: "ws", label: "WebSocket", run: probeWebsocket },
  { key: "clock", label: "Device clock", run: probeClock },
];

export type ProbeStatus = "idle" | "running" | "pass" | "fail";

export interface ProbeState {
  status: ProbeStatus;
  detail: string;
}

export const PROBE_IDLE: ProbeState = { status: "idle", detail: "not run" };
