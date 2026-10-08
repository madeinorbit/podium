import { worklistView } from '@podium/client-graph/worklist/view-model'
import { mobileWorkView } from '@podium/client-graph/worklist/mobile'
/** Frozen mobile pool outputs, native identity and observed generated changes. */
import { reaction } from 'mobx'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createWorklistPool } from '@podium/client-graph/create'
import type { MobxPool } from '@podium/client-graph/pool'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { settableLocals } from '@podium/client-graph/shared/locals-source'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { MOBILE_ROW_FIELDS } from '@podium/client-graph/worklist/mobile-row'
import type { MobileWorkSection, MobileWorkState } from '@podium/client-graph/worklist/mobile'
import { harnessMobxPoolArm, tracked } from '../../../harness/src/adapters/mobx-pool'
import { createReplaySource } from '../../../harness/src/count-harness'
import { openFenceFeeds, FENCE_SCENARIOS } from '../../../harness/src/fence-scenarios'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { poolMobileSnapshot } from '../../../harness/src/oracle/mobile-snapshot'
import { writeResult } from '../../../harness/src/results'
import { countKinds, gen, genCorpus } from '../../../shared/src/gen/changes'
import { startGenRun } from '../../../shared/src/gen/run'
import { DISABLED_READ_FENCE } from '../../../shared/src/instrument/reads'
import { settled, startScenarioEngine, upsert } from '../../../shared/src/scenarios'

installMobxWarnTrap()

