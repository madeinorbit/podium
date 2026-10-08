import { sidebarView } from './worklist/sidebar'
import { observable } from 'mobx'
import { expect, it } from 'vitest'
import { MobxPool } from './pool'

it('keeps an observed eviction pending across repeated render reads until selection moves', () => {
  const pool = new MobxPool({ selectedIssueId: 'selected', coarseNow: 0 })
  const exits = observable.map<string, 'evicted'>()
  pool.sources.register(['issueExit'], { read: (_kind, id) => ({ kind: exits.get(id) }), dispose() {} })
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
    // The canonical replica exit survives without an earlier render read.
    exits.set('selected', 'evicted')
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'selected', value: undefined }] })
    const reads = Array.from({ length: 2 }, () => sidebarView(pool).selectionGone())
    expect(reads).toEqual([true, true])
    pool.applyLocals({ selectedIssueId: null, coarseNow: 0 }, new Set(['selectedIssueId']))
    expect(sidebarView(pool).selectionGone()).toBe(false)
  } finally {
    pool.dispose()
  }
})
