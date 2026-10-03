/** Ludovico-only persisted operator replay. Query-only database access, no
 * credentials or authored text; output contains counts and positions only. */
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { dedupeSessions, type Store } from '@podium/client-core/engine'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { sessionViews } from '@podium/client-core/session-values'
import { asAccountId, asMachineId, asSessionId, type MachineWire } from '@podium/model/browser'
import type { ExecutionProfileWire, WorkflowRunWire } from '@podium/protocol'
import { createRuntimeWorklistPool } from '../src/runtime-pool'
import { WORKFLOW_SUMMARIES } from '../src/workflow-schema'
import type { SliceIssue } from '../src/shared/slice-types'
import { checkWorkflows } from './workflow-check'

interface ReadonlyDatabase {
  exec(sql: string): void
  query(sql: string): { all(): Record<string, unknown>[] }
  close(): void
}

async function main() {
  if (hostname() !== 'ludovico') throw new Error('Replay restricted to ludovico')
  const sqliteModule = 'bun:sqlite'
  const { Database } = await import(sqliteModule) as {
    Database: new (path: string, options: { readonly: true }) => ReadonlyDatabase
  }
  const db = new Database(join(homedir(), '.podium', 'podium.db'), { readonly: true })
  let issues: Record<string, unknown>[] = [], sessions: Record<string, unknown>[] = [], machines: MachineWire[] = []
  let profileRefs: Record<string, unknown>[] = [], runRefs: Record<string, unknown>[] = []
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN')
    issues = db.query('SELECT id,seq,stage,archived,parent_id parentId,deleted_at deletedAt FROM issues ORDER BY id').all().map(row => ({
      ...row, archived: Boolean(row.archived), title: '', description: { value: '' }, labels: [], priority: 2, type: 'task',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', intentOrigin: 'human', audience: 'human', isDraftVessel: false,
    }))
    sessions = db.query(`SELECT id sessionId,cwd,last_active_at lastActiveAt,created_at createdAt,agent_kind agentKind,
      status,headless,issue_id issueId,resume_kind resumeKind,resume_value resumeValue FROM sessions ORDER BY id`).all().map(row => {
      const { resumeKind, resumeValue, ...value } = row
      return { ...value, headless: Boolean(value.headless),
        ...(resumeKind && resumeValue ? { resume: { kind: resumeKind, value: resumeValue } } : {}) }
    })
    machines = db.query('SELECT id,name,hostname,last_seen_at lastSeenAt FROM machines WHERE revoked_at IS NULL AND superseded_by IS NULL ORDER BY id').all().map(row => ({ ...row, online: false })) as MachineWire[]
    profileRefs = db.query('SELECT id,machine_id machineId FROM execution_profiles ORDER BY id').all()
    runRefs = db.query('SELECT id,subject_kind subjectKind,subject_id subjectId FROM workflow_runs ORDER BY id').all()
    db.exec('ROLLBACK')
  } finally { db.close() }
  const records = new Map<string, { entity: string; entityId: string; value: unknown; provenance: { seq: number } }>()
  for (const [entity, rows, key] of [['issueProjection', issues, 'id'], ['session', sessions, 'sessionId']] as const) {
    for (const value of rows) {
      const entityId = String(value[key])
      records.set(`${entity}:${entityId}`, { entity, entityId, value, provenance: { seq: 1 } })
    }
  }
  const replica = createKernelReplica({ cache: { readCursor: () => null, readEntities: () => [...records.values()], read: (entity, id) => records.get(`${entity}:${id}`), durability: () => 'durable' },
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const state = { issueProjections: [...replica.rows('issueProjections')],
    sessions: dedupeSessions(sessionViews(replica.rows('sessions'), { userId: 'workflow-replay', userStatesLoaded: true, userStates: [], repos: [], machines: [] })),
    repos: [], machines, settingsTab: 'general', coarseNow: Date.now(), selectedIssueId: null,
  } as unknown as Store
  const profiles: ExecutionProfileWire[] = profileRefs.map(row => ({ id: String(row.id), name: '', machineId: row.machineId ? asMachineId(String(row.machineId)) : null,
    accountId: asAccountId('replay-placeholder'), harness: 'codex', model: 'auto', effort: 'auto', createdAt: '', updatedAt: '' }))
  // Cover every persisted target identity even when there are no workflow runs.
  // The envelopes are synthetic; only the subject IDs are operator references.
  const subjects = [...runRefs,
    ...issues.map(row => ({ id: `issue:${row.id}`, subjectKind: 'issue', subjectId: row.id })),
    ...sessions.map(row => ({ id: `session:${row.sessionId}`, subjectKind: 'session', subjectId: row.sessionId })),
  ]
  const runs: WorkflowRunWire[] = subjects.map(row => ({ id: String(row.id), subjectKind: row.subjectKind as 'issue' | 'session', subjectId: String(row.subjectId),
    coordinatorSessionId: asSessionId('replay-placeholder'), revision: { id: 'replay-placeholder', workflowId: 'replay-placeholder', version: 1, instructions: '', steps: [], createdAt: '', publishedAt: null },
    status: 'active', supersedesRunId: null, steps: [], history: [], startedAt: '', completedAt: null }))
  const runtime = { replica, getSnapshot: () => state, subscribe: () => () => {}, pendingOverlaysByRow: () => new Map(),
    ui: { get: () => null, subscribe: () => () => {} } }
  const handle = createRuntimeWorklistPool(runtime as never, { settings: true, summaries: WORKFLOW_SUMMARIES })
  try {
    if (process.argv.includes('--red-control')) {
      // An in-memory absent reference masquerades as a visible pool issue.
      const value = { ...issues[0] as unknown as SliceIssue, id: 'planted-workflow-subject' }
      handle.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: value.id, value }] })
      runs.push({ ...runs[0]!, id: 'planted-workflow-run', subjectKind: 'issue', subjectId: value.id })
    }
    checkWorkflows(handle.pool, state, { profiles, runs })
    await Promise.resolve()
    const result = checkWorkflows(handle.pool, state, { profiles, runs })
    console.log(JSON.stringify({ persistedOnly: true, issues: issues.length, sessions: sessions.length, machines: machines.length,
      profiles: profileRefs.length, runs: runRefs.length, targets: subjects.length, ...result }))
    if (result.differences || result.pending) process.exitCode = 1
  } finally { handle.dispose() }
}
try { await main() } catch {
  // No database payloads or private exception messages leave the process.
  console.log(JSON.stringify({ unavailable: true, reason: 'read-only workflow replay unavailable' }))
  process.exitCode = 1
}
