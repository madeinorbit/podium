import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
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
    // A scanned lane names the repo: the label is that name, not a path tail.
    expect(labels).toEqual(['gamma', 'Scanned'])

    pool.apply({ type: 'update', rows: [{ kind: 'worktree', id: lane.path, value: undefined }] })
    expect(labels).toEqual(['gamma', 'Scanned', 'gamma'])

    pool.apply({
      type: 'update',
      rows: [{ kind: 'repo', id: issue.repoId, value: { id: issue.repoId, repoPath: '' } }],
    })
    expect(labels).toEqual(['gamma', 'Scanned', 'gamma'])
  } finally {
    stop()
    pool.dispose()
  }
})

// POD-6246: one repo, checked out under two folder names. Issues filed from a
// `bak_podium` copy carry that path; the group is still named for the repo,
// whichever checkout holds the repo row and whichever issue ranks first.
describe('a repo checked out under two folder names', () => {
  const repoId = 'repo-podium'
  const home = '/home/mgw/src/other/podium'
  const backup = '/Users/mw/Source/other/bak_podium'
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
  // Rank puts the newest `createdAt` first (`compareRank`).
  const issueAt = (id: string, seq: number, repoPath: string, createdAt: string) => ({
    ...issue,
    id,
    seq,
    title: id,
    repoId,
    repoPath,
    createdAt,
    updatedAt: createdAt,
  })
  // Every lane of one repo carries the repo's origin-derived name (`row-source.ts` `indexFor`).
  const lane = (path: string) => ({
    path,
    repoId,
    repoPath: path,
    repoName: 'podium',
    isMain: true,
  })

  it.each([
    ['the home checkout', 'home-issue'],
    ['the backup checkout', 'backup-issue'],
  ])('labels the group "podium" while the issue from %s ranks first', (_, head) => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
    try {
      pool.apply({
        type: 'replace',
        rows: [
          {
            kind: 'issue',
            id: 'home-issue',
            value: issueAt('home-issue', 1, home, at(head === 'home-issue' ? 1 : 30)),
          },
          {
            kind: 'issue',
            id: 'backup-issue',
            value: issueAt('backup-issue', 2, backup, at(head === 'backup-issue' ? 1 : 30)),
          },
          { kind: 'worktree', id: home, value: lane(home) },
          // The backup checkout's lane arrives last, so it holds the repo row.
          { kind: 'worktree', id: backup, value: lane(backup) },
        ],
      })

      const bands = sidebarView(pool).sections().bands
      expect(bands).toHaveLength(1)
      expect(bands[0]).toMatchObject({ key: repoId, label: 'podium' })
      expect(bands[0]?.rowIds[0]).toBe(head)
    } finally {
      pool.dispose()
    }
  })

  it('falls back to the path tail for an issue with no repo', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
    try {
      const { repoId: _, ...repoless } = issueAt('loose-issue', 3, backup, at(1))
      pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'loose-issue', value: repoless }] })
      expect(sidebarView(pool).sections().bands).toMatchObject([
        { label: 'bak_podium', rowIds: ['loose-issue'] },
      ])
    } finally {
      pool.dispose()
    }
  })
})
