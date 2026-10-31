import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { MobxPool } from '../pool'
import { sidebarView } from './sidebar'

const now = Date.parse('2026-10-03T12:00:00Z')
const issue = {
  id: 'remote-task',
  seq: 1,
  title: 'Remote task',
  repoId: 'repo-gamma',
  repoPath: '/code/gamma',
  stage: 'in_progress',
  audience: 'human' as const,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
}

it.each([
  '/code/gamma',
  'C:\\code\\gamma',
])('labels a task-only repo from its issue path %s without scanned worktrees', (repoPath) => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
  try {
    pool.apply({
      type: 'replace',
      rows: [{ kind: 'issue', id: issue.id, value: { ...issue, repoPath } }],
    })

    expect(sidebarView(pool).sections().bands).toMatchObject([
      { key: 'repo-gamma', label: 'gamma', repoPath, rowIds: [issue.id] },
    ])
  } finally {
    pool.dispose()
  }
})

it('keeps the issue path as a fallback while repository scan facts arrive and leave', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
  pool.apply({
    type: 'replace',
    rows: [{ kind: 'issue', id: issue.id, value: issue }],
  })
  const labels: (string | undefined)[] = []
  const stop = autorun(() => {
    labels.push(sidebarView(pool).sections().bands[0]?.label)
  })
  try {
    expect(labels).toEqual(['gamma'])
    const lane = {
      path: '/local/checkout',
      repoId: issue.repoId,
      repoPath: '/local/scanned',
      repoName: 'Scanned',
    }
    pool.apply({ type: 'update', rows: [{ kind: 'worktree', id: lane.path, value: lane }] })
    expect(labels).toEqual(['gamma', 'scanned'])

    pool.apply({ type: 'update', rows: [{ kind: 'worktree', id: lane.path, value: undefined }] })
    expect(labels).toEqual(['gamma', 'scanned', 'gamma'])

    pool.apply({
      type: 'update',
      rows: [{ kind: 'repo', id: issue.repoId, value: { id: issue.repoId, repoPath: '' } }],
    })
    expect(labels).toEqual(['gamma', 'scanned', 'gamma'])
  } finally {
    stop()
    pool.dispose()
  }
})
