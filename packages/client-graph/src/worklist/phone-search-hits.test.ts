import { autorun } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { issueSearch } from '../issue-search'
import { MobxPool } from '../pool'
import type { CollectionLoaderPort } from '../shared/source'
import { worklistView } from './view-model'

// Phone Work search on upstream's server search (POD-2656 review finding 1):
// a sub-task that a listed parent names as its search hit shows only under that
// parent, and a server hit no listed parent represents keeps its own row.

const stamp = '2026-10-01T12:00:00Z'
const issue = (id: string, patch: object = {}) => ({
  kind: 'issue' as const,
  id,
  value: {
    id,
    seq: id.length,
    title: id,
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

/** A pool whose server search answers `serverHits`; every record is on the device. */
function fixture(rows: ReturnType<typeof issue>[], serverHits: readonly string[]) {
  vi.useFakeTimers()
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  stops.push(() => pool.dispose())
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'repo', id: 'r', value: { id: 'r', repoPath: '/repo', prefix: 'POD' } },
      ...rows,
    ] as never,
  })
  const port: CollectionLoaderPort = {
    online: true,
    firstDownload: false,
    isComplete: (spec) => (spec.collection === 'issueProjection.stubs' ? {} : undefined),
    wasRefused: () => false,
    subscribe: () => () => {},
    request() {},
    show: () => () => {},
    status: () => 'loading',
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
  const query = vi.fn(async () => ({ hits: serverHits.map((id) => ({ id })), next: null }))
  issueSearch(pool).bind(query)
  const phone = worklistView(pool).phone
  return { phone, query }
}

async function search(phone: ReturnType<typeof fixture>['phone'], needle: string) {
  let shown: string[] = []
  let hits: readonly string[] = []
  stops.push(
    autorun(() => {
      shown = phone.sections.filter((s) => s.key !== 'search-results').flatMap((s) => s.ids)
      hits = phone.additionalHits.open
    }),
  )
  phone.setQuery(needle)
  await vi.advanceTimersByTimeAsync(1_000)
  return { shown: () => shown, hits: () => hits }
}

it('shows a title-matching sub-task only under its listed parent, not again as a search result', async () => {
  const { phone, query } = fixture(
    [
      issue('parent', { title: 'Parent' }),
      issue('child', { title: 'Überfall plan', parentId: 'parent' }),
    ],
    ['child'],
  )
  const view = await search(phone, 'überfall')
  expect(query).toHaveBeenCalled()
  expect(view.shown()).toContain('parent')
  expect(phone.childHit('parent')).toBe('child')
  expect(view.hits()).not.toContain('child')
})

it.each([
  ['description', { description: 'Der Überfall' }],
  ['brief', { brief: 'Der Überfall' }],
])('keeps a server hit that matches only by %s as its own search result', async (_field, body) => {
  const { phone, query } = fixture(
    [
      issue('parent', { title: 'Parent' }),
      issue('child', { title: 'Child', parentId: 'parent', ...body }),
    ],
    // The server matched the child's body; the device's title/ref matcher cannot.
    ['child'],
  )
  const view = await search(phone, 'überfall')
  expect(query).toHaveBeenCalled()
  expect(phone.childHit('parent')).toBeNull()
  expect(view.shown()).not.toContain('parent')
  expect(view.hits()).toContain('child')
})
