/**
 * A catalog that keeps itself current.
 *
 * `outcomeMeta` is a snapshot, and the thing it describes moves while a session
 * is open. Measured directly: `settledOutcome(1009)` answered `null` at 05:22 and
 * returned a full spec at 10:15 — the market settled between two probes of this
 * project's own. A client holding the 05:22 snapshot would still be showing that
 * market as tradeable, still quoting merges against it, and would learn nothing
 * until it refetched.
 *
 * So the snapshot is seeded once and then **maintained from
 * `outcomeMetaUpdates`**, the websocket channel whose events are exactly the four
 * transitions that invalidate it:
 *
 * | Event             | What it means here                                    |
 * | ----------------- | ----------------------------------------------------- |
 * | `outcomeCreated`  | a new tradeable market; add it                        |
 * | `outcomeSettled`  | it resolved; **remove it**, matching `outcomeMeta`     |
 * | `questionUpdated` | the outcome set changed; replace the question         |
 * | `questionSettled` | the question resolved; remove it                      |
 *
 * Removing on settle rather than flagging is deliberate, because it is what the
 * REST endpoint itself does: `outcomeMeta` lists only unsettled outcomes, and a
 * store that kept settled rows would diverge from a refetch. A client that needs
 * a settled market reads `settledOutcome` — the second, disjoint source.
 *
 * **A settle is the one event a position holder must not miss.** It is the moment
 * their shares stop being tradeable and become a claim, so the store reports
 * settlements rather than only absorbing them.
 *
 * The feed carries **no `venue`**, which `outcomeMeta` does carry on 185 of 309
 * outcomes and which is the only route to deployer attribution. So a
 * socket-created outcome has `venue: null` where a refetched one might not — the
 * store cannot invent it, and a caller that needs deployers must refetch rather
 * than assume the live catalog is complete in that field.
 *
 * ## Keep a refetch backstop
 *
 * **The frame shape below is the SDK's declaration, not a measurement.** The
 * subscription itself is verified live — accepted and cleanly torn down on both
 * networks — but the channel only speaks when a market is created or settles, and
 * 75 seconds of listening on each network produced **zero frames**. Mainnet's one
 * recurring market settles daily at 06:00 UTC, so there was nothing to catch.
 *
 * {@link PredictionCatalogStore.apply} is written to degrade rather than corrupt:
 * a frame it does not recognise changes nothing and returns `false`. But the
 * failure that leaves is a store that quietly stops updating — the exact staleness
 * it exists to prevent. So a caller must **not** treat this as a replacement for
 * refetching: poll {@link PredictionCatalogStore.lastSeededAt} and re-seed on a
 * TTL, and read {@link PredictionCatalogStore.applied} to see whether the socket
 * is contributing anything at all.
 */

import { log } from "@/hyperliquid/core/logger";
import { parseOutcome, parseCatalog } from "@/hyperliquid/predictions/catalog";
import type { PredictionCatalog, PredictionQuestion } from "@/hyperliquid/predictions/types";

const logger = log.child("predictions.catalogStore");

const EMPTY: PredictionCatalog = { outcomes: [], questions: [], deployers: [] };

/** A market that resolved while the store was open. */
export interface SettlementNotice {
  kind: "outcome" | "question";
  id: number;
  at: number;
}

type Listener = () => void;

export class PredictionCatalogStore {
  private catalog: PredictionCatalog | null = null;
  private seededAt: number | null = null;
  private readonly settlements: SettlementNotice[] = [];
  private readonly listeners = new Set<Listener>();
  private appliedCount = 0;

  /**
   * Install the REST snapshot.
   *
   * Separate from construction because the fetch can be refused by the weight
   * budget, and `null` there must stay distinguishable from an empty catalog —
   * "we have not looked" is not "there are no markets".
   */
  seed(catalog: PredictionCatalog, now: number = Date.now()): void {
    this.catalog = catalog;
    this.seededAt = now;
    this.emit();
  }

