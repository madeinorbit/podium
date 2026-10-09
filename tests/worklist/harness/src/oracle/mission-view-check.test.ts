import { omitGone } from '@podium/client-graph/lookup'
import { referenceState } from '../../../diagnostics/reference-state'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ReferenceState as Store } from '../../../diagnostics/reference-state'

import { allIssueViewModels } from '../../../diagnostics/reference/issue-view-models'
import {
  missionIndexStats,
  missionRootFor,
  sessionOwnershipStats,
} from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph'
import { createWorklistPool } from '@podium/client-graph/create'
import { opening, poolMissionViewSnapshot, poolWorkspaceMission } from '../../../diagnostics/mission-view-check'
import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'
import type { MobxPool } from '@podium/client-graph/pool'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { autorun, reaction, runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gen, genCorpus } from '../../../shared/src/gen/changes'
import { startGenRun } from '../../../shared/src/gen/run'
import {
  startScenarioEngine,
  writeRescopeBack,
  writeRescopeGrow,
} from '../../../shared/src/scenarios'
import { tracked } from '../adapters/mobx-pool'
import { FENCE_SCENARIOS, openFenceFeeds } from '../fence-scenarios'
import { FIXED_NOW } from '../fixture/corpus'
import { installMobxWarnTrap } from '../mobx-trap'
import { expectFrozenPoolOutput, expectPoolOutput } from './pool-output'

installMobxWarnTrap({ errors: true })
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
})
afterEach(() => vi.useRealTimers())

function roots(store: Store<PodiumClientApi>): string[] {
  const issues = allIssueViewModels(store.replica, store.issueProjections, store.issueUserStates)
  return [
    ...new Set(
      issues.flatMap((issue) => {
        const root = missionRootFor(issues, issue.id)
        return root && !root.archived && !root.deletedAt ? [root.id] : []
      }),
    ),
  ]
}
function settle(pool: MobxPool, ids: readonly string[]) {
  const last: number[] = []
  for (let round = 0; round < 64; round++) {
    for (const id of ids)
      tracked(() => {
        poolMissionViewSnapshot(pool, id)
        poolWorkspaceMission(pool, id, null)
      })
    const loaded = pool.hydrate()
    if (loaded === 0) return
    last.push(loaded)
  }
  throw new Error(`Mission pane batched loads did not settle: ${last.slice(-8).join(',')}`)
}
/** POD-5432: the owned variant's test-name suffix; it is held to the plain run's frozen output. */
const OWNED = ' (pool owns optimism)'

function compare(
  pool: MobxPool,
  store: Store<PodiumClientApi>,
  label: string,
  all = true,
  owned = false,
) {
  const ids = roots(store)
  const selections = all
    ? ids
    : [...new Set([store.selectedIssueId, ...ids.slice(0, 3), ...ids.slice(-3)])]
  const issues = allIssueViewModels(store.replica, store.issueProjections, store.issueUserStates)
  // Keep the selected pane's groups alive, then release them on the next
  // selection. Holding every mission simultaneously is not the screen's use.
  for (const id of selections) {
    const stop =
      id === null
        ? () => {}
        : reaction(
            () => {
              poolMissionViewSnapshot(pool, id)
              return poolWorkspaceMission(pool, id, null)
            },
            () => {},
            { fireImmediately: true },
          )
    try {
      if (id !== null) settle(pool, [id])
      const focused = issues.find((issue) => issue.parentId === id)?.id ?? null
      const workspace = tracked(() => poolWorkspaceMission(pool, id, focused))
      expect(workspace).not.toBe(LOADING)
      if (workspace !== LOADING) {
        const selected = issues.find(
          (issue) => issue.id === id && !issue.archived && !issue.deletedAt,
        )
        const root = selected ? missionRootFor(issues, selected.id)?.id : null
        expect(workspace.missionRoot?.id ?? null).toBe(root ?? null)
        expect(workspace.issue?.id ?? null).toBe(
          focused && workspace.missionIds.has(focused) ? focused : (root ?? null),
        )
      }
      for (const mode of ['full', 'working', 'needs-you'] as const) {
        const output =
          id === null
            ? runInAction(() => poolMissionViewSnapshot(pool, id, mode))
            : tracked(() => poolMissionViewSnapshot(pool, id, mode))
        if (owned) expectFrozenPoolOutput(output, `${label} ${id} ${mode}`, OWNED)
        else expectPoolOutput(output, `${label} ${id} ${mode}`)
      }
    } finally {
      stop()
    }
  }
}

