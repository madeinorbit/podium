/** Ludovico-only, read-only persisted topology replay. Display bodies stay
 * blank; synthetic and rendered checks cover them. Only counts, positions and
 * opaque IDs leave this process. No snapshot or private error is written. */
import { createRequire } from 'node:module'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { dedupeSessions } from '@podium/client-core/engine'
import { deriveIssueRollups, deriveIssueViews } from '@podium/client-core/replica'
import { missionRootFor, type IssueNavigationModel } from '@podium/client-core/viewmodels'
import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from '@podium/client-graph/pool'
import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'
import { checkMissionView, checkWorkspaceMission, poolMissionViewSnapshot } from '@podium/client-graph/diagnostics/mission-view-check'
import { missionView, readWorkspaceMission } from '@podium/client-graph/mission-view'
import type { SidebarCheckResult } from '@podium/client-graph/diagnostics/sidebar-check'
import { runInAction } from 'mobx'

let step = 'host'
async function main() {
  if (hostname() !== 'ludovico') throw new Error('Restricted host')
  step = 'database'
  const { Database } = createRequire(import.meta.url)('bun:sqlite') as { Database: new (path: string, options: { readonly: true }) => {
    exec(sql: string): void; query(sql: string): { all(): unknown[] }; close(): void
  } }
  const db = new Database(join(homedir(), '.podium', 'podium.db'), { readonly: true })
  let issues: IssueNavigationModel[], rawSessions: SessionView[]
  const iso = (value: unknown) => typeof value === 'number' ? new Date(value).toISOString() : value
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN')
    const deps = new Map<string, { id: string; type: string }[]>()
    for (const edge of db.query('SELECT from_id owner, to_id id, type FROM issue_deps ORDER BY rowid').all() as { owner: string; id: string; type: string }[]) {
      const list = deps.get(edge.owner) ?? []; list.push({ id: edge.id, type: edge.type }); deps.set(edge.owner, list)
    }
    issues = (db.query(`SELECT id,seq,parent_id parentId,archived,deleted_at deletedAt,stage,closed_reason closedReason,
      started_by_session startedBySession,coordinator_session_id coordinatorSessionId,draft,sort_key sortKey,
      created_at createdAt,updated_at updatedAt,closed_at closedAt,defer_until deferUntil,
      superseded_by supersededBy,duplicate_of duplicateOf FROM issues ORDER BY id`).all() as Record<string, unknown>[])
      .map(({ draft, ...row }) => ({ ...row, archived: Boolean(row.archived), isDraftVessel: Boolean(draft), title: '',
        description: '', repoPath: '', worktreePath: null, branch: null, deps: deps.get(String(row.id)) ?? [],
        createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), closedAt: iso(row.closedAt), deletedAt: iso(row.deletedAt),
        deferUntil: iso(row.deferUntil), readAt: null, unread: true,
      })) as unknown as IssueNavigationModel[]
    rawSessions = (db.query(`SELECT id sessionId,issue_id issueId,headless,archived,status,resume_kind resumeKind,
      resume_value resumeValue,created_at createdAt,last_active_at lastActiveAt,agent_kind agentKind,
      spawned_by spawnedBy FROM sessions WHERE deleted_at IS NULL ORDER BY id`).all() as Record<string, unknown>[])
      .map(({ resumeKind, resumeValue, ...row }) => ({ ...row, title: '', cwd: '', headless: Boolean(row.headless),
        archived: Boolean(row.archived), readAt: null, unread: true, createdAt: iso(row.createdAt), lastActiveAt: iso(row.lastActiveAt),
        ...(resumeKind && resumeValue ? { resume: { kind: resumeKind, value: resumeValue } } : {}),
      })) as unknown as SessionView[]
    db.exec('ROLLBACK')
  } finally { db.close() }
  step = 'pool'
  const sessions = dedupeSessions(rawSessions), views = deriveIssueViews(issues, sessions)
  const sessionById = new Map(sessions.map(session => [session.sessionId, session]))
  issues = issues.map(issue => { const view = views.get(issue.id)!; return { ...issue, ...view,
    ...deriveIssueRollups(issue, view.memberSessionIds, id => sessionById.get(id)),
  } })
  const rows = [...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value }))]
  const source = new Map(rows.map(row => [`${row.kind}:${row.id}`, row.value]))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() }, undefined, {
    load: (kind, id) => source.get(`${kind}:${id}`), summaries: MISSION_VIEW_SUMMARIES, schedule: () => () => {},
  })
  try {
    pool.apply({ type: 'replace', rows })
    const roots = [...new Set(issues.flatMap(issue => {
      const root = missionRootFor(issues, issue.id)
      return root && !root.archived && !root.deletedAt ? [root.id] : []
    }))]
    step = 'load'
    for (let round = 0; round < 64; round++) {
      runInAction(() => { for (const id of roots) { poolMissionViewSnapshot(pool, id); readWorkspaceMission(missionView(pool), id, null) } })
      if (pool.hydrate() === 0) break
    }
    step = 'compare'
    let differences = 0, pending = 0, rowsCompared = 0, selections = 0, first: SidebarCheckResult['first'] = null
    const add = (result: SidebarCheckResult) => { differences += result.differences; pending += result.pending; rowsCompared += result.rows; first ??= result.first; selections++ }
    runInAction(() => { for (const id of roots) {
      for (const mode of ['full', 'working', 'needs-you'] as const) add(checkMissionView(pool, issues, sessions, id, mode))
      add(checkWorkspaceMission(pool, issues, sessions, id, null))
    } })
    const opaque = (id: string | null) => id && /^iss_[\w-]+$/.test(id) ? id : null
    const location = first as SidebarCheckResult['first']
    console.log(JSON.stringify({ persistedTopology: true, displayBodiesCompared: false, issues: issues.length,
      sessions: rawSessions.length, retainedSessions: sessions.length, missions: roots.length, selections,
      rows: rowsCompared, differences, pending, first: location ? { sectionIndex: location.sectionIndex, rowIndex: location.rowIndex,
        field: location.field, expectedId: opaque(location.expectedId), actualId: opaque(location.actualId) } : null }))
    if (differences || pending) process.exitCode = 1
  } finally { pool.dispose() }
}
if (import.meta.main) main().catch(() => { console.log(JSON.stringify({ replay: 'failed', step, cause: 'execution' })); process.exitCode = 1 })
