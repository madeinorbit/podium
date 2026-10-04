/** Local-only, read-only replay. Payloads and principal identities never leave
 * ludovico; output contains numeric counts, positions and field paths only. */
import { createRequire } from 'node:module'
import { hostname, homedir } from 'node:os'
import { join } from 'node:path'
import type { ClientRuntime, Store } from '@podium/client-core/engine'
import type { SuperThreadView } from '@podium/client-core/viewmodels'
import type { SessionView } from '@podium/client-core/session-values'
import { FEED_EVENT_KINDS, issueEventRowId, type IssueEventWire } from '@podium/model'
import type { PendingInteractionWire } from '@podium/protocol'
import { MobxPool } from '@podium/client-graph'
import { createSuperagentSource, SUPERAGENT_ENTITIES, SUPERAGENT_SOURCE_KEY, SUPERAGENT_SUMMARIES } from '@podium/client-graph/superagent'
import { NoticeSource, NOTICE_SOURCE_KEY } from '@podium/client-graph/notice-source'
import { NOTICE_ENTITIES } from '@podium/client-graph/notice-schema'
import { checkSuperagent } from '@podium/client-graph/diagnostics/superagent-check'
import { withKeyedInputs } from '@podium/client-core/engine'

interface ReplayDatabase {
  exec(sql: string): void
  query(sql: string): { all(...params: unknown[]): unknown[] }
  close(): void
}
let phase = 0
try {
  if (hostname() !== 'ludovico') throw new Error('Replay host unavailable')
  phase = 1
  const { Database } = createRequire(import.meta.url)('bun:sqlite') as { Database: new (path: string, options: { readonly: true }) => ReplayDatabase }
  const db = new Database(join(homedir(), '.podium/podium.db'), { readonly: true })
  const reports = []
  try {
    db.exec('PRAGMA busy_timeout = 1500')
    phase = 2
    const principals = db.query('SELECT DISTINCT owner_user_id AS id FROM superagent_threads WHERE archived = 0').all() as { id: string }[]
    if (principals.length === 0) throw new Error('Replay has no scoped threads')
    const sessions = db.query('SELECT id AS sessionId, cwd, machine_id AS machineId, status, archived FROM sessions ORDER BY id').all() as SessionView[]
    const events = db.query(`SELECT id AS eventId, ts, kind, subject, repo_path AS repoPath, payload FROM podium_events
      WHERE kind IN (${FEED_EVENT_KINDS.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 200`).all(...FEED_EVENT_KINDS).map(value => {
      const row = value as Omit<IssueEventWire, 'id'>
      let payload: unknown = {}
      try { payload = JSON.parse(row.payload as string) } catch {}
      return { ...row, id: issueEventRowId(row.eventId, row.subject), payload }
    })
    phase = 3
    for (const principal of principals) {
      const threads = db.query(`SELECT id, kind, origin_session_id AS originSessionId, title, repo_path AS repoPath,
        podium_session_id AS podiumSessionId, harness_session_id AS harnessSessionId, agent_kind AS agentKind, model, effort
        FROM superagent_threads WHERE owner_user_id = ? AND archived = 0 ORDER BY updated_at DESC`).all(principal.id).map(value =>
        Object.fromEntries(Object.entries(value as object).filter(([, entry]) => entry !== null))) as SuperThreadView[]
      const ids = new Set(threads.flatMap(row => row.podiumSessionId ? [row.podiumSessionId] : []))
      const interactions = db.query(`SELECT id, session_id AS sessionId, kind, payload_json AS payloadJson,
        source, answerable, fingerprint, status, asked_at AS askedAt FROM pending_interactions
        WHERE status = 'asked' ORDER BY rowid`).all().map(value => {
        const { payloadJson, ...row } = value as Record<string, unknown>
        return { ...row, payload: JSON.parse(payloadJson as string) } as PendingInteractionWire
      }).filter(row => ids.has(row.sessionId))
      const cursor = db.query('SELECT last_event_id AS lastEventId, seen_at AS seenAt FROM user_read_position WHERE user_id = ? AND stream_id = ?').all(principal.id, 'issueEvents')[0]
        ?? { lastEventId: 0, seenAt: null }
      const state = { superThreads: threads, superThreadId: threads.find(row => row.kind === 'global')?.id ?? 'global',
        sessions, issueEvents: events, pendingInteractions: interactions, repos: [], paneA: null, selectedWorktree: null,
        readPosition: { get: () => cursor, subscribe: () => () => {} } } as unknown as Store
      const owner = withKeyedInputs({ getSnapshot: () => state, readPosition: state.readPosition, subscribe: () => () => {},
        replica: { getCursor: () => 1, rows: (kind: string) => kind === 'issueEvents' ? events : kind === 'pendingInteractions' ? interactions : [],
          row: (kind: string, id: string) => (kind === 'issueEvents' ? events : interactions).find(row => row.id === id), subscribeAddressedBatch: () => () => {} },
        outbox: { deadLetters: () => [], subscribe: () => () => {} } }) as unknown as ClientRuntime
      const pool = new MobxPool({ coarseNow: Date.now(), selectedIssueId: null }, undefined,
        { summaries: SUPERAGENT_SUMMARIES, load: (_entity, id) => sessions.find(row => row.sessionId === id) as never })
      try {
        pool.apply({ type: 'replace', rows: sessions.map(row => ({ kind: 'session', id: row.sessionId, value: row as never })) })
        await pool.sources.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES, () => createSuperagentSource(owner))
        await pool.sources.ensure(NOTICE_SOURCE_KEY, NOTICE_ENTITIES, () => new NoticeSource(owner))
        checkSuperagent(pool, state); await Promise.resolve()
        checkSuperagent(pool, state); await Promise.resolve()
        for (let turn = 0; turn < 32; turn++) { checkSuperagent(pool, state); if (pool.hydrate() === 0) break }
        const result = checkSuperagent(pool, state)
        reports.push({ threads: threads.length, questions: interactions.length, ...result })
        if (result.differences || result.pending) process.exitCode = 1
      } finally { pool.dispose() }
    }
    phase = 4
    console.log(JSON.stringify({ principals: principals.length, sessions: sessions.length, events: events.length,
      runningFlags: 'ephemeral: covered by synthetic updates', reports }))
  } finally { db.close() }
} catch { console.log(JSON.stringify({ replay: 'unavailable', phase })); process.exitCode = 1 }
