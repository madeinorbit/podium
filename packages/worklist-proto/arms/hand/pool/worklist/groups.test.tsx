import { allIssueViewModels } from '@podium/client-core/replica'
// @vitest-environment happy-dom
/**
 * POD-4583 (Hb2) — groups, closed folds and the windowed list on the live
 * engine, 1x live-shaped fixture, fence steps #1-#7 in methodology order on
 * one engine. The same instruments as the MobX arm's Mb2 test
 * (`arms/mobx/pool/worklist/groups.test.tsx`) and the hand arm's Hb1 test
 * (`worklist/visible.test.tsx`): the legacy oracle, the shared fences, the
 * checker.
 *
 * PARITY, after bootstrap and after every step: the pool's grouped order
 * (`groups.snapshot`, no selection) equals the legacy oracle's `SliceOrder`
 * (`snapshotFromStore` at the unselected baseline: pinned ids, group keys,
 * labels, open lanes, closed folds); the visible rows equal the oracle's
 * flat rows; the settled snapshot equals the pool's own rebuild, which groups
 * with L1b's `groupKeyOf` / `compareClosedFold` instead of the live layout;
 * and the own-row fields equal the oracle's row views (the roll-ups are
 * Hb3's and stay out of the field comparison, as in Hb1).
 *
 * THE EMPTIED TRIPWIRE (was STUB_WAITING, Hb2). The fold verdict's "nothing
 * in the subtree waits" conjunct is Hb3's waiting roll-up, so no settled
 * closed root whose subtree asks may fold here while staying open in the
 * oracle. The parity check still derives that exception set from the oracle
 * and now asserts it EMPTY at bootstrap and every step: a regression to the
 * stub shows by name. No `it.fails`, no open-ended exception.
 *
 * FENCES: each step commits exactly the oracle-changed rows and reads within
 * its budget (the shared `assertCommits` / `assertReads`) — #7's reparented
 * parents included, whose progress-only changes Hb3 now draws; the layout
 * re-runs only when the order or a visible row's placement moved
 * (`counters.groupRuns`, `counters.groupElements`: the elements one run
 * touches, counted from outside the pool); a group header is notified
 * exactly when its own lanes changed, never on a row-internal change.
 *
 * PLANTS (each must fail its assertion on the planted arm, proving the
 * instrument fails on a control): a header reading its rows (reads fence);
 * an ungated layout (runs on a heartbeat); lanes without identity-keeping
 * (headers notified on a heartbeat); a whole-list layout (elements exceed the
 * visible count); a fold oldest-first (group parity).
 */

import type { SliceIssue, SliceOrder } from '@podium/client-graph/shared/slice-types'
import { act, createElement, type ReactElement, useCallback, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type HarnessHandPoolHandle,
  harnessHandPoolArm,
  poolPendingLoads,
} from '../../../../harness/src/adapters/hand-pool'
import {
  assertCommits,
  assertReads,
  mountArmForCounts,
} from '../../../../harness/src/count-harness'
import {
  engineLocals,
  FENCE_SCENARIOS,
  openFenceFeeds,
  parityLocals,
  runFenceStep,
} from '../../../../harness/src/fence-scenarios'
import {
  legacyDerivationFromStore,
  rowViewsFromStore,
  snapshotFromStore,
  visibleIssueRows,
} from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm } from '../../../../shared/src/arm'
import { diffSnapshots } from '../../../../shared/src/gen/check'
import { type ScenarioEngine, startScenarioEngine } from '../../../../shared/src/scenarios'
import type { HandPool } from '../pool'
import { HEADER_HEIGHT, PoolList, ROW_HEIGHT } from '../react/list'
import { layoutOf, placementRuleOf, sliceOrderOf } from './groups'

