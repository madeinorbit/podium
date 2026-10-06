import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import {
  cwdInWorktree,
  reposToViews,
  resolveActiveWorktree,
  shippingPanelModel,
} from '@podium/client-core/values'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { installMobxWarnTrap } from '../../worklist-proto/harness/src/mobx-trap'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import type { HeaderRecord, HeaderRows } from './header-schema'
import { MobxPool } from './pool'

const stamp = '2026-10-04T12:00:00Z'
installMobxWarnTrap({ errors: true })
function fixture(scale: 1 | 4) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    header: true,
    worklist: 'demand',
    load: () => undefined,
    schedule: () => () => {},
  })
  const scan = (id: string, path: string, machineId?: string, worktrees: string[] = []) =>
    ({
      path,
      repoId: id,
      machineId,
      originUrl: `https://example.test/${id}`,
      worktrees: worktrees.map((path) => ({ path })),
    }) as HeaderRows['repository']
  const repos = [
    scan('first', '/r', 'm0', ['/r/wt']),
    scan('other', '/other', 'm1'),
    scan('deeper', '/r/deeper', 'm0'),
    scan('duplicate', '/r/wt', 'm2'),
    scan('wildcard', '/shared'),
    scan('trailing', '/tail/', 'm0'),
    ...Array.from({ length: 100 * scale }, (_, index) =>
      scan(`unrelated-${index}`, `/unrelated/${index}`, `unused-${index}`),
    ),
    // Matching path, unrelated machines: lookup must not scan this bucket either.
    ...Array.from({ length: 100 * scale }, (_, index) =>
      scan(`machine-${index}`, '/shared', `unused-${index}`),
    ),
  ]
  const contexts = [
    ['/r/sub', 'm0'],
    ['/other/sub', 'm1'],
    ['/r/deeper/sub', 'm0'],
    ['/r/wt/sub', 'm0'],
    ['/tail/sub', 'm0'],
    ['/shared/sub', 'm0'],
    ['/shared/sub', undefined],
    ['/r2', 'm0'],
    ['/r/wt/sub', 'm2'],
  ] as const
  const tabs = contexts.map(([worktreePath, machineId], index) => ({
    id: `file-${index}`,
    worktreePath,
    issueId: 'fallback',
    scope: { kind: 'worktree', machineId },
  })) as unknown as HeaderRows['window']['fileTabs']
  let window = {
    view: 'workspace',
    paneA: tabs[0]!.id,
    fileTabs: tabs,
    outboxSize: 0,
  } as HeaderRows['window']
  const orders = ['first', 'other', 'wildcard', 'trailing', 'fallback'].flatMap((repoId, index) =>
    Array.from(
      { length: index + 1 },
      (_, at) =>
        ({
          id: `${repoId}-${at}`,
          repoId,
          issueId: 'fallback',
          humanState: at ? 'in_progress' : 'needs_you',
          stateChangedAt: stamp,
          destination: 'main',
          targetBranch: 'main',
        }) as HeaderRows['shipOrder'],
    ),
  )
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'issue',
        id: 'fallback',
        value: {
          id: 'fallback',
          repoId: 'fallback',
          seq: 1,
          title: 'Fallback',
          stage: 'planning',
          createdAt: stamp,
          updatedAt: stamp,
          archived: false,
          deletedAt: null,
        } as never,
      },
    ],
  })
  const ids = repos.map((_, index) => `scan-${index}`)
  headerEntities(pool).apply([
    { kind: 'window', id: 'window', value: window },
    ...repos.map((value, index) => ({ kind: 'repository', id: ids[index]!, value })),
    ...orders.map((value) => ({ kind: 'shipOrder', id: value.id, value })),
  ] as HeaderRecord[])
  runInAction(() => headerEntities(pool).order('repository', ids))
  let painted = { unfinishedCount: 0, decisionCount: 0 }
  const stop = autorun(() => {
    painted = headerView(pool).shipping()
  })
  const expected = () => {
    const active = resolveActiveWorktree({ paneA: window.paneA, fileTabs: tabs, sessions: [] })
    let repoId: string | null = null,
      scanned = false
    if (active) {
      for (const repo of reposToViews(repos)) {
        const lane = repo.worktrees
          .filter(
            (lane) =>
              (!active.machineId || !lane.machineId || lane.machineId === active.machineId) &&
              cwdInWorktree(active.cwd, lane.path),
          )
          .sort((a, b) => b.path.length - a.path.length)[0]
        if (lane) {
          repoId = repo.repoId ?? lane.repoId ?? null
          scanned = true
          break
        }
      }
      if (!scanned && active.issueId === 'fallback') repoId = 'fallback'
    }
    const legacy = shippingPanelModel(orders, [], repoId)
    return { unfinishedCount: legacy.unfinishedCount, decisionCount: legacy.decisionCount }
  }
  return {
    pool,
    tabs,
    expected,
    painted: () => painted,
    select(id: string | null) {
      window = { ...window, paneA: id as HeaderRows['window']['paneA'] }
      headerEntities(pool).apply([{ kind: 'window', id: 'window', value: window }])
    },
    replaceScan(index: number, value: HeaderRows['repository'] | undefined) {
      if (value) repos[index] = value
      else repos.splice(index, 1)
      headerEntities(pool).apply([{ kind: 'repository', id: ids[index]!, value }])
    },
    reorder() {
      const reordered = [...repos].reverse()
      repos.splice(0, repos.length, ...reordered)
      runInAction(() => headerEntities(pool).order('repository', [...ids].reverse()))
    },
    dispose() {
      stop()
      pool.dispose()
    },
  }
}

