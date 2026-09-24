// @vitest-environment happy-dom
/**
 * POD-4570 (Mb2) — groups, closed folds and the windowed list on the live
 * engine, 1x live-shaped fixture, fence steps #1-#7 in methodology order on
 * one engine.
 *
 * PARITY, after bootstrap and after every step: the pool's grouped order
 * (`groups.layout`, no selection) equals the legacy oracle's `SliceOrder`
 * (`snapshotFromStore` at the unselected baseline: pinned ids, group keys,
 * labels, open lanes, closed folds), the visible rows equal the oracle's flat
 * rows, and the settled snapshot equals the pool's own rebuild, which groups
 * with L1b's `groupKeyOf` / `compareClosedFold` instead of the live layout.
 * The row roll-ups stay Mb3's stubs, so rows are compared with the rebuild,
 * not the oracle (Mb1's own-field comparison is `visible.test.tsx`).
 *
 * THE ONE NAMED DIFFERENCE. The fold verdict's "nothing in the subtree waits"
 * conjunct is Mb3's roll-up (`STUB_WAITING`, as the row's own `closed`), so a
 * settled closed top-level row whose subtree has a waiting session folds here
 * and stays open in the oracle (1x: i103, i2377, i4446, each `asking` with
 * phase `waiting` in the oracle's views). `stubMoved` derives that set from the
 * ORACLE (rows the fold rule closes with waiting ignored, that the oracle
 * keeps open, and that ask) and the parity check requires the difference to be
 * exactly those rows moved into their group's fold, nothing else. It is also a
 * tripwire: once Mb3 wires waiting in, the set no longer moves and this check
 * fails until it is replaced by exact parity.
 *
 * The same stub on the commit fence: a row the oracle changes ONLY in the
 * roll-up fields (`STUB_ROLLUPS`: #7's old and new parents' progress and
 * phase) cannot redraw before Mb3. Such a row may be missing from the redraw
 * (`stubUnder`, checked against the oracle's own before/after views); a row
 * drawn that the oracle did not change never may. #7 must show one, the
 * tripwire again.
 *
 * FENCES: each step commits exactly the oracle-changed rows and reads within
 * its budget (the shared `assertCommits` / `assertReads`); the layout re-runs
 * only when the order or a visible row's placement moved; a group header
 * redraws exactly when its own lanes changed, never on a row-internal change.
 */

import { Reaction, reaction } from 'mobx'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { CommitLogContext, currentCommitLog } from '../../../../shared/src/row-shell'
import type { SliceIssue, SliceOrder } from '../../../../shared/src/slice-types'
import { type ScenarioEngine, startScenarioEngine } from '../../../../shared/src/scenarios'
import { type MobxPoolHandle, mobxPoolArm } from '../arm'
import { installMobxWarnTrap } from '../mobx-trap'
import { type MobxPool, tracked } from '../pool'
import { HEADER_HEIGHT, PoolList, ROW_HEIGHT } from '../react/list'
import { closedOf, STUB_ROLLUPS } from '../views'
import { sliceOrderOf } from './groups'

installMobxWarnTrap()

/** The pool with a load window that never closes on its own: no load lands inside a counted step. */
const arm: CheckableArm = {
  create: (source, locals, reads) =>
    mobxPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

const STEPS = ['#1', '#2', '#3', '#4', '#5', '#6a', '#6b', '#6c', '#6d', '#7'] as const

/** Close load windows until nothing is queued (the mount asks for every drawn cold row). */
function settle(pool: MobxPool): number {
  let rounds = 0
  while (pool.residency?.hasQueued() && rounds < 100) {
    act(() => {
      pool.hydrate()
    })
    rounds += 1
  }
  expect(pool.residency?.hasQueued()).toBe(false)
  return rounds
}

/** The oracle's row views at the engine's locals (selection included, as the fence's). */
function oracleViews(ctx: ScenarioEngine): Record<string, unknown> {
  return rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx)) as Record<string, unknown>
}

/**
 * The shared commit fence, with Mb3's stub named: rows the oracle changed in
 * the stubbed roll-up fields only may be missing from the redraw. Returns them.
 */
function assertCommitsBeforeRollups(
  result: Parameters<typeof assertCommits>[0],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  try {
    assertCommits(result)
    return []
  } catch (error) {
    const drawn = new Set(result.drawnRows ?? [])
    const changed = new Set(result.oracleChangedRows ?? [])
    const over = [...drawn].filter((id) => !changed.has(id))
    const under = [...changed].filter((id) => !drawn.has(id))
    if (over.length > 0) throw error
    const stubbed = new Set(Object.keys(STUB_ROLLUPS))
    for (const id of under) {
      const a = (before[id] ?? {}) as Record<string, unknown>
      const b = (after[id] ?? {}) as Record<string, unknown>
      const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
        (field) => JSON.stringify(a[field]) !== JSON.stringify(b[field]),
      )
      if (before[id] === undefined || after[id] === undefined || fields.some((f) => !stubbed.has(f))) {
        throw error
      }
    }
    return under.sort()
  }
}

