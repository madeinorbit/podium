import type { MobxPool } from '@podium/client-graph/pool'
import { issueInput } from '@podium/client-graph/shared/issue-input'
import { settableLocals } from '@podium/client-graph/shared/locals-source'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { SidebarState } from '@podium/client-graph/worklist/sidebar'
import { SIDEBAR_ROW_FIELDS } from '@podium/client-graph/worklist/sidebar-row'
/** POD-4953: every real sidebar fact, from the existing issue and indexes.
 * The oracle alone reads the legacy derivation. Kept observed so a stale
 * cache after a random change cannot hide behind an unobserved re-read.
 */
import { reaction } from 'mobx'
import { describe, expect, it } from 'vitest'
import {
  harnessMobxPoolArm,
  snapshotPool,
  tracked,
  visibleOrderOf,
} from '../../../harness/src/adapters/mobx-pool'
import { createReplaySource } from '../../../harness/src/count-harness'
import { createEngineLocals } from '../../../harness/src/engine-locals'
import { engineLocals, openFenceFeeds } from '../../../harness/src/fence-scenarios'
import { buildCorpus } from '../../../harness/src/fixture/index'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { legacyDerivationFromStore, visibleIssueRows } from '../../../harness/src/oracle/oracle'
import {
  legacySidebarRow,
  legacySidebarSections,
  sidebarDiff,
  worktreeDiff,
} from '../../../harness/src/oracle/sidebar'
import { writeResult } from '../../../harness/src/results'
import { countKinds, gen, genCorpus } from '../../../shared/src/gen/changes'
import { startGenRun } from '../../../shared/src/gen/run'
import { DISABLED_READ_FENCE } from '../../../shared/src/instrument/reads'
import { startScenarioEngine, upsert, upsertIssue } from '../../../shared/src/scenarios'

installMobxWarnTrap()

/** Render requests each newly needed cold dependency, one load window at a time. */
function settleSidebar(pool: MobxPool): void {
  for (let window = 0; window < 64; window += 1) {
    snapshotPool(pool)
    tracked(() => {
      for (const id of visibleOrderOf(pool)) pool.sidebar.row(id)
      pool.sidebar.sections()
    })
    if (pool.hydrate() === 0) return
  }
  throw new Error('sidebar did not settle its batched dependencies')
}

function stateFor(
  keys: readonly string[],
  pins: { repos: string[]; worktrees: string[] },
  variant = 0,
): SidebarState {
  return {
    pinnedRepos: pins.repos,
    pinnedWorktrees: pins.worktrees,
    projectOrder: variant % 2 ? [...keys].reverse() : [],
    collapsed:
      variant % 2
        ? Object.fromEntries([
            ['podium:sidebar:pinned-fold', true],
            ...keys.flatMap((key) => [
              [`podium:sidebar:project-fold:${key}`, true],
              [`podium:sidebar:snoozed-fold:${key}`, false],
              [`podium:sidebar:closed-fold:${key}`, false],
            ]),
          ])
        : {},
  }
}

