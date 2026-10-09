import { omitGone } from '../lookup'
/**
 * POD-5423 (review finding 12): the repo's row follows the repo's own facts.
 * A lane-only change (its branch, a scan) keeps the row, so a reader of the
 * prefix does not wake; a prefix change, a lane leaving and the last lane
 * leaving still move it.
 */
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { MobxPool } from '../pool'

const lane = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  repoId: 'repo-1',
  repoPath: '/r',
  repoName: 'r',
  prefix: 'POD',
  branch: 'main',
  ...extra,
})

it('keeps the repo row across lane-only changes and moves it with the repo’s facts', () => {
  const pool = new MobxPool({
    selectedIssueId: null,
    coarseNow: Date.parse('2026-10-03T12:00:00Z'),
  })
  const put = (value: object | undefined, id: string) =>
    pool.apply({ type: 'update', rows: [{ kind: 'worktree', id, value: value as never }] })
  try {
    pool.apply({
      type: 'replace',
      rows: [
        { kind: 'worktree', id: '/r', value: lane('/r') as never },
        { kind: 'worktree', id: '/r/b', value: lane('/r/b', { branch: 'b' }) as never },
      ],
    })
    let runs = 0
    let prefix: unknown
    const stop = autorun(() => {
      runs += 1
      prefix = (omitGone(pool.row('repo', 'repo-1')) as { prefix?: string } | undefined)?.prefix
    })
    const held = pool.tables.repo.get('repo-1')
    put(lane('/r/b', { branch: 'b2' }), '/r/b')
    put(lane('/r', { branch: 'main2' }), '/r')
    // Before POD-5423 the latest lane took the slot: two wake-ups here.
    expect(runs).toBe(1)
    expect(pool.tables.repo.get('repo-1')).toBe(held)
    put(lane('/r/b', { branch: 'b2', prefix: 'NEW' }), '/r/b')
    expect(runs).toBe(2)
    expect(prefix).toBe('NEW')
    // The holding lane leaves: another lane of the repo takes over.
    put(undefined, '/r/b')
    expect(pool.tables.repo.get('repo-1')).toMatchObject({ repoPath: '/r', prefix: 'POD' })
    put(undefined, '/r')
    expect(pool.tables.repo.has('repo-1')).toBe(false)
    expect(prefix).toBeUndefined()
    stop()
  } finally {
    pool.dispose()
  }
})
