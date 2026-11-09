import { autorun, runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobxPool } from '../pool'
import { PhoneWorkFilters } from './phone'
import { worklistView } from './view-model'

const stamp = '2026-10-31T12:00:00Z'
const pools: MobxPool[] = []
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose()
})
const project = (id: string, index: number) => ({
  kind: 'worktree' as const,
  id: `/code/${id}`,
  value: {
    path: `/code/${id}`,
    repoPath: `/code/${id}`,
    repoId: id,
    repoName: id,
    isMain: true,
    projectIndex: index,
    projectRoot: true,
  },
})
const task = (id: string, patch: object = {}) => ({
  kind: 'issue' as const,
  id,
  value: {
    id,
    seq: 1,
    title: id,
    stage: 'in_progress',
    audience: 'human',
    repoId: 'alpha',
    repoPath: '/code/alpha',
    createdAt: stamp,
    updatedAt: stamp,
    deps: [],
    ...patch,
  },
})
/** My pin of a task: a `pin` record (POD-6692), never a field of its row. */
const pin = (id: string) => ({
  kind: 'pin' as const,
  id: `issue:${id}`,
  value: { userId: 'u1', kind: 'issue', entityId: id, pinnedAt: stamp },
})
function fixture() {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pools.push(pool)
  runInAction(() =>
    pool.apply({
      type: 'replace',
      rows: [
        project('alpha', 0),
        project('empty', 1),
        project('beta', 2),
        task('pinned-ask', { stage: 'review', title: 'Review the API' }),
        pin('pinned-ask'),
        task('live', { title: 'Reconnect gracefully' }),
        task('nap', { deferUntil: '2026-11-01T12:00:00Z' }),
        pin('nap'),
        pin('recent'),
        task('recent', {
          stage: 'done',
          closedReason: 'done',
          closedAt: '2026-10-29T12:00:00Z',
          updatedAt: '2026-10-29T12:00:00Z',
        }),
        task('old', {
          stage: 'done',
          closedReason: 'done',
          closedAt: '2026-10-20T12:00:00Z',
          updatedAt: '2026-10-20T12:00:00Z',
        }),
        task('beta-live', { repoId: 'beta', repoPath: '/code/beta' }),
      ] as never,
    }),
  )
  return { pool, model: worklistView(pool), phone: worklistView(pool).phone }
}
const rows = (phone: ReturnType<typeof fixture>['phone']) =>
  phone.sections.flatMap((section) => section.ids)

