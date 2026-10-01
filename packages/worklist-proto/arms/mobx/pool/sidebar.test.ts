/** POD-4953: every real sidebar fact, from the existing issue and indexes.
 * The oracle alone reads the legacy derivation. Kept observed so a stale
 * cache after a random change cannot hide behind an unobserved re-read.
 */
import { reaction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { SIDEBAR_ROW_FIELDS } from '@podium/client-graph/worklist/sidebar-row'
import type { SidebarState } from '@podium/client-graph/worklist/sidebar'
import { temporaryIssueInput } from '@podium/client-graph/shared/temporary-issue-input'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { settableLocals } from '@podium/client-graph/shared/locals-source'
import { createReplaySource } from '../../../harness/src/count-harness'
import { openFenceFeeds, engineLocals } from '../../../harness/src/fence-scenarios'
import { createEngineLocals } from '../../../harness/src/engine-locals'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { legacyDerivationFromStore, visibleIssueRows } from '../../../harness/src/oracle/oracle'
import { legacySidebarSections, sidebarDiff, worktreeDiff, legacySidebarRow } from '../../../harness/src/oracle/sidebar'
import { harnessMobxPoolArm, snapshotPool, tracked, visibleOrderOf } from '../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { writeResult } from '../../../harness/src/results'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import { gen, genCorpus, countKinds } from '../../../shared/src/gen/changes'
import { startGenRun } from '../../../shared/src/gen/run'
import { DISABLED_READ_FENCE } from '../../../shared/src/instrument/reads'

installMobxWarnTrap()

function stateFor(keys: readonly string[], pins: { repos: string[]; worktrees: string[] }, variant = 0): SidebarState {
  return { pinnedRepos: pins.repos, pinnedWorktrees: pins.worktrees,
    projectOrder: variant % 2 ? [...keys].reverse() : [],
    collapsed: variant % 2 ? Object.fromEntries([
      ['podium:sidebar:pinned-fold', true],
      ...keys.flatMap(key => [[`podium:sidebar:project-fold:${key}`, true],
        [`podium:sidebar:snoozed-fold:${key}`, false], [`podium:sidebar:closed-fold:${key}`, false]]),
    ]) : {} }
}

describe('real sidebar oracle (POD-4953)', () => {
  for (const scale of [1, 4] as const) it(`every row, roster and section equals the legacy derivation at ${scale}x`, async () => {
    const ctx = await startScenarioEngine(scale)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source)
    try {
      snapshotPool(handle.pool)
      const locals = engineLocals(ctx)
      const derivation = legacyDerivationFromStore(ctx.engine.getSnapshot(), locals.coarseNow)
      const rows = visibleIssueRows(derivation, locals)
      const rowErrors = tracked(() => sidebarDiff(handle.pool, derivation, rows, locals.coarseNow))
      expect(rowErrors.slice(0, 25), `${rowErrors.length} field differences`).toEqual([])
      expect(Object.keys(legacySidebarRow(rows[0]!, derivation, locals.coarseNow)).sort()).toEqual([...SIDEBAR_ROW_FIELDS].sort())
      for (const variant of [0, 1]) {
        const state = stateFor(derivation.slice.groups.map(g => g.key), ctx.engine.getSnapshot().pins, variant)
        expect(tracked(() => handle.pool.sidebar.sections(state))).toEqual(legacySidebarSections(derivation, state, null, false, locals.coarseNow))
        expect(tracked(() => worktreeDiff(handle.pool, derivation, state, locals.coarseNow))).toEqual([])
      }
      writeResult(`sidebar-values-${scale}x`, { issue: 'POD-4953', scale, rows: rows.length,
        fields: SIDEBAR_ROW_FIELDS, differences: rowErrors.length, rosterRows: derivation.slice.work.filter(r => r.kind === 'worktree').length })
    } finally { handle.dispose(); feeds.dispose(); ctx.engine.destroy() }
  }, 600_000)

  it('normalizes the one temporary input without letting stale durable wire facts win', () => {
    const projection = { id: 'normalized', seq: 42, title: 'Projection title', stage: 'review',
      isDraftVessel: true, intentOrigin: 'agent', asked: { question: 'Pick one', options: ['A'], at: '2026-09-30', by: 'session' } }
    const wire = { title: 'Stale title', stage: 'backlog', draft: false, origin: 'human', humanQuestion: 'Stale question',
      pinned: true, tuckedAt: 'tucked', readAt: 'read', gitState: { ahead: 2 }, repoPath: '/repo', commentCount: 8 }
    const joined = temporaryIssueInput(projection, wire, [], false)!
    expect(joined).toMatchObject({ title: 'Projection title', stage: 'review', draft: true, origin: 'agent',
      humanQuestion: 'Pick one', humanQuestionOptions: ['A'], pinned: true, tuckedAt: 'tucked', readAt: 'read',
      gitState: { ahead: 2 }, repoPath: '/repo', commentCount: 8 })
  })

  it('cold sidebar reads answer LOADING and batch loads; eviction only clears a previously seen selection', () => {
    const corpus = buildCorpus(1)
    const replay = createReplaySource({
      issues: corpus.sliceIssues.map(value => ({ kind: 'issue', id: value.id, value })),
      sessions: corpus.sliceSessions.map(value => ({ kind: 'session', id: value.sessionId, value })),
      worktrees: corpus.sliceWorktrees.map(value => ({ kind: 'worktree', id: value.path, value })),
    })
    const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
    let scheduled = 0
    const handle = harnessMobxPoolArm.create(replay.source, locals.source, DISABLED_READ_FENCE, { schedule: () => { scheduled += 1; return () => {} } })
    const { pool } = handle
    try {
      const cold = pool.residency!.ids('issue').slice(0, 2)
      expect(cold).toHaveLength(2)
      const before = scheduled
      expect(tracked(() => cold.map(id => pool.sidebar.row(id)))).toEqual([LOADING, LOADING])
      expect(scheduled - before).toBeLessThanOrEqual(1)
      expect(pool.hydrate()).toBeGreaterThanOrEqual(2)
      expect(tracked(() => cold.map(id => pool.sidebar.row(id)))).not.toContain(LOADING)
      locals.set({ selectedIssueId: 'never-seen', coarseNow: corpus.fixedNow })
      expect(tracked(() => pool.sidebar.selectionEvicted())).toBe(false)
      const id = tracked(() => visibleOrderOf(pool)[0]!)
      locals.set({ selectedIssueId: id, coarseNow: corpus.fixedNow })
      expect(tracked(() => pool.sidebar.selectionEvicted())).toBe(false)
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id, value: undefined }] })
      expect(tracked(() => pool.sidebar.selectionEvicted())).toBe(true)
      expect(tracked(() => pool.sidebar.selectionEvicted())).toBe(false)
    } finally { handle.dispose() }
  })
})

