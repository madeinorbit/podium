// @vitest-environment happy-dom
/**
 * POD-4569 (Mb1) — the visible collection and its order on the live engine,
 * 1x live-shaped fixture, fence steps #1-#5 in methodology order on one
 * engine.
 *
 * PARITY, after bootstrap and after every step: the pool's visible set and
 * its rank order equal the legacy oracle's flat rows (`visibleIssueRows` over
 * the engine's store: the rows the app would show, in R-ORDER), the settled
 * snapshot equals the pool's own rebuild from scratch, and the fields Mb1's
 * rows carry from the own row and one hop equal the oracle's row views. The
 * roll-ups (`phase`, progress, `working`, `asking`) and `closed` are Mb3's
 * (compared in `rollup.test.tsx` and the gate) and stay out of this one.
 *
 * FENCES the brief names: a heartbeat reads nothing of the visible set and
 * re-sorts nothing; a rank change sorts at most the visible count and commits
 * only rows whose view changed; #1-#5 commit exactly the oracle-changed rows
 * (#4's hidden spin-off is no longer drawn), and a list that draws hidden
 * rows fails #1 and a #4-shaped rename of an origin with a hidden spin-off
 * (#4's own corpus target has no spin-off since POD-4635's reshape).
 */

import { observer } from 'mobx-react-lite'
import { act, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
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
  visibleIssueRows,
} from '../../../../harness/src/oracle/index'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm } from '../../../../shared/src/arm'
import { checkArm, diffSnapshots } from '../../../../shared/src/gen/check'
import { CommitLogContext, currentCommitLog, RowShell } from '../../../../shared/src/row-shell'
import {
  type ScenarioEngine,
  startScenarioEngine,
  upsert,
  writeTitleRename,
} from '../../../../shared/src/scenarios'
import { harnessMobxPoolArm, tracked, type HarnessMobxPoolHandle } from '../../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../mobx-trap'
import type { MobxPool } from '../pool'
import { PoolRow } from '../react/row'
import { rowViewOf } from '../models'

installMobxWarnTrap()

/** The pool with a load window that never closes on its own: no load lands inside a counted step. */
const arm: CheckableArm = {
  create: (source, locals, reads) =>
    harnessMobxPoolArm.create(source, locals, reads, { schedule: () => () => {} }),
}

/** The row fields Mb1's rows carry from the own row and one hop (the roll-ups are Mb3's, `rollup.test.tsx`). */
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

/** Close load windows until nothing is queued (the mount asks for every visible cold row). */
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

/** The oracle's flat order: the rows the app would show, in R-ORDER. */
function oracleOrder(ctx: ScenarioEngine): string[] {
  const locals = parityLocals(ctx)
  const derivation = legacyDerivationFromStore(ctx.engine.getSnapshot(), locals.coarseNow)
  return visibleIssueRows(derivation, locals).map((row) => row.issue.id)
}

interface ParityCell {
  readonly at: string
  readonly visible: number
  readonly cold: number
  readonly orderEqual: boolean
  readonly rebuildDiff: string | null
  readonly fieldDiffs: number
}

function checkParity(ctx: ScenarioEngine, handle: HarnessMobxPoolHandle, at: string): ParityCell {
  const { pool } = handle
  const snapshot = handle.snapshot()
  const expected = oracleOrder(ctx)
  const order = tracked(() => [...pool.worklist.order])
  const cold = order.filter((id) => pool.residency?.isCold('issue', id) === true).length
  expect(order, `${at}: visible order`).toEqual(expected)
  expect(Object.keys(snapshot.rowsById), `${at}: snapshot rows`).toEqual(expected)
  const rebuildDiff = diffSnapshots(snapshot, handle.rebuildFromScratch())
  expect(rebuildDiff, `${at}: rebuild`).toBeNull()
  const views = rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))
  const diffs: string[] = []
  tracked(() => {
    for (const id of order) {
      const live = rowViewOf(pool.issue(id))
      const oracle = views[id]
      for (const field of OWN_FIELDS) {
        if (JSON.stringify(live?.[field]) !== JSON.stringify(oracle?.[field])) {
          diffs.push(
            `${id}.${field}: ${JSON.stringify(live?.[field])} (oracle ${JSON.stringify(oracle?.[field])})`,
          )
        }
      }
    }
  })
  expect(diffs.slice(0, 10), `${at}: own-row fields`).toEqual([])
  return {
    at,
    visible: order.length,
    cold,
    orderEqual: true,
    rebuildDiff,
    fieldDiffs: diffs.length,
  }
}