it('keeps every pane path and machine lookup bounded at 1x/4x with exact legacy shipping counts', async () => {
  const measured = []
  for (const scale of [1, 4] as const) {
    const f = fixture(scale)
    try {
      expect(f.painted()).toEqual(f.expected())
      const steps = []
      for (const tab of f.tabs.slice(1)) {
        const { work } = await measureWork(async () => f.select(tab.id), { pool: f.pool })
        expect(f.painted()).toEqual(f.expected())
        steps.push({
          id: tab.id,
          rows: work.rows!,
          derivations: work.derivations,
          elements: work.elements,
        })
      }
      f.select(null)
      expect(f.painted()).toEqual(f.expected())
      measured.push({ scale, steps })
    } finally {
      f.dispose()
    }
  }
  for (let at = 0; at < measured[0]!.steps.length; at++) {
    const first = measured[0]!.steps[at]!,
      second = measured[1]!.steps[at]!
    expect(second.rows, first.id).toBeLessThanOrEqual(first.rows)
    expect(second.derivations, first.id).toBeLessThanOrEqual(first.derivations)
    expect(second.elements, first.id).toBeLessThanOrEqual(first.elements)
  }
  console.info('[shipping path work]', JSON.stringify(measured))
})

it('adopts resident scan changes, removal and group order without stale shipping counts', () => {
  const f = fixture(1)
  try {
    f.select(f.tabs[2]!.id)
    expect(f.painted()).toEqual(f.expected())
    f.replaceScan(0, {
      path: '/r',
      repoId: 'first',
      machineId: 'm2',
      worktrees: [{ path: '/r/wt' }],
    } as HeaderRows['repository'])
    expect(f.painted()).toEqual(f.expected())
    f.replaceScan(0, undefined)
    expect(f.painted()).toEqual(f.expected())
  } finally {
    f.dispose()
  }
  const ordered = fixture(1)
  try {
    ordered.select(ordered.tabs[2]!.id)
    ordered.reorder()
    expect(ordered.painted()).toEqual(ordered.expected())
  } finally {
    ordered.dispose()
  }
})

it('maintains shipping counts through one-order edits, moves and removal at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const f = fixture(scale)
    const orders = Array.from(
      { length: 128 * scale },
      (_, index) =>
        ({
          id: `count-${index}`,
          repoId: 'first',
          humanState: 'needs_you',
        }) as HeaderRows['shipOrder'],
    )
    headerEntities(f.pool).apply(orders.map((value) => ({ kind: 'shipOrder', id: value.id, value })))
    const rows = vi.spyOn(f.pool, 'row')
    let otherCounts = { unfinishedCount: 0, decisionCount: 0 }
    const stopOther = autorun(() => {
      otherCounts = headerEntities(f.pool).shippingCounts('other')
    })
    const measure = (name: string, action: () => void) =>
      measureWork(async () => insideReader(name, action), { pool: f.pool })
    const update = (value: HeaderRows['shipOrder'] | undefined) =>
      headerEntities(f.pool).apply([{ kind: 'shipOrder', id: 'count-0', value }])
    try {
      const first = await measure('first shipping counts', () => {
        const stop = autorun(() => {
          expect(headerView(f.pool).shipping()).toEqual({
            unfinishedCount: 128 * scale + 1,
            decisionCount: 128 * scale + 1,
          })
        })
        stop()
      })
      const edited = await measure('one shipping state', () =>
        update({ ...orders[0]!, humanState: 'waiting' }),
      )
      expect(f.painted()).toEqual({ unfinishedCount: 128 * scale + 1, decisionCount: 128 * scale })
      const moved = await measure('one shipping repository', () =>
        update({ ...orders[0]!, repoId: 'other' as HeaderRows['shipOrder']['repoId'] }),
      )
      expect(f.painted()).toEqual({ unfinishedCount: 128 * scale, decisionCount: 128 * scale })
      expect(otherCounts).toEqual({ unfinishedCount: 3, decisionCount: 2 })
      const restored = await measure('restore shipping repository', () => update(orders[0]))
      expect(otherCounts).toEqual({ unfinishedCount: 2, decisionCount: 1 })
      const shipped = await measure('finish shipping order', () =>
        update({ ...orders[0]!, humanState: 'shipped' }),
      )
      expect(f.painted()).toEqual({ unfinishedCount: 128 * scale, decisionCount: 128 * scale })
      const deleted = await measure('remove shipping order', () => update(undefined))
      expect(f.painted()).toEqual({ unfinishedCount: 128 * scale, decisionCount: 128 * scale })
      const repeated = await measure('repeat shipping removal', () => update(undefined))
      expect(rows.mock.calls.filter(([kind]) => String(kind) === 'shipOrder')).toEqual([])
      const control = await measure('whole shipping count control', () => {
        const stop = autorun(() => {
          shippingPanelModel(
            [...headerEntities(f.pool).tables.shipOrder.values()] as HeaderRows['shipOrder'][],
            [],
            'first',
          )
        })
        stop()
      })
      expect(control.work.elements).toBeGreaterThanOrEqual(128 * scale)
      samples.push({
        scale,
        first: first.work,
        edited: edited.work,
        moved: moved.work,
        restored: restored.work,
        shipped: shipped.work,
        deleted: deleted.work,
        repeated: repeated.work,
        control: control.work,
      })
    } finally {
      stopOther()
      rows.mockRestore()
      f.dispose()
    }
  }
  console.info('[shipping count work1x4x]', JSON.stringify(samples))
  for (const name of [
    'first',
    'edited',
    'moved',
    'restored',
    'shipped',
    'deleted',
    'repeated',
  ] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(samples[1]![name][counter], `${name}:${counter}`).toBe(samples[0]![name][counter])
})
