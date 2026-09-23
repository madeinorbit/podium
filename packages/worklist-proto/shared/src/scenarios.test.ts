// @vitest-environment happy-dom
/**
 * POD-4444 / POD-4550 — scenario tests on the ONE corpus: every methodology
 * scenario replays on the live-shaped fixture at 1x with exact event counts
 * and the snapshot delta; every rule-picked target is checked against the
 * oracle; the heartbeat cost is counted at 1x/2x/4x.
 *
 * Counts only — no walls under box load (methodology §5.7).
 */
import { asIssueId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { buildCorpus, FIXED_NOW, type FixtureCorpus } from '../../harness/src/fixture/index'
import { READ_BUDGETS } from '../../harness/src/count-harness'
import { expectedSnapshot } from '../../harness/src/oracle/index'
import {
  applyStageMove,
  archiveIssue,
  burst50,
  clockTick,
  coldBootstrap,
  evictKeeperWithoutRevision,
  evictWithoutRevision,
  FIXTURE_SEED,
  measureHeartbeat,
  newIssue,
  OPTIMISTIC_ECHO_READ_AT,
  optimisticEchoAndRejection,
  PHASE_FAMILY_FLOOR,
  parentReassignment,
  pickTargets,
  principalSwitch,
  rescopeGrowth,
  SCENARIOS,
  selectionClick,
  startScenarioEngine,
  stageMoveAcrossGroups,
  unrelatedHeartbeat,
  visibleSessionPhaseChange,
  visibleTitleRename,
  type ScenarioResult,
} from './scenarios'

function summarize(result: ScenarioResult): string {
  return `${result.scenario}: ${result.events.length} events, rows [${
    result.events.map((e) => `${e.type}:${e.rows.length}`).join(', ')
  }]`
}

describe('scenario registry', () => {
  it('covers all thirteen methodology scenarios', () => {
    expect(SCENARIOS.map((s) => s.methodology)).toEqual([
      '#1',
      '#2',
      '#3',
      '#4',
      '#5',
      '#6a',
      '#6b',
      '#6c',
      '#6d',
      '#7',
      '#8',
      '#9',
      '#10',
      '#11',
      '#12',
      '#13',
    ])
  })
})

describe('targets picked by rule, checked against the oracle (1x)', () => {
  const corpus = buildCorpus(1, FIXTURE_SEED)
  const targets = pickTargets(corpus)
  const locals = { selectedIssueId: null, coarseNow: FIXED_NOW }
  const snapshot = expectedSnapshot(corpus, locals)
  const visible = (id: string): boolean => snapshot.rowsById[id] !== undefined
  const withIssue = (
    base: FixtureCorpus,
    id: string,
    patch: Record<string, unknown>,
  ): FixtureCorpus => ({
    ...base,
    issues: base.issues.map((i) => (i.id === id ? ({ ...i, ...patch } as typeof i) : i)),
    issueProjections: base.issueProjections.map((p) =>
      p.id === id ? ({ ...p, ...patch } as typeof p) : p,
    ),
  })

  it('is deterministic in the corpus', () => {
    expect(pickTargets(buildCorpus(1, FIXTURE_SEED))).toEqual(targets)
    console.info(`[scenarios] targets at 1x seed ${FIXTURE_SEED}: ${JSON.stringify(targets)}`)
  })

  it('aims every issue write at a distinct visible row', () => {
    const ids = [
      targets.visibleRootId,
      targets.stageMoveId,
      targets.archiveId,
      targets.evictId,
      targets.keeperLeafId,
      targets.reparentId,
      targets.markReadId,
    ]
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of [...ids, targets.keeperParentId, targets.reparentToId]) {
      expect(visible(id), `${id} visible`).toBe(true)
    }
    expect(targets.burstIssueIds).toHaveLength(50)
  })

  it('#1 heartbeat target is bound to a row the worklist never shows', () => {
    const session = corpus.sessions.find((s) => s.sessionId === targets.heartbeatSessionId)!
    expect(session.issueId).toBeDefined()
    expect(visible(session.issueId as string)).toBe(false)
  })

  it('#2 phase target is a live working session on the visible root', () => {
    const session = corpus.sessions.find((s) => s.sessionId === targets.phaseSessionId)!
    expect(session.issueId).toBe(targets.visibleRootId)
    expect(session.agentState?.phase).toBe('working')
    expect(corpus.issues.some((i) => i.parentId === targets.visibleRootId)).toBe(true)
  })

  it('#5 stage move crosses from the open lane into the closed fold', () => {
    expect(snapshot.rowsById[targets.stageMoveId]!.closed).toBe(false)
    const at = new Date(FIXED_NOW).toISOString()
    const moved = expectedSnapshot(
      withIssue(corpus, targets.stageMoveId, {
        stage: 'done',
        closedAt: at,
        closedReason: 'done',
        tuckedAt: at,
      }),
      locals,
    )
    expect(moved.rowsById[targets.stageMoveId]?.closed).toBe(true)
  })

  it('#6d evicting the keeper leaf drops its rescue parent; #6c drops only its row', () => {
    const without = (id: string): FixtureCorpus => ({
      ...corpus,
      issues: corpus.issues.filter((i) => i.id !== id),
      issueProjections: corpus.issueProjections.filter((p) => p.id !== id),
    })
    const keeper = expectedSnapshot(without(targets.keeperLeafId), locals)
    expect(keeper.rowsById[targets.keeperParentId]).toBeUndefined()
    const evicted = expectedSnapshot(without(targets.evictId), locals)
    expect(Object.keys(evicted.rowsById).length).toBe(Object.keys(snapshot.rowsById).length - 1)
  })
})