describe('real sidebar random-change gate (POD-4953)', () => {
  for (const seed of [1, 2, 3]) it(`every sidebar field after every change, observed, seed ${seed}`, async () => {
    const corpus = genCorpus()
    const changes = gen(seed, 200, {}, { corpus, forceSidebarValues: true })
    const run = await startGenRun({ corpus, feedMode: 'overlaid' })
    let feed = run.feed()
    let locals = createEngineLocals(run.ctx.engine)
    let handle = harnessMobxPoolArm.create(feed.source, locals.source)
    let state: SidebarState = {}
    const observe = () => reaction(() => ({
      rows: visibleOrderOf(handle.pool).map(id => handle.pool.sidebar.row(id)),
      sections: handle.pool.sidebar.sections(state),
    }), () => {}, { fireImmediately: true })
    let stop = observe()
    const appliedIssue = new Set<number>(), appliedSession = new Set<number>()
    try {
      for (let index = 0; index < changes.length; index += 1) {
        const step = await run.apply(changes[index]!)
        if (feed !== run.feed()) {
          stop(); handle.dispose(); locals.dispose()
          feed = run.feed(); locals = createEngineLocals(run.ctx.engine)
          handle = harnessMobxPoolArm.create(feed.source, locals.source); stop = observe()
        }
        locals.flush(); snapshotPool(handle.pool)
        if (!step.skipped && step.change.kind === 'issueFacts') appliedIssue.add(step.change.variant)
        if (!step.skipped && step.change.kind === 'sessionFacts') appliedSession.add(step.change.variant)
        const local = engineLocals(run.ctx)
        const store = run.ctx.engine.getSnapshot()
        const derivation = legacyDerivationFromStore(store, local.coarseNow)
        const rows = visibleIssueRows(derivation, local)
        state = stateFor(derivation.slice.groups.map(g => g.key), store.pins, index)
        const errors = tracked(() => sidebarDiff(handle.pool, derivation, rows, local.coarseNow))
        expect(errors.slice(0, 10), `seed ${seed}, step ${index} ${JSON.stringify(step.change)}; ${errors.length} differences`).toEqual([])
        expect(tracked(() => handle.pool.sidebar.sections(state)), `seed ${seed}, step ${index}: sections`).toEqual(legacySidebarSections(derivation, state, local.selectedIssueId, false, local.coarseNow))
        expect(tracked(() => worktreeDiff(handle.pool, derivation, state, local.coarseNow)), `seed ${seed}, step ${index}: rosters`).toEqual([])
      }
      expect([...appliedIssue].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      expect([...appliedSession].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      writeResult(`sidebar-gate-${seed}`, { issue: 'POD-4953', seed, steps: changes.length,
        vocabulary: countKinds(changes), appliedIssue: [...appliedIssue], appliedSession: [...appliedSession], fields: SIDEBAR_ROW_FIELDS })
    } finally { stop(); handle.dispose(); locals.dispose(); run.dispose() }
  }, 600_000)
})
