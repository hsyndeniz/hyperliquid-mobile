/**
 * The account's whole fill history, paged out of `userFillsByTime`.
 *
 * The live fills store cannot answer "all time": it holds what the websocket
 * pushed plus a REST seed, and the Activity card had to caption itself
 * "over N fills" because of it. This walks `userFillsByTime` forward from
 * epoch until a page comes back short, which is the endpoint's only
 * end-of-history signal.
 *
 * ## The boundary row problem
 *
 * Pages are advanced with `startTime = lastRowTime`, NOT `lastRowTime + 1`:
 * two fills can share a millisecond, and `+1` silently loses the second one
 * at every page boundary. The re-fetched boundary row is dropped through
 * `Fill.key` (`oid:tid` — measured collision-free across 113,984 rows).
 *
 * ## `complete` is a claim, so it is tracked honestly
 *
 * A page refused by the weight budget or a walk that hits the page cap ends
 * the result with `complete: false`. Rendering a partial walk as "all
 * history" would be the exact captioning lie this module exists to remove.
 */

import { weightBudget, type WeightBudget } from "@/hyperliquid/api/weightBudget";
import { log } from "@/hyperliquid/core/logger";
import { parseFills } from "@/hyperliquid/state/accountWire";
import type { Fill } from "@/hyperliquid/types/domain";

const logger = log.child("history.fills");

export interface FillHistoryProbe {
  userFillsByTime(params: { user: string; startTime: number }): Promise<unknown>;
}

/**
 * The server caps a `userFillsByTime` response at 2,000 rows; a full page
 * therefore means "there may be more", and a short one means the walk is done.
 */
const PAGE_CAP = 2000;

/**
 * Walk guard, not a truncation policy: 20 pages is 40,000 fills. An account
 * beyond it gets `complete: false` and a disclosed partial rather than an
 * unbounded loop against a rate-limited endpoint.
 */
const MAX_PAGES = 20;

export interface FillHistory {
  /** Oldest first, as the endpoint returns them. */
  fills: readonly Fill[];
  /** False when a page was refused or the walk hit its guard. Disclose it. */
  complete: boolean;
}

/** Fetch every fill the endpoint will give, through the weight budget per page. */
export async function fetchFillHistory(params: {
  probe: FillHistoryProbe;
  user: string;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<FillHistory> {
  const budget = params.budget ?? weightBudget;
  // Fresh per page, unlike the single-shot fetchers: a 20-page walk can span
  // enough real time that a frozen clock would misprice the later pages.
  const now = params.now ?? Date.now;

  const fills: Fill[] = [];
  const seen = new Set<string>();
  let startTime = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const wrapped = await budget.tryRun(
      "userFillsByTime",
      async () => ({ raw: await params.probe.userFillsByTime({ user: params.user, startTime }) }),
      { now }
    );
    if (wrapped === null) {
      // The budget declined mid-walk. What was collected is real — return it
      // as a disclosed partial instead of throwing it away.
      logger.info("fills.walk_deferred", { context: { pages: page, count: fills.length } });
      return { fills, complete: false };
    }

    const rows = parseFills(wrapped.raw);
    for (const fill of rows) {
      // The boundary row re-fetches by design (see header); `key` drops it.
      if (seen.has(fill.key)) continue;
      seen.add(fill.key);
      fills.push(fill);
    }

    if (rows.length < PAGE_CAP) {
      logger.info("fills.walk_complete", { context: { pages: page + 1, count: fills.length } });
      return { fills, complete: true };
    }
    const last = rows.at(-1);
    if (last === undefined) return { fills, complete: true };
    startTime = last.time;
  }

  logger.warn("fills.walk_capped", { context: { pages: MAX_PAGES, count: fills.length } });
  return { fills, complete: false };
}