  /** The catalog, or `null` before it has been seeded. */
  read(): PredictionCatalog | null {
    return this.catalog;
  }

  /** The catalog, or an empty one — for callers that treat "unknown" as "none". */
  readOrEmpty(): PredictionCatalog {
    return this.catalog ?? EMPTY;
  }

  hasSeeded(): boolean {
    return this.catalog !== null;
  }

  /** When the snapshot was installed, for a staleness decision the caller owns. */
  lastSeededAt(): number | null {
    return this.seededAt;
  }

  /** Markets that settled while this store was open, oldest first. */
  recentSettlements(): readonly SettlementNotice[] {
    return this.settlements;
  }

  /** Forget the settlement log once a caller has shown it. */
  acknowledgeSettlements(): void {
    this.settlements.length = 0;
  }

  /** How many update events have been absorbed — a health signal, not state. */
  get applied(): number {
    return this.appliedCount;
  }

  /**
   * Absorb one `outcomeMetaUpdates` event.
   *
   * A no-op before seeding: applying deltas to nothing would build a catalog that
   * contains only what happened to change since the socket opened, and present it
   * as the whole market list.
   *
   * @returns whether anything changed.
   */
  apply(event: unknown, now: number = Date.now()): boolean {
    if (!this.catalog) return false;
    const updates = (event as { updates?: unknown })?.updates;
    if (!Array.isArray(updates)) return false;

    let outcomes = [...this.catalog.outcomes];
    let questions = [...this.catalog.questions];
    let changed = false;

    for (const update of updates) {
      if (typeof update !== "object" || update === null) continue;
      const row = update as Record<string, unknown>;
      this.appliedCount += 1;

      if (row.outcomeCreated) {
        const parsed = parseOutcome(row.outcomeCreated);
        if (!parsed) continue;
        outcomes = [...outcomes.filter((o) => o.outcomeId !== parsed.outcomeId), parsed];
        changed = true;
        continue;
      }

      if (row.outcomeSettled) {
        const id = idOf(row.outcomeSettled, "outcome");
        if (id === null) continue;
        const before = outcomes.length;
        outcomes = outcomes.filter((o) => o.outcomeId !== id);
        // Recorded even when the outcome was not in the catalog: a holder can own
        // a market this snapshot never listed, and the settlement is exactly what
        // turns their shares into a claim.
        this.settlements.push({ kind: "outcome", id, at: now });
        changed = changed || outcomes.length !== before;
        logger.info("catalog.outcome_settled", { context: { outcome: id } });
        continue;
      }

      if (row.questionUpdated) {
        const parsed = parseCatalog({ outcomes: [], questions: [row.questionUpdated] });
        const [question] = parsed.questions;
        if (!question) continue;
        questions = [...questions.filter((q) => q.questionId !== question.questionId), question];
        changed = true;
        continue;
      }

      if (row.questionSettled) {
        const id = idOf(row.questionSettled, "question");
        if (id === null) continue;
        const before = questions.length;
        questions = questions.filter((q) => q.questionId !== id);
        this.settlements.push({ kind: "question", id, at: now });
        changed = changed || questions.length !== before;
        logger.info("catalog.question_settled", { context: { question: id } });
      }
    }

    if (!changed) return false;
    this.catalog = { ...this.catalog, outcomes, questions };
    this.emit();
    return true;
  }

  clear(): void {
    this.catalog = null;
    this.seededAt = null;
    this.settlements.length = 0;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        logger.warn("catalog.listener_failed", { error });
      }
    }
  }
}

/** Read an id that the wire spells as a number or a numeric string. */
function idOf(payload: unknown, key: string): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** Whether a question mentions an outcome — used to find what a settlement affects. */
export function questionsMentioning(
  catalog: PredictionCatalog,
  outcomeId: number
): PredictionQuestion[] {
  return catalog.questions.filter(
    (q) =>
      q.fallbackOutcomeId === outcomeId ||
      q.namedOutcomeIds.includes(outcomeId) ||
      q.settledNamedOutcomeIds.includes(outcomeId)
  );
}
