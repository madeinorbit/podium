/** Before/after 4x phone board heap and watched-field measurement; run with Bun. */
import { heapStats } from 'bun:jsc'
import { lazyKeptCount } from '@podium/mobx-helpers'
import { autorun } from 'mobx'
import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES, type MobileTasksOptions } from '@podium/client-graph/mobile-screens-schema'
import { MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { createLegacyMobileTasks } from './legacy-mobile-tasks'

const mode = process.argv[2]
if (mode !== 'before' && mode !== 'after') throw new Error('Expected before or after')
const scale = 4, count = 128 * scale, now = Date.parse('2026-10-03T12:00:00Z')
const options: MobileTasksOptions = { showDone: false, expanded: [], filter: {}, ordering: 'priority', showAgentTasks: false }
const rows = Array.from({ length: count }, (_, i) => ({ id: `issue-${i}`, seq: i + 1, title: `Task ${i}`,
  stage: 'in_progress', type: 'task', priority: 2, audience: 'human', repoPath: '/fixture',
  parentId: i % 4 ? `issue-${i - i % 4}` : undefined, description: '', deps: [], labels: [],
  createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }))
const sessions = rows.flatMap(row => [false, true].map(archived => ({
  sessionId: `${row.id}-${archived}`, issueId: row.id, title: 'Agent', cwd: '/fixture',
  agentKind: 'codex', archived, status: archived ? 'exited' : 'live',
  createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(),
  agentState: { phase: 'working', since: new Date(now).toISOString() },
})))
const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined,
  { load: () => undefined, summaries: MOBILE_SCREEN_SUMMARIES, schedule: () => () => {} })
pool.apply({ type: 'replace', rows: [
  ...rows.map(value => ({ kind: 'issue' as const, id: value.id, value })),
  ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
] })
await attachMobileScreens(pool)
const targets = new Set<object>()
for (const name of ['issueObject', 'sessionObject'] as const) {
  const original = pool[name].bind(pool)
  Object.defineProperty(pool, name, { value: (id: string) => { const model = original(id); targets.add(model); return model } })
}
const heap = () => { Bun.gc(true); Bun.gc(true); return heapStats().heapSize }
await Promise.resolve()
const baseline = heap()
const stops: (() => void)[] = []
if (mode === 'before') {
  const old = createLegacyMobileTasks(pool)
  stops.push(() => old.dispose(), autorun(() => { old.tasks(options) }))
} else {
  const board = new MobileTasksBoard(pool, options)
  targets.add(board)
  stops.push(autorun(() => { board.sections }), autorun(() => { board.proposals }))
  const sections = board.sections
  if (sections === LOADING) throw new Error('Membership not ready')
  for (const section of sections) for (const row of section.rows) {
    const issue = pool.issueObject(row.id)
    stops.push(autorun(() => {
      issue.title; issue.seq; issue.displayRef; issue.stage; issue.type; issue.priority;
      issue.repoPath; issue.color; issue.needsHuman; issue.blocked; issue.dependents;
      issue.gitState; issue.childCount; issue.childDoneCount;
      issue.confirmedWorkingAgents; issue.taskProgress;
    }))
  }
}
await Promise.resolve()
const watchedFields = [...targets].reduce((sum, target) => sum + lazyKeptCount(target), 0)
const retained = heap()
console.log(JSON.stringify({ mode, scale, issues: count, sessions: sessions.length, shown: count / 4,
  watchedFields, heapBeforeBoard: baseline, heapWithBoard: retained, boardHeap: retained - baseline }))
for (const stop of stops.reverse()) stop()
pool.dispose()
