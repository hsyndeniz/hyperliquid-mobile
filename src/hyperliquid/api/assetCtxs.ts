/**
 * Combined market metadata + asset contexts over REST.
 *
 * The two reads under the Markets list. Both return `[meta, ctxs]` tuples, and
 * the two tuples obey **opposite alignment rules** — measured live on testnet
 * (2026-08-15), not assumed:
 *
 * - `metaAndAssetCtxs`: 210 universe rows, 210 ctxs, **index-aligned**, and the
 *   ctx side carries no key at all — the position IS the join. So the parser
 *   here asserts the lengths match and refuses the whole response otherwise: a
 *   one-row gap would silently dress every later market in its neighbour's
 *   prices, and no downstream join can detect it because there is nothing to
 *   cross-check against.
 * - `spotMetaAndAssetCtxs`: 1,309 universe rows against **2,492 ctxs** — NOT
 *   index-aligned (1,305 of 1,309 same-index pairs name different markets).
 *   Each spot ctx carries its own `coin`, joining is `markets/rows.ts`'s job,
 *   and asserting equality here would reject every valid response the endpoint
 *   has ever produced. The extra ctxs include the 724 `#N` prediction sides —
 *   predictions ride in this response and cost no separate read.
 *
 * Responses pass through raw (typed by the SDK aliases); parsing validates only
 * the load-bearing structure. The spot payload is ~866 KB — callers cache the
 * BUILT rows per TTL (see `hooks/markets.ts`), never re-parse per mount.
 *
 * `{value, deferred}` is the `predictions/catalog.ts` idiom: `value: null`
 * means the weight budget refused, never "there are no markets".
 */

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { weightBudget, type WeightBudget } from "@/hyperliquid/api/weightBudget";
import type {
  IMetaAndAssetCtxsResponse,
  ISpotMetaAndAssetCtxsResponse,
} from "@/hyperliquid/types/sdk";

const logger = log.child("api.assetCtxs");

export interface PerpCtxsProbe {
  metaAndAssetCtxs(): Promise<unknown>;
}

export interface SpotCtxsProbe {
  spotMetaAndAssetCtxs(): Promise<unknown>;
}

/** The `[meta, ctxs]` halves, or a loud refusal. Shared by both parsers. */
function splitTuple(
  raw: unknown,
  endpoint: string
): { meta: Record<string, unknown>; ctxs: readonly unknown[] } {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new HlError(`${endpoint} did not return a [meta, ctxs] tuple`, {
      code: "validation_error",
      context: { endpoint, got: Array.isArray(raw) ? `array[${raw.length}]` : typeof raw },
    });
  }
  const [meta, ctxs] = raw as [unknown, unknown];
  if (typeof meta !== "object" || meta === null || !Array.isArray(ctxs)) {
    throw new HlError(`${endpoint} tuple halves have the wrong shape`, {
      code: "validation_error",
      context: { endpoint, meta: typeof meta, ctxs: typeof ctxs },
    });
  }
  return { meta: meta as Record<string, unknown>, ctxs };
}

/**
 * Validate a `metaAndAssetCtxs` response.
 *
 * @throws {HlError} `validation_error` on a malformed tuple — or on a
 *   universe/ctxs length mismatch, because with a positional join a partial
 *   response is not partial data, it is WRONG data for every row after the gap.
 */
export function parsePerpCtxs(raw: unknown): IMetaAndAssetCtxsResponse {
  const { meta, ctxs } = splitTuple(raw, "metaAndAssetCtxs");
  const universe = meta.universe;
  if (!Array.isArray(universe)) {
    throw new HlError("metaAndAssetCtxs meta carries no universe array", {
      code: "validation_error",
    });
  }
  if (universe.length !== ctxs.length) {
    throw new HlError("metaAndAssetCtxs universe and ctxs lengths differ", {
      code: "validation_error",
      context: { universe: universe.length, ctxs: ctxs.length },
    });
  }
  return raw as IMetaAndAssetCtxsResponse;
}

/**
 * Validate a `spotMetaAndAssetCtxs` response.
 *
 * Deliberately does NOT compare lengths — see the module header. The ctxs pass
 * through raw; the by-`coin` join lives in `markets/rows.ts`.
 */
export function parseSpotCtxs(raw: unknown): ISpotMetaAndAssetCtxsResponse {
  const { meta } = splitTuple(raw, "spotMetaAndAssetCtxs");
  if (!Array.isArray(meta.universe) || !Array.isArray(meta.tokens)) {
    throw new HlError("spotMetaAndAssetCtxs meta is missing universe or tokens", {
      code: "validation_error",
      context: {
        universe: Array.isArray(meta.universe),
        tokens: Array.isArray(meta.tokens),
      },
    });
  }
  return raw as ISpotMetaAndAssetCtxsResponse;
}

export interface PerpCtxsResult {
  /** `null` only when the weight budget refused — never for "no markets". */
  value: IMetaAndAssetCtxsResponse | null;
  deferred: boolean;
}

export interface SpotCtxsResult {
  value: ISpotMetaAndAssetCtxsResponse | null;
  deferred: boolean;
}

/** Fetch perp metadata + contexts, through the weight budget. */
export async function fetchPerpCtxs(params: {
  probe: PerpCtxsProbe;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<PerpCtxsResult> {
  const budget = params.budget ?? weightBudget;
  const at = (params.now ?? Date.now)();

  // Wrapped so a probe that resolved `null` cannot masquerade as a deferral —
  // `tryRun`'s own `null` means "refused", and the two must stay distinct.
  const wrapped = await budget.tryRun(
    "metaAndAssetCtxs",
    async () => ({ raw: await params.probe.metaAndAssetCtxs() }),
    { now: () => at }
  );
  if (wrapped === null) return { value: null, deferred: true };

  const value = parsePerpCtxs(wrapped.raw);
  logger.info("assetCtxs.perp", {
    context: { universe: value[0].universe.length, ctxs: value[1].length },
  });
  return { value, deferred: false };
}

/** Fetch spot metadata + contexts (prediction `#N` ctxs included), through the budget. */
export async function fetchSpotCtxs(params: {
  probe: SpotCtxsProbe;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<SpotCtxsResult> {
  const budget = params.budget ?? weightBudget;
  const at = (params.now ?? Date.now)();

  const wrapped = await budget.tryRun(
    "spotMetaAndAssetCtxs",
    async () => ({ raw: await params.probe.spotMetaAndAssetCtxs() }),
    { now: () => at }
  );
  if (wrapped === null) return { value: null, deferred: true };

  const value = parseSpotCtxs(wrapped.raw);
  logger.info("assetCtxs.spot", {
    context: { universe: value[0].universe.length, ctxs: value[1].length },
  });
  return { value, deferred: false };
}
