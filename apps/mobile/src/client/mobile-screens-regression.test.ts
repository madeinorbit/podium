import { expectMobileScreens } from '../../../../tests/worklist/diagnostics/mobile-screens-reference'
import { referenceState } from '../../../../tests/worklist/diagnostics/reference-state'

/** Phone outputs compared to an independent record oracle across the accepted corpus gates. */

import { missionRootFor } from '@podium/client-core/values'
import { createWorklistPool } from '@podium/client-graph/create'
import { missionView, requireLoaded } from '@podium/client-graph/mission-view'
import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import type { MobxPool } from '@podium/client-graph/pool'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  type MobileScreenInput,
  mobileScreenLoadingState,
  observeMobileScreens,
  poolMobileScreensSnapshot,
  trackMobileScreenRead as tracked,
} from '../../../../tests/worklist/diagnostics/mobile-screens-snapshot'
import type { ReferenceState as Store } from '../../../../tests/worklist/diagnostics/reference-state'
import { FENCE_SCENARIOS, openFenceFeeds } from '../../../../tests/worklist/harness/src/fence-feeds'
import { FIXED_NOW } from '../../../../tests/worklist/harness/src/fixture/corpus'
import {
  startScenarioEngine,
  writeRescopeBack,
  writeRescopeGrow,
} from '../../../../tests/worklist/shared/src/scenarios'
import { mostRelevantSession } from '../lib/mission-session'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
})
afterEach(() => vi.useRealTimers())
const tasks: NonNullable<MobileScreenInput['tasks']> = {
  showDone: false,
  expanded: [],
  filter: {},
  ordering: 'priority',
  showAgentTasks: false,
}
async function settle(pool: MobxPool, input: MobileScreenInput) {
  for (let round = 0; round < 64; round++) {
    const output = tracked(() => poolMobileScreensSnapshot(pool, input))
    if (typeof output !== 'symbol') return
    if (!pool.hydrate())
      // Large missions warm their rows in MessageChannel tasks. A drained
      // record-load queue does not mean that the opening has finished.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(
    `Phone opening did not settle: ${JSON.stringify(tracked(() => mobileScreenLoadingState(pool, input)))}`,
  )
}

it.each([
  { selectedId: 'i100', header: { id: 'i100', archived: true, startedBySession: 's4048' } },
  { selectedId: 'i1157', header: { id: 'i1321', archived: true } },
])('archived corpus $selectedId retains its full header and record-derived phone output', async ({
  selectedId,
  header,
}) => {
  const ctx = await startScenarioEngine(1),
    feeds = openFenceFeeds(ctx, 'pooled')
  const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, {})
  feeds.attachPool(handle.pool)
  await attachMobileScreens(handle.pool)
  try {
    for (const mode of ['full', 'working', 'needs-you'] as const) {
      const input: MobileScreenInput = {
        selectSession: mostRelevantSession,
        tasks: null,
        selectedId,
        mode,
      }
      const stop = observeMobileScreens(handle.pool, input)
      try {
        await settle(handle.pool, input)
        const output = tracked(() => poolMobileScreensSnapshot(handle.pool, input))
        if (typeof output === 'symbol') throw new Error('Archived root is still loading')
        expect(output.sections.find((section) => section.key === 'mission')?.fields).toMatchObject({
          root: selectedId,
          header,
        })
        expectMobileScreens(
          output,
          referenceState(ctx.engine),
          input,
          `archived ${selectedId} ${mode}`,
        )
      } finally {
        stop()
      }
    }
  } finally {
    handle.dispose()
    feeds.dispose()
    ctx.dispose()
  }
})

