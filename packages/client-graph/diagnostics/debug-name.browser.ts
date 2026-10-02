/** Synthetic rows only. The driver inspects actual MobX name_ edges in V8. */
import { autorun } from 'mobx'
import { enableDebugNames } from '../src/debug-name'
import { MobxPool } from '../src/pool'
import type { RowRecord } from '../src/shared/source'
import { PendingOverlay } from '../src/write/overlay'

if (new URLSearchParams(location.search).get('toolNames') === '1') enableDebugNames()

const count = 256
const now = Date.parse('2026-09-20T12:00:00Z')
const at = new Date(now).toISOString()
const rows: RowRecord[] = []
for (let i = 0; i < count; i++) {
  const id = `heap-issue-${i}`
  rows.push({ kind: 'issue', id, value: {
    id, seq: i + 1, title: `Synthetic ${i}`, stage: 'in_progress',
    createdAt: at, updatedAt: at, repoId: 'R', repoPath: '/repo',
    parentId: null, worktreePath: null, deps: [], audience: 'human',
  } as RowRecord['value'] })
  rows.push({ kind: 'session', id: `heap-session-${i}`, value: {
    sessionId: `heap-session-${i}`, issueId: id, cwd: '/repo',
    status: 'live', lastActiveAt: at, agentKind: 'codex',
  } as RowRecord['value'] })
}
rows.push({ kind: 'worktree', id: '/repo', value: {
  path: '/repo', repoId: 'R', repoPath: '/repo', prefix: 'POD',
} as RowRecord['value'] })

const pool = new MobxPool({ selectedIssueId: 'heap-issue-0', coarseNow: now }, undefined, undefined, new PendingOverlay())
pool.apply({ type: 'replace', rows })
const stops = [autorun(() => {
  for (let i = 0; i < count; i++) {
    const issue = pool.model('issue', `heap-issue-${i}`)!
    void issue.sidebar
    void issue.presence
    void pool.model('session', `heap-session-${i}`)!.retention
  }
  void pool.header
  void pool.headerViews.selectedIssue()
  void pool.settingsViews.setup()
  void pool.sidebar.sections()
  pool.clock.reached(now + 60_000)
})]

declare global {
  interface Window {
    __debugNameHeap: { rows: number; pool: MobxPool; dispose(): void }
  }
}
window.__debugNameHeap = { rows: count, pool, dispose() {
  stops.forEach(stop => stop())
  pool.dispose()
} }
