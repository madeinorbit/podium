import { createIssuePageViews } from '@podium/client-graph/issue-page'
import { MobxPool } from '@podium/client-graph/pool'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useArtifactCount, usePageIssue } from './artifacts-tab'

const fixture = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  views: null as ReturnType<typeof createIssuePageViews> | null,
  openings: 0,
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T, empty: T) =>
    fixture.pool ? read(fixture.pool) : empty,
}))
vi.mock('@/features/issues/issue-page/opening-context', () => ({
  useIssueViews: () => {
    fixture.openings++
    return fixture.views
  },
}))

afterEach(() => {
  cleanup()
  fixture.views?.dispose()
  fixture.pool?.dispose()
  fixture.pool = null
  fixture.views = null
  fixture.openings = 0
})

it('reads the same artifact record as the detail page without opening a detail view', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  fixture.pool = pool
  const views = createIssuePageViews(pool)
  fixture.views = views
  const panel = { artifacts: [{ path: 'report.html', addedAt: '2026-10-29T00:00:00Z' }] }
  const row = { id: 'root', seq: 1, title: 'Artifacts', stage: 'review', panel }
  pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'root', value: row as never }] })

  const result = renderHook(() => ({
    issue: usePageIssue('root'),
    count: useArtifactCount('root'),
  }))
  expect(result.result.current.issue).toBe(views.issue('root'))
  expect(result.result.current.count).toBe(1)
  expect(fixture.openings).toBe(0)

  pool.apply({
    type: 'update',
    rows: [{ kind: 'issue', id: 'root', value: { ...row, panel: { artifacts: [] } } as never }],
  })
  result.rerender()
  expect(result.result.current.issue).toBe(views.issue('root'))
  expect(result.result.current.count).toBe(0)

  pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'root', value: undefined }] })
  result.rerender()
  expect(result.result.current.issue).toBeUndefined()
  expect(result.result.current.count).toBe(0)
})

it('keeps the startup loading state empty without an attached pool', () => {
  const result = renderHook(() => ({
    issue: usePageIssue('pending'),
    count: useArtifactCount('pending'),
  }))
  expect(result.result.current).toEqual({ issue: undefined, count: 0 })
  expect(fixture.openings).toBe(0)
})
