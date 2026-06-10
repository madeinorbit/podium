import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AgentConversationSummary,
  AgentKind,
  ConversationFileStat,
} from './types.js'

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

export class ConversationDiscoveryCache {
  private readonly db: DatabaseSync
  private readonly schemaVersion: number

  constructor(
    private readonly path: string = defaultDiscoveryDbPath(),
    options: { schemaVersion?: number } = {},
  ) {
    this.schemaVersion = options.schemaVersion ?? DISCOVERY_CACHE_SCHEMA_VERSION
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
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

  deleteMissing(existingPaths: ReadonlySet<string>, agentKinds?: readonly AgentKind[]): void {
    const rows = this.db.prepare('SELECT path, agent_kind FROM conversation_cache').all() as {
      path: string
      agent_kind: AgentKind
    }[]
    const allowed = agentKinds ? new Set(agentKinds) : undefined
    const deleteRow = this.db.prepare('DELETE FROM conversation_cache WHERE path = ?')
    for (const row of rows) {
      if (allowed && !allowed.has(row.agent_kind)) continue
      if (!existingPaths.has(row.path)) deleteRow.run(row.path)
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
    const existing = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    if (!existing) {
      this.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', DB_SCHEMA_VERSION)
    }
  }
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
