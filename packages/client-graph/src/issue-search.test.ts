import { autorun, observable, runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReferencePicker } from './chat-context'
import { createIssueBoardSource } from './issue-board-source'
import {
  ISSUE_SEARCH_PAGE,
  type IssueSearchInput,
  type IssueSearchPage,
  type IssueSearchResult,
  issueSearch,
} from './issue-search'
import { issueTargets } from './issue-targets'
import { LOADING } from './loading'
import { MobxPool } from './pool'
import type { CollectionLoaderPort } from './shared/source'
import { worklistView } from './worklist/view-model'

const stamp = '2026-10-01T12:00:00Z'
const row = (id: string, patch: object = {}) => ({
  kind: 'issue' as const,
  id,
  value: {
    id,
    seq: id === 'device' ? 1 : 2,
    title: `Needle ${id}`,
    repoId: 'r',
    repoPath: '/repo',
    stage: 'in_progress',
    audience: 'human',
    deps: [],
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  },
})
const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop()
  vi.useRealTimers()
})
function fixture(online = true) {
  vi.useFakeTimers()
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  stops.push(() => pool.dispose())
  pool.apply({ type: 'replace', rows: [row('device')] as never })
  const adopt = vi.fn((_kind: string, ids: readonly string[]) => {
    const missing = ids.filter((id) => !pool.tables.issue.has(id))
    pool.apply({
      type: 'update',
      rows: missing.map((id) =>
        row(id, {
          title: 'Historical body match',
          stage: 'done',
          closedReason: 'done',
          closedAt: '2020-01-01T00:00:00Z',
        }),
      ) as never,
    })
  })
  const port: CollectionLoaderPort = {
    online,
    firstDownload: false,
    isComplete: (spec) => (spec.collection === 'issueProjection.stubs' ? {} : undefined),
    wasRefused: () => false,
    requestRecords: adopt,
    subscribe: () => () => {},
    request() {},
    show: () => () => {},
    status: () => (online ? 'loading' : 'offline'),
    stubOf: (_entity, id) =>
      pool.tables.issue.get(id) as unknown as Readonly<Record<string, unknown>>,
    stubsByParent: () => [],
    stubRows: () =>
      [...pool.tables.issue].map(([id, stub]) => ({
        id,
        stub: stub as unknown as Readonly<Record<string, unknown>>,
      })),
  }
  pool.collections.attach(() => port)
  const query = vi.fn(async () => ({
    hits: [{ id: 'remote' }, { id: 'device' }, { id: 'remote' }],
    next: null,
  }))
  issueSearch(pool).bind(query)
  return { pool, query, adopt }
}

const surfaces = {
  mentions(pool: MobxPool) {
    const picker = createReferencePicker(pool)
    picker.search('needle', 5)
    stops.push(() => picker.close())
    return () => picker.issueIds
  },
  'phone links'(pool: MobxPool) {
    return () => issueTargets(pool, { id: 'origin', repoPath: '/repo' }, 'needle', 5) ?? []
  },
  board(pool: MobxPool) {
    const board = createIssueBoardSource(pool)
    stops.push(() => board.dispose())
    return () => {
      const found = board.queryIds({ kind: 'board', filter: { text: 'needle' } })
      return !found || found === LOADING ? [] : found.ids
    }
  },
  'phone Work'(pool: MobxPool) {
    const phone = worklistView(pool).phone
    phone.setQuery('needle')
    phone.setLane('closed')
    return () => [
      ...phone.sections.flatMap((section) => section.ids),
      ...phone.additionalHits.closed,
    ]
  },
}
for (const [name, open] of Object.entries(surfaces))
  describe(name, () => {
    it('finds a body match absent from this device through shared identities', async () => {
      const { pool, query, adopt } = fixture()
      const read = open(pool)
      let ids: readonly string[] = []
      const stop = autorun(() => {
        ids = read()
      })
      stops.push(stop)
      expect(ids).not.toContain('remote')
      expect(query).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(149)
      expect(query).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(query).toHaveBeenCalledTimes(1)
      expect(adopt).toHaveBeenCalledWith('issueProjection', ['remote', 'device'])
      expect(ids).toContain('remote')
      const identity = pool.issueObject('remote')
      pool.apply({
        type: 'update',
        rows: [row('remote', { title: 'Changed on the feed' })] as never,
      })
      expect(pool.issueObject('remote')).toBe(identity)
      expect(identity.title).toBe('Changed on the feed')
    })

    it('keeps device matches usable offline without a failed request', async () => {
      const { pool, query, adopt } = fixture(false)
      // All surfaces can display this closed device row, including the phone's Closed lane.
      pool.apply({
        type: 'update',
        rows: [row('device', { stage: 'done', closedAt: stamp })] as never,
      })
      const read = open(pool)
      let ids: readonly string[] = []
      stops.push(
        autorun(() => {
          ids = read()
        }),
      )
      await vi.advanceTimersByTimeAsync(500)
      expect(ids).toContain('device')
      expect(query).not.toHaveBeenCalled()
      expect(adopt).not.toHaveBeenCalled()
    })
  })

