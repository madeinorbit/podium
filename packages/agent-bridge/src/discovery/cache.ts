import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentConversationSummary, AgentKind, ConversationFileStat } from './types.js'

// Load node:sqlite at runtime instead of via a static import: both bundlers that
// touch this package (esbuild via tsup, rollup via tsup's treeshake) predate the
// node:sqlite builtin and rewrite the import to bare 'sqlite', which only exists
// under the node: prefix — making the emitted dist unloadable. A createRequire
// call with a runtime string is opaque to both.
const requireBuiltin = createRequire(import.meta.url)
const { DatabaseSync: DatabaseSyncImpl } = requireBuiltin(
  'node:sqlite',
) as typeof import('node:sqlite')

export const DISCOVERY_CACHE_SCHEMA_VERSION = 1
const DB_SCHEMA_VERSION = '1'

export function defaultDiscoveryDbPath(): string {
  const base = process.env.PODIUM_STATE_DIR ?? join(process.env.HOME || homedir(), '.podium')
  return join(base, 'discovery.db')
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
 * - `deleted` is the number of cache rows pruned (always 0 when `skipped`).
 */
export type DeleteMissingResult = {
  skipped: boolean
  deleted: number
}

export class ConversationDiscoveryCache {
  private readonly db: DatabaseSync
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
    this.db = new DatabaseSyncImpl(path)
    this.migrate()
  }

  getFresh(
    path: string,
    stats: ConversationFileStat,
    agentKind: AgentKind,
  ): AgentConversationSummary | undefined {
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
    return decodeSummary(row.summary_json)
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
    if (rows.length === 0) return
    const stmt = this.upsertPrepared()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        stmt.run(
          row.path,
          row.agentKind ?? row.summary.agentKind,
          row.stats.mtimeMs,
          row.stats.size,
          this.schemaVersion,
          encodeSummary(row.summary),
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
      return { skipped: true, deleted: 0 }
    }

    const allowed = agentKinds ? [...new Set(agentKinds)] : undefined
    const deleted = this.runPrune(existingPaths, allowed)

    // Record the converged state so the next identical tick can short-circuit.
    // Snapshot the seen-set since the caller may mutate/reuse theirs.
    this.lastPrune = {
      writeEpoch: this.writeEpoch,
      scopeKey,
      seen: new Set(existingPaths),
    }

    return { skipped: false, deleted }
  }

  private runPrune(
    existingPaths: ReadonlySet<string>,
    allowed: readonly AgentKind[] | undefined,
  ): number {
    // An empty scope means "no kinds eligible" — nothing can be pruned.
    if (allowed && allowed.length === 0) return 0

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
      const result = this.db.prepare(sql).run(...params)
      return Number(result.changes)
    } finally {
      this.db.exec('DELETE FROM discovery_seen_paths')
    }
  }

  close(): void {
    this.db.close()
  }

  private upsertPrepared(): ReturnType<DatabaseSync['prepare']> {
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