/** Pending mark-read values use the same deterministic clock as server echoes. */
async function mobileRun(corpus = genCorpus()) {
  let now = () => corpus.fixedNow
  vi.spyOn(Date, 'now').mockImplementation(() => now())
  const run = await startGenRun({ corpus, feedMode: 'pooled' })
  now = () => run.ctx.engine.readLocal('coarseNow')
  return run
}

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
    vi.spyOn(Date, 'now').mockImplementation(() => ctx.engine.readLocal('coarseNow'))
    const feeds = openFenceFeeds(ctx, 'pooled')
    const handle = createWorklistPool(feeds.rows.source, feeds.locals.source)
    feeds.attachPool(handle.pool)
    const nativeState: MobileWorkState = {}
    const checks: unknown[] = []
    let previous: readonly MobileWorkSection[] | undefined
    let retained = 0
    let identityFailure: unknown
    const inspectNative = (scenario: string) => {
      const native = mobileWorkView(handle.pool).mobileSections().sections
      const before = previous
      previous = native
      if (before) for (const section of native) {
        const old = before.find(band => band.key === section.key)
        if (!old) continue
        const refs = (rows: MobileWorkSection['data']) => rows.slice()
        if (JSON.stringify(refs(old.data)) === JSON.stringify(refs(section.data))) {
          expect(section.data, `${scenario} ${section.key}: native data identity`).toBe(old.data)
          retained++
        }
        for (const lane of ['snoozedIds', 'closedIds'] as const) if (JSON.stringify(old[lane]) === JSON.stringify(section[lane])) {
          expect(section[lane], `${scenario} ${section.key}: ${lane} identity`).toBe(old[lane])
        }
        if (JSON.stringify(old) === JSON.stringify(section)) expect(section, `${scenario} ${section.key}: section identity`).toBe(old)
      }
    }
    // Evicting a rescue child can move its parent into and back out of a band
    // within one scenario. Check consecutive publications, not historical
    // versions of a lane whose membership really changed in between.
    const stop = reaction(() => {
      const snapshot = poolMobileSnapshot(handle.pool, nativeState)
      try { inspectNative('observed publication') }
      catch (cause) { identityFailure ??= cause }
      return snapshot
    }, () => {}, { fireImmediately: true })
    const check = async (scenario: string) => {
      feeds.flush(); settle(handle.pool)
      if (scenario === 'selectionClick') {
        // At 4x, navigation activity can need a cold subtree. Its completed
        // loads trigger the eager mark-read after the selection write settled.
        await settled(ctx)
        feeds.flush(); settle(handle.pool)
        expect(tracked(() => worklistView(handle.pool).knownRow(ctx.targets.visibleRootId)?.emphasizeUnread)).toBe(false)
      }
      if (identityFailure) throw identityFailure
      tracked(() => inspectNative(scenario))
      for (const searching of [false, true]) {
        const state = { searching, collapsed: Object.fromEntries(['pinned', 'needs-you', ...tracked(() => mobileWorkView(handle.pool).mobileSections().orderingSections.map(section => section.key))]
          .map(key => [`podium:sidebar:work-group-fold:${key}`, true])) }
        const result = tracked(() => poolMobileSnapshot(handle.pool, state))
        expect(result.pending, `${scenario}, searching=${searching}`).toBe(0)
        expect(createHash('sha256').update(JSON.stringify(tracked(() => poolMobileSnapshot(handle.pool, state)))).digest('hex')).toMatchSnapshot(`${scenario}, searching=${searching}`)
        checks.push({ scenario, searching, sections: result.sections.length, pending: result.pending })
      }
      const first = tracked(() => mobileWorkView(handle.pool).mobileSections().orderingSections.flatMap(section => section.data)[0]!)
      const value = tracked(() => mobileWorkView(handle.pool).mobileRow({ id: first, kind: handle.pool.tables.worktree.has(first) ? 'worktree' : 'issue' }))
      expect(value).not.toBe(LOADING)
      expect(value !== LOADING && value?.ready).toBe('ready')
    }
    try {
      await check('corpus')
      for (const scenario of FENCE_SCENARIOS) { await scenario.write(ctx); await check(scenario.scenario) }
      expect(retained).toBeGreaterThan(0)
      writeResult(`mobile-${scale}x`, { issue: 'POD-5439', scale, checks, retainedNativeArrays: retained })
    } finally { stop(); handle.dispose(); feeds.dispose(); ctx.dispose() }
  }, 600_000)

  it('pinned asks keep both keys, complete counts and their original reorder scope', async () => {
    const run = await mobileRun()
    const locals = createEngineLocals(run.ctx.engine)
    const handle = createWorklistPool(run.feed().source, locals.source)
    const id = 'mobile-pinned-ask'
    try {
      await run.apply({ kind: 'newIssue', id, parentId: null, title: 'Pinned ask' })
      await run.apply({ kind: 'newSession', sessionId: 'mobile-asker', issueId: id, phase: 'idle' })
      await run.apply({ kind: 'offerChange', sessionId: 'mobile-asker', offer: true })
      await run.apply({ kind: 'issueFacts', id, variant: 0 })
      locals.flush(); run.feed().flush(); settle(handle.pool)
      const split = tracked(() => mobileWorkView(handle.pool).mobileSections())
      expect(split.sections[0]!.key).toBe('pinned')
      expect(split.sections.find(section => section.key === 'pinned')!.data).toContain(id)
      expect(split.sections.find(section => section.key === 'needs-you')!.data).toContain(id)
      expect(split.orderingSections.some(section => section.key === 'needs-you')).toBe(false)
      const ids = split.sections.flatMap(section => section.data.map(row => row.listKey))
      expect(new Set(ids).size).toBe(ids.length)
      expect(tracked(() => poolMobileSnapshot(handle.pool)).pending).toBe(0)
      expect(createHash('sha256').update(JSON.stringify(tracked(() => poolMobileSnapshot(handle.pool)))).digest('hex')).toMatchSnapshot('last green pinned ask output')
    } finally { handle.dispose(); locals.dispose(); run.dispose() }
  }, 120_000)

  it('draft quietness suppresses unread until the first runtime state and opens its session', async () => {
    const run = await mobileRun()
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
      expect(tracked(() => mobileWorkView(handle.pool).mobileRow(ref))).toMatchObject({ sessionOnlyDraft: true, quietDraft: true, emphasizeUnread: false, navigation: { kind: 'session', id: sessionId } })
      const stop = reaction(() => mobileWorkView(handle.pool).mobileRow(ref), () => {}, { fireImmediately: true })
      try {
        await run.apply({ kind: 'phaseChange', sessionId, phase: 'idle' })
        locals.flush(); settle(handle.pool)
        expect(tracked(() => mobileWorkView(handle.pool).mobileRow(ref))).toMatchObject({ sessionOnlyDraft: true, quietDraft: false })
        expect(tracked(() => poolMobileSnapshot(handle.pool)).pending).toBe(0)
        expect(createHash('sha256').update(JSON.stringify(tracked(() => poolMobileSnapshot(handle.pool)))).digest('hex')).toMatchSnapshot('last green draft output')
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
      expect(tracked(() => ids.map(id => mobileWorkView(handle.pool).mobileRow({ id, kind: 'issue' })))).toEqual([LOADING, LOADING])
      expect(hydrate).not.toHaveBeenCalled()
      expect(scheduled - before).toBeLessThanOrEqual(1)
      for (let window = 0; window < 64; window += 1) {
        tracked(() => ids.map(id => mobileWorkView(handle.pool).mobileRow({ id, kind: 'issue' })))
        if (handle.pool.hydrate() === 0) break
      }
      expect(tracked(() => ids.map(id => mobileWorkView(handle.pool).mobileRow({ id, kind: 'issue' })))).not.toContain(LOADING)
      replay.push({ type: 'update', rows: [{ kind: 'issue', id: ids[0]!, value: undefined }] })
      expect(tracked(() => mobileWorkView(handle.pool).mobileRow({ id: ids[0]!, kind: 'issue' }))).toBeUndefined()
      expect(tracked(() => mobileWorkView(handle.pool).mobileRow({ id: 'never-known', kind: 'issue' }))).toBeUndefined()
    } finally { hydrate.mockRestore(); handle.dispose() }
  })

  const firstSeed = Number(process.env['POD_POOL_GATE_FIRST_SEED'] ?? 1)
  const seeds = Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3)
  const steps = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
  for (let seed = firstSeed; seed <= seeds; seed += 1) it(`observed random-change gate, seed ${seed}`, async () => {
    const corpus = genCorpus(), changes = gen(seed, steps, {}, { corpus, forceSidebarValues: true })
    const run = await mobileRun(corpus)
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
        const state = { searching: index % 3 === 0, collapsed: { 'podium:sidebar:work-group-fold:needs-you': index % 2 === 1 } }
        expect(tracked(() => poolMobileSnapshot(handle.pool, state)).pending, `seed ${seed}, step ${index}, ${changes[index]!.kind}`).toBe(0)
        expect(createHash('sha256').update(JSON.stringify(tracked(() => poolMobileSnapshot(handle.pool, state)))).digest('hex')).toMatchSnapshot(`step ${index}, ${changes[index]!.kind}`)
      }
      writeResult(`mobile-seed-${seed}`, { issue: 'POD-5439', seed, steps: changes.length, ...countKinds(changes), regressions: 0 })
    } finally { stop(); handle.dispose(); locals.dispose(); run.dispose() }
  }, 600_000)
})
