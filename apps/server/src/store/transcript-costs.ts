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
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { transaction } from '@podium/runtime/sqlite'

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

interface Row {
  machine_id: string
  native_id: string
  path: string
  harness: string
  session_id: string | null
  issue_id: string | null
  scanned_bytes: number
  first_ts_ms: number
  last_ts_ms: number
  messages: number
  models_json: string
  window_models_json: string
  window_since_ms: number
  updated_at: string
}

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

const toCost = (row: Row): TranscriptCost => ({
  machineId: row.machine_id as MachineId,
  nativeId: row.native_id,
  path: row.path,
  harness: row.harness as CostHarness,
  sessionId: (row.session_id as SessionId | null) ?? null,
  issueId: (row.issue_id as IssueId | null) ?? null,
  scannedBytes: row.scanned_bytes,
  firstTsMs: row.first_ts_ms,
  lastTsMs: row.last_ts_ms,
  messages: row.messages,
  models: parseModels(row.models_json),
  windowModels: parseModels(row.window_models_json),
  windowSinceMs: row.window_since_ms,
  updatedAt: row.updated_at,
})

export class TranscriptCostsRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Bank one harvest. Transactional over the whole batch: a walk is one
   * observation of the disk, and half of it landing would leave the sheet's
   * total disagreeing with its own by-task breakdown.
   */
  record(records: TranscriptCostRecord[], nowIso: string): void {
    if (records.length === 0) return
    const stmt = this.db.prepare(
      `INSERT INTO transcript_costs
         (machine_id, native_id, path, harness, session_id, issue_id, scanned_bytes,
          first_ts_ms, last_ts_ms, messages, models_json, window_models_json,
          window_since_ms, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(machine_id, native_id) DO UPDATE SET
         path = excluded.path,
         harness = excluded.harness,
         session_id = excluded.session_id,
         issue_id = excluded.issue_id,
         scanned_bytes = MAX(transcript_costs.scanned_bytes, excluded.scanned_bytes),
         first_ts_ms = excluded.first_ts_ms,
         last_ts_ms = excluded.last_ts_ms,
         messages = excluded.messages,
         models_json = excluded.models_json,
         window_models_json = excluded.window_models_json,
         window_since_ms = excluded.window_since_ms,
         updated_at = excluded.updated_at`,
    )
    transaction(this.db, () => {
      for (const r of records) {
        stmt.run(
          r.machineId,
          r.nativeId,
          r.path,
          r.harness,
          r.sessionId,
          r.issueId,
          r.scannedBytes,
          r.firstTsMs,
          r.lastTsMs,
          r.models.reduce((n, m) => n + m.messages, 0),
          JSON.stringify(r.models),
          JSON.stringify(r.windowModels),
          r.windowSinceMs,
          nowIso,
        )
      }
    })
  }

  /** Every transcript attributed to one of these issues. */
  forIssues(issueIds: readonly IssueId[]): TranscriptCost[] {
    if (issueIds.length === 0) return []
    const placeholders = issueIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT * FROM transcript_costs WHERE issue_id IN (${placeholders})`)
      .all(...issueIds) as Row[]
    return rows.map(toCost)
  }

  /** Every transcript that resolved to a task, for the sheet's ranked table. */
  allAttributed(): TranscriptCost[] {
    const rows = this.db
      .prepare(`SELECT * FROM transcript_costs WHERE issue_id IS NOT NULL`)
      .all() as Row[]
    return rows.map(toCost)
  }

  /** Which sessions already have a fold — the `pending` state's other half. */
  costedSessionIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT session_id FROM transcript_costs
         WHERE session_id IS NOT NULL AND messages > 0`,
      )
      .all() as { session_id: string }[]
    return new Set(rows.map((r) => r.session_id))
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
    const row = this.db.prepare(`SELECT MAX(window_since_ms) AS m FROM transcript_costs`).get() as {
      m: number | null
    }
    return row.m ?? 0
  }

  countAll(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM transcript_costs`).get() as { n: number }
    return row.n
  }
}
