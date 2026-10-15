import { MissionScreen } from '@podium/client-graph/mission-screen'
import { MobxPool } from '@podium/client-graph/pool'
import { ingestSettings } from '@podium/client-graph/requested-records'
import { DEFAULT_SETTINGS, nativeAccountId } from '@podium/runtime'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'

it('resolves the root launch target from Settings and follows changes without using session history', () => {
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
      ingestSettings(pool, {
        ...DEFAULT_SETTINGS,
        roles: {
          ...DEFAULT_SETTINGS.roles,
          coding: { ...DEFAULT_SETTINGS.roles.coding, accountId: nativeAccountId(harness) },
        },
      })
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