describe('#2 target family is larger than one level of the reads budget (POD-4635)', () => {
  // Ma4 (POD-4568): on a family of exactly the budget, a pool that re-reads
  // every sibling on a phase change costs the budget and passes, so the #2
  // fence could not catch it. The rule now demands a larger family.
  const familyOf = (corpus: FixtureCorpus, id: string) =>
    corpus.sessions.filter(
      (s) => s.issueId === id && (s as { headless?: boolean }).headless !== true,
    )

  it('the floor is the harness budget for one level', () => {
    expect(PHASE_FAMILY_FLOOR).toBe(READ_BUDGETS.phaseChangePerLevel)
  })

  it.each([1, 2, 4] as const)('at %ix the target family exceeds the floor', (scale) => {
    const corpus = buildCorpus(scale, FIXTURE_SEED)
    const { visibleRootId } = pickTargets(corpus)
    expect(familyOf(corpus, visibleRootId).length).toBeGreaterThan(PHASE_FAMILY_FLOOR)
  })

  it.each([1, 2, 4] as const)(
    'startEngineOnCorpus boots on the live-shaped fixture at %ix with the rule-picked targets',
    async (scale) => {
      const ctx = await startScenarioEngine(scale)
      try {
        expect(ctx.targets).toEqual(pickTargets(ctx.corpus))
        expect(ctx.engine.getSnapshot().issues).toHaveLength(ctx.corpus.issues.length)
      } finally {
        ctx.engine.destroy()
      }
    },
    120_000,
  )

  it('control: the same root with its family trimmed to the floor is refused', () => {
    const corpus = buildCorpus(1, FIXTURE_SEED)
    const targets = pickTargets(corpus)
    const others = familyOf(corpus, targets.visibleRootId).filter(
      (s) => s.sessionId !== targets.phaseSessionId && s.agentState?.phase !== 'working',
    )
    const keep = new Set([
      targets.phaseSessionId,
      ...others.slice(0, PHASE_FAMILY_FLOOR - 1).map((s) => s.sessionId),
    ])
    const trimmed: FixtureCorpus = {
      ...corpus,
      sessions: corpus.sessions.filter(
        (s) => s.issueId !== targets.visibleRootId || keep.has(s.sessionId),
      ),
    }
    expect(familyOf(trimmed, targets.visibleRootId)).toHaveLength(PHASE_FAMILY_FLOOR)
    expect(pickTargets(trimmed).visibleRootId).not.toBe(targets.visibleRootId)
  })
})