describe('visible collection and order (Mb1)', () => {
  it('parity at 1x through #1-#5; the commit and reads fences hold', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    const handle = mounted.handle as HarnessMobxPoolHandle
    const { pool } = handle
    try {
      const rounds = settle(pool)
      const parity: ParityCell[] = [checkParity(ctx, handle, 'bootstrap')]
      mounted.log.reset()
      handle.stats.reset()
      mounted.reads.reset()
      const cells = []
      for (const methodology of ['#1', '#2', '#3', '#4', '#5']) {
        const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
        expect(entry, methodology).toBeDefined()
        const visibleBefore = new Set(tracked(() => [...pool.worklist.order]))
        const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry!)
        // runCountScenario read the snapshot after counting: nothing loads mid-step.
        assertCommits(result)
        // Reads are recorded, not held to a fixed budget: whether they grow
        // with the data is the work-per-change check's (POD-4746).
        mounted.reads.assertNoCopies(mounted.handle)
        const counters = { ...pool.stats.counters }
        if (methodology === '#1') {
          // A heartbeat reads 0 of the visible set and files nothing.
          const readIds = (result.reads?.sample ?? []).map((key) => key.split(':')[1] ?? '')
          expect(result.reads?.rows ?? 0).toBeLessThanOrEqual(8)
          expect(readIds.filter((id) => visibleBefore.has(id))).toEqual([])
          expect(counters.groupRuns).toBe(0)
          expect(counters.membershipFlips).toBe(0)
        }
        cells.push({
          methodology,
          scenario: result.scenario,
          oracleChanged: result.oracleChangedRows,
          drawn: result.drawnRows,
          rowsCommitted: result.rowsCommitted,
          readsPerChange: result.readsPerChange,
          readsBudget,
          readsByEntity: result.reads?.byEntity,
          groupRuns: counters.groupRuns,
          groupElements: counters.groupElements,
          membershipFlips: counters.membershipFlips,
          visible: visibleBefore.size,
        })
        parity.push(checkParity(ctx, handle, methodology))
        mounted.log.reset()
        handle.stats.reset()
        mounted.reads.reset()
      }
      writeResult('mobx-visible-1x', {
        scale: 1,
        loadWindows: rounds,
        parity,
        cells,
      })
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)

  it('a rank change moves the one row, sorts nothing and redraws only the moved row', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    const { pool } = mounted.handle as HarnessMobxPoolHandle
    try {
      settle(pool)
      const before = tracked(() => [...pool.worklist.order])
      // Pin the LAST visible unpinned row: band 1 → 0, so it moves to the top block.
      const target = tracked(() =>
        [...before].reverse().find((id) => pool.knownIssue(id)?.standing?.pinned === false),
      )
      expect(target).toBeDefined()
      mounted.log.reset()
      pool.stats.reset()
      await act(async () => {
        const wire = ctx.cache.read('issue', target!)?.value as object | undefined
        expect(wire).toBeDefined()
        ctx.replica.batch(() => upsert(ctx, 'issue', target!, { ...wire, pinned: true }))
        await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
        feeds.flush()
      })
      const after = tracked(() => [...pool.worklist.order])
      const counters = pool.stats.counters
      // One filing: out of its group's member and open lanes, into the pinned section.
      expect(counters.groupRuns).toBe(1)
      expect(counters.groupElements).toBe(3)
      expect(counters.membershipFlips).toBe(0)
      expect(after.indexOf(target!)).toBeLessThan(before.indexOf(target!))
      expect(new Set(after)).toEqual(new Set(before))
      // The pinned row redraws: its view's `band` and `pinned` moved, and a row
      // DRAWS both (the pinned and snoozed looks; POD-4825's rule: a row redraws
      // exactly when a field it draws changes). Since POD-4792 each lane is its
      // own observer, so the row leaves its group's open lane and is mounted in
      // the pinned section: a REMOUNT, which draws it with the new values, not
      // a commit in place. The exact-commit fence counts a remount of a row
      // visible before and after as a redraw (`changedViews`); so does this.
      // No other row commits or remounts.
      const redrawn = new Set([...mounted.log.counts.keys(), ...mounted.log.mounts.keys()])
      expect([...redrawn]).toEqual([target])
      expect(after).toEqual(oracleOrder(ctx))
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)

  it('a rename of an origin with a hidden open spin-off commits only visible rows (#4 shape)', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
    try {
      settle((mounted.handle as HarnessMobxPoolHandle).pool)
      mounted.log.reset()
      mounted.handle.stats.reset()
      mounted.reads.reset()
      const { result, readsBudget } = await runHiddenSpinOffRename(mounted, ctx, feeds.flush)
      assertCommits(result)
      assertReads(result, { readsPerChange: readsBudget })
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)

  it('an evicted parent re-added places its descendants again (gate seed 1, step 112)', async () => {
    // The L4b gate's shrunk sequence: with an untracked node registry the
    // descendants' nest parents never looked for the re-added node.
    const plain: CheckableArm = {
      create: (source, locals, reads) => harnessMobxPoolArm.create(source, locals, reads),
    }
    const result = await checkArm(
      plain,
      [
        { kind: 'evict', id: 'i234' },
        { kind: 'reAdd', id: 'i234' },
      ] as never,
      { oracleEvery: 0, shrink: false },
    )
    expect(result.ok ? null : `${result.against}: ${result.diff}`).toBeNull()
  }, 300_000)

  it('a list that draws hidden rows fails the commit fence on #4 (a hidden spin-off)', async () => {
    const planted: CheckableArm = {
      create(source, locals, reads) {
        const handle = arm.create(source, locals, reads) as HarnessMobxPoolHandle
        const { pool } = handle
        return {
          ...handle,
          mountWeb(el: Element): () => void {
            const root = createRoot(el)
            root.render(
              <CommitLogContext.Provider value={currentCommitLog()}>
                <AllKnownList pool={pool} />
              </CommitLogContext.Provider>,
            )
            return () => root.unmount()
          },
        }
      },
    }
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(planted, feeds.rows.source, feeds.locals)
    try {
      settle((mounted.handle as HarnessMobxPoolHandle).pool)
      mounted.log.reset()
      mounted.handle.stats.reset()
      mounted.reads.reset()
      const failures: Record<string, string> = {}
      for (const methodology of ['#1', '#2', '#3', '#4']) {
        const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === methodology)
        const { result } = await runFenceStep(mounted, ctx, feeds.flush, entry!)
        try {
          assertCommits(result)
        } catch (error) {
          failures[methodology] = (error as Error).message
        }
        mounted.log.reset()
        mounted.handle.stats.reset()
        mounted.reads.reset()
      }
      const renamed = await runHiddenSpinOffRename(mounted, ctx, feeds.flush)
      try {
        assertCommits(renamed.result)
      } catch (error) {
        failures['#4 hidden spin-off'] = (error as Error).message
      }
      // #4's corpus target (the #2 root since POD-4635) has no spin-off, so only
      // the #4-shaped rename of an origin with a hidden spin-off can show it.
      // #1 no longer does (POD-4679): its heartbeat session is a retained seat
      // of no hidden row, so no hidden row's `activityAt` moves (it did while
      // `activityAt` read every explicit session, decayed ones included).
      expect(Object.keys(failures).sort()).toEqual(['#4 hidden spin-off'])
      expect(failures['#4 hidden spin-off']).toContain(`over=[${renamed.spinOff}`)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 300_000)
})

/**
 * #4's write (`writeTitleRename`) on a visible origin that has an OPEN (so
 * resident) spin-off the worklist hides: the origin's rename re-derives the
 * hidden spin-off's ⤷ tick. The origin is picked from the oracle before the
 * write; the same budget as #4.
 */
async function runHiddenSpinOffRename(
  mounted: ReturnType<typeof mountArmForCounts>,
  ctx: ScenarioEngine,
  flush: () => void,
) {
  const store = ctx.engine.getSnapshot()
  const visible = rowViewsFromStore(store, engineLocals(ctx))
  let origin: string | undefined
  let spinOff: string | undefined
  for (const issue of store.issues) {
    const from = issue.deps?.find((dep) => dep.type === 'discovered-from')?.id
    if (from === undefined || visible[from] === undefined) continue
    if (issue.closedAt != null || visible[issue.id] !== undefined) continue
    origin = from
    spinOff = issue.id
    break
  }
  expect(origin, 'a visible origin with an open hidden spin-off').toBeDefined()
  const entry = FENCE_SCENARIOS.find((candidate) => candidate.methodology === '#4')
  const step = await runFenceStep(mounted, ctx, flush, {
    ...entry!,
    scenario: 'hiddenSpinOffOriginRename',
    write: (c) => writeTitleRename(c, origin),
  })
  return { ...step, origin: origin as string, spinOff: spinOff as string }
}

/** The plant: every known issue drawn, hidden ones included (a cold one loads, then draws). */
const AllKnownSlot = observer(function AllKnownSlot({
  pool,
  id,
}: {
  pool: MobxPool
  id: string
}): ReactElement | null {
  const issue = pool.issue(id)
  if (issue === undefined || !issue.inMemory) {
    pool.resident('issue', id)
    return null
  }
  return <RowShell row={issue} component={PoolRow} />
})

const AllKnownList = observer(function AllKnownList({ pool }: { pool: MobxPool }): ReactElement {
  return (
    <div>
      {[...pool.fenced.issue.keys(), ...(pool.residency?.ids('issue') ?? [])].map((id) => (
        <AllKnownSlot key={id} pool={pool} id={id} />
      ))}
    </div>
  )
})
