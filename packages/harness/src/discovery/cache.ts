import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateDir } from '@podium/runtime/config'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import type { AgentConversationSummary, AgentKind, ConversationFileStat } from './types.js'

// Bump whenever summary DERIVATION changes, not just the row shape — cached
// summaries outlive the code that wrote them. v2: subagent conversation ids
// switched from the records' (parent) sessionId to the agent-* filename
// (issue #94); v1 caches keep re-poisoning the parent's registry path. v3: files
// that summarize to nothing (guardian rollouts, parse-diagnostic files) are now
// cached as negative rows (POD-624) so their heads aren't re-read every scan; the
// bump discards v2 rows that never carried that distinction.
export const DISCOVERY_CACHE_SCHEMA_VERSION = 3
const DB_SCHEMA_VERSION = '1'

// summary_json for a negative row: a file that was summarized but produced no
// summary. Deliberately NOT valid JSON so an older binary's decodeSummary()
// JSON.parse-fails and treats the row as a miss (re-summarize) rather than
// decoding a bogus summary — negative caching stays safe under a downgrade even
// beyond the schema-version guard.
const NEGATIVE_SUMMARY_SENTINEL = '__negative__'

export function defaultDiscoveryDbPath(): string {
  return join(stateDir(), 'discovery.db')
}

type CacheRow = {
  path: string
  agent_kind: AgentKind
  mtime_ms: number
  size: number
  schema_version: number
  summary_json: string
}

/**
 * Outcome of a {@link ConversationDiscoveryCache.deleteMissing} call.
 *
 * - `skipped` is true when the steady-state short-circuit engaged: the seen-set
 *   and scope were identical to the previous call and no rows were written since,
 *   so no SQL was issued and no rows were touched.
 * - `deleted` is the number of cache rows pruned (always 0 when `skipped`),
 *   including negative rows that carry no conversation id.
 * - `removedIds` are the conversation ids of the pruned rows (always empty when
 *   `skipped`), so callers can emit a removal delta without re-listing the cache.
 *   Negative rows (summarized-to-nothing) prune without contributing an id, so
 *   `removedIds.length` can be less than `deleted`.
 */
export type DeleteMissingResult = {
  skipped: boolean
  deleted: number
  removedIds: string[]
}

/**
 * A fresh cache hit from {@link ConversationDiscoveryCache.getFreshEntry}: either a
 * decoded summary, or a `negative` marker for a file that was summarized to nothing
 * and should not be re-read until it changes.
 */
export type CacheEntry =
  | { kind: 'summary'; summary: AgentConversationSummary }
  | { kind: 'negative' }

export class ConversationDiscoveryCache {
  private readonly db: SqlDatabase
  private readonly schemaVersion: number
  /** Bumped by every write so a no-op `deleteMissing` tick can short-circuit. */
  private writeEpoch = 0
  /** State of the most recent `deleteMissing` call, for the short-circuit. */
  private lastPrune?: {
    writeEpoch: number
    scopeKey: string
    seen: ReadonlySet<string>
  }

  constructor(
    private readonly path: string = defaultDiscoveryDbPath(),
    options: { schemaVersion?: number } = {},
  ) {
    this.schemaVersion = options.schemaVersion ?? DISCOVERY_CACHE_SCHEMA_VERSION
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = openDatabase(path)
    this.migrate()
  }

  /**
   * A fresh cache hit, discriminated so callers can tell a summarized-to-nothing
   * file (`negative`) from a genuine summary. A negative hit still means "do not
   * re-summarize this file" — its head hasn't changed — so the scanner can skip
   * the re-read without producing a conversation. A miss returns `undefined`.
   */
  getFreshEntry(
    path: string,
    stats: ConversationFileStat,
    agentKind: AgentKind,
  ): CacheEntry | undefined {
    const row = this.db
      .prepare(
        `SELECT path, agent_kind, mtime_ms, size, schema_version, summary_json
         FROM conversation_cache WHERE path = ?`,
      )
      .get(path) as CacheRow | undefined
    if (!row) return undefined
    if (row.agent_kind !== agentKind) return undefined
    if (row.schema_version !== this.schemaVersion) return undefined
    if (row.size !== stats.size) return undefined
    if (Math.abs(row.mtime_ms - stats.mtimeMs) > 0.5) return undefined
    if (row.summary_json === NEGATIVE_SUMMARY_SENTINEL) return { kind: 'negative' }
    const summary = decodeSummary(row.summary_json)
    // A row that can't decode is treated as a miss (re-summarize), never a hit.
    return summary ? { kind: 'summary', summary } : undefined
  }