describe('mission pane value differential', () => {
  // POD-5432: 'owned' is the pool owning optimism, against the same oracle.
  for (const mode of ['pooled', 'owned'] as const)
    for (const scale of [1, 4] as const)
      it(`${scale === 1 ? 'all' : 'representative'} synthetic missions and focused change gates at ${scale}x${mode === 'owned' ? OWNED : ''}`, async () => {
        const ctx = await startScenarioEngine(scale)
        const feeds = openFenceFeeds(ctx, mode)
        const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, {
          summaries: MISSION_VIEW_SUMMARIES,
        })
        feeds.attachPool(handle.pool)
        try {
          compare(handle.pool, referenceState(ctx.engine), 'corpus', scale === 1, mode === 'owned')
          for (const scenario of FENCE_SCENARIOS) {
            await scenario.write(ctx)
            feeds.flush()
            compare(
              handle.pool,
              referenceState(ctx.engine),
              scenario.scenario,
              false,
              mode === 'owned',
            )
          }
          await writeRescopeGrow(ctx)
          feeds.flush()
          compare(handle.pool, referenceState(ctx.engine), 'rescopeGrowth', false, mode === 'owned')
          await writeRescopeBack(ctx)
          feeds.flush()
          compare(handle.pool, referenceState(ctx.engine), 'rescopeBack', false, mode === 'owned')
        } finally {
          handle.dispose()
          feeds.dispose()
          ctx.dispose()
        }
      }, 600_000)

  for (const seed of [1, 2, 3])
    it(`generated publications including overlays, scope and reload, seed ${seed}`, async () => {
      const corpus = genCorpus(),
        changes = gen(seed, 200, {}, { corpus, forceSidebarValues: true })
      const run = await startGenRun({ corpus, feedMode: 'pooled' })
      let feed = run.feed(),
        locals = createEngineLocals(run.ctx.engine)
      let handle = createWorklistPool(feed.source, locals.source, {
        summaries: MISSION_VIEW_SUMMARIES,
      })
      try {
        for (const [index, change] of changes.entries()) {
          await run.apply(change)
          if (feed !== run.feed()) {
            handle.dispose()
            locals.dispose()
            feed = run.feed()
            locals = createEngineLocals(run.ctx.engine)
            handle = createWorklistPool(feed.source, locals.source, {
              summaries: MISSION_VIEW_SUMMARIES,
            })
          }
          locals.flush()
          compare(
            handle.pool,
            referenceState(run.ctx.engine),
            `seed ${seed} step ${index} ${change.kind}`,
            false,
          )
        }
      } finally {
        handle.dispose()
        locals.dispose()
        run.dispose()
      }
    }, 600_000)

  it('observes only addressed mission rows and counts zero legacy ownership work', async () => {
    const ctx = await startScenarioEngine(1),
      feeds = openFenceFeeds(ctx, 'pooled')
    const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, {
      summaries: MISSION_VIEW_SUMMARIES,
    })
    const ids = roots(referenceState(ctx.engine)),
      selected = ids[0]!
    settle(handle.pool, [selected])
    // The opened deck's own reader: its keyed reads are this opening's.
    const reader = opening(handle.pool, selected).reader
    const row = vi.spyOn(handle.pool, 'row')
    const legacyMission = missionIndexStats(),
      legacyOwnership = sessionOwnershipStats()
    const stop = autorun(() => poolMissionViewSnapshot(handle.pool, selected))
    const paneReads = row.mock.calls.slice()
    try {
      const before = { ...reader.stats }
      const other = ids.find((id) => id !== selected)!
      const raw = tracked(() => omitGone(handle.pool.row('issue', other))) as
        | SliceIssue
        | typeof LOADING
        | undefined
      if (!raw || raw === LOADING) throw new Error('Addressed synthetic row is not loaded')
      runInAction(() =>
        handle.pool.apply({
          type: 'update',
          rows: [{ kind: 'issue', id: other, value: { ...raw, title: 'Unrelated title' } }],
        }),
      )
      expect(reader.stats).toEqual(before)
      expect(paneReads.filter(([kind]) => kind === 'session').length).toBeLessThan(
        referenceState(ctx.engine).sessions.length,
      )
      expect(paneReads.some(([, , absent]) => String(absent) === 'peek')).toBe(false)
      expect(missionIndexStats()).toEqual(legacyMission)
      expect(sessionOwnershipStats()).toEqual(legacyOwnership)
    } finally {
      stop()
      row.mockRestore()
      handle.dispose()
      feeds.dispose()
      ctx.dispose()
    }
  }, 120_000)
})