it('merges device IDs first, deduplicates and ignores a superseded in-flight reply', async () => {
  const { pool, adopt } = fixture()
  const resolve = new Map<string, (page: IssueSearchPage) => void>()
  const query = vi.fn(
    ({ text }: { text: string }) => new Promise<IssueSearchPage>((done) => resolve.set(text, done)),
  )
  issueSearch(pool).bind(query)
  const text = observable({ query: 'first' })
  let result: IssueSearchResult | undefined
  const stop = autorun(() => {
    result = issueSearch(pool).read(text.query, ['device'])
  })
  stops.push(stop)
  await vi.advanceTimersByTimeAsync(150)
  runInAction(() => {
    text.query = 'second'
  })
  expect(result?.ids).toEqual(['device'])
  await vi.advanceTimersByTimeAsync(150)
  resolve.get('second')!({ hits: [{ id: 'new' }, { id: 'device' }, { id: 'new' }], next: null })
  await vi.advanceTimersByTimeAsync(0)
  expect(result?.ids).toEqual(['device', 'new'])
  expect(result?.complete).toBe(true)
  resolve.get('first')!({ hits: [{ id: 'stale' }], next: null })
  await vi.advanceTimersByTimeAsync(0)
  expect(result?.ids).toEqual(['device', 'new'])
  expect(adopt).not.toHaveBeenCalledWith('issueProjection', ['stale'])
  expect(pool.tables.issue.has('stale')).toBe(false)
})

it('fails silently to device matches and cancels a closed search before its debounce', async () => {
  const { pool, adopt } = fixture()
  const query = vi.fn(async () => {
    throw new Error('offline')
  })
  issueSearch(pool).bind(query)
  let result: IssueSearchResult | undefined
  const stop = autorun(() => {
    result = issueSearch(pool).read('needle', ['device'])
  })
  await vi.advanceTimersByTimeAsync(150)
  expect(result).toMatchObject({ ids: ['device'], pending: false, complete: false })
  expect(adopt).not.toHaveBeenCalled()
  stop()
  const abandoned = autorun(() => {
    issueSearch(pool).read('abandoned', [])
  })
  abandoned()
  await vi.advanceTimersByTimeAsync(150)
  expect(query).toHaveBeenCalledTimes(1)
})

describe('paged server answers (POD-7108)', () => {
  const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => `hit-${from + i}`)
  function paged() {
    const { pool, adopt } = fixture()
    const pages: Record<string, IssueSearchPage> = {
      first: { hits: ids(0, ISSUE_SEARCH_PAGE).map((id) => ({ id })), next: 'after-first' },
      'after-first': { hits: ids(ISSUE_SEARCH_PAGE, 7).map((id) => ({ id })), next: null },
    }
    const query = vi.fn(async (input: IssueSearchInput) => pages[input.cursor ?? 'first']!)
    issueSearch(pool).bind(query)
    const want = observable.box(ISSUE_SEARCH_PAGE)
    let result: IssueSearchResult | undefined
    stops.push(
      autorun(() => {
        result = issueSearch(pool).read('re', [], undefined, want.get())
      }),
    )
    return { adopt, query, want, read: () => result }
  }

  it('installs only the first page until the view wants more', async () => {
    const { adopt, query, read } = paged()
    await vi.advanceTimersByTimeAsync(150)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith({ text: 're' })
    expect(adopt).toHaveBeenCalledTimes(1)
    expect(adopt).toHaveBeenCalledWith('issueProjection', ids(0, ISSUE_SEARCH_PAGE))
    expect(read()).toMatchObject({ more: true, pending: false })
    expect(read()?.serverIds).toEqual(ids(0, ISSUE_SEARCH_PAGE))
    await vi.advanceTimersByTimeAsync(1000)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('asks for the next page when the view scrolls past the first, installing only that page', async () => {
    const { adopt, query, want, read } = paged()
    await vi.advanceTimersByTimeAsync(150)
    runInAction(() => want.set(ISSUE_SEARCH_PAGE + 14))
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(2)
    expect(query).toHaveBeenLastCalledWith({ text: 're', cursor: 'after-first' })
    expect(adopt).toHaveBeenCalledTimes(2)
    expect(adopt).toHaveBeenLastCalledWith('issueProjection', ids(ISSUE_SEARCH_PAGE, 7))
    expect(read()?.serverIds).toEqual(ids(0, ISSUE_SEARCH_PAGE + 7))
    expect(read()?.more).toBe(false)
    // The answer is complete: wanting more asks nothing.
    runInAction(() => want.set(ISSUE_SEARCH_PAGE * 3))
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('stops paging after a failed page instead of retrying on every read', async () => {
    const { pool, adopt } = fixture()
    const query = vi.fn(async (input: IssueSearchInput) => {
      if (input.cursor) throw new Error('offline')
      return { hits: [{ id: 'remote' }], next: 'after-first' }
    })
    issueSearch(pool).bind(query)
    const want = observable.box(1)
    stops.push(
      autorun(() => {
        issueSearch(pool).read('re', [], undefined, want.get())
      }),
    )
    await vi.advanceTimersByTimeAsync(150)
    runInAction(() => want.set(2))
    await vi.advanceTimersByTimeAsync(0)
    runInAction(() => want.set(3))
    await vi.advanceTimersByTimeAsync(1000)
    expect(query).toHaveBeenCalledTimes(2)
    expect(adopt).toHaveBeenCalledTimes(1)
  })
})