/** The pool with a load window that never closes on its own: no load lands inside a counted step. */
const arm: CheckableArm = {
  create: (source, locals, reads) =>
    harnessHandPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

const STEPS = ['#1', '#2', '#3', '#4', '#5', '#6a', '#6b', '#6c', '#6d', '#7'] as const

/** The row fields Hb2's rows carry from the own row and one hop (the roll-ups are Hb3's). */
const OWN_FIELDS = [
  'displayRef',
  'title',
  'band',
  'repoKey',
  'pinned',
  'sortKey',
  'createdAt',
  'seq',
  'foldAt',
  'originTick',
] as const

/** Land every queued load (the mount and the visibility parts ask for cold rows). */
function settle(handle: HarnessHandPoolHandle): number {
  const before = handle.pool.residency?.counters.hydrated ?? 0
  act(() => {
    handle.settleLoads()
  })
  expect(poolPendingLoads(handle.pool)).toBe(0)
  return (handle.pool.residency?.counters.hydrated ?? 0) - before
}

/** An order-only snapshot, so `diffSnapshots` names group differences alone. */
function orderDiff(actual: SliceOrder, expected: SliceOrder): string | null {
  return diffSnapshots({ order: actual, rowsById: {} }, { order: expected, rowsById: {} })
}

/**
 * Rows the waiting conjunct holds open: the pool folds them (its placement
 * says closed) while the oracle keeps them open, and the oracle says they
 * ask. Derived from the oracle, so a regression to the stub shows by name —
 * and since Hb3 wires the waiting conjunct, the set must be empty.
 */
function waitingKept(ctx: ScenarioEngine, pool: HandPool, expected: SliceOrder): Set<string> {
  const store = ctx.engine.getSnapshot()
  const views = rowViewsFromStore(store, { ...engineLocals(ctx), selectedIssueId: null })
  const open = new Set(expected.groups.flatMap((group) => group.rowIds))
  const kept = new Set<string>()
  for (const issue of allIssueViewModels(
    store.replica,
    store.issueProjections,
    store.issueUserStates,
  ) as unknown as SliceIssue[]) {
    if (!open.has(issue.id)) continue
    const view = views[issue.id]
    if (view === undefined || view.closed) continue
    const placement = pool.groups.placement(issue.id)
    if (placement?.closed !== true) continue
    expect(view.asking, `${issue.id}: open in the oracle only because it asks`).toBe(true)
    kept.add(issue.id)
  }
  return kept
}

interface GroupParity {
  readonly at: string
  readonly waitingKept: readonly string[]
  readonly visible: number
  readonly pinned: number
  readonly groups: number
  readonly open: number
  readonly closed: number
}

function checkParity(ctx: ScenarioEngine, handle: HarnessHandPoolHandle, at: string): GroupParity {
  const { pool } = handle
  const locals = parityLocals(ctx)
  const store = ctx.engine.getSnapshot()
  const expected = snapshotFromStore(store, locals)
  const oracle = expected.order
  const kept = waitingKept(ctx, pool, oracle)
  expect([...kept].sort(), `${at}: the waiting conjunct holds nothing open`).toEqual([])
  expect(
    orderDiff(sliceOrderOf(pool.groups.snapshot()), oracle),
    `${at}: groups against the oracle`,
  ).toBeNull()
  const flat = visibleIssueRows(legacyDerivationFromStore(store, locals.coarseNow), locals).map(
    (row) => row.issue.id,
  )
  expect([...pool.order()], `${at}: visible order`).toEqual(flat)
  const snapshot = handle.snapshot()
  expect(diffSnapshots(snapshot, handle.rebuildFromScratch()), `${at}: rebuild`).toBeNull()
  const views = rowViewsFromStore(store, engineLocals(ctx))
  const diffs: string[] = []
  for (const id of pool.order()) {
    const live = pool.view(id)
    const oracleView = views[id]
    for (const field of OWN_FIELDS) {
      if (JSON.stringify(live?.[field]) !== JSON.stringify(oracleView?.[field])) {
        diffs.push(
          `${id}.${field}: ${JSON.stringify(live?.[field])} (oracle ${JSON.stringify(oracleView?.[field])})`,
        )
      }
    }
  }
  expect(diffs.slice(0, 10), `${at}: own-row fields`).toEqual([])
  const live = sliceOrderOf(pool.groups.snapshot())
  return {
    at,
    waitingKept: [...kept].sort(),
    visible: flat.length,
    pinned: live.pinnedIds.length,
    groups: live.groups.length,
    open: live.groups.reduce((n, group) => n + group.rowIds.length, 0),
    closed: live.groups.reduce((n, group) => n + group.closedIds.length, 0),
  }
}

/** Each group's UI lanes, as the headers observe them. */
function lanes(pool: HandPool): Map<string, readonly (readonly string[])[]> {
  return new Map(
    pool.groupsView().keys.map((key) => {
      const group = pool.groupLanes(key)
      return [key, [[group.label], group.rowIds, group.closedIds]] as const
    }),
  )
}

/** Groups whose lanes differ between two `lanes` readings (present in either). */
function changedGroups(
  before: Map<string, readonly (readonly string[])[]>,
  after: Map<string, readonly (readonly string[])[]>,
): string[] {
  const keys = new Set([...before.keys(), ...after.keys()])
  return [...keys]
    .filter((key) => JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)))
    .filter((key) => after.has(key))
    .sort()
}

