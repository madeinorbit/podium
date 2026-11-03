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
    // A scanned checkout does not name the repo (POD-6246); with no server
    // name the label stays a path tail.
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

// POD-6246: the repo's name is the server's `repo.name`, and nothing else.
// The podium repo is checked out under several folder names; the server's row
// carries the alphabetically first checkout as its path (the Mac's
// `bak_podium` copy) and "podium" as its name.
describe('a repo is named by its server record', () => {
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
  const record = (patch: Record<string, unknown> = {}) => ({
    kind: 'repo' as const,
    id: repoId,
    value: {
      id: repoId,
      prefix: 'POD',
      defaultParentBranch: null,
      repoPath: backup,
      name: 'podium',
      ...patch,
    },
  })
  // A lane's own scan name differs on purpose: it must never win over the record.
  const lane = (path: string) => ({
    kind: 'worktree' as const,
    id: path,
    value: { path, repoId, repoPath: path, repoName: 'scan-name', isMain: true },
  })
  const labelsOf = (pool: MobxPool) => {
    const labels: (string | undefined)[] = []
    const stop = autorun(() => {
      labels.push(
        sidebarView(pool)
          .sections()
          .bands.find((band) => band.key === repoId)?.label,
      )
    })
    return { labels, stop }
  }

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
          lane(home),
          lane(backup),
          record(),
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

  const task = {
    kind: 'issue' as const,
    id: 'task',
    value: { ...issue, id: 'task', repoId, repoPath: backup },
  }
  const orders = {
    'lanes, then the record': [lane(home), lane(backup), record()],
    'the record, then lanes': [record(), lane(home), lane(backup)],
  }

  it.each(
    Object.entries(orders),
  )('keeps "podium" after a replace carrying %s, then a base-branch edit', (_, rows) => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
    const { labels, stop } = labelsOf(pool)
    try {
      pool.apply({ type: 'replace', rows: [task, ...rows] })
      pool.apply({ type: 'update', rows: [record({ defaultParentBranch: 'dev/mw' })] })
      expect(labels.at(-1)).toBe('podium')
      expect(labels.filter((label) => label !== undefined && label !== 'podium')).toEqual([])
    } finally {
      stop()
      pool.dispose()
    }
  })

  it.each(
    Object.entries(orders),
  )('keeps "podium" after updates carrying %s, then a base-branch edit', (_, rows) => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
    const { labels, stop } = labelsOf(pool)
    try {
      pool.apply({ type: 'replace', rows: [task] })
      for (const row of rows) pool.apply({ type: 'update', rows: [row] })
      pool.apply({ type: 'update', rows: [record({ defaultParentBranch: 'dev/mw' })] })
      expect(labels.at(-1)).toBe('podium')
    } finally {
      stop()
      pool.dispose()
    }
  })

  it('follows a server rename, by update and by a replace', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
    const { labels, stop } = labelsOf(pool)
    try {
      pool.apply({ type: 'replace', rows: [task, lane(home), record()] })
      pool.apply({ type: 'update', rows: [record({ name: 'podium-app' })] })
      pool.apply({ type: 'replace', rows: [task, lane(home), record({ name: 'podium-next' })] })
      expect(labels.filter((label) => label !== undefined)).toEqual([
        'podium',
        'podium-app',
        'podium-next',
      ])
    } finally {
      stop()
      pool.dispose()
    }
  })

  it('names a registered repo with no tasks by its record, not its scan', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
    try {
      pool.apply({
        type: 'replace',
        rows: [
          { ...lane(home), value: { ...lane(home).value, projectIndex: 0, projectRoot: true } },
          record(),
        ],
      })
      expect(sidebarView(pool).sections().bands).toMatchObject([
        { key: repoId, label: 'podium', rowIds: [] },
      ])
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