/** An order-only snapshot, so `diffSnapshots` names group differences alone. */
function orderDiff(actual: SliceOrder, expected: SliceOrder): string | null {
  return diffSnapshots({ order: actual, rowsById: {} }, { order: expected, rowsById: {} })
}

/**
 * Rows the stub folds and the oracle keeps open: visible, closed by the fold
 * rule with waiting ignored, open in the oracle's views, and asking there.
 */
function stubMoved(ctx: ScenarioEngine, expected: SliceOrder): Set<string> {
  const store = ctx.engine.getSnapshot()
  const coarseNow = parityLocals(ctx).coarseNow
  const views = rowViewsFromStore(store, { ...engineLocals(ctx), selectedIssueId: null })
  const open = new Set(expected.groups.flatMap((group) => group.rowIds))
  const moved = new Set<string>()
  for (const issue of store.issues as unknown as SliceIssue[]) {
    if (!open.has(issue.id)) continue
    const view = views[issue.id]
    if (view === undefined || view.closed) continue
    if (!closedOf(issue, false, { passed: (t) => coarseNow > t })) continue
    expect(view.asking, `${issue.id}: open in the oracle only because it asks`).toBe(true)
    moved.add(issue.id)
  }
  return moved
}

/** The oracle's order with `moved` folded: out of the open lane, into the fold by stamp. */
function withStubMoves(
  ctx: ScenarioEngine,
  expected: SliceOrder,
  moved: ReadonlySet<string>,
): SliceOrder {
  const store = ctx.engine.getSnapshot()
  const byId = new Map((store.issues as unknown as SliceIssue[]).map((i) => [i.id, i]))
  const foldMs = (id: string) => {
    const issue = byId.get(id) as SliceIssue
    return Date.parse(issue.tuckedAt ?? issue.closedAt ?? issue.updatedAt) || 0
  }
  return {
    pinnedIds: expected.pinnedIds,
    groups: expected.groups.map((group) => {
      const add = group.rowIds.filter((id) => moved.has(id))
      if (add.length === 0) return group
      // Rank order among the moved, then a stable merge by stamp (ties keep rank).
      const closedIds = [...group.closedIds]
      for (const id of add) {
        const at = closedIds.findIndex((other) => foldMs(other) < foldMs(id))
        closedIds.splice(at === -1 ? closedIds.length : at, 0, id)
      }
      return { ...group, rowIds: group.rowIds.filter((id) => !moved.has(id)), closedIds }
    }),
  }
}

interface GroupParity {
  readonly at: string
  readonly stubMoved: readonly string[]
  readonly visible: number
  readonly pinned: number
  readonly groups: number
  readonly open: number
  readonly closed: number
}

function checkParity(ctx: ScenarioEngine, handle: MobxPoolHandle, at: string): GroupParity {
  const { pool } = handle
  const locals = parityLocals(ctx)
  const store = ctx.engine.getSnapshot()
  const oracle = snapshotFromStore(store, locals).order
  const moved = stubMoved(ctx, oracle)
  const expected = withStubMoves(ctx, oracle, moved)
  const live = tracked(() => sliceOrderOf(pool.groups.layout))
  expect(orderDiff(live, expected), `${at}: groups against the oracle`).toBeNull()
  // The tripwire: the stub still moves rows, and they are why live differs.
  expect(moved.size, `${at}: rows the waiting stub folds`).toBeGreaterThan(0)
  expect(orderDiff(live, oracle), `${at}: the stub's rows differ`).not.toBeNull()
  const flat = visibleIssueRows(legacyDerivationFromStore(store, locals.coarseNow), locals).map(
    (row) => row.issue.id,
  )
  expect(
    tracked(() => [...pool.worklist.order]),
    `${at}: visible order`,
  ).toEqual(flat)
  const snapshot = handle.snapshot()
  expect(diffSnapshots(snapshot, handle.rebuildFromScratch()), `${at}: rebuild`).toBeNull()
  return {
    at,
    stubMoved: [...moved].sort(),
    visible: flat.length,
    pinned: live.pinnedIds.length,
    groups: live.groups.length,
    open: live.groups.reduce((n, group) => n + group.rowIds.length, 0),
    closed: live.groups.reduce((n, group) => n + group.closedIds.length, 0),
  }
}

