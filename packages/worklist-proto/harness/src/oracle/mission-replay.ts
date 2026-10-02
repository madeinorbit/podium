/// <reference types="bun" />
/** Read-only operator replay, ludovico only. No input is saved or exported;
 * only counts, positions and opaque issue ids are printed. */
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { dedupeSessions } from '@podium/client-core/engine'
import type { MissionIssueTopology } from '@podium/client-core/viewmodels'
import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from '@podium/client-graph/pool'
import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import { runInAction } from 'mobx'
import { allIssueViewModels, createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { createWorklistPool } from '@podium/client-graph/create'
import { checkMissions, poolMissionSnapshot, type MissionDifference } from '@podium/client-graph/diagnostics/mission-check'
import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { seedCacheFromCorpus } from '../../../shared/src/scenarios'
import { readLive } from '../fixture/export-snapshot'
import { corpusFromLive } from '../fixture/live-snapshot'
import { sidebarReplayStore } from './sidebar-replay'

/** Persisted topology is a separate replay mode for a running server on an
 * older transport version. Read only canonical topology columns; no old wire
 * record, credentials, discovery, titles or descriptions are copied. */
function persistedReplay() {
  step = 'database'
  const db = new Database(join(homedir(), '.podium', 'podium.db'), { readonly: true })
  let issues: SliceIssue[], seats: SliceSession[]
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN')
    const deps = new Map<string, { id: string; type: string }[]>()
    for (const edge of db.query('SELECT from_id owner, to_id id, type FROM issue_deps ORDER BY rowid').all() as { owner: string; id: string; type: string }[]) {
      const list = deps.get(edge.owner) ?? []; list.push({ id: edge.id, type: edge.type }); deps.set(edge.owner, list)
    }
    const rawIssues = db.query(`SELECT id,seq,parent_id parentId,archived,deleted_at deletedAt,stage,
      started_by_session startedBySession,draft,created_at createdAt,updated_at updatedAt,closed_at closedAt
      FROM issues ORDER BY id`).all() as Record<string, unknown>[]
    const iso = (value: unknown) => typeof value === 'number' ? new Date(value).toISOString() : value as string
    issues = rawIssues.map(row => ({ ...row, archived: Boolean(row.archived), isDraftVessel: Boolean(row.draft),
      deletedAt: row.deletedAt ? iso(row.deletedAt) : null, closedAt: row.closedAt ? iso(row.closedAt) : null,
      createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), title: '', repoPath: '', deps: deps.get(String(row.id)) ?? [],
    })) as unknown as SliceIssue[]
    const rawSeats = db.query(`SELECT id sessionId,issue_id issueId,headless,archived,status,resume_kind resumeKind,
      resume_value resumeValue,created_at createdAt,last_active_at lastActiveAt,agent_kind agentKind
      FROM sessions WHERE deleted_at IS NULL ORDER BY id`).all() as Record<string, unknown>[]
    seats = rawSeats.map(({ resumeKind, resumeValue, ...row }) => ({ ...row, cwd: '', headless: Boolean(row.headless),
      archived: Boolean(row.archived), createdAt: iso(row.createdAt), lastActiveAt: iso(row.lastActiveAt),
      ...(resumeKind && resumeValue ? { resume: { kind: resumeKind, value: resumeValue } } : {}),
    })) as unknown as SliceSession[]
    db.exec('ROLLBACK')
  } finally { db.close() }
  step = 'pool'
  const records = [ ...seats.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })) ]
  const input = new Map(records.map(row => [`${row.kind}:${row.id}`, row.value]))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() }, undefined,
    { load: (kind, id) => input.get(`${kind}:${id}`), summaries: MISSION_SUMMARIES, schedule: () => () => {} })
  try {
    pool.apply({ type: 'replace', rows: records })
    for (let round = 0; round < 64; round++) {
      runInAction(() => poolMissionSnapshot(pool))
      if (pool.hydrate() === 0) break
    }
    step = 'compare'
    const legacySeats = dedupeSessions(seats as unknown as SessionView[])
    const result = runInAction(() => checkMissions(pool, issues as unknown as MissionIssueTopology[], legacySeats))
    const opaque = (id: string | null) => id && /^iss_[\w-]+$/.test(id) ? id : null
    console.log(JSON.stringify({ persistedTopology: true, includesDeletedIssues: true, sessions: seats.length,
      retainedSessions: legacySeats.length, ...result, first: result.first ? { ...result.first,
        issueId: opaque(result.first.issueId), expectedId: opaque(result.first.expectedId), actualId: opaque(result.first.actualId) } : null }))
    if (result.differences || result.pending) process.exitCode = 1
  } finally { pool.dispose() }
}

let step = 'host'
async function main() {
  if (hostname() !== 'ludovico') throw new Error('Mission replay is restricted to ludovico')
  if (process.argv.includes('--database')) return persistedReplay()
  step = 'bootstrap'
  const { raw, bootstrapEntityCounts } = await readLive('http://127.0.0.1:18787')
  step = 'corpus'
  const corpus = { ...corpusFromLive(raw, Date.now()), issueProjections: raw.issueProjections,
    issueUserStates: raw.issueUserStates ?? [], issueGitStates: raw.issueGitStates ?? [], repoProjections: raw.repoProjections }
  step = 'replica'
  const cache = seedCacheFromCorpus(corpus)
  const replica = createKernelReplica({ cache, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const store = sidebarReplayStore(corpus, replica)
  const runtime = { getSnapshot: () => store, subscribe: () => () => {}, pendingOverlaysByRow: () => new Map() }
  step = 'pool'
  const rows = createRowSource(runtime, replica, { mode: 'overlaid' }), locals = createEngineLocals(runtime)
  const handle = createWorklistPool(rows.source, locals.source, { summaries: MISSION_SUMMARIES })
  try {
    step = 'load'
    for (let round = 0; round < 64; round++) {
      runInAction(() => poolMissionSnapshot(handle.pool))
      if (handle.pool.hydrate() === 0) break
    }
    step = 'compare'
    const locations: MissionDifference[] = []
    const result = runInAction(() => checkMissions(handle.pool,
      allIssueViewModels(replica, store.issueProjections, store.issueUserStates), store.sessions, diff => locations.push(diff)))
    const opaque = (id: string | null) => id && /^iss_[\w-]+$/.test(id) ? id : null
    const safe = (diff: MissionDifference) => ({ ...diff, issueId: opaque(diff.issueId), expectedId: opaque(diff.expectedId), actualId: opaque(diff.actualId) })
    console.log(JSON.stringify({ inputKinds: bootstrapEntityCounts, ...result,
      first: result.first ? safe(result.first) : null, locations: locations.map(safe) }))
    if (result.differences || result.pending) process.exitCode = 1
  } finally { handle.dispose(); locals.dispose(); rows.dispose() }
}
if (import.meta.main) main().catch(error => {
  // Classification is fixed vocabulary. Never emit a private response/error.
  const message = error instanceof Error ? error.message : ''
  const cause = error instanceof Error && error.name === 'SyncFormatError' && /^(http-[0-9]+|unsupported-version|unexpected-content-type|unexpected-bootstrap-refusal|streaming-body-required)$/.test(message) ? message : /expired/i.test(message) ? 'expired-session' : /401|403|unauth/i.test(message) ? 'authentication'
    : /connect|fetch|timeout/i.test(message) ? 'transport' : 'execution'
  console.log(JSON.stringify({ replay: 'failed', step, cause, errorKind: error instanceof Error ? error.name : 'unknown' }))
  process.exitCode = 1
})
