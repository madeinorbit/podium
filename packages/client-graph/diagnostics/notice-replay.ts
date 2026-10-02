/** Operator rows never leave ludovico. Read only the local database, with a
 * bounded busy timeout; no credentials, RPC, backend or exported payloads. */
import { createRequire } from 'node:module'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { ClientRuntime, Store } from '@podium/client-core/engine'
import type { SessionView } from '@podium/client-core/session-values'
import type { MessageRecordWire } from '@podium/model'
import type { PendingInteractionWire } from '@podium/protocol'
import { MobxPool } from '../src/pool'
import { NOTICE_ENTITIES, NOTICE_SUMMARIES } from '../src/notice-schema'
import { NoticeSource } from '../src/notice-source'
import { checkNotices } from './notice-check'

/** The browser package does not install Bun globals. This local-only adapter
 * exposes just the SQLite operations used by the bounded, read-only replay. */
interface ReplayDatabase {
  exec(sql: string): void
  query(sql: string): { all(): unknown[] }
  close(): void
}

let phase = 0
try {
  if (hostname() !== 'ludovico') throw new Error('Replay host unavailable')
  phase = 1
  const { Database } = createRequire(import.meta.url)('bun:sqlite') as {
    Database: new (path: string, options: { readonly: true }) => ReplayDatabase
  }
  const db = new Database(join(homedir(), '.podium/podium.db'), { readonly: true })
  let sessions: SessionView[], messages: MessageRecordWire[], interactions: PendingInteractionWire[]
  try {
    db.exec('PRAGMA busy_timeout = 1500')
    phase = 2
    sessions = db.query(`SELECT id AS sessionId, name, title, cwd, agent_kind AS agentKind,
      status, archived FROM sessions ORDER BY id`).all() as SessionView[]
    phase = 3
    messages = db.query(`SELECT id, to_id AS sessionId, COALESCE(on_behalf_of, actor_id) AS senderUserId,
      body, created_at AS createdAt, delivery_status AS status, delivery_deferred_reason AS reason
      FROM messages WHERE from_kind = 'operator' AND to_kind = 'session' AND to_id IS NOT NULL
      AND (on_behalf_of IS NOT NULL OR actor_kind = 'user') AND notice_dismissed_at IS NULL
      AND delivery_status IN ('failed', 'expired', 'unknown') ORDER BY id`).all() as MessageRecordWire[]
    phase = 4
    interactions = db.query(`SELECT id, session_id AS sessionId, kind, payload_json AS payloadJson,
      source, answerable, fingerprint, status, asked_at AS askedAt
      FROM pending_interactions WHERE status = 'asked' ORDER BY id`).all().map(value => {
      const { payloadJson, ...row } = value as Record<string, unknown>
      return { ...row, payload: JSON.parse(payloadJson as string) } as PendingInteractionWire
    })
  } finally { db.close() }
  phase = 5
  const runtime = { replica: {
    rows: (kind: string) => kind === 'messageRecords' ? messages : interactions,
    row: (kind: string, id: string) => (kind === 'messageRecords' ? messages : interactions).find(row => row.id === id),
    subscribeAddressedBatch: () => () => {},
  }, outbox: { deadLetters: () => [], subscribe: () => () => {} } } as unknown as Pick<ClientRuntime, 'replica' | 'outbox'>
  const pool = new MobxPool({ coarseNow: Date.now(), selectedIssueId: null }, undefined,
    { summaries: NOTICE_SUMMARIES, load: (_entity, id) => sessions.find(row => row.sessionId === id) as never })
  pool.apply({ type: 'replace', rows: sessions.map(row => ({ kind: 'session', id: row.sessionId, value: row as never })) })
  pool.header.apply([{ kind: 'window', id: 'window', value: { view: 'workspace', paneA: null, fileTabs: [], outboxSize: 0 } }])
  pool.sources.register(NOTICE_ENTITIES, new NoticeSource(runtime))
  const state = { sessions, messageRecords: messages, pendingInteractions: interactions, outboxDeadLetters: [], outboxSize: 0 } as unknown as Store
  const sessionIds = [...new Set(interactions.map(row => row.sessionId))]
  try {
    checkNotices(pool, state, sessionIds)
    await Promise.resolve()
    for (let turn = 0; turn < 32; turn++) {
      checkNotices(pool, state, sessionIds)
      if (pool.hydrate() === 0) break
    }
    phase = 6
    const result = checkNotices(pool, state, sessionIds)
    console.log(JSON.stringify({ sessions: sessions.length, messages: messages.length, interactions: interactions.length,
      recovery: 'device-local: synthetic coverage only', ...result }))
    if (result.differences || result.pending) process.exitCode = 1
  } finally { pool.dispose() }
} catch { console.log(JSON.stringify({ replay: 'unavailable', phase })); process.exitCode = 1 }