/** Each group's UI lanes (the latch applied), as the headers observe them. */
function lanes(pool: MobxPool): Map<string, readonly (readonly string[])[]> {
  return tracked(
    () =>
      new Map(
        pool.groups.keys.map((key) => {
          const group = pool.groups.group(key)
          return [key, [[group.label], group.rowIds, group.closedIds]] as const
        }),
      ),
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

/**
 * Header redraws while `run` runs: every `track` of an observer whose
 * component is the group header (mobx-react-lite names its reaction
 * `observer<Component>`, and tracks it once per render).
 */
async function countHeaderRenders(run: () => Promise<void>): Promise<number> {
  let renders = 0
  const proto = Reaction.prototype as unknown as {
    track: (this: { name_: string }, fn: () => void) => void
  }
  const original = proto.track
  proto.track = function (fn) {
    if (this.name_ === 'observerPoolGroupHeader') renders += 1
    return original.call(this, fn)
  }
  try {
    await run()
  } finally {
    proto.track = original
  }
  return renders
}

describe('groups and closed folds (Mb2)', () => {
  it('parity at 1x through #1-#7; commits, reads, layout runs and header redraws follow the change', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    const handle = mounted.handle as MobxPoolHandle
    const { pool } = handle
    try {
      settle(pool)
      const parity: GroupParity[] = [checkParity(ctx, handle, 'bootstrap')]
      const cells = []
      for (const methodology of STEPS) {
        mounted.log.reset()
        handle.stats.reset()
        mounted.reads.reset()
        const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
        expect(entry, methodology).toBeDefined()
        const orderBefore = tracked(() => [...pool.worklist.order])
        const lanesBefore = lanes(pool)
        const viewsBefore = oracleViews(ctx)
        let step: Awaited<ReturnType<typeof runFenceStep>> | undefined
        const headerRenders = await countHeaderRenders(async () => {
          step = await runFenceStep(mounted, ctx, feeds.flush, entry!)
        })
        const { result, readsBudget } = step!
        const stubUnder = assertCommitsBeforeRollups(result, viewsBefore, oracleViews(ctx))
        assertReads(result, { readsPerChange: readsBudget })
        mounted.reads.assertNoCopies(mounted.handle)
        const counters = { ...pool.stats.counters }
        const orderMoved =
          JSON.stringify(orderBefore) !== JSON.stringify(tracked(() => [...pool.worklist.order]))
        const groupsChanged = changedGroups(lanesBefore, lanes(pool))
        // A header redraws exactly for its own group's lane change.
        expect(headerRenders, `${methodology}: header redraws`).toBe(groupsChanged.length)
        // Nothing moved: the layout never re-ran (a row-internal change stops at its node).
        if (!orderMoved && groupsChanged.length === 0) {
          expect(counters.groupRuns, `${methodology}: layout runs`).toBe(0)
        }
        cells.push({
          methodology,
          scenario: result.scenario,
          oracleChanged: result.oracleChangedRows,
          rowsCommitted: result.rowsCommitted,
          stubUnder,
          readsPerChange: result.readsPerChange,
          readsBudget,
          orderMoved,
          groupRuns: counters.groupRuns,
          groupElements: counters.groupElements,
          groupsChanged,
          headerRenders,
        })
        parity.push(checkParity(ctx, handle, methodology))
      }
      // #1-#4 change no order and no placement.
      for (const cell of cells.slice(0, 4)) {
        expect(cell.groupRuns, `${cell.methodology}: layout runs`).toBe(0)
        expect(cell.headerRenders, `${cell.methodology}: header redraws`).toBe(0)
      }
      // #2 and #4 redraw a row and no header (the brief's pitfall).
      expect(cells[1]!.rowsCommitted).toBeGreaterThan(0)
      expect(cells[3]!.rowsCommitted).toBeGreaterThan(0)
      // #7 moves a child between parents: their progress changes (Mb3's stub).
      expect(cells.find((cell) => cell.methodology === '#7')?.stubUnder.length).toBeGreaterThan(0)
      // The header counter can say yes: some step changed a group's lanes.
      expect(cells.some((cell) => cell.headerRenders > 0)).toBe(true)
      writeResult('mobx-groups-1x', { scale: 1, parity, cells })
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 600_000)

  it('the fold latch holds a selected grace-folded row open; a dismissal or a folded click does not', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = arm.create(feeds.rows.source, feeds.locals.source) as MobxPoolHandle
    const { pool } = handle
    // Observed, as the mounted list observes them: an unobserved computed
    // re-runs on every read, so the layout counter would count the reads.
    const observe = reaction(
      () => [
        pool.groups.layout,
        ...pool.groups.keys.map((key) => [
          pool.groups.group(key).rowIds,
          pool.groups.group(key).closedIds,
        ]),
      ],
      () => {},
    )
    try {
      settle(pool)
      const where = (id: string) =>
        tracked(() => {
          for (const key of pool.groups.keys) {
            const group = pool.groups.group(key)
            if (group.rowIds.includes(id)) return { key, lane: 'open', at: group.rowIds.indexOf(id) }
            if (group.closedIds.includes(id)) return { key, lane: 'closed' }
          }
          return null
        })
      const placed = tracked(() =>
        pool.worklist.order.map((id) => ({ id, placement: pool.worklist.issue(id)?.placement })),
      )
      const grace = placed.find(
        ({ placement }) => placement?.closed === true && !placement.dismissed && !placement.pinned,
      )
      const dismissed = placed.find(
        ({ placement }) => placement?.dismissed === true && !placement.pinned,
      )
      expect(grace, 'a grace-folded row in the fixture').toBeDefined()
      expect(dismissed, 'a dismissed row in the fixture').toBeDefined()
      const snapshotOrder = () => tracked(() => sliceOrderOf(pool.groups.layout))
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
      const open = tracked(() => pool.groups.group(latched!.key).rowIds)
      const rank = tracked(() => pool.worklist.order)
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
      observe()
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)
})

describe('the windowed web list (Mb2)', () => {
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
    const feedReads = { bootstrap: new Set<string>(), firstWindow: new Set<string>(), later: new Set<string>() }
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
    const handle = mobxPoolArm.create(counting, feeds.locals.source, undefined, {
      schedule: () => () => {},
    })
    const { pool } = handle
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    try {
      phase = 'firstWindow'
      act(() => {
        root.render(
          <CommitLogContext.Provider value={currentCommitLog()}>
            <PoolList pool={pool} />
          </CommitLogContext.Provider>,
        )
      })
      const visible = tracked(() => pool.worklist.order.length)
      const drawn = () => el.querySelectorAll('[data-issue-row], [data-loading-row]').length
      const firstWindow = drawn()
      // A window, not the list: the viewport's worth of items plus overscan.
      expect(firstWindow).toBeGreaterThan(0)
      expect(firstWindow).toBeLessThanOrEqual(Math.ceil(height / HEADER_HEIGHT) + 10)
      expect(firstWindow).toBeLessThan(visible)
      const queuedAtPaint = pool.pendingLoads()
      const coldVisible = tracked(
        () => pool.worklist.order.filter((id) => pool.residency?.isCold('issue', id)).length,
      )
      expect(queuedAtPaint).toBeLessThan(coldVisible)
      const hydratedBefore = pool.residency?.counters.hydrated ?? 0
      settle(pool)
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
      const lastId = tracked(() => {
        const keys = pool.groups.keys
        const last = pool.groups.group(keys[keys.length - 1]!)
        return last.closedIds.at(-1) ?? last.rowIds.at(-1)
      })
      expect(el.querySelector(`[data-issue-row="${lastId}"]`)).toBeNull()
      await act(async () => {
        list.scrollTop = 10_000_000
        list.dispatchEvent(new Event('scroll'))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      settle(pool)
      expect(el.querySelector(`[data-issue-row="${lastId}"]`)).not.toBeNull()
      expect(drawn()).toBeLessThan(visible)

      // Fold the first group with a closed fold: its closed rows leave the list.
      await act(async () => {
        list.scrollTop = 0
        list.dispatchEvent(new Event('scroll'))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      const folding = tracked(() =>
        pool.groups.keys.find((key) => pool.groups.group(key).closedIds.length > 0),
      )
      expect(folding).toBeDefined()
      const header = el.querySelector(`[data-group="${folding}"] button`) as HTMLButtonElement
      expect(header).not.toBeNull()
      const totalBefore = (list.firstElementChild as HTMLElement).style.height
      act(() => header.click())
      expect(el.querySelector(`[data-group="${folding}"]`)?.getAttribute('data-folded')).toBe('true')
      const closedCount = tracked(() => pool.groups.group(folding!).closedIds.length)
      const totalAfter = (list.firstElementChild as HTMLElement).style.height
      expect(Number.parseFloat(totalBefore) - Number.parseFloat(totalAfter)).toBe(
        closedCount * ROW_HEIGHT,
      )
      writeResult('mobx-groups-window-1x', {
        visible,
        coldVisible,
        firstWindowDrawn: firstWindow,
        coldQueuedAtFirstPaint: queuedAtPaint,
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
