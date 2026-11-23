import { MissionScreen } from '@podium/client-graph/mission-screen'
import { MobxPool } from '@podium/client-graph/pool'
import { asUserId, resolveUserPreferences } from '@podium/model'
import { nativeAccountId } from '@podium/runtime'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'

it('resolves the root launch target from my settings and follows changes without using session history', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const issue = {
    id: 'root',
    seq: 1,
    title: 'Auto task',
    stage: 'backlog',
    defaultAgent: 'auto',
    repoPath: '/repo',
    machineId: null,
    createdAt: '2026-10-15T00:00:00Z',
    updatedAt: '2026-10-15T00:00:00Z',
  }
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: issue.id, value: issue }] })
  const screen = new MissionScreen(pool, issue.id)
  const seen: string[] = []
  const stop = autorun(() => {
    seen.push(screen.rootAgentTarget.defaultAgent)
  })
  try {
    for (const harness of ['codex', 'claude-code'] as const) {
      // My coding role is my synced `userPreferences` record (POD-6673).
      const value = {
        ...resolveUserPreferences(
          { 'roles.coding.accountId': nativeAccountId(harness) },
          asUserId('user_me'),
        ),
        id: 'user_me',
      }
      pool.apply({ type: 'update', rows: [{ kind: 'userPreferences', id: 'user_me', value }] })
      expect(screen.rootAgentTarget).toEqual({
        defaultAgent: harness,
        repoPath: '/repo',
        machineId: null,
      })
    }
    expect(seen).toContain('codex')
    pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: issue.id, value: { ...issue, defaultAgent: 'codex' } }],
    })
    expect(screen.rootAgentTarget.defaultAgent).toBe('codex')
  } finally {
    stop()
    screen.close()
    pool.dispose()
  }
})
