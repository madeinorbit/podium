/**
 * WHAT EACH TRANSCRIPT COST, AND WHOSE IT WAS (POD-1858).
 *
 * The durable half of the usage harvest. The daemon's hour×model buckets answer
 * "what did this host spend this week"; these rows answer "what did this task
 * cost", for a task that closed months ago and whose week is long gone.
 *
 * NO DOLLARS IN THIS FILE. `models_json` is tokens by model, and the one price
 * table lives in `client-core/viewmodels/usage.ts` — see `entities/cost.ts` for
 * why there must never be a second one.
 *
 * WRITES ARE IDEMPOTENT UPSERTS, NOT ACCUMULATIONS. The daemon reports absolute
 * per-file totals for the WHOLE file, so re-ingesting a transcript replaces its
 * row. That is what makes the incremental cursor an optimisation rather than a
 * correctness dependency: a daemon that restarts and re-reads a file from byte
 * zero writes exactly the row it wrote before.
 */

import type { CostHarness, CostModelTotalWire, IssueId, MachineId, SessionId } from '@podium/model'
import { and, count, gt, inArray, isNotNull, max, sql } from 'drizzle-orm'
import { transcriptCosts } from '../migrations/schema'
import type { QueryClient, StoreExecutor } from './executor'
import type { SyncDrizzle, SyncSpans } from './executor/sync-drizzle'

/** One transcript's fold, as the ingest hands it over. */
export interface TranscriptCostRecord {
  machineId: MachineId
  nativeId: string
  path: string
  harness: CostHarness
  sessionId: SessionId | null
  issueId: IssueId | null
  scannedBytes: number
  firstTsMs: number
  lastTsMs: number
  /** The whole file, folded by model. */
  models: CostModelTotalWire[]
  /** The same fold restricted to the harvest's window. */
  windowModels: CostModelTotalWire[]
  /** The window those `windowModels` were taken over. */
  windowSinceMs: number
}

/** One transcript's fold, as a reader gets it back. */
export interface TranscriptCost extends TranscriptCostRecord {
  messages: number
  /** When the harvest last wrote this row — the figure's read time. */
  updatedAt: string
}

/** One stored row, as drizzle hands it back: the schema's TypeScript names and
 *  its `$type` brands, so nothing here re-enters an id space by hand. */
type Row = typeof transcriptCosts.$inferSelect

/**
 * A stored fold that will not parse is worth exactly one transcript's figure, so
 * it reads as an empty fold rather than taking the whole task's cost down with
 * it. The row is still counted as a transcript we have read — which is true.
 */
function parseModels(json: string): CostModelTotalWire[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((m): m is CostModelTotalWire => {
      if (typeof m !== 'object' || m === null) return false
      const rec = m as Record<string, unknown>
      return typeof rec.model === 'string' && typeof rec.inputTokens === 'number'
    })
  } catch {
    return []
  }
}

/**
 * The two folds are the only mapping left. Every other column arrives already
 * named and already branded, so the lines that used to re-enter the id spaces
 * by cast are gone; these two are a DECISION — the quarantine above — and stay.
 */
const toCost = (row: Row): TranscriptCost => ({
  machineId: row.machineId,
  nativeId: row.nativeId,
  path: row.path,
  harness: row.harness as CostHarness,
  sessionId: row.sessionId,
  issueId: row.issueId,
  scannedBytes: row.scannedBytes,
  firstTsMs: row.firstTsMs,
  lastTsMs: row.lastTsMs,
  messages: row.messages,
  models: parseModels(row.modelsJson),
  windowModels: parseModels(row.windowModelsJson),
  windowSinceMs: row.windowSinceMs,
  updatedAt: row.updatedAt,
})

export class TranscriptCostsRepository {
  private readonly db: SyncDrizzle
  private readonly spans: SyncSpans

  constructor(executor: StoreExecutor<QueryClient>) {
    // Stage A's synchronous seam, asserted HERE so a store built over a non-bun
    // handle names the repository that needed it [spec rule 27a].
    if (!executor.stageA) {
      throw new Error("TranscriptCostsRepository needs the executor's Stage A drizzle instance")
    }
    this.db = executor.stageA.db
    this.spans = executor.stageA.spans
  }

