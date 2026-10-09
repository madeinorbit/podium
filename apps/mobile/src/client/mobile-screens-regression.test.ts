import { attachMissionTestPreferences } from '@podium/client-graph/mission-screen.test.fixture'
import { referenceState } from '../../../../tests/worklist/diagnostics/reference-state'
/** Exact pool-only phone outputs frozen after the accepted parity controls.
 * Synthetic fixture roots select the same questions and publication gates. */

import { createHash } from 'node:crypto'
import type { ReferenceState as Store } from '../../../../tests/worklist/diagnostics/reference-state'
import { type IssueNavigationModel, missionRootFor } from '@podium/client-core/values'
import { createWorklistPool } from '@podium/client-graph/create'
import {
  type MobileScreenInput,
  observeMobileScreens,
  poolMobileScreensSnapshot,
  trackMobileScreenRead as tracked,
} from '../../../../tests/worklist/diagnostics/mobile-screens-snapshot'
import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES } from '@podium/client-graph/mobile-screens-schema'
import { MobxPool } from '@podium/client-graph/pool'
import { MissionScreen } from '@podium/client-graph/mission-screen'
import { settled } from '@podium/client-graph/mission-view'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { autorun } from 'mobx'
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

it.each([
  { selectedId: 'i100', header: { id: 'i100', archived: true, startedBySession: 's4048' }, hash: 'd96ff48b3da330f4bd8b8783fb43a8e93d84154c89fcd728218cc105ca96397e' },
  { selectedId: 'i1157', header: { id: 'i1321', archived: true }, hash: '4ffc0f9ff59ee6fc4c40417d6d432967503d349abc3002307d8b74ce92a5e5b5' },
])('archived corpus $selectedId retains its full header and frozen phone output', async ({ selectedId, header, hash }) => {
  const ctx = await startScenarioEngine(1), feeds = openFenceFeeds(ctx, 'pooled')
  const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, {
    summaries: MOBILE_SCREEN_SUMMARIES,
  })
  await attachMobileScreens(handle.pool)
  try {
    for (const mode of ['full', 'working', 'needs-you'] as const) {
      const input: MobileScreenInput = {
        selectSession: mostRelevantSession, tasks: null, selectedId, mode,
      }
      const stop = observeMobileScreens(handle.pool, input)
      try {
        settle(handle.pool, input)
        const output = tracked(() => poolMobileScreensSnapshot(handle.pool, input))
        if (typeof output === 'symbol') throw new Error('Archived root is still loading')
        expect(output.sections.find(section => section.key === 'mission')?.fields).toMatchObject({
          root: selectedId, header,
        })
        // The existing corpus snapshots freeze these hashes in all three modes.
        expect(fingerprint(output)).toBe(hash)
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

it('phone mission batches cold spin-offs and their dependency targets together', () => {
  const stamp = new Date(FIXED_NOW).toISOString()
  const old = new Date(FIXED_NOW - 30 * 86_400_000).toISOString()
  const issue = (id: string, patch: Record<string, unknown> = {}) => ({
    id, seq: 1, title: id, description: '', stage: 'in_progress', deps: [], parentId: null,
    repoPath: '/synthetic', createdAt: old, updatedAt: stamp, readAt: stamp, ...patch,
  }) as unknown as IssueNavigationModel
  const width = 80
  const cold = { stage: 'done', closedAt: old, updatedAt: old, readAt: old }
  const rows = [
    issue('root'),
    ...Array.from({ length: width }, (_, index) => issue(`branch-${index}`, {
      ...cold,
      deps: [{ id: 'root', type: 'discovered-from' }, { id: `target-${index}`, type: 'blocks' }],
    })),
    ...Array.from({ length: width }, (_, index) => issue(`target-${index}`, cold)),
    issue('unrelated-history', cold),
  ]
  const byId = new Map(rows.map(row => [row.id as string, row]))
  const load = vi.fn((_entity: string, id: string) => byId.get(id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: FIXED_NOW }, undefined, {
    load, summaries: MOBILE_SCREEN_SUMMARIES, schedule: () => () => {},
  })
  attachMissionTestPreferences(pool)
  const screen = new MissionScreen(pool, 'root')
  let stop = () => {}
  try {
    pool.apply({ type: 'replace', rows: rows.map(value => ({ kind: 'issue' as const, id: value.id, value })) })
    // The phone's opening draws where the work went: every cold spin-off and
    // the dependency each one waits on. A cold sibling must not prevent the
    // remaining siblings from requesting their rows.
    const read = () => settled(() => screen.ready
      ? [screen.rootId, ...screen.otherDepartures.map(departure => departure.issue.id), ...screen.otherDepartures.flatMap(departure =>
        departure.issue.deps.filter(dep => dep.type === 'blocks').map(dep => dep.id))]
      : LOADING)
    // Keep the opening mounted while hydration publishes the next load wave.
    stop = autorun(() => { read() })
    expect(read()).toBe(LOADING)
    expect(load).not.toHaveBeenCalled()
    let batches = 0
    while (pool.hydrate() > 0) batches++
    const addressed = read()
    expect(addressed).not.toBe(LOADING)
    if (addressed === LOADING) throw new Error('Phone mission is still loading')
    expect(new Set(addressed)).toEqual(new Set(rows.slice(0, -1).map(row => row.id)))
    expect(batches).toBeLessThanOrEqual(2)
    expect(load).toHaveBeenCalledTimes(width * 2)
    expect(pool.hydrate()).toBe(0)
    expect(pool.tables.issue.has('unrelated-history')).toBe(false)
  } finally {
    stop()
    screen.close()
    pool.dispose()
  }
})

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
