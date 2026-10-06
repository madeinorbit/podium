import { worklistGroups } from '@podium/client-graph/worklist/groups'
import { referenceState } from '../../../diagnostics/reference-state'
import { NAVIGATION_SUMMARIES } from '@podium/client-graph/navigation-schema'
import { createWorklistPool } from '@podium/client-graph/create'
import {
  compareSidebarSnapshots,
  poolSidebarSnapshot,
  type SidebarDifference,
  type SidebarSnapshot,
} from '../../../diagnostics/sidebar-check'
import type { MobxPool } from '@podium/client-graph/pool'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '../../../shared/src/row-source'
import type { SidebarState } from '@podium/client-graph/worklist/sidebar'
import { reaction } from 'mobx'
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
import { writeResult } from '../results'
import { expectFrozenPoolOutput, expectPoolOutput } from './pool-output'

installMobxWarnTrap()
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
})
afterEach(() => vi.useRealTimers())

function settle(pool: MobxPool, state: SidebarState = {}): void {
  for (let round = 0; round < 64; round += 1) {
    tracked(() => poolSidebarSnapshot(pool, state))
    if (pool.hydrate() === 0) return
  }
  throw new Error('Sidebar check failed to settle')
}

function sample(): SidebarSnapshot {
  return {
    pending: 0,
    sections: [
      { key: 'pinned', fields: { collapsed: false }, rows: [] },
      {
        key: 'repo-a:open',
        fields: { label: 'Sensitive title' },
        rows: [
          { id: 'one', fields: { color: null, title: 'Private question' } },
          { id: 'two', fields: { color: null } },
        ],
      },
      { key: 'repo-b:open', fields: {}, rows: [{ id: 'three', fields: { color: null } }] },
    ],
  }
}

describe('ordered sidebar differential', () => {
  it('matches independently allocated snapshots', () => {
    expect(compareSidebarSnapshots(sample(), sample())).toMatchObject({
      differences: 0,
      first: null,
      rows: 3,
      sections: 3,
    })
  })
  it.each([
    'drop-field',
    'reorder-band',
    'keep-evicted-row',
    'reorder-row',
    'missing-section',
    'roster-field',
  ])('identifies the first location for %s without row values', (plant) => {
    const actual = structuredClone(sample())
    const sections = actual.sections as Array<{
      key: string
      fields: Record<string, unknown>
      rows: Array<{ id: string; fields: Record<string, unknown> }>
    }>
    if (plant === 'drop-field') delete sections[1]!.rows[0]!.fields.color
    if (plant === 'reorder-band') [sections[1], sections[2]] = [sections[2]!, sections[1]!]
    if (plant === 'keep-evicted-row') sections[1]!.rows.push({ id: 'evicted', fields: {} })
    if (plant === 'reorder-row') sections[1]!.rows.reverse()
    if (plant === 'missing-section') sections.pop()
    if (plant === 'roster-field')
      sections[1]!.rows[0]!.fields.sessions = [{ sessionId: 'unexpected' }]
    const locations: SidebarDifference[] = []
    const result = compareSidebarSnapshots(sample(), actual, (difference) =>
      locations.push(difference),
    )
    expect(result.differences).toBeGreaterThan(0)
    expect(locations).toHaveLength(result.differences)
    expect(locations[0]).toEqual(result.first)
    expect(result.first).toMatchObject(
      plant === 'missing-section'
        ? { sectionIndex: 2, field: 'section' }
        : plant === 'reorder-band'
          ? { sectionIndex: 1, field: 'section' }
          : {
              sectionIndex: 1,
              rowIndex: plant === 'keep-evicted-row' ? 2 : 0,
              field:
                plant === 'drop-field' ? 'color' : plant === 'roster-field' ? 'sessions' : 'id',
            },
    )
    expect(JSON.stringify(result)).not.toMatch(/Sensitive title|Private question/)
    expect(JSON.stringify(locations)).not.toMatch(/Sensitive title|Private question/)
  })
  it('reports a nested session field and loading separately', () => {
    const expected: SidebarSnapshot = {
      pending: 0,
      sections: [
        {
          key: 'roster',
          fields: {},
          rows: [
            {
              id: 'lane',
              fields: { sessions: [{ sessionId: 'seat', agentState: { phase: 'idle' } }] },
            },
          ],
        },
      ],
    }
    const actual: SidebarSnapshot = {
      pending: 2,
      sections: [
        {
          key: 'roster',
          fields: {},
          rows: [
            {
              id: 'lane',
              fields: { sessions: [{ sessionId: 'seat', agentState: { phase: 'working' } }] },
            },
          ],
        },
      ],
    }
    expect(compareSidebarSnapshots(expected, actual)).toMatchObject({
      pending: 2,
      first: { field: 'sessions[0].agentState.phase' },
    })
  })
})

