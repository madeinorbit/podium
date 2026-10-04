/** Read-only persisted operator corpus. Run ONLY on ludovico. No credentials,
 * authenticated RPC, files containing payloads, or running service changes.
 * Dynamic discovery/reachability is not reconstructed from persisted rows. */
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { dedupeSessions, type Store } from '@podium/client-core/engine'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { machineViewsFromWire } from '@podium/client-core/values'
import { AutomationWire, AutomationRunWire, GitRepositoryWire, type MachineWire } from '@podium/model/browser'
import { createRuntimeWorklistPool } from '../src/runtime-pool'
import { createRowSource } from '../src/shared/row-source'
import { AutomationSource } from '../src/automation-source'
import { AUTOMATION_ENTITIES } from '../src/automation-schema'
import { checkAutomations, type LegacyTargets } from './automation-check'
import { withKeyedInputs } from '@podium/client-core/engine'

interface ReadonlyDatabase {
  exec(sql: string): void
  query(sql: string): { all(): Record<string, unknown>[] }
  close(): void
}

async function main() {
  if (hostname() !== 'ludovico') throw new Error('Operator replay is restricted to ludovico')
  const sqliteModule = 'bun:sqlite'
  const { Database } = await import(sqliteModule) as {
    Database: new (path: string, options: { readonly: true }) => ReadonlyDatabase
  }
  const db = new Database(join(homedir(), '.podium', 'podium.db'), { readonly: true })
  let automations: ReturnType<typeof AutomationWire.parse>[] = [], runs: ReturnType<typeof AutomationRunWire.parse>[] = []
  let sessions: Store['sessions'] = [], repos: GitRepositoryWire[] = [], machines: MachineWire[] = []
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN')
    automations = db.query(`SELECT id,name,enabled,repo_path repoPath,schedule_kind scheduleKind,cron,run_at runAt,
      target_session_id targetSessionId,agent_kind agentKind,model,effort,prompt,session_mode sessionMode,
      next_run_at nextRunAt,last_run_at lastRunAt,created_at createdAt FROM automations WHERE deleted_at IS NULL ORDER BY id`).all().map(row => {
      const value = row as Record<string, unknown>
      return AutomationWire.parse({ ...value, enabled: Boolean(value.enabled), cron: value.cron || null })
    })
    runs = db.query(`SELECT id,automation_id automationId,fired_at firedAt,session_id sessionId,outcome,detail
      FROM automation_runs WHERE deleted_at IS NULL ORDER BY id`).all().map(row => AutomationRunWire.parse(row))
    sessions = db.query(`SELECT id sessionId,cwd,last_active_at lastActiveAt,created_at createdAt,agent_kind agentKind,
      status,archived,headless,machine_id machineId,issue_id issueId,resume_kind resumeKind,resume_value resumeValue
      FROM sessions ORDER BY id`).all().map(row => {
      const { resumeKind, resumeValue, ...value } = row as Record<string, unknown>
      return { ...value, archived: Boolean(value.archived), headless: Boolean(value.headless),
        ...(resumeKind && resumeValue ? { resume: { kind: resumeKind, value: resumeValue } } : {}),
      }
    }) as unknown as Store['sessions']
    repos = db.query('SELECT path,machine_id machineId,repo_id repoId FROM repos ORDER BY machine_id,path').all().map(row => GitRepositoryWire.parse({ ...row, kind: 'repository', branch: '', worktrees: [] }))
    // Only non-credential columns. Liveness is deliberately unavailable here;
    // parity tests persistently-known catalogs, not live server projections.
    machines = db.query('SELECT id,name,hostname,last_seen_at lastSeenAt FROM machines WHERE revoked_at IS NULL AND superseded_by IS NULL ORDER BY id').all().map(row => ({ ...row as object, online: false })) as MachineWire[]
    db.exec('ROLLBACK')
  } finally { db.close() }
  const records = new Map<string, { entity: string; entityId: string; value: unknown; provenance: { seq: number } }>()
  for (const [entity, rows, key] of [['session', sessions, 'sessionId'], ['automation', automations, 'id'], ['automationRun', runs, 'id']] as const) {
    for (const value of rows) {
      const entityId = String(Reflect.get(value, key))
      records.set(`${entity}:${entityId}`, { entity, entityId, value, provenance: { seq: 1 } })
    }
  }
  const replica = createKernelReplica({ cache: { readCursor: () => null, readEntities: () => [...records.values()], read: (entity, id) => records.get(`${entity}:${id}`), durability: () => 'durable' },
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const sessionReader = createRowSource(withKeyedInputs({ principal: { userId: '' },
    getSnapshot: () => ({ repos: [] }), subscribe: () => () => {}, pendingOverlaysByRow: () => new Map(),
  }), { ...replica, sessionUserStatesLoaded: () => true }, { mode: 'truth' })
  let normalizedSessions: Store['sessions']
  try {
    normalizedSessions = dedupeSessions(sessionReader.source.snapshot('session').map(row => row.value as Store['sessions'][number]))
  } finally { sessionReader.dispose() }
  const state = { automations: [...replica.rows('automations')], automationRuns: [...replica.rows('automationRuns')], sessions: normalizedSessions,
    repos, machines, settingsTab: 'general', coarseNow: Date.now(), selectedIssueId: null, paneA: null,
    pins: { repos: [], worktrees: [] }, sidebarSettings: { repoOrder: [] },
  } as unknown as Store
  const runtime = withKeyedInputs({ replica, getSnapshot: () => state, subscribe: () => () => {}, pendingOverlaysByRow: () => new Map(),
    ui: { get: () => null, subscribe: () => () => {} },
  })
  const handle = createRuntimeWorklistPool(runtime as never, { settings: true })
  handle.pool.sources.register(AUTOMATION_ENTITIES, new AutomationSource(replica))
  try {
    if (process.argv.includes('--red-control')) {
      const value = AutomationWire.parse({ id: 'planted-automation', name: 'Planted red control', enabled: true,
        repoPath: null, scheduleKind: 'cron', cron: '0 9 * * *', runAt: null, targetSessionId: null,
        agentKind: 'codex', model: 'auto', effort: 'auto', prompt: 'Synthetic control', sessionMode: 'fresh',
        nextRunAt: null, lastRunAt: null, createdAt: new Date().toISOString(),
      })
      const record = { entity: 'automation', entityId: value.id, value, provenance: { seq: 2 } }
      records.set(`automation:${value.id}`, record)
      replica.onKernelEvent({ type: 'upserted', record, readmitted: false })
    }
    // Keep the offline executable out of the web/graph project dependency
    // cycle, while still calling the actual legacy screen policy at replay.
    const policyModule = '../../../apps/web/src/features/automations/automation-form.ts'
    const { automationTargetChoices } = await import(policyModule) as {
      automationTargetChoices(repos: Store['repos'], sessions: Store['sessions'], views: ReturnType<typeof machineViewsFromWire>, path: string | null): ReturnType<LegacyTargets>
    }
    const targets = (path: string | null) => automationTargetChoices(state.repos, state.sessions, machineViewsFromWire(state.machines), path)
    checkAutomations(handle.pool, state, targets)
    await Promise.resolve()
    const result = checkAutomations(handle.pool, state, targets)
    console.log(JSON.stringify({ persistedOnly: true, automations: automations.length, runs: runs.length, sessions: sessions.length,
      repositories: repos.length, machines: machines.length, ...result }))
    if (result.differences || result.pending) process.exitCode = 1
  } finally { handle.dispose() }
}
try { await main() } catch {
  // Never print database payloads or private error text.
  console.log(JSON.stringify({ unavailable: true, reason: 'read-only replay unavailable' }))
  process.exitCode = 1
}
