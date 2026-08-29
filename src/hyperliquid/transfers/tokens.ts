/**
 * Spot token identifiers, resolved live per network.
 *
 * `spotSend` and `sendAsset` take a `token` field spelled `NAME:tokenId`, where
 * the id is the **16-byte spotMeta token id** (32 hex characters), not the
 * 20-byte EVM contract address. It sits inside the signed message and the SDK
 * types it as a bare string, so nothing anywhere catches a wrong one.
 *
 * **It differs by network**, and this is the trap: every `spotSend` example in
 * the SDK's own doc comments uses the *testnet* USDC id. Copying an example into
 * production code produces a signed message naming a token that does not exist
 * on mainnet.
 *
 *     mainnet  USDC:0x6d1e7cde53ba9467b783cb7c530ce054
 *     testnet  USDC:0xeb62eee3685fc4c43992febcd9e75443
 *
 * So there is no constant here and there never will be. `WireToken` is branded
 * and this module is its only producer, which makes a hardcoded id a type error
 * rather than a code-review question.
 */

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { weightBudget, type WeightBudget } from "@/hyperliquid/api/weightBudget";
import type { HlEnv } from "@/hyperliquid/types/domain";
import type { WireToken } from "@/hyperliquid/transfers/types";

const logger = log.child("transfers.tokens");

export interface SpotToken {
  name: string;
  /** 32 hex characters, prefixed `0x`. Not an EVM address. */
  tokenId: string;
  index: number;
  szDecimals: number;
  weiDecimals: number;
}

export interface SpotMetaProbe {
  spotMeta(): Promise<unknown>;
}

/**
 * Token catalogue for one network.
 *
 * Cached per env because it is near-static and every transfer needs it, but
 * **never shared across envs** — that is exactly the mistake the branding
 * exists to prevent.
 */
export class TokenCatalogue {
  private byName = new Map<string, SpotToken>();
  private byIndex = new Map<number, SpotToken>();
  private loadedAt = 0;

  constructor(readonly env: HlEnv) {}

  get isLoaded(): boolean {
    return this.byName.size > 0;
  }

  get size(): number {
    return this.byName.size;
  }

  /** Populate from a live `spotMeta` response. */
  load(raw: unknown): void {
    const tokens = readTokens(raw);
    this.byName = new Map(tokens.map((t) => [t.name.toUpperCase(), t]));
    this.byIndex = new Map(tokens.map((t) => [t.index, t]));
    this.loadedAt = Date.now();
    logger.info("tokens.loaded", { context: { env: this.env, count: tokens.length } });
  }

  find(name: string): SpotToken | null {
    return this.byName.get(name.trim().toUpperCase()) ?? null;
  }

  findByIndex(index: number): SpotToken | null {
    return this.byIndex.get(index) ?? null;
  }

  /**
   * Build the signed `NAME:tokenId` string.
   *
   * @throws {HlError} when the token is unknown on this network — which is the
   *   correct outcome, because the alternative is signing a message naming a
   *   token that does not exist here.
   */
  wireToken(name: string): WireToken {
    const token = this.find(name);
    if (!token) {
      throw new HlError(`Token ${name} is not on ${this.env}`, {
        code: "validation_error",
        context: { name, env: this.env, known: this.byName.size },
      });
    }
    return `${token.name}:${token.tokenId}` as WireToken;
  }
}

/** Parse the `tokens` array out of a `spotMeta` response. */
function readTokens(raw: unknown): SpotToken[] {
  if (typeof raw !== "object" || raw === null) {
    throw new HlError("spotMeta is not an object", { code: "validation_error" });
  }
  const tokens = (raw as { tokens?: unknown }).tokens;
  if (!Array.isArray(tokens)) {
    throw new HlError("spotMeta.tokens is not an array", { code: "validation_error" });
  }

  return tokens.flatMap((entry, i) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const name = record.name;
    const tokenId = record.tokenId;
    // A token missing either field cannot be sent, so it is skipped rather than
    // faked — a half-parsed entry would produce an unsignable wire string.
    if (typeof name !== "string" || typeof tokenId !== "string") return [];
    return [
      {
        name,
        tokenId,
        index: typeof record.index === "number" ? record.index : i,
        szDecimals: typeof record.szDecimals === "number" ? record.szDecimals : 0,
        weiDecimals: typeof record.weiDecimals === "number" ? record.weiDecimals : 0,
      },
    ];
  });
}

/** Fetch and populate a catalogue, through the weight budget. */
export async function loadTokenCatalogue(params: {
  probe: SpotMetaProbe;
  env: HlEnv;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<{ catalogue: TokenCatalogue | null; deferred: boolean }> {
  const budget = params.budget ?? weightBudget;
  const at = (params.now ?? Date.now)();

  const raw = await budget.tryRun("spotMeta", () => params.probe.spotMeta(), { now: () => at });
  if (raw === null) return { catalogue: null, deferred: true };

  const catalogue = new TokenCatalogue(params.env);
  catalogue.load(raw);
  return { catalogue, deferred: false };
}
