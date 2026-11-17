// workspace-scoped (POD-6959)
/**
 * WHAT EACH TRANSCRIPT COST, AND WHOSE IT WAS (POD-1858).
 *
 * The durable half of the usage harvest. The daemon's hour×model buckets answer
 * "what did this host spend this week"; these rows answer "what did this task
 * cost", for a task that closed months ago and whose week is long gone.
 *
 * NO DOLLARS IN THIS FILE. `models_json` is tokens by model, and the one price
 * table lives in `client-core/values/usage.ts` — see `entities/cost.ts` for
 * why there must never be a second one.
 *
 * WRITES ARE IDEMPOTENT UPSERTS, NOT ACCUMULATIONS. The daemon reports absolute
 * per-file totals for the WHOLE file, so re-ingesting a transcript replaces its
 * row. That is what makes the incremental cursor an optimisation rather than a
 * correctness dependency: a daemon that restarts and re-reads a file from byte
 * zero writes exactly the row it wrote before.
 */

import type { CostHarness, CostModelTotalWire, IssueId, MachineId, SessionId } from '@podium/model'
import { foldModelTotals } from '@podium/model'
import { and, count, eq, gt, isNotNull, isNull, max, sql, sum } from 'drizzle-orm'
import type { transcriptCosts } from '../migrations/schema'
import { dialectOf } from './executor/dialect-prepared'
import type { TransactionRunner, WorkspaceDb, WorkspaceQueries } from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  prepared,
  preparedFamily,
  sameWorkspace,
  WORKSPACE,
} from './executor/sync-drizzle'

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

// Every query this repository runs, prepared once per store [POD-6147].

