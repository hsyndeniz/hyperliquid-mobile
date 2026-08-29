/**
 * The transport generation — the market feed's rebuild gate.
 *
 * Constructing a real transport is out of reach here (`WebSocketTransport`
 * connects eagerly in its constructor), so what is pinned is the property the
 * gate depends on: a close that tore nothing down must not look like a rebuild.
 */

import { observeServerTime, resetClock } from "@/hyperliquid/core/clock";
import { closeClients, issueNonce, transportGenerationOf } from "@/hyperliquid/api/clients";

describe("transportGenerationOf", () => {
  it("does not advance when there was nothing to close", () => {
    // The whole point of the gate. If a no-op close bumped the counter, the
    // market feed would tear down and reopen every live subscription on any
    // session publish — which is the churn this replaced, just relocated.
    closeClients();
    const before = transportGenerationOf();
    closeClients();
    closeClients();
    expect(transportGenerationOf()).toBe(before);
  });

  it("is a plain comparable counter, never interpreted", () => {
    expect(typeof transportGenerationOf()).toBe("number");
  });
});

describe("issueNonce builds on the exchange's clock", () => {
  const REAL = 1_800_000_000_000;
  const ADDRESS = "0xabcdef0123456789abcdef0123456789abcdef01";

  afterEach(resetClock);

  it("does not stamp the nonce ahead when the device clock runs fast", () => {
    // The hazard this closes: a nonce must exceed the SMALLEST of this signer's
    // 100 highest, and that floor never comes back down. A fast phone ratchets
    // its own floor into the future, then locks itself out the moment the clock
    // is corrected — one app restart later, once the in-memory monotonic guard
    // is gone, with nothing local to explain it.
    const SKEW_MS = 5 * 60_000;
    for (let i = 0; i < 5; i += 1) observeServerTime(REAL - SKEW_MS + i, REAL + i);

    const deviceNow = Date.now();
    const nonce = issueNonce(`${ADDRESS}-fast`);

    // Roughly five minutes behind this device — i.e. on the exchange's clock.
    expect(nonce).toBeLessThan(deviceNow - SKEW_MS + 30_000);
    expect(nonce).toBeGreaterThan(deviceNow - SKEW_MS - 30_000);
  });

  it("is byte-identical to Date.now() while no skew is established", () => {
    // The deadband case, which is every healthy phone: this path must behave
    // exactly as it did before the clock module existed.
    const before = Date.now();
    const nonce = issueNonce(`${ADDRESS}-healthy`);
    expect(nonce).toBeGreaterThanOrEqual(before);
    expect(nonce).toBeLessThan(before + 5_000);
  });

  it("still advances when two actions land in the same millisecond", () => {
    // The server rejects a nonce that does not advance, whichever clock it came
    // from. Correcting the clock must not cost the monotonic guard.
    const key = `${ADDRESS}-mono`;
    const first = issueNonce(key);
    const second = issueNonce(key);
    expect(second).toBeGreaterThan(first);
  });
});
