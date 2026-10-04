import {
  cwdInWorktree,
  reposToViews,
  resolveActiveWorktree,
  shippingPanelModel,
} from '@podium/client-core/viewmodels'
import { autorun, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { installMobxWarnTrap } from '../../worklist-proto/harness/src/mobx-trap'
import { measureWork } from '../../worklist-proto/harness/src/work-meter'
import type { HeaderRecord, HeaderRows } from './header-schema'
import { MobxPool } from './pool'

const stamp = '2026-10-04T12:00:00Z'
installMobxWarnTrap()
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
  pool.header.apply([
    { kind: 'window', id: 'window', value: window },
    ...repos.map((value, index) => ({ kind: 'repository', id: ids[index]!, value })),
    ...orders.map((value) => ({ kind: 'shipOrder', id: value.id, value })),
  ] as HeaderRecord[])
  pool.header.order('repository', ids)
  let painted = pool.headerViews.shipping()
  const stop = autorun(() => {
    painted = pool.headerViews.shipping()
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
      pool.header.apply([{ kind: 'window', id: 'window', value: window }])
    },
    replaceScan(index: number, value: HeaderRows['repository'] | undefined) {
      if (value) repos[index] = value
      else repos.splice(index, 1)
      pool.header.apply([{ kind: 'repository', id: ids[index]!, value }])
    },
    reorder() {
      const reordered = [...repos].reverse()
      repos.splice(0, repos.length, ...reordered)
      runInAction(() => pool.header.order('repository', [...ids].reverse()))
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