describe('#2 target moves its row at every scale (oracle)', () => {
  // Cross-scale counts only compare like with like if the write has the same
  // visible effect at every scale: the phase session going idle must change
  // the root's row at 1x, 2x and 4x.
  it.each([1, 2, 4] as const)('at %ix', (scale) => {
    const corpus = buildCorpus(scale, FIXTURE_SEED)
    const targets = pickTargets(corpus)
    const locals = { selectedIssueId: null, coarseNow: FIXED_NOW }
    const before = expectedSnapshot(corpus, locals).rowsById[targets.visibleRootId]
    const idle: FixtureCorpus = {
      ...corpus,
      sessions: corpus.sessions.map((s) =>
        s.sessionId === targets.phaseSessionId
          ? ({ ...s, agentState: { ...s.agentState, phase: 'idle' } } as typeof s)
          : s,
      ),
    }
    const after = expectedSnapshot(idle, locals).rowsById[targets.visibleRootId]
    expect(before).toBeDefined()
    expect(after).not.toEqual(before)
  }, 120_000)
})

describe('scenarios on the fixture at 1x', () => {
  it('#1 unrelatedHeartbeat: one update, one row; session delta only', async () => {
    const result = await unrelatedHeartbeat()
    expect(result.corpus).toEqual({ scale: 1, seed: FIXTURE_SEED, issues: 4867, sessions: 4304 })
    expect(summarize(result)).toBe('#1 unrelatedHeartbeat: 1 events, rows [update:1]')
    expect(result.events[0]?.rows[0]).toMatchObject({
      kind: 'session',
      id: result.targets.heartbeatSessionId,
    })
    const id = result.targets.heartbeatSessionId
    const before = result.before.sessions.find((s) => s.sessionId === id)
    const after = result.after.sessions.find((s) => s.sessionId === id)
    expect(after?.lastActiveAt).not.toBe(before?.lastActiveAt)
    expect(result.after.issues).toEqual(result.before.issues)
  }, 60_000)

  it('#2 visibleSessionPhaseChange: one update, one session row', async () => {
    const result = await visibleSessionPhaseChange()
    expect(summarize(result)).toBe('#2 visibleSessionPhaseChange: 1 events, rows [update:1]')
    const id = result.targets.phaseSessionId
    expect(result.events[0]?.rows[0]).toMatchObject({ kind: 'session', id })
    expect(result.after.sessions.find((s) => s.sessionId === id)?.phase).toBe('idle')
    expect(result.before.sessions.find((s) => s.sessionId === id)?.phase).toBe('working')
  }, 60_000)

  it('#3 selectionClick: locals plus the eager mark-read row, then its echo', async () => {
    const result = await selectionClick()
    const id = result.targets.visibleRootId
    // The painted mark-read, then the server's echo of it as truth, both within
    // the step (POD-4618): nothing is left for the 60 s sweep to retire later.
    expect(result.events).toHaveLength(2)
    for (const event of result.events) {
      expect(event.type).toBe('update')
      expect(event.rows).toHaveLength(1)
      expect(event.rows[0]).toMatchObject({ kind: 'issue', id })
    }
    const [painted, echoed] = result.events.map(
      (event) => (event.rows[0]?.value as { readAt?: string | null } | undefined)?.readAt,
    )
    expect(painted).toEqual(expect.any(String))
    expect(echoed).toEqual(expect.any(String))
    expect(echoed).not.toBe(painted)
    expect(result.after.issues.find((i) => i.id === id)?.readAt).toBe(echoed)
    expect(result.before.selectedIssueId).not.toBe(result.after.selectedIssueId)
    expect(result.after.selectedIssueId).toBe(id)
  }, 60_000)

  it('#4 visibleTitleRename: one update, one issue row; title delta', async () => {
    const result = await visibleTitleRename()
    const id = result.targets.visibleRootId
    expect(summarize(result)).toBe('#4 visibleTitleRename: 1 events, rows [update:1]')
    expect(result.events[0]?.rows[0]).toMatchObject({ kind: 'issue', id })
    expect(result.after.issues.find((i) => i.id === id)?.title).toBe('Renamed visible row')
    expect(result.before.issues.find((i) => i.id === id)?.title).not.toBe('Renamed visible row')
  }, 60_000)

  it('#5 stageMoveAcrossGroups: one update, one row; stage delta', async () => {
    const result = await stageMoveAcrossGroups()
    const id = result.targets.stageMoveId
    expect(summarize(result)).toBe('#5 stageMoveAcrossGroups: 1 events, rows [update:1]')
    expect(result.before.issues.find((i) => i.id === id)?.stage).not.toBe('done')
    expect(result.after.issues.find((i) => i.id === id)?.stage).toBe('done')
  }, 60_000)

  it('#6a newIssue: one update, issue + session rows', async () => {
    const result = await newIssue()
    expect(summarize(result)).toBe('#6a newIssue: 1 events, rows [update:2]')
    expect(result.after.issues.some((i) => i.id === 'i-new')).toBe(true)
    expect(result.before.issues.some((i) => i.id === 'i-new')).toBe(false)
  }, 60_000)

  it('#6b archiveIssue: one update, one row', async () => {
    const result = await archiveIssue()
    const id = result.targets.archiveId
    expect(summarize(result)).toBe('#6b archiveIssue: 1 events, rows [update:1]')
    expect(result.before.issues.find((i) => i.id === id)?.archived).toBe(false)
    expect(result.after.issues.find((i) => i.id === id)?.archived).toBe(true)
  }, 60_000)

  it('#6c evictWithoutRevision: one update, row gone with value undefined', async () => {
    const result = await evictWithoutRevision()
    const id = result.targets.evictId
    expect(summarize(result)).toBe('#6c evictWithoutRevision: 1 events, rows [update:1]')
    expect(result.events[0]?.rows[0]).toEqual({ kind: 'issue', id, value: undefined })
    expect(result.after.issues.some((i) => i.id === id)).toBe(false)
    expect(result.before.issues.some((i) => i.id === id)).toBe(true)
  }, 60_000)

  it('#6d evictKeeperWithoutRevision: one update, keeper leaf gone; parent stays a kernel row', async () => {
    const result = await evictKeeperWithoutRevision()
    const { keeperLeafId, keeperParentId } = result.targets
    expect(summarize(result)).toBe('#6d evictKeeperWithoutRevision: 1 events, rows [update:1]')
    expect(result.events[0]?.rows[0]).toEqual({ kind: 'issue', id: keeperLeafId, value: undefined })
    expect(result.after.issues.some((i) => i.id === keeperLeafId)).toBe(false)
    expect(result.before.issues.some((i) => i.id === keeperLeafId)).toBe(true)
    // The rescue parent survives as a kernel row; it only leaves the
    // VISIBLE set (asserted against the oracle above and via parity in the
    // arm gates).
    expect(result.after.issues.some((i) => i.id === keeperParentId)).toBe(true)
  }, 60_000)

  it('#7 parentReassignment: one update, one row', async () => {
    const result = await parentReassignment()
    expect(summarize(result)).toBe('#7 parentReassignment: 1 events, rows [update:1]')
    expect(result.events[0]?.rows[0]).toMatchObject({ kind: 'issue', id: result.targets.reparentId })
    expect(
      (result.events[0]?.rows[0]?.value as { parentId?: unknown } | undefined)?.parentId,
    ).toBe(result.targets.reparentToId)
  }, 60_000)

  it('#8 clockTick: the runtime publishes the new coarse clock; zero row events', async () => {
    const result = await clockTick()
    expect(result.events).toHaveLength(0)
    // Pinned to the corpus clock at boot, advanced through the engine.
    expect(result.before.coarseNow).toBe(FIXED_NOW)
    expect(result.after.coarseNow).toBe(FIXED_NOW + 60_000)
    expect(result.after.issues).toEqual(result.before.issues)
    expect(result.after.sessions).toEqual(result.before.sessions)
  }, 60_000)

  it('#9 optimisticEchoAndRejection: press, echo, press, rollback with identity chain', async () => {
    const result = await optimisticEchoAndRejection()
    const id = result.targets.markReadId
    expect(result.events).toHaveLength(4)
    const [press, echo, press2, rollback] = result.events
    for (const [index, event] of result.events.entries()) {
      expect(event.type, `event ${index}`).toBe('update')
      expect(event.rows, `event ${index}`).toHaveLength(1)
      expect(event.rows[0]?.id, `event ${index}`).toBe(id)
    }
    const beforeValue = result.before.issues.find((i) => i.id === id)
    expect(press?.rows[0]?.value).not.toBe(beforeValue)
    expect(echo?.rows[0]?.value).not.toBe(press?.rows[0]?.value)
    expect((echo?.rows[0]?.value as { readAt: unknown }).readAt).toBe(OPTIMISTIC_ECHO_READ_AT)
    expect(press2?.rows[0]?.value).not.toBe(echo?.rows[0]?.value)
    // The rejection restores the echo object itself (covered truth).
    expect(rollback?.rows[0]?.value).toBe(echo?.rows[0]?.value)
    expect(result.after.issues.find((i) => i.id === id)?.readAt).toBe(OPTIMISTIC_ECHO_READ_AT)
  }, 60_000)

  it('#10 burst50: exactly one update with 50 rows', async () => {
    const result = await burst50()
    expect(summarize(result)).toBe('#10 burst50: 1 events, rows [update:50]')
    expect(result.after.sessions.length - result.before.sessions.length).toBe(50)
  }, 60_000)

  it('#11 principalSwitch: one full replace on the fresh replica', async () => {
    const result = await principalSwitch()
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.type).toBe('replace')
    const sessionRows = result.events[0]?.rows.filter((r) => r.kind === 'session')
    const issueRows = result.events[0]?.rows.filter((r) => r.kind === 'issue')
    expect(sessionRows).toHaveLength(result.corpus.sessions)
    expect(issueRows).toHaveLength(result.corpus.issues)
  }, 60_000)

  it('#12 coldBootstrap: empty before, discovery lanes only, full snapshot', async () => {
    const result = await coldBootstrap()
    expect(result.before).toEqual({ issues: [], sessions: [], selectedIssueId: null, coarseNow: 0 })
    // The hydrate-first seed names no kernel address, so no issue or session
    // row is emitted. Discovery lands after the source primed, so every lane
    // it found is announced, once (POD-4606): repo roots plus worktrees.
    // The scan also reports each linked worktree as a standalone entry; the
    // source drops those, as legacy `reposToViews` does (POD-4635).
    const corpus = buildCorpus(result.corpus.scale, result.corpus.seed)
    const linked = new Set(corpus.repos.flatMap((repo) => repo.worktrees.map((wt) => wt.path)))
    const lanes = corpus.repos.filter((repo) => !linked.has(repo.path)).length + linked.size
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.type).toBe('update')
    expect(result.events[0]?.rows.every((row) => row.kind === 'worktree')).toBe(true)
    expect(new Set(result.events[0]?.rows.map((row) => row.id)).size).toBe(lanes)
    expect(result.events[0]?.rows).toHaveLength(lanes)
    expect(result.after.issues).toHaveLength(result.corpus.issues)
    // The runtime collapses all-parked resume twins on every session read
    // (runtime.ts:465): each non-live twin group shows one row (POD-4551).
    const collapsed = buildCorpus(result.corpus.scale, result.corpus.seed).resumeTwins.reduce(
      (sum, group) => sum + group.sessionIds.length - group.keptSessionIds.length,
      0,
    )
    expect(collapsed).toBeGreaterThan(0)
    expect(result.after.sessions).toHaveLength(result.corpus.sessions - collapsed)
  }, 60_000)

  it('#13 rescopeGrowth: two replaces; the corpus returns to before', async () => {
    const result = await rescopeGrowth()
    expect(result.events).toHaveLength(2)
    expect(result.events[0]?.type).toBe('replace')
    expect(result.events[1]?.type).toBe('replace')
    expect(result.events[0]?.rows.length).toBeGreaterThan(result.events[1]?.rows.length ?? 0)
    expect(result.after.issues.map((i) => i.id).sort()).toEqual(
      result.before.issues.map((i) => i.id).sort(),
    )
  }, 60_000)
})

