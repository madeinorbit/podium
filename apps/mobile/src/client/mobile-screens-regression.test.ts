import { referenceState } from '../../../../tests/worklist/diagnostics/reference-state'
/** Exact pool-only phone outputs frozen after the accepted parity controls.
 * Synthetic fixture roots select the same questions and publication gates. */

import { createHash } from 'node:crypto'
import type { ReferenceState as Store } from '../../../../tests/worklist/diagnostics/reference-state'
import { missionRootFor } from '@podium/client-core/values'
import { createWorklistPool } from '@podium/client-graph/create'
import {
  type MobileScreenInput,
  observeMobileScreens,
  poolMobileScreensSnapshot,
  trackMobileScreenRead as tracked,
} from '../../../../tests/worklist/diagnostics/mobile-screens-snapshot'
import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES } from '@podium/client-graph/mobile-screens-schema'
import type { MobxPool } from '@podium/client-graph/pool'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  FENCE_SCENARIOS,
  openFenceFeeds,
} from '../../../../tests/worklist/harness/src/fence-scenarios'
import { FIXED_NOW } from '../../../../tests/worklist/harness/src/fixture/corpus'
import {
  startScenarioEngine,
  writeRescopeBack,
  writeRescopeGrow,
} from '../../../../tests/worklist/shared/src/scenarios'
import { mostRelevantSession } from '../lib/mission-session'

function fingerprint(value: unknown) {
  const normalized = JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  )
  if (normalized === undefined) throw new Error('Phone pool output is not settled')
  return createHash('sha256').update(normalized).digest('hex')
}

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
function settle(pool: MobxPool, input: MobileScreenInput) {
  for (let round = 0; round < 64; round++) {
    tracked(() => poolMobileScreensSnapshot(pool, input))
    if (!pool.hydrate()) return
  }
  throw new Error('Phone batched loads did not settle')
}
function compare(pool: MobxPool, store: Store, label: string, all: boolean) {
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
        settle(pool, input)
        const output = tracked(() => poolMobileScreensSnapshot(pool, input))
        if (typeof output === 'symbol') throw new Error('Phone output is still loading')
        expect(output.pending).toBe(0)
        expect(fingerprint(tracked(() => poolMobileScreensSnapshot(pool, input)))).toMatchSnapshot(
          `${label} ${selectedId} ${mode}`,
        )
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
    settle(pool, input)
    expect(fingerprint(tracked(() => poolMobileScreensSnapshot(pool, input)))).toMatchSnapshot(
      `${label} board options ${optionIndex}`,
    )
  }
  return positions
}
for (const scale of [1, 4] as const)
  it(`phone Tasks, Mission and Details: corpus and focused gates at ${scale}x`, async () => {
    const ctx = await startScenarioEngine(scale),
      feeds = openFenceFeeds(ctx, 'pooled')
    const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, {
      summaries: MOBILE_SCREEN_SUMMARIES,
    })
    await attachMobileScreens(handle.pool)
    try {
      let positions = compare(handle.pool, referenceState(ctx.engine), 'corpus', scale === 1)
      for (const scenario of FENCE_SCENARIOS) {
        await scenario.write(ctx)
        feeds.flush()
        positions += compare(handle.pool, referenceState(ctx.engine), scenario.scenario, false)
      }
      await writeRescopeGrow(ctx)
      feeds.flush()
      positions += compare(handle.pool, referenceState(ctx.engine), 'scope growth', false)
      await writeRescopeBack(ctx)
      feeds.flush()
      positions += compare(handle.pool, referenceState(ctx.engine), 'scope back', false)
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