const recordCost = prepared((db, t) =>
  db
    .insert(t.transcriptCosts)
    .values({
      workspaceId: WORKSPACE,
      machineId: sql.placeholder('machineId'),
      nativeId: sql.placeholder('nativeId'),
      path: sql.placeholder('path'),
      harness: sql.placeholder('harness'),
      sessionId: sql.placeholder('sessionId'),
      issueId: sql.placeholder('issueId'),
      scannedBytes: sql.placeholder('scannedBytes'),
      firstTsMs: sql.placeholder('firstTsMs'),
      lastTsMs: sql.placeholder('lastTsMs'),
      messages: sql.placeholder('messages'),
      modelsJson: sql.placeholder('modelsJson'),
      windowModelsJson: sql.placeholder('windowModelsJson'),
      windowSinceMs: sql.placeholder('windowSinceMs'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: [
        t.transcriptCosts.workspaceId,
        t.transcriptCosts.machineId,
        t.transcriptCosts.nativeId,
      ],
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
        sessionId: sql`COALESCE(excluded.session_id, ${t.transcriptCosts.sessionId})`,
        issueId: sql`COALESCE(excluded.issue_id, ${t.transcriptCosts.issueId})`,
        // The larger of the two: SQLite's scalar MAX(a, b) is GREATEST(a, b) on
        // Postgres. The column is not null, so the two agree on every value.
        scannedBytes:
          dialectOf(db) === 'pg'
            ? sql`GREATEST(${t.transcriptCosts.scannedBytes}, excluded.scanned_bytes)`
            : sql`MAX(${t.transcriptCosts.scannedBytes}, excluded.scanned_bytes)`,
        firstTsMs: sql`excluded.first_ts_ms`,
        lastTsMs: sql`excluded.last_ts_ms`,
        messages: sql`excluded.messages`,
        modelsJson: sql`excluded.models_json`,
        windowModelsJson: sql`excluded.window_models_json`,
        windowSinceMs: sql`excluded.window_since_ms`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .prepare(),
)

const costsOfIssues = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.transcriptCosts)
    .where(inWorkspace(t.transcriptCosts, inListOf(t.transcriptCosts.issueId, size)))
    .prepare(),
)

const attributedCosts = prepared((db, t) =>
  db
    .select()
    .from(t.transcriptCosts)
    .where(inWorkspace(t.transcriptCosts, isNotNull(t.transcriptCosts.issueId)))
    .prepare(),
)

const ownCohortFolds = prepared((db, t) =>
  db
    // One JSON array of each row's models text. Postgres stores the column as `json`,
    // so it aggregates the text (`::text`) to give the same array of strings; its
    // spacing differs from SQLite's, and the reader parses it before use.
    .select({
      folds:
        dialectOf(db) === 'pg'
          ? sql<string>`json_agg(${t.transcriptCosts.modelsJson}::text)::text`
          : sql<string>`json_group_array(${t.transcriptCosts.modelsJson})`,
    })
    .from(t.transcriptCosts)
    .innerJoin(
      t.issues,
      and(sameWorkspace(t.issues, t.transcriptCosts), eq(t.issues.id, t.transcriptCosts.issueId)),
    )
    .where(inWorkspace(t.transcriptCosts, isNull(t.issues.deletedAt)))
    .groupBy(t.transcriptCosts.issueId)
    .having(gt(sum(t.transcriptCosts.messages), sql.placeholder('minReplies')))
    .prepare(),
)

const costedSessions = prepared((db, t) =>
  db
    .selectDistinct({ sessionId: t.transcriptCosts.sessionId })
    .from(t.transcriptCosts)
    .where(
      inWorkspace(
        t.transcriptCosts,
        isNotNull(t.transcriptCosts.sessionId),
        gt(t.transcriptCosts.messages, 0),
      ),
    )
    .prepare(),
)

const latestWindow = prepared((db, t) =>
  db
    .select({ m: max(t.transcriptCosts.windowSinceMs) })
    .from(t.transcriptCosts)
    .where(inWorkspace(t.transcriptCosts))
    .prepare(),
)

const costCount = prepared((db, t) =>
  db.select({ n: count() }).from(t.transcriptCosts).where(inWorkspace(t.transcriptCosts)).prepare(),
)

export class TranscriptCostsRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query capability, INJECTED rather than reached for [spec rule 27b], and
   * read through a getter rather than frozen into a field [rule 34a]. Ambient
   * transaction routing (rule 35) has to resolve the ENCLOSING transaction on
   * every access, which a field assigned once in a constructor can never do — so
   * B1 changes the one line inside this getter and no call site below it.
   */
  private get db(): WorkspaceDb {
    return this.scope
  }

  /**
   * Bank one harvest. Transactional over the whole batch: a walk is one
   * observation of the disk, and half of it landing would leave the sheet's
   * total disagreeing with its own by-task breakdown.
   */
  async record(records: TranscriptCostRecord[], nowIso: string): Promise<void> {
    if (records.length === 0) return
    await this.createOrJoinTransaction(async () => {
      for (const r of records) {
        await recordCost(this.db).run({
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
      }
    })
  }

  /** Every transcript attributed to one of these issues. */
  async forIssues(issueIds: readonly IssueId[]): Promise<TranscriptCost[]> {
    if (issueIds.length === 0) return []
    const size = inListSize(issueIds.length)
    return (await costsOfIssues(this.db, size).all(inListValues(issueIds, size))).map(toCost)
  }

  /** Every transcript that resolved to a task, for the sheet's ranked table. */
  async allAttributed(): Promise<TranscriptCost[]> {
    return (await attributedCosts(this.db).all()).map(toCost)
  }

  /** Only all-time OWN model folds for qualifying, surviving issues. One
   * grouped SQL read; no issue bodies, window folds, sessions or rollups. */
  async ownCohortTotals(minReplies: number): Promise<CostModelTotalWire[][]> {
    const rows = await ownCohortFolds(this.db).all({ minReplies })
    return rows.map((row) => foldModelTotals((JSON.parse(row.folds) as string[]).map(parseModels)))
  }

  /** Which sessions already have a fold — the `pending` state's other half. */
  async costedSessionIds(): Promise<Set<string>> {
    const rows = await costedSessions(this.db).all()
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
  async latestWindowSinceMs(): Promise<number> {
    const row = await latestWindow(this.db).get()
    return row?.m ?? 0
  }

  async countAll(): Promise<number> {
    const row = await costCount(this.db).get()
    return row?.n ?? 0
  }
}
