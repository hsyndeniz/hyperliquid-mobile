/**
 * The prediction catalog, as a screen needs it.
 *
 * A prediction holding arrives as a spot balance whose coin is `+102251` — an
 * encoding, not a name. `102251` is `outcomeId * 10 + sideIndex`, so outcome
 * 10225 side 1, and only the catalog knows that is *"June Fed rate change"* and
 * that side 1 is *"No Change"*. Without this join the portfolio shows a user a
 * raw wire id where the thing they bet on should be.
 *
 * The catalog is fetched once and cached in a module-level store rather than
 * per screen: it is the same for every account (it is the exchange's own market
 * list, not a user's), it costs 20 weight, and several screens will want it.
 *
 * **Names are `null`, never a fallback string.** A settled outcome drops out of
 * `outcomeMeta` entirely — that is documented behaviour, not an error — so a
 * holding can legitimately have no name, and inventing one ("Unknown market")
 * would present a guess as knowledge. The caller renders the encoding, which is
 * at least true.
 */

import { useCallback, useEffect } from "react";

import { getInfoClient } from "@/hyperliquid/api/clients";
import { decomposeAssetId } from "@/hyperliquid/core/assetIds";
import { log } from "@/hyperliquid/core/logger";
import { useStoreValue } from "@/hyperliquid/hooks/useStore";
import { fetchCatalog, type OutcomeMetaProbe } from "@/hyperliquid/predictions/catalog";
import { PredictionCatalogStore } from "@/hyperliquid/predictions/catalogStore";
import type { PredictionOutcome } from "@/hyperliquid/predictions/types";

const logger = log.child("hooks.predictions");

/** Shared across screens — the catalog is the exchange's, not an account's. */
export const predictionCatalog = new PredictionCatalogStore();

/** Guards against several screens fetching the same catalog at once. */
let inFlight: Promise<void> | null = null;

/**
 * How long an in-flight catalog read keeps later callers coalescing into it.
 *
 * React Native's fetch has no reliable timeout on Hermes, so a request that
 * stalls at the socket level never settles — and a never-settling promise
 * latched in `inFlight` made every retry coalesce into it forever: zero
 * network traffic, zero logs, predictions stuck on skeletons until an app
 * restart (observed live, diagnosed by hooking global fetch — the retries
 * fired but no `outcomeMeta` request ever left the app). After this long,
 * the latch opens and the NEXT caller starts a fresh request; the stalled
 * one, if it ever resolves, still seeds harmlessly.
 */
const CATALOG_STALL_UNLATCH_MS = 15_000;

/** Identity of the CURRENT attempt — lets the unlatch target only its own. */
let inFlightToken: object | null = null;

async function ensureCatalog(): Promise<void> {
  if (predictionCatalog.hasSeeded()) return;
  if (inFlight === null) {
    const token = {};
    inFlightToken = token;
    inFlight = (async () => {
      try {
        const result = await fetchCatalog({
          probe: getInfoClient() as unknown as OutcomeMetaProbe,
        });
        // Deferred by the weight budget is not a failure — the next caller
        // retries, and until then a holding renders its encoding.
        if (result.value) predictionCatalog.seed(result.value);
      } catch (error) {
        logger.warn("predictions.catalog_unavailable", { error });
      } finally {
        if (inFlightToken === token) {
          inFlight = null;
          inFlightToken = null;
        }
      }
    })();
    setTimeout(() => {
      if (inFlightToken === token) {
        logger.warn("predictions.catalog_stalled", {
          context: { afterMs: CATALOG_STALL_UNLATCH_MS },
        });
        inFlight = null;
        inFlightToken = null;
      }
    }, CATALOG_STALL_UNLATCH_MS);
  }
  return inFlight;
}

/** What a balance coin names, when the catalog knows. */
export interface NamedOutcome {
  outcome: PredictionOutcome;
  /** e.g. `"No Change"`. `null` when the side index is not in the catalog. */
  sideName: string | null;
}