describe('seeded kernel rows reach the replica (POD-4624)', () => {
  it('every fixture repo projection is a replica repos row', async () => {
    // The kernel maps entity 'repo' (not 'repos') to the kind; a wrong entity
    // is dropped silently and every displayRef loses its repo prefix.
    const ctx = await startScenarioEngine(1)
    try {
      expect(ctx.corpus.repoProjections.length).toBeGreaterThan(0)
      expect(ctx.replica.rows('repos')).toHaveLength(ctx.corpus.repoProjections.length)
    } finally {
      ctx.engine.destroy()
    }
  }, 60_000)
})

describe('scenario server writes build on server truth (POD-4551)', () => {
  it('a server write on another field of a row with a pending edit keeps the server value', async () => {
    // A server that never answers keeps the title edit pending, so the
    // runtime snapshot paints it while the server cache does not have it.
    const ctx = await startScenarioEngine(1, { server: { issueUpdate: () => new Promise(() => {}) } })
    try {
      const id = ctx.targets.stageMoveId
      const serverTitle = (ctx.cache.read('issue', id)?.value as { title: string }).title
      void ctx.engine.getSnapshot().updateIssue(asIssueId(id), { title: 'Pending title' } as never)
      await new Promise((r) => setTimeout(r, ctx.settleMs))
      const painted = ctx.engine.getSnapshot().issues.find((i) => i.id === id) as { title: string }
      expect(painted.title, 'the edit is pending and painted').toBe('Pending title')

      applyStageMove(ctx, id)

      const wire = ctx.cache.read('issue', id)?.value as { title: string; stage: string }
      expect(wire.stage).toBe('done')
      expect(wire.title, 'the server write carries the server title, not the painted one').toBe(serverTitle)
    } finally {
      ctx.engine.destroy()
    }
  }, 60_000)
})

