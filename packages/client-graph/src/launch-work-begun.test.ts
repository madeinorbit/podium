import { ALL_ISSUE_STAGES, isFinished } from '@podium/model/browser'
import { autorun, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { MobxPool } from './pool'

// Frozen LaunchBox rule, retained as the independent pre-migration oracle.
const begunStages = new Set(['planning', 'in_progress', 'review', 'shipping'])
function oldWorkBegun(issue: { stage: string; worktreePath?: string }, active: number) {
  return active > 0 || Boolean(issue.worktreePath) || begunStages.has(issue.stage)
}
const stamp = '2026-10-09T12:00:00Z'
const statuses = ['starting', 'live', 'reconnecting', 'hibernated', 'exited']

it.each(ALL_ISSUE_STAGES)('preserves enabled launch actions for %s across every checkout and session state', (stage) => {
  let fixtures = 0
  for (const worktreePath of [undefined, '', '/checkout'])
    for (const status of [undefined, ...statuses]) for (const archived of [false, true])
      for (const headless of [false, true]) {
        const issue = { id: 'task', seq: 1, title: 'Task', stage, worktreePath,
          archived: false, repoPath: '/checkout', createdAt: stamp, updatedAt: stamp }
        const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
        pool.apply({ type: 'replace', rows: [
          { kind: 'issue', id: 'task', value: issue as never },
          ...(status ? [{ kind: 'session' as const, id: 'agent', value: {
            sessionId: 'agent', issueId: 'task', agentKind: 'codex', cwd: '/checkout',
            title: 'Agent', status, archived, headless, lastActiveAt: stamp,
          } as never }] : []),
        ] })
        const active = status && status !== 'exited' && !archived ? 1 : 0
        const label = JSON.stringify({ stage, worktreePath, status, archived, headless })
        const model = pool.issueObject('task')
        try {
          runInAction(() => {
            expect(model.workBegun, label).toBe(oldWorkBegun(issue, active))
            expect(!isFinished(issue) && !model.workBegun, label)
              .toBe(!isFinished(issue) && !oldWorkBegun(issue, active))
          })
          fixtures++
        } finally { pool.dispose() }
      }
  expect(fixtures).toBe(3 * 6 * 2 * 2)
})

it('follows attachment and process state while ignoring archived, moved and shell sessions', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'task', value: {
    id: 'task', seq: 1, stage: 'backlog', title: 'Task', repoPath: '/checkout', createdAt: stamp, updatedAt: stamp,
  } as never }] })
  const answers: boolean[] = []
  const stop = autorun(() => answers.push(pool.issueObject('task').workBegun))
  const update = (patch: object) => runInAction(() => pool.apply({ type: 'update', rows: [{
    kind: 'session', id: 'agent', value: { sessionId: 'agent', issueId: 'task',
      agentKind: 'codex', cwd: '/checkout', title: 'Agent', status: 'live',
      archived: false, lastActiveAt: stamp, ...patch } as never,
  }] }))
  try {
    update({ agentKind: 'shell' }); expect(answers.at(-1)).toBe(false)
    update({}); expect(answers.at(-1)).toBe(true)
    update({ status: 'exited' }); expect(answers.at(-1)).toBe(false)
    update({ status: 'hibernated' }); expect(answers.at(-1)).toBe(true)
    update({ archived: true }); expect(answers.at(-1)).toBe(false)
    update({ issueId: 'elsewhere' }); expect(answers.at(-1)).toBe(false)
  } finally { stop(); pool.dispose() }
})