describe('sidebar readiness', () => {
  it('defers only pending payloads while reporting settled row and header differences', () => {
    const expected = sample()
    const actual: SidebarSnapshot = {
      pending: 1,
      sections: expected.sections.map((section, index) =>
        index !== 1
          ? section
          : {
              ...section,
              fields: { ...section.fields, collapsed: true },
              rows: [
                { id: 'one', pending: true, fields: { loading: true } },
                { id: 'two', fields: { color: 'changed' } },
              ],
            },
      ),
    }
    const locations: SidebarDifference[] = []
    expect(
      compareSidebarSnapshots(expected, actual, (difference) => locations.push(difference)),
    ).toMatchObject({
      differences: 2,
      pending: 1,
      first: { sectionIndex: 1, rowIndex: null, field: 'collapsed' },
    })
    expect(locations).toMatchObject([{ field: 'collapsed' }, { rowIndex: 1, field: 'color' }])
  })

  it.each([
    'reorder-row',
    'missing-row',
    'extra-row',
    'reorder-section',
    'missing-section',
    'header-field',
  ])('keeps %s strict while row payloads are pending', (fault) => {
    const expected = sample()
    const actual = {
      pending: 3,
      sections: expected.sections.map((section) => ({
        ...section,
        fields: { ...section.fields },
        rows: section.rows.map((row) => ({ ...row, pending: true })),
      })),
    }
    if (fault === 'reorder-row') actual.sections[1]!.rows.reverse()
    if (fault === 'missing-row') actual.sections[1]!.rows.pop()
    if (fault === 'extra-row')
      actual.sections[1]!.rows.push({ id: 'extra', pending: true, fields: {} })
    if (fault === 'reorder-section')
      [actual.sections[1], actual.sections[2]] = [actual.sections[2]!, actual.sections[1]!]
    if (fault === 'missing-section') actual.sections.pop()
    if (fault === 'header-field') actual.sections[1]!.fields.label = 'changed'
    const result = compareSidebarSnapshots(expected, actual)
    expect(result.differences).toBeGreaterThan(0)
    expect(result).toMatchObject({
      pending: 3,
      first: {
        field: fault.endsWith('section') ? 'section' : fault === 'header-field' ? 'label' : 'id',
      },
    })
  })

  it('compares the complete nested payload as soon as a pending row settles', () => {
    const row = {
      id: 'lane',
      fields: { sessions: [{ sessionId: 'seat', agentState: { phase: 'idle' } }] },
    }
    const expected: SidebarSnapshot = {
      pending: 0,
      sections: [{ key: 'roster', fields: {}, rows: [row] }],
    }
    const pending: SidebarSnapshot = {
      pending: 1,
      sections: [
        {
          key: 'roster',
          fields: {},
          rows: [{ id: row.id, pending: true, fields: { sessions: [] } }],
        },
      ],
    }
    expect(compareSidebarSnapshots(expected, pending)).toMatchObject({
      differences: 0,
      first: null,
      pending: 1,
    })
    // Readiness on either side defers only this row, without treating loading as equality.
    expect(compareSidebarSnapshots(pending, expected)).toMatchObject({
      differences: 0,
      first: null,
      pending: 1,
    })
    const settled: SidebarSnapshot = {
      pending: 0,
      sections: [
        {
          key: 'roster',
          fields: {},
          rows: [
            {
              id: row.id,
              fields: { sessions: [{ sessionId: 'seat', agentState: { phase: 'working' } }] },
            },
          ],
        },
      ],
    }
    expect(compareSidebarSnapshots(expected, settled)).toMatchObject({
      differences: 1,
      pending: 0,
      first: { field: 'sessions[0].agentState.phase' },
    })
    expect(compareSidebarSnapshots(expected, expected)).toMatchObject({
      differences: 0,
      first: null,
      pending: 0,
    })
  })

  it('defers provisional roster membership and order without shifting settled mismatch locations', () => {
    const row = (id: string, color: string | null = null) => ({ id, fields: { color } })
    const expected: SidebarSnapshot = {
      pending: 0,
      sections: [
        {
          key: 'roster',
          fields: {},
          rows: [row('issue'), row('settled'), row('pending'), row('last')],
        },
      ],
    }
    const actual: SidebarSnapshot = {
      pending: 2,
      sections: [
        {
          key: 'roster',
          fields: {},
          rows: [
            row('issue'),
            { ...row('extra'), pending: true, placementPending: true },
            { ...row('pending'), pending: true, placementPending: true },
            row('settled', 'changed'),
            row('last'),
          ],
        },
      ],
    }
    const locations: SidebarDifference[] = []
    expect(
      compareSidebarSnapshots(expected, actual, (difference) => locations.push(difference)),
    ).toMatchObject({
      differences: 1,
      pending: 2,
      first: { rowIndex: 1, expectedId: 'settled', actualId: 'settled', field: 'color' },
    })
    expect(locations).toHaveLength(1)
    expect(compareSidebarSnapshots(actual, expected)).toMatchObject({
      differences: 1,
      pending: 2,
      first: { rowIndex: 3, field: 'color' },
    })
  })

  it('checks worktree membership and ordering again as soon as its roster settles', () => {
    const row = (id: string) => ({ id, fields: {} })
    const expected: SidebarSnapshot = {
      pending: 0,
      sections: [{ key: 'roster', fields: {}, rows: [row('one'), row('two')] }],
    }
    const actual: SidebarSnapshot = {
      pending: 2,
      sections: [
        {
          key: 'roster',
          fields: {},
          rows: [
            { ...row('two'), pending: true, placementPending: true },
            row('one'),
            { ...row('extra'), pending: true, placementPending: true },
          ],
        },
      ],
    }
    expect(compareSidebarSnapshots(expected, actual)).toMatchObject({
      differences: 0,
      first: null,
      pending: 2,
    })
    const settled: SidebarSnapshot = {
      pending: 0,
      sections: [{ key: 'roster', fields: {}, rows: [row('two'), row('one'), row('extra')] }],
    }
    expect(compareSidebarSnapshots(expected, settled)).toMatchObject({
      differences: 3,
      pending: 0,
      first: { rowIndex: 0, field: 'id' },
    })
  })

  it('compares settled header facts while the empty-project affordance awaits a roster', () => {
    const expected: SidebarSnapshot = {
      pending: 0,
      sections: [{ key: 'roster', fields: { startFirstTask: true, collapsed: false }, rows: [] }],
    }
    const actual: SidebarSnapshot = {
      pending: 1,
      sections: [
        {
          key: 'roster',
          fields: { startFirstTask: false, collapsed: true },
          pendingFields: ['startFirstTask'],
          rows: [],
        },
      ],
    }
    expect(compareSidebarSnapshots(expected, actual)).toMatchObject({
      differences: 1,
      pending: 1,
      first: { rowIndex: null, field: 'collapsed' },
    })
    const settled: SidebarSnapshot = {
      pending: 0,
      sections: [{ key: 'roster', fields: { startFirstTask: false, collapsed: false }, rows: [] }],
    }
    expect(compareSidebarSnapshots(expected, settled)).toMatchObject({
      differences: 1,
      pending: 0,
      first: { field: 'startFirstTask' },
    })
    expect(compareSidebarSnapshots(expected, expected)).toMatchObject({
      differences: 0,
      first: null,
      pending: 0,
    })
  })

  for (const scale of [1, 4] as const)
    it(`reports cold ${scale}x rows separately without draining their batched loads`, async () => {
      const ctx = await startScenarioEngine(scale)
      const feeds = openFenceFeeds(ctx, 'pooled')
      const handle = createWorklistPool(feeds.rows.source, feeds.locals.source)
      const hydrate = vi.spyOn(handle.pool, 'hydrate')
      try {
        const store = referenceState(ctx.engine)
        const state: SidebarState = {
          pinnedRepos: store.pins.repos,
          pinnedWorktrees: store.pins.worktrees,
          projectOrder: store.sidebarSettings.repoOrder,
        }
        const cold = tracked(() => poolSidebarSnapshot(handle.pool, state))
        expect(hydrate).not.toHaveBeenCalled()
        expect(cold.pending).toBeGreaterThan(0)
        const snapshot = tracked(() => poolSidebarSnapshot(handle.pool, state))
        // POD-5407: no lane waits on history sessions any more: a session the
        // rule keeps cold can never be a retained seat, so none is fetched.
        expect(
          snapshot.sections
            .flatMap((section) => section.rows)
            .some((row) => row.pending && 'sessions' in row.fields),
        ).toBe(false)
        settle(handle.pool, state)
        expect(tracked(() => poolSidebarSnapshot(handle.pool, state)).pending).toBe(0)
      } finally {
        hydrate.mockRestore()
        handle.dispose()
        feeds.dispose()
        ctx.dispose()
      }
    }, 120_000)
})