describe('phone Work list desktop parity', () => {
  it('keeps search reads inside the working set as unrelated archived history grows', () => {
    const calls: number[] = []
    for (const scale of [1, 4]) {
      const { pool, model, phone } = fixture()
      runInAction(() =>
        pool.apply({
          type: 'update',
          rows: Array.from({ length: 120 * scale }, (_, index) =>
            task(`history-${index}`, { archived: true, title: 'Reconnect old history' }),
          ) as never,
        }),
      )
      let shown: readonly string[] = []
      const stop = autorun(() => {
        shown = rows(phone)
        void phone.otherLaneHits
      })
      const reader = vi.spyOn(model, 'knownRow')
      try {
        phone.setQuery('reconnect')
        expect(shown).toEqual(['live'])
        expect(reader.mock.calls.every(([id]) => !id.startsWith('history-'))).toBe(true)
        calls.push(reader.mock.calls.length)
      } finally {
        reader.mockRestore()
        stop()
      }
    }
    expect(calls[0]).toBeGreaterThan(0)
    expect(calls[1]).toBe(calls[0])
  })

  it('labels an unregistered pinned-only project with one addressed task read', () => {
    const { pool, model, phone } = fixture()
    runInAction(() =>
      pool.apply({
        type: 'update',
        rows: [
          task('nap', {
            repoId: 'orphan',
            repoPath: '/code/paper-prototype',
            deferUntil: '2026-11-01T12:00:00Z',
          }),
        ] as never,
      }),
    )
    phone.setLane('snoozed')
    const section = phone.section('orphan')
    const stop = autorun(() => {
      void section.ids
      void section.label
    })
    const reader = vi.spyOn(model, 'knownRow')
    try {
      expect(section.label).toBe('paper-prototype')
      expect(reader.mock.calls).toEqual([['nap']])
    } finally {
      reader.mockRestore()
      stop()
    }
  })

  it('retains lane and query across a same-account pool reattachment without carrying old records', () => {
    const filters = new PhoneWorkFilters()
    const first = fixture()
    first.phone.setFilters(filters)
    first.phone.setQuery('nap')
    first.phone.setLane('snoozed')
    const second = fixture()
    second.phone.setFilters(filters)
    expect(second.phone.query).toBe('nap')
    expect(second.phone.lane).toBe('snoozed')
    expect(second.phone.worklist.pool).not.toBe(first.pool)
    expect(rows(second.phone)).toEqual(['nap'])
  })
  it('borrows desktop ordering and membership once, including pinned asks and empty projects', () => {
    const { model, phone } = fixture()
    model.setLayout({ projectOrder: ['beta', 'empty', 'alpha'] })
    const desktop = model.sections()
    expect(phone.sections.map((section) => section.key)).toEqual([
      'pinned',
      ...desktop.bands.map((band) => band.key),
    ])
    expect(rows(phone)).toEqual(['pinned-ask', ...desktop.bands.flatMap((band) => band.rowIds)])
    expect(rows(phone).filter((id) => id === 'pinned-ask')).toHaveLength(1)
    expect(phone.section('empty').ids).toEqual([])
    expect(phone.sections.some((section) => section.key === 'needsYou')).toBe(false)
  })

  it('files still-pinned snoozed and recent closed tasks under their project, with the desktop time window', () => {
    const { model, phone } = fixture()
    const desktop = model.sections()
    phone.setLane('snoozed')
    expect(phone.sections.map((section) => section.key)).not.toContain('pinned')
    expect(rows(phone)).toEqual([...desktop.bands.flatMap((band) => band.snoozedIds), 'nap'])
    expect(rows(phone)).toContain('nap')
    phone.setLane('closed')
    expect(phone.sections.map((section) => section.key)).not.toContain('pinned')
    expect(rows(phone)).toEqual(['recent'])
    expect(rows(phone)).toContain('recent')
    expect(rows(phone)).not.toContain('old')
  })

  it('searches the current row word and finds matching tasks in other lanes without mixing them in', () => {
    const { phone } = fixture()
    phone.setQuery('needs review')
    expect(rows(phone)).toEqual(['pinned-ask'])
    phone.setQuery('nap')
    expect(rows(phone)).toEqual([])
    expect(phone.otherLaneHits.snoozed).toBe(1)
    phone.setLane('snoozed')
    expect(rows(phone)).toEqual(['nap'])
    expect(phone.otherLaneHits.snoozed).toBe(0)
    phone.setQuery('  RECONNECT  ')
    expect(phone.otherLaneHits.open).toBe(1)
    phone.setLane('open')
    expect(rows(phone)).toEqual(['live'])
  })

  it('keeps the snooze date in the sparse row and handles next-message snoozes', () => {
    const { model, pool } = fixture()
    expect(model.knownRow('nap')?.snoozeLabel).toMatch(/^Snoozed until /)
    runInAction(() =>
      pool.apply({ type: 'update', rows: [task('nap', { deferUntil: 'next-message' })] as never }),
    )
    expect(model.knownRow('nap')?.snoozeLabel).toBe('Snoozed until next message')
  })

  it('keeps the same section objects and row-id arrays through a title change, while live search updates', () => {
    const { pool, phone } = fixture()
    let seen = rows(phone)
    const stop = autorun(() => {
      seen = rows(phone)
    })
    try {
      const sections = phone.sections,
        section = phone.section('alpha'),
        ids = section.ids
      runInAction(() =>
        pool.apply({ type: 'update', rows: [task('live', { title: 'A fresh title' })] as never }),
      )
      expect(phone.sections).toBe(sections)
      expect(phone.section('alpha')).toBe(section)
      expect(section.ids).toBe(ids)
      phone.setQuery('fresh')
      expect(seen).toEqual(['live'])
      runInAction(() =>
        pool.apply({ type: 'update', rows: [task('live', { title: 'Renamed again' })] as never }),
      )
      expect(seen).toEqual([])
    } finally {
      stop()
    }
  })
})
