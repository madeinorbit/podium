import { reaction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { checkSidebar, compareSidebarSnapshots, poolSidebarSnapshot, type SidebarDifference, type SidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import type { MobxPool } from '@podium/client-graph/pool'
import type { SidebarState } from '@podium/client-graph/worklist/sidebar'
import { createWorklistPool } from '@podium/client-graph/create'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { startScenarioEngine, writeRescopeGrow, writeRescopeBack } from '../../../shared/src/scenarios'
import { gen, genCorpus } from '../../../shared/src/gen/changes'
import { startGenRun } from '../../../shared/src/gen/run'
import { FENCE_SCENARIOS, openFenceFeeds } from '../fence-scenarios'
import { tracked } from '../adapters/mobx-pool'
import { installMobxWarnTrap } from '../mobx-trap'
import { writeResult } from '../results'

installMobxWarnTrap()

function settle(pool: MobxPool, state: SidebarState = {}): void {
  for (let round = 0; round < 64; round += 1) {
    tracked(() => poolSidebarSnapshot(pool, state))
    if (pool.hydrate() === 0) return
  }
  throw new Error('Sidebar check failed to settle')
}

function sample(): SidebarSnapshot {
  return { pending: 0, sections: [
    { key: 'pinned', fields: { collapsed: false }, rows: [] },
    { key: 'repo-a:open', fields: { label: 'Sensitive title' }, rows: [{ id: 'one', fields: { color: null, title: 'Private question' } }, { id: 'two', fields: { color: null } }] },
    { key: 'repo-b:open', fields: {}, rows: [{ id: 'three', fields: { color: null } }] },
  ] }
}

describe('ordered sidebar differential', () => {
  it('matches independently allocated snapshots', () => {
    expect(compareSidebarSnapshots(sample(), sample())).toMatchObject({ differences: 0, first: null, rows: 3, sections: 3 })
  })
  it.each(['drop-field', 'reorder-band', 'keep-evicted-row', 'reorder-row', 'missing-section', 'roster-field'])(
    'identifies the first location for %s without row values', plant => {
      const actual = structuredClone(sample())
      const sections = actual.sections as Array<{ key: string; fields: Record<string, unknown>; rows: Array<{ id: string; fields: Record<string, unknown> }> }>
      if (plant === 'drop-field') delete sections[1]!.rows[0]!.fields.color
      if (plant === 'reorder-band') [sections[1], sections[2]] = [sections[2]!, sections[1]!]
      if (plant === 'keep-evicted-row') sections[1]!.rows.push({ id: 'evicted', fields: {} })
      if (plant === 'reorder-row') sections[1]!.rows.reverse()
      if (plant === 'missing-section') sections.pop()
      if (plant === 'roster-field') sections[1]!.rows[0]!.fields.sessions = [{ sessionId: 'unexpected' }]
      const locations: SidebarDifference[] = []
      const result = compareSidebarSnapshots(sample(), actual, difference => locations.push(difference))
      expect(result.differences).toBeGreaterThan(0)
      expect(locations).toHaveLength(result.differences)
      expect(locations[0]).toEqual(result.first)
      expect(result.first).toMatchObject(plant === 'missing-section' ? { sectionIndex: 2, field: 'section' }
        : plant === 'reorder-band' ? { sectionIndex: 1, field: 'section' }
        : { sectionIndex: 1, rowIndex: plant === 'keep-evicted-row' ? 2 : 0, field: plant === 'drop-field' ? 'color' : plant === 'roster-field' ? 'sessions' : 'id' })
      expect(JSON.stringify(result)).not.toMatch(/Sensitive title|Private question/)
      expect(JSON.stringify(locations)).not.toMatch(/Sensitive title|Private question/)
    },
  )
  it('reports a nested session field and loading separately', () => {
    const expected: SidebarSnapshot = { pending: 0, sections: [{ key: 'roster', fields: {}, rows: [{ id: 'lane', fields: { sessions: [{ sessionId: 'seat', agentState: { phase: 'idle' } }] } }] }] }
    const actual: SidebarSnapshot = { pending: 2, sections: [{ key: 'roster', fields: {}, rows: [{ id: 'lane', fields: { sessions: [{ sessionId: 'seat', agentState: { phase: 'working' } }] } }] }] }
    expect(compareSidebarSnapshots(expected, actual)).toMatchObject({ pending: 2, first: { field: 'sessions[0].agentState.phase' } })
  })
})

describe('sidebar differential replay', () => {
  for (const scale of [1, 4] as const) it(`corpus and every methodology change at ${scale}x`, async () => {
    const ctx = await startScenarioEngine(scale)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = createWorklistPool(feeds.rows.source, feeds.locals.source)
    const stop = reaction(() => poolSidebarSnapshot(handle.pool), () => {}, { fireImmediately: true })
    const checks: Array<{ scenario: string; rows: number; differences: number }> = []
    const check = (scenario: string): void => {
      feeds.flush(); settle(handle.pool)
      const store = ctx.engine.getSnapshot()
      const state: SidebarState = { pinnedRepos: store.pins.repos, pinnedWorktrees: store.pins.worktrees, projectOrder: store.sidebarSettings.repoOrder }
      const result = tracked(() => checkSidebar(handle.pool, store, state))
      expect(result, scenario).toMatchObject({ differences: 0, first: null, pending: 0 })
      checks.push({ scenario, rows: result.rows, differences: result.differences })
    }
    try {
      check('corpus')
      for (const scenario of FENCE_SCENARIOS) { await scenario.write(ctx); check(scenario.scenario) }
      await writeRescopeGrow(ctx); check('rescopeGrowth')
      await writeRescopeBack(ctx); check('rescopeBack')
      writeResult(`sidebar-check-${scale}x`, { issue: 'POD-4954', scale, checks })
    } finally { stop(); handle.dispose(); feeds.dispose(); ctx.engine.destroy() }
  }, 600_000)

  it('cold bootstrap and a fresh principal compare after batched loading', async () => {
    for (const principal of ['checker-one', 'checker-two']) {
      const ctx = await startScenarioEngine(1, { principal, start: false })
      const rows = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
      const locals = createEngineLocals(ctx.engine)
      const handle = createWorklistPool(rows.source, locals.source)
      try {
        ctx.engine.start()
        for (let turn = 0; turn < 10; turn += 1) await new Promise(resolve => setTimeout(resolve, 0))
        rows.flush(); locals.flush(); settle(handle.pool)
        expect(tracked(() => checkSidebar(handle.pool, ctx.engine.getSnapshot()))).toMatchObject({ differences: 0, first: null })
      } finally { handle.dispose(); locals.dispose(); rows.dispose(); ctx.engine.destroy() }
    }
  }, 600_000)

  const firstSeed = Number(process.env['POD_POOL_GATE_FIRST_SEED'] ?? 1)
  const seeds = Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3)
  const steps = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
  for (let seed = firstSeed; seed <= seeds; seed += 1) it(`every random change, seed ${seed}`, async () => {
    const corpus = genCorpus()
    const changes = gen(seed, steps, {}, { corpus, forceSidebarValues: true })
    const run = await startGenRun({ corpus, feedMode: 'overlaid' })
    let feed = run.feed(), locals = createEngineLocals(run.ctx.engine)
    let handle = createWorklistPool(feed.source, locals.source)
    const observe = () => reaction(() => poolSidebarSnapshot(handle.pool), () => {}, { fireImmediately: true })
    let stop = observe()
    try {
      for (let index = 0; index < changes.length; index += 1) {
        await run.apply(changes[index]!)
        if (feed !== run.feed()) {
          stop(); handle.dispose(); locals.dispose()
          feed = run.feed(); locals = createEngineLocals(run.ctx.engine)
          handle = createWorklistPool(feed.source, locals.source); stop = observe()
        }
        locals.flush(); settle(handle.pool)
        const store = run.ctx.engine.getSnapshot()
        const keys = tracked(() => handle.pool.groups.keys)
        const state: SidebarState = { pinnedRepos: store.pins.repos, pinnedWorktrees: store.pins.worktrees,
          projectOrder: index % 2 ? [...keys].reverse() : [], collapsed: { 'podium:sidebar:pinned-fold': index % 2 === 1 } }
        const result = tracked(() => checkSidebar(handle.pool, store, state))
        expect(result, `seed ${seed} step ${index} ${changes[index]!.kind}`).toMatchObject({ differences: 0, first: null, pending: 0 })
      }
      writeResult(`sidebar-check-seed-${seed}`, { issue: 'POD-4954', seed, steps: changes.length, differences: 0 })
    } finally { stop(); handle.dispose(); locals.dispose(); run.dispose() }
  }, 600_000)
})