describe('per-row feed on every scenario (POD-4553)', () => {
  it('whole-slice passes happen only for a replace, once each', async () => {
    const table: Record<string, { replaces: number; enumerations: number; rowsVisited: number }> =
      {}
    for (const entry of SCENARIOS) {
      const result = await entry.run()
      table[entry.name] = {
        replaces: result.events.filter((e) => e.type === 'replace').length,
        enumerations: result.stats.enumerations,
        rowsVisited: result.stats.rowsVisited,
      }
    }
    console.info(`ROW-SOURCE ENUMERATIONS ${JSON.stringify(table)}`)
    for (const [name, cost] of Object.entries(table)) {
      // A cold boot's discovery lands after the source primed: one pass over
      // the discovery answer (POD-4606). No other scenario discovers.
      const discoveries = name === 'coldBootstrap' ? 1 : 0
      expect(cost.enumerations, `${name}: enumerations == replace events + discoveries`).toBe(
        cost.replaces + discoveries,
      )
    }
  }, 300_000)
})

describe('heartbeat cost on the fixture at 1x, 2x, 4x (counts only)', () => {
  it('visits 1 row at every scale', async () => {
    const table: Record<string, { rowsVisited: number; enumerations: number; rows: number }> = {}
    for (const scale of [1, 2, 4] as const) {
      table[`${scale}x`] = await measureHeartbeat(scale)
    }
    console.info(`[scenarios] heartbeat cost: ${JSON.stringify(table)}`)
    for (const [scale, cost] of Object.entries(table)) {
      expect(cost.rows, `${scale}: one addressed row`).toBe(1)
      expect(cost.rowsVisited, `${scale}: O(addresses) visits`).toBe(1)
      // POD-4553: the per-row feed reads the addressed row by id; no kind is
      // re-indexed, so no whole-slice pass happens at any scale.
      expect(cost.enumerations, `${scale}: no whole-slice pass`).toBe(0)
    }
  }, 300_000)
})