const OWNED = ' (pool owns optimism)'

describe('sidebar differential replay', () => {
  // POD-5432: 'owned' is the pool owning optimism (its log paints, the
  // runtime's actions route through it), against the same legacy oracle.
  for (const mode of ['pooled', 'owned'] as const)
    for (const scale of [1, 4] as const)
      it(`corpus and every methodology change at ${scale}x${mode === 'owned' ? OWNED : ''}`, async () => {
        const ctx = await startScenarioEngine(scale)
        const feeds = openFenceFeeds(ctx, mode)
        // The fixture attaches the app's navigation consumer, so it declares
        // that consumer's cold facts before ingest, exactly as the app does.
        const handle = createWorklistPool(feeds.rows.source, feeds.locals.source, {
          summaries: NAVIGATION_SUMMARIES,
        })
        feeds.attachPool(handle.pool)
        const stop = reaction(
          () => poolSidebarSnapshot(handle.pool),
          () => {},
          { fireImmediately: true },
        )
        const checks: Array<{ scenario: string; rows: number; pending: number }> = []
        const check = (scenario: string): void => {
          feeds.flush()
          settle(handle.pool)
          const store = referenceState(ctx.engine)
          const state: SidebarState = {
            pinnedRepos: store.pins.repos,
            pinnedWorktrees: store.pins.worktrees,
            projectOrder: store.sidebarSettings.repoOrder,
          }
          const result = tracked(() => poolSidebarSnapshot(handle.pool, state))
          expect(result.pending, scenario).toBe(0)
          const output = tracked(() => poolSidebarSnapshot(handle.pool, state))
          // POD-5432: owning optimism, the pool must show exactly the frozen
          // output of the plain run, step for step (no second snapshot copy).
          if (mode === 'owned') expectFrozenPoolOutput(output, scenario, OWNED)
          else expectPoolOutput(output, scenario)
          checks.push({
            scenario,
            rows: result.sections.reduce((sum, section) => sum + section.rows.length, 0),
            pending: result.pending,
          })
        }
        try {
          check('corpus')
          for (const scenario of FENCE_SCENARIOS) {
            await scenario.write(ctx)
            check(scenario.scenario)
          }
          await writeRescopeGrow(ctx)
          check('rescopeGrowth')
          await writeRescopeBack(ctx)
          check('rescopeBack')
          writeResult(`sidebar-check-${scale}x${mode === 'owned' ? '-owned' : ''}`, {
            issue: 'POD-5437',
            scale,
            checks,
          })
        } finally {
          stop()
          handle.dispose()
          feeds.dispose()
          ctx.dispose()
        }
      }, 600_000)

  it('cold bootstrap and a fresh principal compare after batched loading', async () => {
    for (const principal of ['checker-one', 'checker-two']) {
      const ctx = await startScenarioEngine(1, { principal, start: false })
      const rows = createRowSource(ctx.engine, ctx.replica, { mode: 'pooled' })
      const locals = createEngineLocals(ctx.engine)
      const handle = createWorklistPool(rows.source, locals.source)
      try {
        ctx.engine.start()
        for (let turn = 0; turn < 10; turn += 1)
          await new Promise((resolve) => setTimeout(resolve, 0))
        rows.flush()
        locals.flush()
        settle(handle.pool)
        expect(tracked(() => poolSidebarSnapshot(handle.pool)).pending).toBe(0)
      } finally {
        handle.dispose()
        locals.dispose()
        rows.dispose()
        ctx.dispose()
      }
    }
  }, 600_000)

  const firstSeed = Number(process.env['POD_POOL_GATE_FIRST_SEED'] ?? 1)
  const seeds = Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3)
  const steps = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
  for (let seed = firstSeed; seed <= seeds; seed += 1)
    it(`every random change, seed ${seed}`, async () => {
      const corpus = genCorpus()
      const changes = gen(seed, steps, {}, { corpus, forceSidebarValues: true })
      const run = await startGenRun({ corpus, feedMode: 'pooled' })
      let feed = run.feed(),
        locals = createEngineLocals(run.ctx.engine)
      let handle = createWorklistPool(feed.source, locals.source)
      const observe = () =>
        reaction(
          () => poolSidebarSnapshot(handle.pool),
          () => {},
          { fireImmediately: true },
        )
      let stop = observe()
      try {
        for (let index = 0; index < changes.length; index += 1) {
          await run.apply(changes[index]!)
          if (feed !== run.feed()) {
            stop()
            handle.dispose()
            locals.dispose()
            feed = run.feed()
            locals = createEngineLocals(run.ctx.engine)
            handle = createWorklistPool(feed.source, locals.source)
            stop = observe()
          }
          locals.flush()
          settle(handle.pool)
          const store = referenceState(run.ctx.engine)
          const keys = tracked(() => worklistGroups(handle.pool).keys)
          const state: SidebarState = {
            pinnedRepos: store.pins.repos,
            pinnedWorktrees: store.pins.worktrees,
            projectOrder: index % 2 ? [...keys].reverse() : [],
            collapsed: { 'podium:sidebar:pinned-fold': index % 2 === 1 },
          }
          expect(tracked(() => poolSidebarSnapshot(handle.pool, state)).pending).toBe(0)
          expectPoolOutput(
            tracked(() => poolSidebarSnapshot(handle.pool, state)),
            `step ${index}`,
          )
        }
        writeResult(`sidebar-check-seed-${seed}`, {
          issue: 'POD-4954',
          seed,
          steps: changes.length,
          frozenOutputs: true,
        })
      } finally {
        stop()
        handle.dispose()
        locals.dispose()
        run.dispose()
      }
    }, 600_000)
})
