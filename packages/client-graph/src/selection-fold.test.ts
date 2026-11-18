import { expect, it } from 'vitest'
import { MobxPool } from './pool'
import { worklistView } from './worklist/view-model'

it('keeps the clicked fold state for a resident issue and allows a missing selection', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-10') })
  const view = worklistView(pool)
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'issue',
        id: 'folded',
        value: {
          id: 'folded',
          seq: 1,
          title: 'Folded task',
          stage: 'done',
          audience: 'human',
          createdAt: '2020-01-01T00:00:00Z',
          updatedAt: '2020-01-01T00:00:00Z',
          closedAt: '2020-01-01T00:00:00Z',
          closedReason: 'completed',
          repoPath: '/fixture',
        },
      },
    ],
  })
  try {
    view.select('folded')
    expect(view.selectedWasFolded).toBe(true)
    expect(() => view.select('missing')).not.toThrow()
    expect(view.selectedId).toBe('missing')
    expect(view.selectedWasFolded).toBe(false)
    view.select(null)
    expect(view.selectedId).toBeNull()
  } finally {
    pool.dispose()
  }
})