async function compare(pool: MobxPool, store: Store, label: string, all: boolean) {
  console.info('[phone gate]', label)
  const issues = store.issueProjections
  const roots = [
    ...new Set(
      issues.flatMap((issue) => {
        const root = missionRootFor(issues, issue.id)
        return root ? [root.id] : []
      }),
    ),
  ]
  const ids = all
    ? [null, ...roots]
    : [...new Set([store.selectedIssueId, ...roots.slice(0, 3), ...roots.slice(-3)])]
  let positions = 0
  for (const selectedId of ids) {
    for (const mode of ['full', 'working', 'needs-you'] as const) {
      const input: MobileScreenInput = {
        selectSession: mostRelevantSession,
        tasks: selectedId === null ? tasks : null,
        selectedId: selectedId ?? null,
        mode,
      }
      const stop = observeMobileScreens(pool, input)
      try {
        await settle(pool, input)
        const output = tracked(() => poolMobileScreensSnapshot(pool, input))
        if (typeof output === 'symbol')
          throw new Error(
            `${label} ${selectedId} ${mode}: phone output is still loading ${JSON.stringify(tracked(() => mobileScreenLoadingState(pool, input)))}`,
          )
        expect(output.pending).toBe(0)
        try {
          expectMobileScreens(output, store, input, `${label} ${selectedId} ${mode}`)
        } catch (error) {
          // Fixed field names and opaque ids only. A filtered branch mismatch
          // needs its live predicate inputs, not a diff of two id lists alone.
          if (selectedId)
            console.info(
              '[phone filter inputs]',
              JSON.stringify(
                tracked(() =>
                  missionView(pool)
                    .deck(selectedId, 'full')
                    .rows()
                    .filter((row) => row.stage === 'review')
                    .map((row) => ({
                      id: row.id,
                      matched: row.matches(mode),
                      filteredMatched: missionView(pool)
                        .deck(selectedId, mode)
                        .model(row.id)
                        .matches(mode),
                      member: requireLoaded(missionView(pool).deck(selectedId, mode).members).has(
                        row.id,
                      ),
                      fullPath: row.key,
                      parent: row.facts.parentId,
                      path: missionView(pool).deck(selectedId, mode).ancestorPath(row.id),
                      visible: row.facts.visible,
                      coordinated: row.coordinated,
                      stage: row.rulesIssue?.stage,
                      closedReason: row.rulesIssue?.closedReason,
                      dependents: row.rulesIssue?.dependents,
                      crew: row.sessions.map((session) => ({
                        id: session.sessionId,
                        home: session.issueId,
                        status: session.status,
                        archived: session.archived,
                      })),
                    })),
                ),
              ),
            )
          throw error
        }
        positions += output.sections.reduce((count, section) => count + section.rows.length, 0)
      } finally {
        stop()
      }
    }
  }
  for (const [optionIndex, options] of [
    { ...tasks, showDone: true, expanded: roots.slice(0, 5), showAgentTasks: true },
    {
      ...tasks,
      filter: { stage: 'review' as const },
      expanded: roots.slice(0, 5),
      ordering: 'updated' as const,
    },
    { ...tasks, filter: { archived: true }, showDone: true },
  ].entries()) {
    const input: MobileScreenInput = {
      selectSession: mostRelevantSession,
      tasks: options,
      selectedId: ids[0] ?? null,
      mode: 'full',
    }
    await settle(pool, input)
    const output = tracked(() => poolMobileScreensSnapshot(pool, input))
    if (typeof output === 'symbol') throw new Error('Phone board is still loading')
    expectMobileScreens(output, store, input, `${label} board options ${optionIndex}`)
  }
  return positions
}
for (const scale of [1, 4] as const)
  it(`phone Tasks, Mission and Details: corpus and focused gates at ${scale}x`, async () => {
    const ctx = await startScenarioEngine(scale),
      feeds = openFenceFeeds(ctx, 'pooled')
    const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, {})
    feeds.attachPool(handle.pool)
    await attachMobileScreens(handle.pool)
    try {
      let positions = await compare(handle.pool, referenceState(ctx.engine), 'corpus', scale === 1)
      for (const scenario of FENCE_SCENARIOS) {
        await scenario.write(ctx)
        feeds.flush()
        positions += await compare(
          handle.pool,
          referenceState(ctx.engine),
          scenario.scenario,
          false,
        )
      }
      await writeRescopeGrow(ctx)
      feeds.flush()
      positions += await compare(handle.pool, referenceState(ctx.engine), 'scope growth', false)
      await writeRescopeBack(ctx)
      feeds.flush()
      positions += await compare(handle.pool, referenceState(ctx.engine), 'scope back', false)
      expect(positions).toBeGreaterThan(0)
      console.info(
        '[phone screen regression]',
        JSON.stringify({ scale, gates: FENCE_SCENARIOS.length + 2, positions }),
      )
    } finally {
      handle.dispose()
      feeds.dispose()
      ctx.dispose()
    }
  }, 600_000)
