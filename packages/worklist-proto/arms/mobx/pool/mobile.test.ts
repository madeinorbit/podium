/** Mobile corpus parity and the observed random-change gate. Only the oracle
 * imports the real phone band projection and legacy row derivation. */
import { reaction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { createWorklistPool } from '@podium/client-graph/create'
import type { MobxPool } from '@podium/client-graph/pool'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { settableLocals } from '@podium/client-graph/shared/locals-source'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { MOBILE_ROW_FIELDS } from '@podium/client-graph/worklist/mobile-row'
import type { MobileWorkState } from '@podium/client-graph/worklist/mobile'
import { harnessMobxPoolArm, tracked } from '../../../harness/src/adapters/mobx-pool'
import { createReplaySource } from '../../../harness/src/count-harness'
import { openFenceFeeds, FENCE_SCENARIOS } from '../../../harness/src/fence-scenarios'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { checkMobile, poolMobileSnapshot } from '../../../harness/src/oracle/mobile'
import { legacyDerivationFromStore } from '../../../harness/src/oracle/oracle'
import { writeResult } from '../../../harness/src/results'
import { countKinds, gen, genCorpus } from '../../../shared/src/gen/changes'
import { startGenRun } from '../../../shared/src/gen/run'
import { DISABLED_READ_FENCE } from '../../../shared/src/instrument/reads'
import { startScenarioEngine, upsert } from '../../../shared/src/scenarios'

installMobxWarnTrap()

function settle(pool: MobxPool, state: MobileWorkState = {}): void {
  for (let window = 0; window < 64; window += 1) {
    tracked(() => poolMobileSnapshot(pool, state))
    if (pool.hydrate() === 0) return
  }
  throw new Error('Mobile payload did not settle its batched loads')
}

describe('mobile pool values', () => {
  for (const scale of [1, 4] as const) it(`corpus and methodology changes at ${scale}x`, async () => {
    const ctx = await startScenarioEngine(scale)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = createWorklistPool(feeds.rows.source, feeds.locals.source)
    const stop = reaction(() => poolMobileSnapshot(handle.pool), () => {}, { fireImmediately: true })
    const checks: unknown[] = []
    const check = (scenario: string) => {
      feeds.flush(); settle(handle.pool)
      const derivation = legacyDerivationFromStore(ctx.engine.getSnapshot(), handle.pool.clock.current)
      for (const searching of [false, true]) {
        const state = { searching, collapsed: Object.fromEntries(['pinned', 'needs-you', ...derivation.slice.groups.map(group => group.key)]
          .map(key => [`podium:sidebar:work-group-fold:${key}`, true])) }
        const result = tracked(() => checkMobile(handle.pool, derivation, state))
        expect(result, `${scenario}, searching=${searching}`).toMatchObject({ differences: 0, first: null, pending: 0 })
        checks.push({ scenario, searching, ...result })
      }
      const first = tracked(() => handle.pool.mobileWork.sections().orderingSections.flatMap(section => section.data)[0]!)
      const value = tracked(() => handle.pool.mobileWork.row(first))
      expect(value).not.toBe(LOADING)
      expect(Object.keys(value!).sort()).toEqual([...MOBILE_ROW_FIELDS].sort())
    }
    try {
      check('corpus')
      for (const scenario of FENCE_SCENARIOS) { await scenario.write(ctx); check(scenario.scenario) }
      writeResult(`mobile-${scale}x`, { issue: 'POD-4975', scale, checks })
    } finally { stop(); handle.dispose(); feeds.dispose(); ctx.engine.destroy() }
  }, 600_000)

  it('pinned asks keep both keys, complete counts and their original reorder scope', async () => {
    const run = await startGenRun({ feedMode: 'overlaid' })
    const locals = createEngineLocals(run.ctx.engine)
    const handle = createWorklistPool(run.feed().source, locals.source)
    const id = 'mobile-pinned-ask'
    try {
      await run.apply({ kind: 'newIssue', id, parentId: null, title: 'Pinned ask' })
      await run.apply({ kind: 'newSession', sessionId: 'mobile-asker', issueId: id, phase: 'idle' })
      await run.apply({ kind: 'offerChange', sessionId: 'mobile-asker', offer: true })
      await run.apply({ kind: 'issueFacts', id, variant: 0 })
      locals.flush(); run.feed().flush(); settle(handle.pool)
      const split = tracked(() => handle.pool.mobileWork.sections())
      expect(split.sections[0]!.key).toBe('pinned')
      expect(split.sections.find(section => section.key === 'pinned')!.data).toContainEqual({ id, kind: 'issue', listKey: id })
      expect(split.sections.find(section => section.key === 'needs-you')!.data).toContainEqual({ id, kind: 'issue', listKey: `needs-you:${id}` })
      expect(split.orderingSections.some(section => section.key === 'needs-you')).toBe(false)
      const ids = split.sections.flatMap(section => section.data.map(row => row.listKey))
      expect(new Set(ids).size).toBe(ids.length)
      expect(tracked(() => checkMobile(handle.pool, legacyDerivationFromStore(run.ctx.engine.getSnapshot(), handle.pool.clock.current))))
        .toMatchObject({ differences: 0, first: null, pending: 0 })
    } finally { handle.dispose(); locals.dispose(); run.dispose() }
  }, 120_000)

  it('draft quietness suppresses unread until the first runtime state and opens its session', async () => {
    const run = await startGenRun({ feedMode: 'overlaid' })
    const locals = createEngineLocals(run.ctx.engine)
    const handle = createWorklistPool(run.feed().source, locals.source)
    const id = 'mobile-quiet-draft', sessionId = 'mobile-draft-seat'
    const ref = { id, kind: 'issue' as const }
    try {
      await run.apply({ kind: 'newDraftIssue', id, title: 'Draft' })
      await run.apply({ kind: 'newSession', sessionId, issueId: id, phase: 'idle' })
      const session = run.ctx.cache.read('session', sessionId)!.value as Record<string, unknown>
      upsert(run.ctx, 'session', sessionId, { ...session, busy: false, agentState: undefined })
      run.feed().flush(); locals.flush(); settle(handle.pool)
      expect(tracked(() => handle.pool.mobileWork.row(ref))).toMatchObject({ draftOnly: true, draftQuiet: true, unread: false, navigation: { kind: 'session', id: sessionId } })
      const stop = reaction(() => handle.pool.mobileWork.row(ref), () => {}, { fireImmediately: true })
      try {
        await run.apply({ kind: 'phaseChange', sessionId, phase: 'idle' })
        locals.flush(); settle(handle.pool)
        expect(tracked(() => handle.pool.mobileWork.row(ref))).toMatchObject({ draftOnly: true, draftQuiet: false })
        expect(tracked(() => checkMobile(handle.pool, legacyDerivationFromStore(run.ctx.engine.getSnapshot(), handle.pool.clock.current))))
          .toMatchObject({ differences: 0, first: null, pending: 0 })
      } finally { stop() }
    } finally { handle.dispose(); locals.dispose(); run.dispose() }
  }, 120_000)

  it('cold reads return LOADING without hydrating, batch requests, and forget evicted rows', () => {
    const corpus = buildCorpus(1)
    const replay = createReplaySource({
      issues: corpus.sliceIssues.map(value => ({ kind: 'issue', id: value.id, value })),
      sessions: corpus.sliceSessions.map(value => ({ kind: 'session', id: value.sessionId, value })),
      worktrees: corpus.sliceWorktrees.map(value => ({ kind: 'worktree', id: value.path, value })),
    })
    const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
    let scheduled = 0
    const handle = harnessMobxPoolArm.create(replay.source, locals.source, DISABLED_READ_FENCE, { schedule: () => { scheduled += 1; return () => {} } })
    const hydrate = vi.spyOn(handle.pool, 'hydrate')
    try {
      const ids = handle.pool.residency!.ids('issue').slice(0, 2)
      expect(ids).toHaveLength(2)
      const before = scheduled
      expect(tracked(() => ids.map(id => handle.pool.mobileWork.row({ id, kind: 'issue' })))).toEqual([LOADING, LOADING])
      expect(hydrate).not.toHaveBeenCalled()
      expect(scheduled - before).toBeLessThanOrEqual(1)
      for (let window = 0; window < 64; window += 1) {
        tracked(() => ids.map(id => handle.pool.mobileWork.row({ id, kind: 'issue' })))
        if (handle.pool.hydrate() === 0) break
      }
      expect(tracked(() => ids.map(id => handle.pool.mobileWork.row({ id, kind: 'issue' })))).not.toContain(LOADING)
      replay.push({ type: 'update', rows: [{ kind: 'issue', id: ids[0]!, value: undefined }] })
      expect(tracked(() => handle.pool.mobileWork.row({ id: ids[0]!, kind: 'issue' }))).toBeUndefined()
      expect(tracked(() => handle.pool.mobileWork.row({ id: 'never-known', kind: 'issue' }))).toBeUndefined()
    } finally { hydrate.mockRestore(); handle.dispose() }
  })

  const firstSeed = Number(process.env['POD_POOL_GATE_FIRST_SEED'] ?? 1)
  const seeds = Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3)
  const steps = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
  for (let seed = firstSeed; seed <= seeds; seed += 1) it(`observed random-change gate, seed ${seed}`, async () => {
    const corpus = genCorpus(), changes = gen(seed, steps, {}, { corpus, forceSidebarValues: true })
    const run = await startGenRun({ corpus, feedMode: 'overlaid' })
    let feed = run.feed(), locals = createEngineLocals(run.ctx.engine)
    let handle = createWorklistPool(feed.source, locals.source)
    const observe = () => reaction(() => poolMobileSnapshot(handle.pool), () => {}, { fireImmediately: true })
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
        const derivation = legacyDerivationFromStore(run.ctx.engine.getSnapshot(), handle.pool.clock.current)
        const state = { searching: index % 3 === 0, collapsed: { 'podium:sidebar:work-group-fold:needs-you': index % 2 === 1 } }
        expect(tracked(() => checkMobile(handle.pool, derivation, state)), `seed ${seed}, step ${index}, ${changes[index]!.kind}`)
          .toMatchObject({ differences: 0, first: null, pending: 0 })
      }
      writeResult(`mobile-seed-${seed}`, { issue: 'POD-4975', seed, steps: changes.length, ...countKinds(changes), differences: 0 })
    } finally { stop(); handle.dispose(); locals.dispose(); run.dispose() }
  }, 600_000)
})