describe('groups and closed folds (Hb2)', () => {
  it('parity at 1x through #1-#7; commits, reads, layout runs and header notices follow the change', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    const handle = mounted.handle as HarnessHandPoolHandle
    const { pool } = handle
    try {
      settle(handle)
      const parity: GroupParity[] = [checkParity(ctx, handle, 'bootstrap')]
      // The waiting conjunct is wired: it holds nothing open.
      expect(parity[0]!.waitingKept).toEqual([])
      const cells = []
      for (const methodology of STEPS) {
        mounted.log.reset()
        handle.stats.reset()
        mounted.reads.reset()
        const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
        expect(entry, methodology).toBeDefined()
        const orderBefore = [...pool.order()]
        const lanesBefore = lanes(pool)
        // One test listener per group, as each header holds one.
        const notices = new Map<string, number>()
        const offs = pool
          .groupsView()
          .keys.map((key) =>
            pool.subscribeGroup(key, () => notices.set(key, (notices.get(key) ?? 0) + 1)),
          )
        const viewNotices: number[] = []
        const offView = pool.subscribeGroups(() => viewNotices.push(1))
        const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry!)
        for (const off of offs) off()
        offView()
        assertCommits(result)
        assertReads(result, { readsPerChange: readsBudget })
        mounted.reads.assertNoCopies(mounted.handle)
        const counters = { ...pool.stats.counters }
        const orderMoved = JSON.stringify(orderBefore) !== JSON.stringify([...pool.order()])
        const lanesAfter = lanes(pool)
        const addedKeys = [...lanesAfter.keys()].filter((key) => !lanesBefore.has(key))
        const groupsChanged = changedGroups(lanesBefore, lanesAfter)
        // A header is notified exactly for its own group's lane change (a
        // group added by the step has no header yet; the list covers it).
        expect(
          [...notices.entries()]
            .filter(([, n]) => n > 0)
            .map(([key]) => key)
            .sort(),
          `${methodology}: notified headers`,
        ).toEqual(groupsChanged.filter((key) => !addedKeys.includes(key)))
        // The list is notified exactly when the lanes moved.
        expect(viewNotices.length > 0, `${methodology}: list notified`).toBe(
          groupsChanged.length > 0 || orderMoved,
        )
        // Nothing moved: the layout never re-ran (a row-internal change stops at its placement).
        if (!orderMoved && groupsChanged.length === 0) {
          expect(counters.groupRuns, `${methodology}: layout runs`).toBe(0)
        }
        // A run files exactly the rows that moved: its elements are the
        // touched lanes, never more than the visible count (POD-4694: the
        // scaling test holds them to the moved lane).
        if (counters.groupRuns > 0) {
          expect(counters.groupElements, `${methodology}: layout elements`).toBeLessThanOrEqual(
            counters.groupRuns * pool.order().length,
          )
        }
        cells.push({
          methodology,
          scenario: result.scenario,
          oracleChanged: result.oracleChangedRows,
          rowsCommitted: result.rowsCommitted,
          readsPerChange: result.readsPerChange,
          readsBudget,
          orderMoved,
          groupRuns: counters.groupRuns,
          groupElements: counters.groupElements,
          groupsChanged,
          headerNotices: [...notices.values()].reduce((a, b) => a + b, 0),
        })
        parity.push(checkParity(ctx, handle, methodology))
      }
      // #1-#4 change no order and no placement.
      for (const cell of cells.slice(0, 4)) {
        expect(cell.groupRuns, `${cell.methodology}: layout runs`).toBe(0)
        expect(cell.headerNotices, `${cell.methodology}: header notices`).toBe(0)
      }
      // #2 and #4 redraw a row and no header (the brief's pitfall).
      expect(cells[1]!.rowsCommitted).toBeGreaterThan(0)
      expect(cells[3]!.rowsCommitted).toBeGreaterThan(0)
      // The header counter can say yes: some step changed a group's lanes.
      expect(cells.some((cell) => cell.headerNotices > 0)).toBe(true)
      writeResult('hand-groups-1x', { scale: 1, parity, cells })
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 600_000)

  it('the fold latch holds a selected grace-folded row open; a dismissal or a folded click does not', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = arm.create(feeds.rows.source, feeds.locals.source) as HarnessHandPoolHandle
    const { pool } = handle
    try {
      settle(handle)
      const where = (id: string) => {
        for (const key of pool.groupsView().keys) {
          const group = pool.groupLanes(key)
          if (group.rowIds.includes(id)) return { key, lane: 'open' }
          if (group.closedIds.includes(id)) return { key, lane: 'closed' }
        }
        return null
      }
      const placed = pool.order().map((id) => ({ id, placement: pool.groups.placement(id) }))
      const grace = placed.find(
        ({ placement }) => placement?.closed === true && !placement.dismissed && !placement.pinned,
      )
      const dismissed = placed.find(
        ({ placement }) => placement?.dismissed === true && !placement.pinned,
      )
      expect(grace, 'a grace-folded row in the fixture').toBeDefined()
      expect(dismissed, 'a dismissed row in the fixture').toBeDefined()
      const snapshotOrder = () => sliceOrderOf(pool.groups.snapshot())
      const baseline = snapshotOrder()
      const coarseNow = ctx.engine.getSnapshot().coarseNow
      const select = (id: string, wasFolded?: boolean) =>
        pool.applyLocals(
          {
            selectedIssueId: id,
            coarseNow,
            ...(wasFolded === undefined ? {} : { selectedIssueWasFolded: wasFolded }),
          },
          new Set(['selectedIssueId', 'selectedIssueWasFolded'] as const),
        )
      expect(where(grace!.id)?.lane).toBe('closed')

      pool.stats.reset()
      select(grace!.id)
      const latched = where(grace!.id)
      expect(latched?.lane).toBe('open')
      // At its rank: every open neighbour before it ranks before it.
      const open = pool.groupLanes(latched!.key).rowIds
      const rank = [...pool.order()]
      for (let i = 1; i < open.length; i += 1) {
        expect(rank.indexOf(open[i - 1]!)).toBeLessThan(rank.indexOf(open[i]!))
      }
      // The snapshot stays the unselected baseline, and the layout did not re-run.
      expect(orderDiff(snapshotOrder(), baseline)).toBeNull()
      expect(pool.stats.counters.groupRuns).toBe(0)

      select(grace!.id, true)
      expect(where(grace!.id)?.lane).toBe('closed')
      select(dismissed!.id, false)
      expect(where(dismissed!.id)?.lane).toBe('closed')
      select(grace!.id, false)
      expect(where(grace!.id)?.lane).toBe('open')
      pool.applyLocals({ selectedIssueId: null, coarseNow }, new Set(['selectedIssueId'] as const))
      expect(where(grace!.id)?.lane).toBe('closed')
    } finally {
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)

  it('layout elements follow the visible count at 4x', async () => {
    const ctx = await startScenarioEngine(4)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    // Bootstrap counts on an unmounted arm: the mount resets the stats, so
    // the replace's own settle is only visible before one.
    {
      const handle = arm.create(feeds.rows.source, feeds.locals.source) as HarnessHandPoolHandle
      try {
        settle(handle)
        // One bootstrap run over the visible count (the settle of the replace).
        expect(handle.pool.stats.counters.groupRuns).toBe(1)
        expect(handle.pool.stats.counters.groupElements).toBe(handle.pool.order().length)
        const parity = checkParity(ctx, handle, 'bootstrap')
        expect(parity.waitingKept).toEqual([])
        writeResult('hand-groups-bootstrap-4x', {
          scale: 4,
          visible: handle.pool.order().length,
          runs: handle.pool.stats.counters.groupRuns,
          elements: handle.pool.stats.counters.groupElements,
          waitingKept: parity.waitingKept,
        })
      } finally {
        handle.dispose()
      }
    }
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    const handle = mounted.handle as HarnessHandPoolHandle
    const { pool } = handle
    try {
      settle(handle)
      const parity = [checkParity(ctx, handle, 'bootstrap')]
      const cells = []
      for (const methodology of ['#5', '#1'] as const) {
        mounted.log.reset()
        handle.stats.reset()
        mounted.reads.reset()
        const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
        const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry!)
        assertCommits(result)
        assertReads(result, { readsPerChange: readsBudget })
        const counters = { ...pool.stats.counters }
        if (counters.groupRuns > 0) {
          expect(counters.groupElements, `${methodology}: layout elements`).toBeLessThanOrEqual(
            counters.groupRuns * pool.order().length,
          )
        }
        cells.push({
          methodology,
          groupRuns: counters.groupRuns,
          groupElements: counters.groupElements,
          visible: pool.order().length,
        })
        parity.push(checkParity(ctx, handle, methodology))
      }
      writeResult('hand-groups-4x', {
        scale: 4,
        visible: pool.order().length,
        parity,
        cells,
      })
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 600_000)
})

describe('the windowed web list (Hb2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('draws a window, loads only its cold rows, scrolls, and folds a group', async () => {
    // The browser harness's viewport height (`harness/browser/run.ts`).
    const height = 5800
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute('data-pool-list') ? height : 0
    })
    // react-virtual measures the scroll element by its offset box.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute('data-pool-list') ? height : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute('data-pool-list') ? 1600 : 0
    })
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    // Distinct rows read through the feed's per-row read, per phase.
    let phase: 'bootstrap' | 'firstWindow' | 'later' = 'bootstrap'
    const feedReads = {
      bootstrap: new Set<string>(),
      firstWindow: new Set<string>(),
      later: new Set<string>(),
    }
    const source = feeds.rows.source
    const counting = {
      ...source,
      snapshot: source.snapshot.bind(source),
      subscribe: source.subscribe.bind(source),
      row: (kind: 'issue' | 'session', id: string) => {
        feedReads[phase].add(`${kind}:${id}`)
        return source.row?.(kind, id)
      },
    }
    const handle = harnessHandPoolArm.create(counting, feeds.locals.source, undefined, {
      schedule: () => () => {},
    }) as HarnessHandPoolHandle
    const { pool } = handle
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    try {
      phase = 'firstWindow'
      await act(async () => {
        root.render(<PoolList pool={pool} />)
      })
      settle(handle)
      const visible = pool.order().length
      const drawn = () => el.querySelectorAll('[data-issue-row], [data-loading-row]').length
      const firstWindow = drawn()
      // A window, not the list: the viewport's worth of items plus overscan.
      expect(firstWindow).toBeGreaterThan(0)
      expect(firstWindow).toBeLessThanOrEqual(Math.ceil(height / HEADER_HEIGHT) + 10)
      expect(firstWindow).toBeLessThan(visible)
      const queuedAtPaint = poolPendingLoads(pool)
      const coldVisible = pool.order().filter((id) => pool.residency?.isCold('issue', id)).length
      // What drawing the WHOLE list would load: every cold visible row and
      // every cold origin a visible spin-off's tick names. Since POD-4665 the
      // schema keeps visible rows resident (coldVisible is 0), so what is left
      // is the ticked origins; the window loads only those its rows reach.
      const wholeListLoads = (() => {
        const cold = new Set<string>()
        for (const id of pool.order()) {
          if (pool.residency?.isCold('issue', id)) cold.add(id)
          const origin = pool.relations.one('issue', id, 'discoveredFrom')
          if (origin !== null && pool.residency?.isCold('issue', origin)) cold.add(origin)
        }
        return cold.size
      })()
      expect(coldVisible).toBe(0)
      expect(queuedAtPaint).toBeLessThan(wholeListLoads)
      const hydratedBefore = pool.residency?.counters.hydrated ?? 0
      settle(handle)
      const loadedSettlingFirstWindow = (pool.residency?.counters.hydrated ?? 0) - hydratedBefore
      phase = 'later'
      const byKind = (set: Set<string>) => {
        const out: Record<string, number> = { distinct: set.size }
        for (const key of set) {
          const kind = key.split(':')[0] as string
          out[kind] = (out[kind] ?? 0) + 1
        }
        return out
      }

      // Scroll to the end: the window moves, the last rows draw.
      const list = el.querySelector('[data-pool-list]') as HTMLElement
      const keys = pool.groupsView().keys
      const lastGroup = pool.groupLanes(keys[keys.length - 1]!)
      const lastId = lastGroup.closedIds.at(-1) ?? lastGroup.rowIds.at(-1)
      expect(el.querySelector(`[data-issue-row="${lastId}"]`)).toBeNull()
      await act(async () => {
        list.scrollTop = 10_000_000
        list.dispatchEvent(new Event('scroll'))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      settle(handle)
      expect(el.querySelector(`[data-issue-row="${lastId}"]`)).not.toBeNull()
      expect(drawn()).toBeLessThan(visible)

      // Fold the first group with a closed fold: its closed rows leave the list.
      await act(async () => {
        list.scrollTop = 0
        list.dispatchEvent(new Event('scroll'))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      const folding = pool
        .groupsView()
        .keys.find((key) => pool.groupLanes(key).closedIds.length > 0)
      expect(folding).toBeDefined()
      const header = el.querySelector(`[data-group="${folding}"] button`) as HTMLButtonElement
      expect(header).not.toBeNull()
      const totalBefore = (list.firstElementChild as HTMLElement).style.height
      act(() => header.click())
      expect(el.querySelector(`[data-group="${folding}"]`)?.getAttribute('data-folded')).toBe(
        'true',
      )
      const closedCount = pool.groupLanes(folding!).closedIds.length
      const totalAfter = (list.firstElementChild as HTMLElement).style.height
      expect(Number.parseFloat(totalBefore) - Number.parseFloat(totalAfter)).toBe(
        closedCount * ROW_HEIGHT,
      )
      writeResult('hand-groups-window-1x', {
        visible,
        firstWindowDrawn: firstWindow,
        feedReadsAtBootstrap: byKind(feedReads.bootstrap),
        feedReadsSettlingFirstWindow: byKind(feedReads.firstWindow),
        rowsLoadedSettlingFirstWindow: loadedSettlingFirstWindow,
      })
    } finally {
      act(() => root.unmount())
      el.remove()
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)
})

describe('plants that must fail (Hb2)', () => {
  it('a header reading its rows fails the reads fence', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    const handle = mounted.handle as HarnessHandPoolHandle
    const { pool } = handle
    try {
      settle(handle)
      // The plant header: subscribed to its group's lanes (so a lane change
      // re-renders it, as a real header) but reading every row of its group
      // through the fenced tables on each render, as a header that renders
      // its rows' fields would.
      const key = pool.groupsView().keys[0]!
      let renders = 0
      const plant = document.createElement('div')
      document.body.appendChild(plant)
      const root = createRoot(plant)
      await act(async () => {
        root.render(
          createElement(PlantHeader, { pool, groupKey: key, onRender: () => (renders += 1) }),
        )
      })
      const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === '#5')
      mounted.log.reset()
      handle.stats.reset()
      mounted.reads.reset()
      renders = 0
      const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry!)
      assertCommits(result)
      const lanes = pool.groupLanes(key)
      const groupSize = lanes.rowIds.length + lanes.closedIds.length
      // The lane change re-rendered the plant, which touched its whole group
      // against a neighbourhood budget.
      expect(renders).toBeGreaterThan(0)
      expect(groupSize).toBeGreaterThan(readsBudget)
      expect(() => assertReads(result, { readsPerChange: readsBudget })).toThrow(
        `budget ${readsBudget}`,
      )
      await act(async () => {
        root.unmount()
      })
      plant.remove()
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)

  it('an ungated layout runs on a heartbeat; lanes without identity notify on one', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    const handle = mounted.handle as HarnessHandPoolHandle
    const { pool } = handle
    try {
      settle(handle)
      const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === '#1')
      // Clean: a heartbeat moves nothing, so no layout run and no header notice.
      {
        mounted.log.reset()
        handle.stats.reset()
        mounted.reads.reset()
        let notices = 0
        const offs = pool
          .groupsView()
          .keys.map((key) => pool.subscribeGroup(key, () => (notices += 1)))
        const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry!)
        for (const off of offs) off()
        assertCommits(result)
        assertReads(result, { readsPerChange: readsBudget })
        expect(pool.stats.counters.groupRuns).toBe(0)
        expect(notices).toBe(0)
      }
      // Plant 1: a whole-visible-order walk (the old layout shape: `layoutOf`
      // over the visible order). From outside the pool it touches the visible
      // count per run (POD-4694: the scaling test holds the live settle to 0).
      {
        const order = [...pool.order()]
        let touched = 0
        layoutOf(order, (id) => {
          touched += 1
          return pool.groups.placement(id)
        })
        expect(touched, 'whole-visible-order walk elements').toBe(order.length)
        expect(order.length, 'visible count').toBeGreaterThan(0)
      }
      // Plant 2: the lanes never keep identity (every commit notifies every header).
      {
        const groups = pool.groups as unknown as {
          takeMoved(): { readonly moved: boolean; readonly changedKeys: readonly string[] }
        }
        const orig = groups.takeMoved.bind(groups)
        groups.takeMoved = () => {
          const cleared = orig()
          void cleared
          return { moved: true, changedKeys: pool.groupsView().keys }
        }
        let notices = 0
        try {
          const offs = pool
            .groupsView()
            .keys.map((key) => pool.subscribeGroup(key, () => (notices += 1)))
          mounted.log.reset()
          handle.stats.reset()
          mounted.reads.reset()
          await runFenceStep(mounted, ctx, feeds.flush, entry!)
          for (const off of offs) off()
        } finally {
          groups.takeMoved = orig
        }
        expect(notices).toBeGreaterThan(0)
      }
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)

  it('a whole-list layout touches the known count, not the visible count; a reversed fold fails parity', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    const handle = mounted.handle as HarnessHandPoolHandle
    const { pool } = handle
    try {
      settle(handle)
      const visible = pool.order().length
      const known = [...pool.issueIds(), ...(pool.residency?.ids('issue') ?? [])]
      expect(new Set(known).size).toBeGreaterThan(visible)
      // The plant: `layoutOf` over every known id (a layout that walks the
      // tables instead of placing the visible order). From outside the pool it
      // touches the known count per run, and reads hidden rows to do it.
      mounted.reads.reset()
      const plantElements = layoutOf(known, (id) =>
        placementRuleOf(
          { ...pool.visibleInputs, waiting: (rowId) => pool.rollup.waitingOf(rowId) },
          id,
        ),
      )
      void plantElements
      const plantReads = mounted.reads.stats().rows
      expect(plantReads).toBeGreaterThan(visible)
      // The live settle's runs touch the visible count exactly (the main loop
      // asserts this per step at 1x, and the 4x test at scale).
      expect(pool.stats.counters.groupElements).toBeLessThanOrEqual(
        pool.stats.counters.groupRuns * visible,
      )
      // A fold oldest-first fails the group parity: reverse one non-trivial
      // fold and the order diff names it.
      const live = sliceOrderOf(pool.groups.snapshot())
      const folding = live.groups.find((group) => group.closedIds.length > 1)
      expect(folding, 'a group with a non-trivial fold').toBeDefined()
      const reversed: SliceOrder = {
        pinnedIds: live.pinnedIds,
        groups: live.groups.map((group) =>
          group.key === folding!.key
            ? { ...group, closedIds: [...group.closedIds].reverse() }
            : group,
        ),
      }
      expect(orderDiff(reversed, live)).not.toBeNull()
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)
})

/**
 * The plant header: subscribed to the grouped view (so any lane change
 * re-renders it, as a real header's own subscription does on its group) but
 * reading every row of its group through the fenced tables on each render —
 * what a header that renders its rows' fields does. A row-internal change
 * must never re-render a clean header, so this render path must fail the
 * reads fence where the clean list passes it.
 */
function PlantHeader({
  pool,
  groupKey,
  onRender,
}: {
  pool: HandPool
  groupKey: string
  onRender: () => void
}): ReactElement {
  const view = useSyncExternalStore(pool.subscribeGroups, pool.groupsView)
  void view
  const subscribe = useCallback(
    (listener: () => void) => pool.subscribeGroup(groupKey, listener),
    [pool, groupKey],
  )
  const lanes = useSyncExternalStore(subscribe, () => pool.groupLanes(groupKey))
  onRender()
  for (const id of [...lanes.rowIds, ...lanes.closedIds]) {
    pool.fenced.issue.get(id)
  }
  return <div data-plant-header={groupKey}>{lanes.label}</div>
}