describe('real sidebar oracle (POD-4953)', () => {
  for (const scale of [1, 4] as const)
    it(`every row, roster and section equals the legacy derivation at ${scale}x`, async () => {
      const ctx = await startScenarioEngine(scale)
      const feeds = openFenceFeeds(ctx, 'overlaid')
      const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source)
      try {
        settleSidebar(handle.pool)
        const locals = engineLocals(ctx)
        const derivation = legacyDerivationFromStore(ctx.engine.access, locals.coarseNow)
        const rows = visibleIssueRows(derivation, locals)
        const rowErrors = tracked(() =>
          sidebarDiff(handle.pool, derivation, rows, locals.coarseNow),
        )
        expect(rowErrors.slice(0, 25), `${rowErrors.length} field differences`).toEqual([])
        expect(
          Object.keys(legacySidebarRow(rows[0]!, derivation, locals.coarseNow)).sort(),
        ).toEqual([...SIDEBAR_ROW_FIELDS].sort())
        for (const variant of [0, 1]) {
          const state = stateFor(
            derivation.slice.groups.map((g) => g.key),
            ctx.engine.access.pins,
            variant,
          )
          const gotSections = tracked(() => handle.pool.sidebar.sections(state))
          const expectedSections = legacySidebarSections(
            derivation,
            state,
            null,
            false,
            locals.coarseNow,
          )
          expect(gotSections).toEqual(expectedSections)
          expect(
            tracked(() => worktreeDiff(handle.pool, derivation, state, locals.coarseNow)),
          ).toEqual([])
          const roster = derivation.slice.work.find((row) => row.kind === 'worktree')
          if (roster?.kind === 'worktree')
            expect(
              tracked(() =>
                worktreeDiff(
                  handle.pool,
                  derivation,
                  { ...state, selectedWorktree: roster.worktree.path },
                  locals.coarseNow,
                ),
              ),
            ).toEqual([])
        }
        writeResult(`sidebar-values-${scale}x`, {
          issue: 'POD-4953',
          scale,
          rows: rows.length,
          fields: SIDEBAR_ROW_FIELDS,
          differences: rowErrors.length,
          rosterRows: derivation.slice.work.filter((r) => r.kind === 'worktree').length,
        })
      } finally {
        handle.dispose()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }, 600_000)

  it('joins normalized facts and clears an absent ask without old rows', () => {
    const projection = {
      id: 'normalized',
      seq: 42,
      title: 'Projection title',
      stage: 'review',
      isDraftVessel: true,
      intentOrigin: 'agent',
      asked: { question: 'Pick one', options: ['A'], at: '2026-09-30', by: 'session' },
    }
    const markers = { pinned: true, tuckedAt: 'tucked', readAt: 'read' }
    const git = { id: 'normalized', ahead: 2 }
    const repo = { repoPath: '/repo' }
    const joined = issueInput(projection, markers, git, repo, [], false, undefined)!
    expect(joined).toMatchObject({
      title: 'Projection title',
      stage: 'review',
      isDraftVessel: true,
      intentOrigin: 'agent',
      asked: projection.asked,
      pinned: true,
      tuckedAt: 'tucked',
      readAt: 'read',
      gitState: { ahead: 2 },
      repoPath: '/repo',
    })
    expect(joined).not.toHaveProperty('commentCount')
    const { asked: _asked, ...withoutAsk } = projection
    expect(issueInput(withoutAsk, markers, git, repo, [], false, undefined)?.asked).toBeUndefined()
  })

  it('cold sidebar reads answer LOADING and batch loads; eviction only clears a previously seen selection', () => {
    const corpus = buildCorpus(1)
    const replay = createReplaySource({
      issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
      sessions: corpus.sliceSessions.map((value) => ({
        kind: 'session',
        id: value.sessionId,
        value,
      })),
      worktrees: corpus.sliceWorktrees.map((value) => ({
        kind: 'worktree',
        id: value.path,
        value,
      })),
    })
    const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
    let scheduled = 0
    const handle = harnessMobxPoolArm.create(replay.source, locals.source, DISABLED_READ_FENCE, {
      schedule: () => {
        scheduled += 1
        return () => {}
      },
    })
    const { pool } = handle
    try {
      // POD-5407: the pool lists no cold rows; take them from the feed.
      const cold = replay.source
        .snapshot('issue')
        .map((record) => record.id)
        .filter((id) => pool.residency!.isCold('issue', id))
        .slice(0, 2)
      expect(cold).toHaveLength(2)
      const before = scheduled
      expect(tracked(() => cold.map((id) => pool.sidebar.row(id)))).toEqual([LOADING, LOADING])
      expect(scheduled - before).toBeLessThanOrEqual(1)
      expect(pool.hydrate()).toBeGreaterThanOrEqual(2)
      for (let window = 0; window < 64; window += 1) {
        tracked(() => cold.map((id) => pool.sidebar.row(id)))
        if (pool.hydrate() === 0) break
      }
      expect(tracked(() => cold.map((id) => pool.sidebar.row(id)))).not.toContain(LOADING)
      locals.set({ selectedIssueId: 'never-seen', coarseNow: corpus.fixedNow })
      locals.flush()
      expect(tracked(() => pool.sidebar.selectionEvicted())).toBe(false)
      const id = tracked(() => visibleOrderOf(pool)[0]!)
      locals.set({ selectedIssueId: id, coarseNow: corpus.fixedNow })
      locals.flush()
      expect(tracked(() => pool.sidebar.selectionEvicted())).toBe(false)
      replay.push({ type: 'update', rows: [{ kind: 'issue', id, value: undefined }] })
      // POD-5437 (83df844916, repeated-read probe 2a84baadce): the eviction
      // signal persists until the selection moves, so every reader sees it
      // until the clear-selection commits. A one-shot read here pinned the bug.
      expect(tracked(() => pool.sidebar.selectionEvicted())).toBe(true)
      expect(tracked(() => pool.sidebar.selectionEvicted())).toBe(true)
      locals.set({ selectedIssueId: null, coarseNow: corpus.fixedNow })
      locals.flush()
      expect(tracked(() => pool.sidebar.selectionEvicted())).toBe(false)
    } finally {
      handle.dispose()
    }
  })

  it('keeps the selection fold latch and draft-vessel pane selection', async () => {
    const run = await startGenRun({ feedMode: 'overlaid' })
    const locals = settableLocals(engineLocals(run.ctx))
    const handle = harnessMobxPoolArm.create(run.feed().source, locals.source)
    const id = 'sidebar-selection'
    try {
      await run.apply({ kind: 'newIssue', id, parentId: null, title: 'Selection' })
      const select = (selectedIssueId: string | null) => {
        locals.set({ selectedIssueId, coarseNow: engineLocals(run.ctx).coarseNow })
        locals.flush()
        snapshotPool(handle.pool)
      }
      select(id)
      await run.apply({ kind: 'stageChange', id, stage: 'done' })
      await run.apply({ kind: 'clockTick', ms: 25 * 60 * 60_000 })
      select(id)
      expect(
        tracked(() => handle.pool.sidebar.sections().bands.some((b) => b.rowIds.includes(id))),
      ).toBe(true)
      select(null)
      expect(
        tracked(() => handle.pool.sidebar.sections().bands.some((b) => b.closedIds.includes(id))),
      ).toBe(true)
      select(id)
      expect(
        tracked(() => handle.pool.sidebar.sections().bands.some((b) => b.closedIds.includes(id))),
      ).toBe(true)
      await run.apply({ kind: 'newDraftIssue', id: 'sidebar-vessel', title: '' })
      await run.apply({
        kind: 'newSession',
        sessionId: 'vessel-seat',
        issueId: 'sidebar-vessel',
        phase: 'idle',
      })
      select('sidebar-vessel')
      expect(
        tracked(() => handle.pool.sidebar.active('sidebar-vessel', { paneA: 'other-pane' })),
      ).toBe(false)
      expect(
        tracked(() => handle.pool.sidebar.active('sidebar-vessel', { paneA: 'vessel-seat' })),
      ).toBe(true)
    } finally {
      handle.dispose()
      locals.dispose()
      run.dispose()
    }
  }, 120_000)

  it('keeps missing-owner guests in a worktree roster, including the stale partition', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source)
    try {
      const lane = ctx.corpus.sliceWorktrees[0]!
      const now = engineLocals(ctx).coarseNow
      ctx.replica.batch(() => {
        const stamp = new Date(now - 60_000).toISOString()
        const owner = {
          id: 'roster-owner',
          seq: 50001,
          title: 'Roster owner',
          audience: 'agent',
          stage: 'in_progress',
          parentId: null,
          startedBySession: null,
          coordinatorSessionId: null,
          archived: false,
          deletedAt: null,
          closedReason: null,
          closedAt: null,
          draft: false,
          isDraftVessel: false,
          pinned: false,
          needsHuman: false,
          worktreePath: lane.path,
          repoPath: lane.repoPath,
          updatedAt: stamp,
        }
        upsertIssue(ctx, 'roster-owner', { ...ctx.corpus.issues[0]!, ...owner })
        upsert(ctx, 'session', 'owned-roster-guest', {
          sessionId: 'owned-roster-guest',
          issueId: 'roster-owner',
          cwd: lane.path,
          title: 'Owned guest',
          agentKind: 'codex',
          status: 'hibernated',
          archived: false,
          lastActiveAt: stamp,
          createdAt: stamp,
          unread: false,
          readAt: new Date(now).toISOString(),
          agentState: { phase: 'idle', since: stamp },
        })
        for (let index = 0; index < 8; index += 1) {
          const stamp = new Date(now - (index + 20) * 60 * 60_000).toISOString()
          upsert(ctx, 'session', `roster-guest-${index}`, {
            sessionId: `roster-guest-${index}`,
            issueId: `missing-owner-${index}`,
            displayRef: `POD-${index}-A`,
            cwd: lane.path,
            title: `Guest ${index}`,
            agentKind: 'codex',
            status: 'hibernated',
            archived: false,
            lastActiveAt: stamp,
            createdAt: stamp,
            unread: false,
            readAt: new Date(now).toISOString(),
            agentState: { phase: 'idle', since: stamp },
          })
        }
      })
      feeds.flush()
      snapshotPool(handle.pool)
      const derivation = legacyDerivationFromStore(ctx.engine.access, now)
      const value = tracked(() => handle.pool.sidebar.worktree(lane.path))
      expect(value?.sessions.filter((s) => s.sessionId.startsWith('roster-guest-'))).toHaveLength(8)
      expect(value?.issues.map((issue) => issue.id)).toContain('roster-owner')
      expect(value!.stale.length).toBeGreaterThan(0)
      expect(tracked(() => worktreeDiff(handle.pool, derivation, {}, now))).toEqual([])
      expect(
        tracked(() => worktreeDiff(handle.pool, derivation, { selectedWorktree: lane.path }, now)),
      ).toEqual([])
      settleSidebar(handle.pool)
      let sectionReads = 0
      const stop = reaction(
        () => {
          sectionReads += 1
          return handle.pool.sidebar.sections()
        },
        () => {},
        { fireImmediately: true },
      )
      try {
        const before = sectionReads
        const stamp = new Date(now - 60_000).toISOString()
        upsert(ctx, 'session', 'owned-roster-guest', {
          sessionId: 'owned-roster-guest',
          issueId: 'roster-owner',
          cwd: lane.path,
          title: 'Renamed guest',
          agentKind: 'codex',
          status: 'hibernated',
          archived: false,
          lastActiveAt: new Date(now).toISOString(),
          createdAt: stamp,
          unread: false,
          readAt: new Date(now).toISOString(),
          agentState: { phase: 'idle', since: stamp },
        })
        feeds.flush()
        expect(sectionReads, 'roster payload and activity do not rebuild sections').toBe(before)
        const roster = tracked(() => handle.pool.sidebar.worktree(lane.path))
        expect(roster?.sessions.find((s) => s.sessionId === 'owned-roster-guest')?.title).toBe(
          'Renamed guest',
        )
        expect(roster?.activityAt).toBe(now)
      } finally {
        stop()
      }
    } finally {
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('expires a last fallback seat without scanning lanes, and restores it on clock rewind', () => {
    const corpus = buildCorpus(1)
    const lane = {
      ...corpus.sliceWorktrees[0]!,
      path: '/roster-clock',
      repoPath: '/roster-clock',
      repoId: 'roster-clock',
      projectRoot: true,
    }
    const stamp = new Date(corpus.fixedNow).toISOString()
    const session = {
      sessionId: 'clock-guest',
      issueId: 'absent-owner',
      cwd: lane.path,
      title: 'Clock guest',
      agentKind: 'codex',
      status: 'exited',
      archived: false,
      stoppedAt: stamp,
      lastActiveAt: stamp,
      createdAt: stamp,
      unread: false,
      readAt: stamp,
      agentState: { phase: 'ended', since: stamp },
    }
    const replay = createReplaySource({
      issues: [],
      sessions: [{ kind: 'session', id: session.sessionId, value: session }],
      worktrees: [{ kind: 'worktree', id: lane.path, value: lane }],
    })
    const locals = settableLocals({ selectedIssueId: null, coarseNow: corpus.fixedNow })
    const handle = harnessMobxPoolArm.create(replay.source, locals.source)
    const values: unknown[] = []
    const stop = reaction(
      () => handle.pool.sidebar.sections(),
      (value) => values.push(value),
      { fireImmediately: true },
    )
    try {
      const band = () =>
        tracked(() => handle.pool.sidebar.sections().bands.find((b) => b.key === lane.repoId))!
      expect(band().worktreeIds).toEqual([lane.path])
      locals.set({ coarseNow: corpus.fixedNow + 25 * 60 * 60_000 })
      locals.flush()
      expect(band().worktreeIds).toEqual([])
      expect(band().startFirstTask).toBe(true)
      locals.set({ coarseNow: corpus.fixedNow })
      locals.flush()
      expect(band().worktreeIds).toEqual([lane.path])
      expect(band().startFirstTask).toBe(false)
      expect(values).toHaveLength(3)
    } finally {
      stop()
      handle.dispose()
      locals.dispose()
    }
  })
})

describe('real sidebar random-change gate (POD-4953)', () => {
  for (const seed of [1, 2, 3])
    it(`every sidebar field after every change, observed, seed ${seed}`, async () => {
      const corpus = genCorpus()
      const changes = gen(seed, 200, {}, { corpus, forceSidebarValues: true })
      const run = await startGenRun({ corpus, feedMode: 'overlaid' })
      let feed = run.feed()
      let locals = createEngineLocals(run.ctx.engine)
      let handle = harnessMobxPoolArm.create(feed.source, locals.source)
      let state: SidebarState = {}
      const observe = () =>
        reaction(
          () => ({
            rows: visibleOrderOf(handle.pool).map((id) => handle.pool.sidebar.row(id)),
            sections: handle.pool.sidebar.sections(state),
          }),
          () => {},
          { fireImmediately: true },
        )
      let stop = observe()
      const appliedIssue = new Set<number>(),
        appliedSession = new Set<number>()
      try {
        for (let index = 0; index < changes.length; index += 1) {
          const step = await run.apply(changes[index]!)
          if (feed !== run.feed()) {
            stop()
            handle.dispose()
            locals.dispose()
            feed = run.feed()
            locals = createEngineLocals(run.ctx.engine)
            handle = harnessMobxPoolArm.create(feed.source, locals.source)
            stop = observe()
          }
          locals.flush()
          settleSidebar(handle.pool)
          if (!step.skipped && step.change.kind === 'issueFacts')
            appliedIssue.add(step.change.variant)
          if (!step.skipped && step.change.kind === 'sessionFacts')
            appliedSession.add(step.change.variant)
          const local = engineLocals(run.ctx)
          const store = run.ctx.engine.access
          const derivation = legacyDerivationFromStore(store, local.coarseNow)
          const rows = visibleIssueRows(derivation, local)
          state = stateFor(
            derivation.slice.groups.map((g) => g.key),
            store.pins,
            index,
          )
          const errors = tracked(() => sidebarDiff(handle.pool, derivation, rows, local.coarseNow))
          expect(
            errors.slice(0, 10),
            `seed ${seed}, step ${index} ${JSON.stringify(step.change)}; ${errors.length} differences`,
          ).toEqual([])
          expect(
            tracked(() => handle.pool.sidebar.sections(state)),
            `seed ${seed}, step ${index}: sections`,
          ).toEqual(
            legacySidebarSections(derivation, state, local.selectedIssueId, false, local.coarseNow),
          )
          expect(
            tracked(() => worktreeDiff(handle.pool, derivation, state, local.coarseNow)),
            `seed ${seed}, step ${index}: rosters`,
          ).toEqual([])
        }
        expect([...appliedIssue].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
        expect([...appliedSession].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
        writeResult(`sidebar-gate-${seed}`, {
          issue: 'POD-4953',
          seed,
          steps: changes.length,
          vocabulary: countKinds(changes),
          appliedIssue: [...appliedIssue],
          appliedSession: [...appliedSession],
          fields: SIDEBAR_ROW_FIELDS,
        })
      } finally {
        stop()
        handle.dispose()
        locals.dispose()
        run.dispose()
      }
    }, 600_000)
})