  /**
   * Bank one harvest. Transactional over the whole batch: a walk is one
   * observation of the disk, and half of it landing would leave the sheet's
   * total disagreeing with its own by-task breakdown.
   */
  record(records: TranscriptCostRecord[], nowIso: string): void {
    if (records.length === 0) return
    this.spans.transact(() => {
      for (const r of records) {
        this.db
          .insert(transcriptCosts)
          .values({
            machineId: r.machineId,
            nativeId: r.nativeId,
            path: r.path,
            harness: r.harness,
            sessionId: r.sessionId,
            issueId: r.issueId,
            scannedBytes: r.scannedBytes,
            firstTsMs: r.firstTsMs,
            lastTsMs: r.lastTsMs,
            messages: r.models.reduce((n, m) => n + m.messages, 0),
            modelsJson: JSON.stringify(r.models),
            windowModelsJson: JSON.stringify(r.windowModels),
            windowSinceMs: r.windowSinceMs,
            updatedAt: nowIso,
          })
          .onConflictDoUpdate({
            target: [transcriptCosts.machineId, transcriptCosts.nativeId],
            set: {
              path: sql`excluded.path`,
              harness: sql`excluded.harness`,
              // COALESCE, NEVER A PLAIN OVERWRITE. A later harvest re-resolves the
              // owner from live rows, and that lookup skips tombstones -- so a
              // session soft-deleted while its transcript is still inside the mtime
              // window resolves to nothing, and a plain assignment would write NULL
              // over an attribution this table exists to keep. Every other column is
              // a re-measurement and may be overwritten; these two are history.
              //
              // COALESCE PROTECTS, IT CANNOT REPAIR. Any attribution a pre-fix build
              // already nulled stays nulled forever, and invisibly: the owner lookup
              // skips tombstones, so it will never resolve that session again and no
              // later harvest can put the id back. A task missing spend it once had
              // is the shape to look for; the row is still there, with session_id and
              // issue_id NULL and its token totals intact.
              sessionId: sql`COALESCE(excluded.session_id, ${transcriptCosts.sessionId})`,
              issueId: sql`COALESCE(excluded.issue_id, ${transcriptCosts.issueId})`,
              scannedBytes: sql`MAX(${transcriptCosts.scannedBytes}, excluded.scanned_bytes)`,
              firstTsMs: sql`excluded.first_ts_ms`,
              lastTsMs: sql`excluded.last_ts_ms`,
              messages: sql`excluded.messages`,
              modelsJson: sql`excluded.models_json`,
              windowModelsJson: sql`excluded.window_models_json`,
              windowSinceMs: sql`excluded.window_since_ms`,
              updatedAt: sql`excluded.updated_at`,
            },
          })
          .run()
      }
    })
  }

  /** Every transcript attributed to one of these issues. */
  forIssues(issueIds: readonly IssueId[]): TranscriptCost[] {
    if (issueIds.length === 0) return []
    return this.db
      .select()
      .from(transcriptCosts)
      .where(inArray(transcriptCosts.issueId, issueIds))
      .all()
      .map(toCost)
  }

  /** Every transcript that resolved to a task, for the sheet's ranked table. */
  allAttributed(): TranscriptCost[] {
    return this.db
      .select()
      .from(transcriptCosts)
      .where(isNotNull(transcriptCosts.issueId))
      .all()
      .map(toCost)
  }

  /** Which sessions already have a fold — the `pending` state's other half. */
  costedSessionIds(): Set<string> {
    const rows = this.db
      .selectDistinct({ sessionId: transcriptCosts.sessionId })
      .from(transcriptCosts)
      .where(and(isNotNull(transcriptCosts.sessionId), gt(transcriptCosts.messages, 0)))
      .all()
    return new Set(rows.flatMap((r) => (r.sessionId === null ? [] : [r.sessionId])))
  }

  /**
   * The newest window any row was written for.
   *
   * A row from an older harvest is a file the latest walk skipped on mtime,
   * which means it has NO activity in the current window — so its stored window
   * fold has to read as zero rather than as last week's number. Comparing
   * against this is how a reader tells the two apart without a second write.
   */
  latestWindowSinceMs(): number {
    const row = this.db
      .select({ m: max(transcriptCosts.windowSinceMs) })
      .from(transcriptCosts)
      .get()
    return row?.m ?? 0
  }

  countAll(): number {
    const row = this.db.select({ n: count() }).from(transcriptCosts).get()
    return row?.n ?? 0
  }
}