  getFresh(
    path: string,
    stats: ConversationFileStat,
    agentKind: AgentKind,
  ): AgentConversationSummary | undefined {
    const entry = this.getFreshEntry(path, stats, agentKind)
    return entry?.kind === 'summary' ? entry.summary : undefined
  }

  upsert(
    path: string,
    stats: ConversationFileStat,
    summary: AgentConversationSummary,
    agentKind: AgentKind = summary.agentKind,
  ): void {
    this.upsertPrepared().run(
      path,
      agentKind,
      stats.mtimeMs,
      stats.size,
      this.schemaVersion,
      encodeSummary(summary),
    )
    this.writeEpoch++
  }

  upsertMany(
    rows: readonly {
      path: string
      stats: ConversationFileStat
      summary: AgentConversationSummary
      agentKind?: AgentKind
    }[],
  ): void {
    this.upsertRows(
      rows.map((row) => ({
        path: row.path,
        agentKind: row.agentKind ?? row.summary.agentKind,
        stats: row.stats,
        summaryJson: encodeSummary(row.summary),
      })),
    )
  }

  /**
   * Cache files that were summarized but produced no summary (guardian rollouts,
   * parse-diagnostic files) as negative rows keyed by size+mtime like positive
   * ones (POD-624). Until the file changes, {@link getFreshEntry} then reports it
   * as a `negative` hit so the scanner never re-reads its head. Rows are pruned by
   * {@link deleteMissing} when the file vanishes, exactly like positive rows.
   */
  upsertManyNegative(
    rows: readonly { path: string; stats: ConversationFileStat; agentKind: AgentKind }[],
  ): void {
    this.upsertRows(
      rows.map((row) => ({
        path: row.path,
        agentKind: row.agentKind,
        stats: row.stats,
        summaryJson: NEGATIVE_SUMMARY_SENTINEL,
      })),
    )
  }

