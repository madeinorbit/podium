/** Actual phone derivations against the shared pool, over the same feed and
 * focused change gates used by POD-4954. Synthetic values stay in this test. */
import { allIssueViewModels } from '@podium/client-core/replica'
import { missionRootFor, reposToViews } from '@podium/client-core/viewmodels'
import { createWorklistPool } from '@podium/client-graph/create'
import { checkMobileScreens, poolMobileScreensSnapshot, type MobileScreenCheck } from '@podium/client-graph/diagnostics/mobile-screens-check'
import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES } from '@podium/client-graph/mobile-screens-schema'
import type { MobxPool } from '@podium/client-graph/pool'
import type { Store } from '@podium/client-core/engine'
import { reaction } from 'mobx'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startScenarioEngine, writeRescopeBack, writeRescopeGrow } from '../../../../packages/worklist-proto/shared/src/scenarios'
import { FENCE_SCENARIOS, openFenceFeeds } from '../../../../packages/worklist-proto/harness/src/fence-scenarios'
import { tracked } from '../../../../packages/worklist-proto/harness/src/adapters/mobx-pool'
import { FIXED_NOW } from '../../../../packages/worklist-proto/harness/src/fixture/corpus'

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(FIXED_NOW) })
afterEach(() => vi.useRealTimers())
const tasks: MobileScreenCheck['tasks'] = { showDone: false, expanded: [], filter: {}, ordering: 'priority', showAgentTasks: false }
function settle(pool: MobxPool, input: MobileScreenCheck) {
  for (let round = 0; round < 64; round++) {
    tracked(() => poolMobileScreensSnapshot(pool, input))
    if (!pool.hydrate()) return
  }
  throw new Error('Phone batched loads did not settle')
}
function compare(pool: MobxPool, store: Store, label: string, all: boolean) {
  const issues = allIssueViewModels(store.replica, store.issueProjections, store.issueUserStates)
  const roots = [...new Set(issues.flatMap(issue => {
    const root = missionRootFor(issues, issue.id)
    return root ? [root.id] : []
  }))]
  const ids = all ? roots : [...new Set([store.selectedIssueId, ...roots.slice(0, 3), ...roots.slice(-3)])]
  const paths = reposToViews(store.repos).flatMap(repo => repo.worktrees.map(tree => tree.path))
  let positions = 0
  for (const selectedId of ids) {
    for (const mode of ['full', 'working', 'needs-you'] as const) {
      const input: MobileScreenCheck = { tasks, selectedId: selectedId ?? null, mode, worktreePaths: paths }
      const stop = reaction(() => poolMobileScreensSnapshot(pool, input), () => {}, { fireImmediately: true })
      try {
        settle(pool, input)
        const result = tracked(() => checkMobileScreens(pool, issues, store.sessions, input))
        expect(result, `${label} ${selectedId} ${mode}`).toMatchObject({ differences: 0, first: null, pending: 0 })
        positions += result.rows
      } finally { stop() }
    }
  }
  for (const options of [
    { ...tasks, showDone: true, expanded: roots.slice(0, 5), showAgentTasks: true },
    { ...tasks, filter: { stage: 'review' as const }, expanded: roots.slice(0, 5), ordering: 'updated' as const },
    { ...tasks, filter: { archived: true }, showDone: true },
  ]) {
    const input: MobileScreenCheck = { tasks: options, selectedId: ids[0] ?? null, mode: 'full', worktreePaths: paths }
    settle(pool, input)
    expect(tracked(() => checkMobileScreens(pool, issues, store.sessions, input)), `${label} board options`)
      .toMatchObject({ differences: 0, first: null, pending: 0 })
  }
  return positions
}
for (const scale of [1, 4] as const) it(`phone Tasks, Mission and Details: corpus and focused gates at ${scale}x`, async () => {
  const ctx = await startScenarioEngine(scale), feeds = openFenceFeeds(ctx, 'overlaid')
  const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, { summaries: MOBILE_SCREEN_SUMMARIES })
  await attachMobileScreens(handle.pool)
  try {
    let positions = compare(handle.pool, ctx.engine.getSnapshot(), 'corpus', scale === 1)
    for (const scenario of FENCE_SCENARIOS) {
      await scenario.write(ctx); feeds.flush()
      positions += compare(handle.pool, ctx.engine.getSnapshot(), scenario.scenario, false)
    }
    await writeRescopeGrow(ctx); feeds.flush(); positions += compare(handle.pool, ctx.engine.getSnapshot(), 'scope growth', false)
    await writeRescopeBack(ctx); feeds.flush(); positions += compare(handle.pool, ctx.engine.getSnapshot(), 'scope back', false)
    expect(positions).toBeGreaterThan(0)
    console.info('[phone screen parity]', JSON.stringify({ scale, gates: FENCE_SCENARIOS.length + 2, positions, differences: 0 }))
  } finally { handle.dispose(); feeds.dispose(); ctx.engine.destroy() }
}, 600_000)