/**
 * Resolve an outcome coin against the catalog.
 *
 * Accepts **both live spellings of the same market side**: `+102251` on a spot
 * balance and `#102251` on a fill, an order or a book. They carry the identical
 * encoding and differ only in sigil, so accepting one would have named a
 * holding while leaving the fill that created it showing a raw id — measured on
 * this project's own test account, where the outcome fill arrives as `#102251`.
 *
 * `oN` is deliberately NOT accepted: on a settled share `N` is the outcome id
 * itself, not `outcomeId * 10 + sideIndex`, so decoding it the same way would
 * name the wrong market entirely.
 *
 * Exported for tests: the arithmetic is the same encoding `core/assetIds` owns,
 * and getting it wrong labels a holding with someone else's market.
 */
export function namedOutcomeFor(
  balanceCoin: string,
  catalog: { outcomes: readonly PredictionOutcome[] } | null
): NamedOutcome | null {
  if (catalog === null) return null;
  const match = /^[+#](\d+)$/.exec(balanceCoin);
  if (!match) return null;

  // Through `decomposeAssetId` rather than by hand: the encoding lives in
  // `core/assetIds` and must not be re-derived at a call site.
  const decoded = decomposeAssetId(100_000_000 + Number(match[1]));
  if (decoded.kind !== "outcome") return null;

  const outcome = catalog.outcomes.find((entry) => entry.outcomeId === decoded.outcomeId);
  if (!outcome) return null;

  const side = outcome.sides.find((entry) => entry.sideIndex === decoded.sideIndex);
  return { outcome, sideName: side?.name ?? null };
}

/** While unseeded, how often a mounted consumer re-asks for the catalog. */
const CATALOG_RETRY_INTERVAL_MS = 20_000;

/**
 * The catalog, fetched on first use.
 *
 * Returns `null` until it has loaded, or permanently if it could not be read —
 * both mean "no name available", which the caller must render as the encoding
 * rather than as a placeholder.
 *
 * The read goes through `useStoreValue` (`useSyncExternalStore`), and that is
 * load-bearing, not style: a previous version returned
 * `predictionCatalog.read()` directly from render and nudged re-renders with a
 * subscribe→setState counter. Under React Compiler that read is memoised with
 * an empty dependency set — the store is a module binding, invisible to the
 * compiler's reactivity — so every re-render replayed the first render's
 * `null` and the predictions UI sat on skeletons forever while the store held
 * 358 seeded outcomes (observed live; the seed log and the stuck screen in the
 * same session). `useSyncExternalStore` is the escape hatch the compiler
 * honours: its snapshot is re-read on store emit, not cached from render one.
 */
export function usePredictionCatalog(): { outcomes: readonly PredictionOutcome[] } | null {
  useEffect(() => {
    // Deferred a tick so mount work never lands synchronously in the effect.
    const timer = setTimeout(() => void ensureCatalog(), 0);
    // `ensureCatalog` retries "on the next call" — but on a permanently
    // mounted tab (NativeTabs keeps screens alive) there IS no next call, so
    // one deferred or failed first read stalled the predictions section until
    // an app restart (observed live). While unseeded, keep asking on a gentle
    // cadence; the interval dies the moment the catalog lands.
    const retry = setInterval(() => {
      if (predictionCatalog.hasSeeded()) {
        clearInterval(retry);
        return;
      }
      void ensureCatalog();
    }, CATALOG_RETRY_INTERVAL_MS);
    return () => {
      clearTimeout(timer);
      clearInterval(retry);
    };
  }, []);

  return useStoreValue(predictionCatalog, (store) => store.read());
}

/** A namer for balance coins, stable across renders. */
export function useOutcomeNamer(): (balanceCoin: string) => NamedOutcome | null {
  const catalog = usePredictionCatalog();
  return useCallback((balanceCoin: string) => namedOutcomeFor(balanceCoin, catalog), [catalog]);
}
