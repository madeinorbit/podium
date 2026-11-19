import { MobxPool } from '@podium/client-graph/pool'
import { expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { readIssueMenuChoices, readIssueMenuOrigins } from './issue-menu-readers'

it('requests no choice catalog for main, status or colour controls at 1x/4x history', () => {
  for (const size of [64, 256]) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() })
    const subject = makeIssue({ parentId: 'parent' }),
      parent = makeIssue({ id: 'parent', title: 'Origin' })
    pool.apply({
      type: 'replace',
      rows: [
        parent,
        subject,
        ...Array.from({ length: size }, (_, i) => makeIssue({ id: `other-${i}` })),
      ].map((value) => ({ kind: 'issue', id: value.id, value })),
    })
    const ids = vi.spyOn(pool.queries, 'ids'),
      row = vi.spyOn(pool, 'row')
    try {
      for (const kind of [undefined, 'status', 'handoff'] as const) {
        expect(readIssueMenuChoices(pool, kind)).toBeUndefined()
        expect(ids).not.toHaveBeenCalled()
        expect(row).not.toHaveBeenCalled()
      }
      expect(readIssueMenuOrigins(pool, [subject]).map((issue) => issue.id)).toEqual([
        subject.id,
        'parent',
      ])
      expect(
        row.mock.calls.filter(([kind]) => kind === 'issue').every(([, id]) => id === 'parent'),
      ).toBe(true)
      expect(ids).not.toHaveBeenCalled()
      readIssueMenuChoices(pool, 'duplicate')
      expect(ids).toHaveBeenCalledWith({ kind: 'pageIssues' })
    } finally {
      vi.restoreAllMocks()
      pool.dispose()
    }
  }
})

it('shares server matches across duplicate, parent/relation, header and compact choice lists', async () => {
  const { autorun } = await import('mobx')
  const { issueSearch } = await import('@podium/client-graph/issue-search')
  const { issuePages } = await import('@podium/client-graph/issue-page')
  const { readIssueSearchChoices } = await import('./issue-search-choices')
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() })
  const device = makeIssue({ id: 'device', title: 'Needle device', repoPath: '/repo' })
  const remote = makeIssue({ id: 'remote', title: 'Historical body match', repoPath: '/repo' })
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: device.id, value: device }] })
  // The server answers the hit; the device installs its record (the loader's part).
  const query = vi.fn(async () => {
    pool.apply({ type: 'update', rows: [{ kind: 'issue' as const, id: remote.id, value: remote }] })
    return { hits: [{ id: remote.id }], next: null }
  })
  issueSearch(pool).bind(query)
  const hold = vi.spyOn(pool.collections, 'holdRecords')
  const views = issuePages(pool)
  let duplicate: readonly string[] = [],
    choices: readonly string[] = []
  const stop = autorun(() => {
    duplicate = (readIssueMenuChoices(pool, 'duplicate', views, 'needle', '/repo') ?? []).map(
      (issue) => issue.id,
    )
    // Parent/relation and overflow use this reader through useIssuePageCatalog;
    // compact controls mount the same duplicate submenu reader.
    choices = readIssueSearchChoices(pool, views, 'needle', '/repo').map((issue) => issue.id)
  })
  try {
    expect(choices).toEqual(['device'])
    expect(() => expect(['deliberately-wrong']).toEqual(choices)).toThrow()
    await vi.waitFor(() => expect(choices).toEqual(['device', 'remote']))
    expect(duplicate).toEqual(choices)
    expect(query).toHaveBeenCalledTimes(1)
    expect(hold).toHaveBeenCalledWith('issue', ['remote'])
  } finally {
    stop()
    hold.mockRestore()
    views.dispose()
    pool.dispose()
  }
})

it('keeps the shared web choice lists usable when search fails offline', async () => {
  const { autorun } = await import('mobx')
  const { issueSearch } = await import('@podium/client-graph/issue-search')
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() })
  const device = makeIssue({ id: 'device', title: 'Needle device', repoPath: '/repo' })
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: device.id, value: device }] })
  const query = vi.fn(async () => {
    throw new Error('offline')
  })
  issueSearch(pool).bind(query)
  let choices: readonly string[] = []
  const stop = autorun(() => {
    choices = (readIssueMenuChoices(pool, 'duplicate', undefined, 'needle', '/repo') ?? []).map(
      (issue) => issue.id,
    )
  })
  try {
    expect(choices).toEqual(['device'])
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    expect(choices).toEqual(['device'])
  } finally {
    stop()
    pool.dispose()
  }
})
