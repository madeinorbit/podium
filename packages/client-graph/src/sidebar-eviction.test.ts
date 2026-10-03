import { expect, it } from 'vitest'
import { MobxPool } from './pool'

it('keeps an observed eviction pending across repeated render reads until selection moves', () => {
  const pool = new MobxPool({ selectedIssueId: 'selected', coarseNow: 0 })
  try {
    pool.apply({
      type: 'replace',
      rows: [
        {
          kind: 'issue',
          id: 'selected',
          value: {
            id: 'selected',
            stage: 'in_progress',
            title: 'Selected',
            repoPath: '/synthetic',
            createdAt: '2026-10-03T00:00:00Z',
            updatedAt: '2026-10-03T00:00:00Z',
          } as never,
        },
      ],
    })
    expect(pool.sidebar.selectionEvicted()).toBe(false)
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'selected', value: undefined }] })
    const reads = Array.from({ length: 2 }, () => pool.sidebar.selectionEvicted())
    expect(reads).toEqual([true, true])
    pool.applyLocals({ selectedIssueId: null, coarseNow: 0 }, new Set(['selectedIssueId']))
    expect(pool.sidebar.selectionEvicted()).toBe(false)
  } finally {
    pool.dispose()
  }
})