  private upsertRows(
    rows: readonly {
      path: string
      agentKind: AgentKind
      stats: ConversationFileStat
      summaryJson: string
    }[],
  ): void {
    if (rows.length === 0) return
    const stmt = this.upsertPrepared()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        stmt.run(
          row.path,
          row.agentKind,
          row.stats.mtimeMs,
          row.stats.size,
          this.schemaVersion,
          row.summaryJson,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.writeEpoch++
  }

  listSummaries(agentKinds?: readonly AgentKind[]): AgentConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT summary_json FROM conversation_cache
         WHERE schema_version = ?
         ORDER BY path ASC`,
      )
      .all(this.schemaVersion) as { summary_json: string }[]
    const allowed = agentKinds ? new Set(agentKinds) : undefined
    const summaries: AgentConversationSummary[] = []
    for (const row of rows) {
      const summary = decodeSummary(row.summary_json)
      if (!summary) continue
      if (allowed && !allowed.has(summary.agentKind)) continue
      summaries.push(summary)
    }
    return summaries
  }

  /**
   * Prune cache rows whose `path` is absent from `existingPaths`, scoped (when
   * `agentKinds` is given) to those kinds — rows of other kinds are never touched.
   *
   * The discovery scan calls this on every tick (~every 15s), and in steady state
   * nothing has changed. To keep that no-op tick cheap we short-circuit when the
   * seen-set and scope are identical to the previous call AND no rows were written
   * since (tracked via {@link writeEpoch}); in that case zero SQL is issued.
   *
   * When work is needed the prune runs as a single set-difference DELETE against a
   * temp table of the seen paths, rather than loading the whole table into JS.
   */
  deleteMissing(
    existingPaths: ReadonlySet<string>,
    agentKinds?: readonly AgentKind[],
  ): DeleteMissingResult {
    const scopeKey = agentKinds ? [...agentKinds].sort().join('\0') : '*'

    if (
      this.lastPrune &&
      this.lastPrune.writeEpoch === this.writeEpoch &&
      this.lastPrune.scopeKey === scopeKey &&
      sameSet(this.lastPrune.seen, existingPaths)
    ) {
      return { skipped: true, deleted: 0, removedIds: [] }
    }

    const allowed = agentKinds ? [...new Set(agentKinds)] : undefined
    const { deleted, removedIds } = this.runPrune(existingPaths, allowed)

    // Record the converged state so the next identical tick can short-circuit.
    // Snapshot the seen-set since the caller may mutate/reuse theirs.
    this.lastPrune = {
      writeEpoch: this.writeEpoch,
      scopeKey,
      seen: new Set(existingPaths),
    }

    return { skipped: false, deleted, removedIds }
  }

  private runPrune(
    existingPaths: ReadonlySet<string>,
    allowed: readonly AgentKind[] | undefined,
  ): { deleted: number; removedIds: string[] } {
    // An empty scope means "no kinds eligible" — nothing can be pruned.
    if (allowed && allowed.length === 0) return { deleted: 0, removedIds: [] }

    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS discovery_seen_paths (path TEXT PRIMARY KEY)')
    this.db.exec('DELETE FROM discovery_seen_paths')

    try {
      if (existingPaths.size > 0) {
        const insert = this.db.prepare(
          'INSERT OR IGNORE INTO discovery_seen_paths (path) VALUES (?)',
        )
        this.db.exec('BEGIN IMMEDIATE')
        try {
          for (const path of existingPaths) insert.run(path)
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
      }

      let sql =
        'DELETE FROM conversation_cache WHERE path NOT IN (SELECT path FROM discovery_seen_paths)'
      const params: AgentKind[] = []
      if (allowed) {
        sql += ` AND agent_kind IN (${allowed.map(() => '?').join(', ')})`
        params.push(...allowed)
      }
      sql += ' RETURNING summary_json'
      const rows = this.db.prepare(sql).all(...params) as { summary_json: string }[]
      // `deleted` counts every pruned row (per DeleteMissingResult's contract);
      // `removedIds` carries only the decodable conversation ids — negative rows
      // (the summarized-to-nothing sentinel) prune silently, with no removal delta.
      const removedIds: string[] = []
      for (const row of rows) {
        const summary = decodeSummary(row.summary_json)
        if (summary) removedIds.push(summary.id)
      }
      return { deleted: rows.length, removedIds }
    } finally {
      this.db.exec('DELETE FROM discovery_seen_paths')
    }
  }

  close(): void {
    this.db.close()
  }

  private upsertPrepared(): ReturnType<SqlDatabase['prepare']> {
    return this.db.prepare(
      `INSERT INTO conversation_cache
         (path, agent_kind, mtime_ms, size, schema_version, summary_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         agent_kind = excluded.agent_kind,
         mtime_ms = excluded.mtime_ms,
         size = excluded.size,
         schema_version = excluded.schema_version,
         summary_json = excluded.summary_json`,
    )
  }

  private migrate(): void {
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS conversation_cache (
         path TEXT PRIMARY KEY,
         agent_kind TEXT NOT NULL,
         mtime_ms REAL NOT NULL,
         size INTEGER NOT NULL,
         schema_version INTEGER NOT NULL,
         summary_json TEXT NOT NULL
       )`,
    )
    const existing = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as { value: string } | undefined
    if (!existing) {
      this.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', DB_SCHEMA_VERSION)
    }
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

type SummaryJson = Omit<AgentConversationSummary, 'createdAt' | 'updatedAt'> & {
  createdAt?: string
  updatedAt?: string
}

function encodeSummary(summary: AgentConversationSummary): string {
  const { createdAt, updatedAt, ...rest } = summary
  const json: SummaryJson = {
    ...rest,
    ...(createdAt ? { createdAt: createdAt.toISOString() } : {}),
    ...(updatedAt ? { updatedAt: updatedAt.toISOString() } : {}),
  }
  return JSON.stringify(json)
}

function decodeSummary(raw: string): AgentConversationSummary | undefined {
  let parsed: SummaryJson
  try {
    parsed = JSON.parse(raw) as SummaryJson
  } catch {
    return undefined
  }
  const { createdAt, updatedAt, ...rest } = parsed
  return {
    ...rest,
    ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
    ...(updatedAt ? { updatedAt: new Date(updatedAt) } : {}),
  }
}
