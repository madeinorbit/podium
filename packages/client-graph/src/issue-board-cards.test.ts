import { omitGone } from './lookup'
import {
  confirmedWorkingAgentCount,
  operationalState,
  rankedTaskStateSlots,
  type RankedTaskIssue,
} from '@podium/client-core/values'
import { issueDisplayRef } from '@podium/protocol'
import { autorun, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { insideArm, insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { inBoardCheck } from '../../../tests/worklist/diagnostics/issue-board-check'
import { readLegacyBoardCard } from '../../../tests/worklist/diagnostics/legacy-board-card'
import { BoardCard, boardCards, ExplorerRow } from './issue-board-cards'
import { ISSUE_BOARD_ENTITIES, ISSUE_BOARD_SOURCE_KEY, ISSUE_BOARD_SUMMARIES } from './issue-board-schema'
import { createIssueBoardSource } from './issue-board-source'
import { IssueModel } from './models'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const now = Date.parse('2026-10-03T12:00:00Z')
const at = (ms: number) => new Date(ms).toISOString()
const issue = (id: string, patch: object = {}) => ({
  id,
  seq: 1,
  title: id,
  description: '',
  stage: 'in_progress',
  priority: 2,
  type: 'task',
  audience: 'human',
  repoPath: '/fixture',
  labels: [],
  deps: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
})
const seat = (id: string, patch: object = {}) => ({
  sessionId: id,
  issueId: 'root',
  cwd: '/fixture',
  title: id,
  status: 'live',
  agentKind: 'codex',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
  lastActiveAt: at(now),
  agentState: { phase: 'working', since: at(now) },
  ...patch,
})
const disposals: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose()
})
async function setupBoard(rows: ReturnType<typeof issue>[], seats: ReturnType<typeof seat>[] = []) {
  const load = vi.fn((kind: string, id: string) =>
    kind === 'session'
      ? seats.find((row) => row.sessionId === id)
      : rows.find((row) => row.id === id),
  )
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    load,
    summaries: ISSUE_BOARD_SUMMARIES,
    schedule: () => () => {},
  })
  pool.apply({
    type: 'replace',
    rows: [
      ...rows.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
      ...seats.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
    ],
  })
  await pool.sources.ensure(ISSUE_BOARD_SOURCE_KEY, ISSUE_BOARD_ENTITIES, () =>
    createIssueBoardSource(pool),
  )
  disposals.push(() => pool.dispose())
  return { pool, load }
}

const READ = at(now - 60 * 60_000)
const ROWS = [
  issue('root', { seq: 10, type: 'epic', readAt: READ, labels: ['a', 'b'], dueAt: '2026-10-20T00:00:00Z', estimateMin: 30 }),
  issue('c1', { seq: 11, parentId: 'root', stage: 'review', readAt: at(now + 60_000) }),
  issue('c2', { seq: 12, parentId: 'root', stage: 'done', closedReason: 'completed' }),
  issue('c3', { seq: 13, parentId: 'root', stage: 'planning', archived: true }),
  issue('c4', { seq: 14, parentId: 'root', audience: 'agent', stage: 'backlog' }),
  issue('c5', { seq: 15, parentId: 'root', deletedAt: '2026-09-01T00:00:00Z' }),
  issue('c6', { seq: 16, parentId: 'root', stage: 'done', archived: true, closedReason: 'cancelled' }),
  issue('g1', { seq: 21, parentId: 'c1', stage: 'planning', readAt: at(now - 1) }),
  issue('g2', { seq: 22, parentId: 'c1', stage: 'done', closedReason: 'completed' }),
  issue('g3', { seq: 23, parentId: 'c1', isDraftVessel: true }),
  issue('g4', { seq: 24, parentId: 'c4', stage: 'in_progress' }),
  issue('blocked', { seq: 30, blocked: true, needsHuman: true,
    deps: [{ id: 'c1', type: 'blocks' }, { id: 'c2', type: 'blocks' }, { id: 'missing', type: 'blocks' },
      { id: 'root', type: 'discovered-from' }] }),
  issue('noted', { seq: 31, blocked: true, blockedByNotes: ['waiting on the vendor'] }),
  issue('agent-root', { seq: 40, audience: 'agent' }),
  issue('agent-child', { seq: 41, audience: 'agent', parentId: 'agent-root' }),
  issue('gone', { seq: 50, deletedAt: '2026-09-01T00:00:00Z', gitState: { ahead: 3 } }),
  issue('lonely', { seq: 60, readAt: at(now + 1) }),
  issue('history', { seq: 61, readAt: at(now - 10 * 60_000) }),
]
const SEATS = [
  seat('fresh'),
  seat('stale', { lastActiveAt: at(now - 20 * 60_000), agentState: { phase: 'working', since: at(now - 20 * 60_000) } }),
  seat('shell', { agentKind: 'shell' }),
  seat('archived', { archived: true, status: 'exited', lastActiveAt: at(now - 1000) }),
  seat('old-archive', { archived: true, status: 'exited', lastActiveAt: '2026-02-01T00:00:00Z' }),
  seat('headless', { headless: true, agentKind: 'claude-code' }),
  seat('exited', { status: 'exited', agentState: { phase: 'idle', since: at(now) } }),
  seat('asking', { agentKind: 'claude-code', agentState: { phase: 'waiting', since: at(now), offer: { kind: 'question' } } }),
  seat('twin-a', { status: 'hibernated', resume: { kind: 'claude', value: 'conversation' }, lastActiveAt: at(now - 5000) }),
  seat('twin-b', { status: 'exited', resume: { kind: 'claude', value: 'conversation' }, lastActiveAt: at(now - 9000) }),
  seat('c1-worker', { issueId: 'c1', lastActiveAt: at(now - 30_000) }),
  seat('c1-cold', { issueId: 'c1', archived: true, status: 'exited', lastActiveAt: '2026-03-01T00:00:00Z' }),
  seat('g1-worker', { issueId: 'g1', agentKind: 'claude-code' }),
  seat('g1-compacting', { issueId: 'g1', agentState: { phase: 'compacting', since: at(now) } }),
  seat('g4-worker', { issueId: 'g4' }),
  seat('c3-worker', { issueId: 'c3' }),
  seat('blocked-error', { issueId: 'blocked', agentState: { phase: 'errored', since: at(now), error: { class: 'overloaded' } } }),
  seat('lonely-retired', { issueId: 'lonely', status: 'exited', agentState: { phase: 'idle', since: at(now) } }),
  seat('history-archived', { issueId: 'history', archived: true, status: 'exited', lastActiveAt: at(now - 1000) }),
]
const IDS = ROWS.map((row) => row.id)
const mutants: Record<string, (value: unknown) => unknown> = {
  number: (value) => (value as number) + 1,
  boolean: (value) => !value,
  string: (value) => `${value}!`,
  object: (value) => (value === null ? { total: 1 } : Array.isArray(value) ? [...value, 'extra'] : { ...value, extra: 1 }),
  undefined: () => 'defined',
}

it('answers every board and explorer card field like the old card graph on nested, archived, cold and collapsed fixtures', async () => {
  const { pool } = await setupBoard(ROWS, SEATS)
  const cards = boardCards(pool)
  const killed = new Set<string>()
  for (const agents of [false, true]) {
    const read = () => {
      const pairs: Record<string, Record<string, [unknown, unknown]>> = {}
      for (const id of IDS) {
        const old = readLegacyBoardCard(pool, { id, agents })
        if (old === LOADING) throw LOADING
        if (!old) throw new Error(`${id} has no old card`)
        const model = cards.issue(id)
        const card = cards.card(model, agents), row = cards.explorerRow(model)
        const fleet = old.fleet
        const working = confirmedWorkingAgentCount(fleet, pool.clock.peekNow())
        pairs[id] = {
          ...Object.fromEntries((['title', 'color', 'type', 'priority', 'assignee', 'dueAt', 'estimateMin',
            'deletedAt', 'gitState', 'updatedAt', 'intentOrigin', 'stage', 'closedReason', 'seq'] as const)
            .map((key) => [key, [old.issue[key] ?? null, model[key] ?? null]])),
          // The old overlay defaulted absent flags to false; cards read them as truth values.
          ...Object.fromEntries((['needsHuman', 'blocked', 'archived'] as const)
            .map((key) => [key, [Boolean(old.issue[key]), Boolean(model[key])]])),
          labels: [old.issue.labels, model.labels ?? []],
          displayRef: [issueDisplayRef(old.issue), issueDisplayRef(model)],
          unread: [old.issue.unread, model.unread],
          childCount: [old.issue.childCount, model.childCount],
          childDoneCount: [old.issue.childDoneCount, model.childDoneCount],
          dependents: [old.issue.dependents, [...model.dependents]],
          fleet: [fleet.map((seat) => seat.sessionId), model.presentMembers.map((seat) => seat.id)],
          working: [working, model.confirmedWorkingAgents],
          progress: [old.progress, model.taskProgress],
          stageCounts: [old.stageCounts, [...card.stageCounts]],
          slots: [rankedTaskStateSlots(old.issue as unknown as RankedTaskIssue, { workingAgents: working, progress: old.progress }),
            rankedTaskStateSlots(model as unknown as RankedTaskIssue, { workingAgents: model.confirmedWorkingAgents, progress: model.taskProgress })],
          explorerSessions: [old.sessions.map((seat) => seat.sessionId), row.sessions.map((seat) => seat.id)],
          explorerState: [operationalState(old.issue, old.sessions, old.byId), row.state],
        }
      }
      return pairs
    }
    // Settle cold summaries and addressed loads the way a mounted card would.
    const stop = autorun(() => { try { read() } catch (error) { if (error !== LOADING) throw error } })
    for (let round = 0; round < 6; round++) pool.hydrate()
    stop()
    const pairs = inBoardCheck(read)
    const differences = Object.entries(pairs).flatMap(([id, fields]) =>
      Object.entries(fields).flatMap(([field, [before, after]]) => {
        try { expect(after).toEqual(before); return [] }
        catch { return [{ id, field, before, after }] }
      }))
    expect(differences, `agents=${agents}`).toEqual([])
    for (const [id, fields] of Object.entries(pairs))
      for (const [field, [before, after]] of Object.entries(fields)) {
        // A deliberately wrong answer must fail this same comparison.
        const wrong = mutants[typeof after]!(after)
        let failed = false
        try { expect(wrong).toEqual(before) } catch { failed = true }
        expect(failed, `${id}.${field} mutant`).toBe(true)
        killed.add(field)
      }
  }
  // The fixture reaches every rule the old card answered.
  const pairs = inBoardCheck(() => {
    const out: Record<string, unknown> = {}
    for (const id of IDS) {
      const model = cards.issue(id)
      out[id] = { progress: model.taskProgress, working: model.confirmedWorkingAgents, unread: model.unread,
        stages: cards.card(model, false).stageCounts.length, state: cards.explorerRow(model).state.state,
        fleet: model.presentMembers.length }
    }
    return out
  }) as Record<string, { progress: unknown; working: number; unread: boolean; stages: number; state: string; fleet: number }>
  expect(pairs.root!.progress).toEqual({ total: 6, done: 2, liveAgents: 4 })
  expect(pairs.root!.working).toBe(1)
  expect(pairs.root!.stages).toBeGreaterThan(1)
  expect(pairs.c1!.unread).toBe(false)
  expect(pairs.history!.unread).toBe(true)
  expect(pairs.history!.fleet).toBe(0)
  // Archived history stays cold: summaries answer it, no payload is loaded.
  expect(pool.tables.issue.has('c6')).toBe(false)
  expect(pairs.root!.unread).toBe(true)
  expect(new Set(Object.values(pairs).map((value) => value.state))).toEqual(
    new Set(['error', 'needs-you', 'working', 'waiting', 'retired', 'ready', 'done']))
  expect(killed.size).toBeGreaterThan(20)
})

/** Settle a mounted reader's cold summaries and addressed loads. */
function settle(pool: MobxPool, read: () => void) {
  const stop = autorun(() => { try { read() } catch (error) { if (error !== LOADING) throw error } })
  for (let round = 0; round < 6; round++) pool.hydrate()
  stop()
}
it('loads and keeps no row the old card graph did not', async () => {
  const before = await setupBoard(ROWS, SEATS), after = await setupBoard(ROWS, SEATS)
  for (const agents of [false, true]) {
    settle(before.pool, () => {
      for (const id of IDS) if (readLegacyBoardCard(before.pool, { id, agents }) === LOADING) throw LOADING
    })
    const cards = boardCards(after.pool)
    settle(after.pool, () => {
      for (const id of IDS) {
        const model = cards.issue(id)
        void [model.title, model.color, model.labels, model.displayRef, model.unread, model.childCount,
          model.childDoneCount, model.dependents, model.confirmedWorkingAgents, model.taskProgress,
          model.presentMembers.map((seat) => [seat.agentKind, seat.status, seat.agentState]),
          cards.card(model, agents).stageCounts, cards.explorerRow(model).state]
      }
    })
  }
  const loads = (calls: unknown[][]) => new Set(calls.map((call) => call.join(':')))
  const resident = (pool: MobxPool) =>
    new Set([...pool.tables.issue.keys()].map((id) => `issue:${id}`)
      .concat([...pool.tables.session.keys()].map((id) => `session:${id}`)))
  expect([...loads(after.load.mock.calls)].filter((key) => !loads(before.load.mock.calls).has(key))).toEqual([])
  expect([...resident(after.pool)].filter((key) => !resident(before.pool).has(key))).toEqual([])
})

/** What a mounted desktop card reads: its own line, rollups, fleet and word. */
function readCard(pool: MobxPool, id: string, agents = false) {
  const cards = boardCards(pool), model = cards.issue(id)
  return [model.title, model.color, model.labels, model.displayRef, model.unread, model.childCount,
    model.childDoneCount, model.dependents, model.confirmedWorkingAgents, model.taskProgress,
    model.presentMembers.map((seat) => [seat.agentKind, seat.status, seat.agentState]),
    cards.card(model, agents).stageCounts, cards.explorerRow(model).state]
}
const PRESENTATION = [
  [IssueModel.prototype, ['taskProgress', 'confirmedWorkingAgents', 'presentMembers', 'unread', 'dependents']],
  [BoardCard.prototype, ['stageCounts']],
  [ExplorerRow.prototype, ['state', 'sessions']],
] as const
function spyPresentation() {
  const spies = PRESENTATION.flatMap(([prototype, fields]) =>
    fields.map((field) => [field, vi.spyOn(prototype as never, field as never, 'get')] as const))
  const idsOf = (spy: (typeof spies)[number][1]) =>
    spy.mock.contexts.map((self) => (self as { id: string }).id)
  return {
    /** The issue ids whose presentation fields were read. */
    ids: () => new Set(spies.flatMap(([, spy]) => idsOf(spy))),
    /** The same, per field. */
    byField: () => Object.fromEntries(spies.map(([field, spy]) => [field, new Set(idsOf(spy))])),
    restore: () => { for (const [, spy] of spies) spy.mockRestore() },
  }
}

it('resolves no presentation field for hidden, folded or unmounted cards', async () => {
  const rows = [
    ...ROWS,
    ...Array.from({ length: 40 }, (_, i) => issue(`extra-${i}`, { seq: 100 + i, stage: i % 2 ? 'backlog' : 'in_progress' })),
  ]
  const { pool } = await setupBoard(rows, SEATS)
  const spies = spyPresentation()
  try {
    for (const layout of ['board', 'list'] as const)
      for (const expanded of [[], ['root']]) {
        const options = { display: { layout, ordering: 'priority' as const, showAgentTasks: false },
          filter: {}, expanded, isMobile: false, now }
        settle(pool, () => {
          const board = omitGone(pool.row('issueBoardModel', JSON.stringify(options)))
          if (board === LOADING) throw LOADING
          omitGone(pool.row('issueExplorerModel', JSON.stringify({ tab: null, query: '', windowed: true })))
        })
      }
    // Layouts publish ids only: no card answered anything.
    expect(spies.ids()).toEqual(new Set())
    // Two mounted cards resolve their own fields and nothing for their
    // neighbours. The parent's shared progress reads only its own live
    // descendants' working counts.
    settle(pool, () => { readCard(pool, 'root'); readCard(pool, 'extra-3') })
    const mounted = new Set(['root', 'extra-3'])
    for (const [field, ids] of Object.entries(spies.byField()))
      expect(ids, field).toEqual(field === 'confirmedWorkingAgents'
        ? new Set([...mounted, 'c1', 'c2', 'c4', 'g1', 'g2', 'g4'])
        : field === 'taskProgress' || field === 'presentMembers' || field === 'unread' || field === 'dependents' ||
          field === 'stageCounts' || field === 'state' || field === 'sessions' ? mounted : new Set())
  } finally {
    spies.restore()
  }
})

it('reruns and recomputes nothing on unrelated cards when one session heartbeats', async () => {
  for (const plant of [false, true]) {
    const rows = [issue('a'), issue('a1', { parentId: 'a' }), issue('b'), issue('b1', { parentId: 'b' }), issue('c')]
    const seats = [seat('wa', { issueId: 'a' }), seat('wa1', { issueId: 'a1' }), seat('wb', { issueId: 'b' }),
      seat('wb1', { issueId: 'b1', agentKind: 'claude-code' }), seat('wc', { issueId: 'c', status: 'exited' })]
    const { pool } = await setupBoard(rows, seats)
    const runs: Record<string, number> = { a: 0, b: 0, c: 0 }
    for (const id of ['a', 'b', 'c'])
      disposals.push(autorun(() => insideReader(`card:${id}`, () => {
        runs[id]!++
        try {
          readCard(pool, id)
          // A planted whole-roster reader: what the old seat projection did.
          if (plant && id === 'b')
            [...pool.tables.session.values()].sort((x, y) =>
              String((x as { lastActiveAt?: string }).lastActiveAt)
                .localeCompare(String((y as { lastActiveAt?: string }).lastActiveAt)))
        } catch (error) { if (error !== LOADING) throw error }
      })))
    for (let round = 0; round < 6; round++) pool.hydrate()
    const before = { ...runs }
    const heartbeat = () => pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'wa1',
      value: seat('wa1', { issueId: 'a1', lastActiveAt: at(now + 1000) }) }] })
    const { work } = await measureWork(async () => insideArm(() => runInAction(heartbeat)), { pool })
    // The meter writes digits as '#': b1 is reported as 'b#'.
    const unrelated = Object.keys(work.derivationsBy).filter((key) =>
      /card:[bc]|@(b|b#|c)\./.test(key))
    if (plant) {
      expect(runs.b).toBeGreaterThan(before.b!)
      expect(unrelated.length).toBeGreaterThan(0)
      continue
    }
    console.info('[desktop card heartbeat]', work.derivationsBy)
    expect({ b: runs.b, c: runs.c }).toEqual({ b: before.b, c: before.c })
    expect(unrelated).toEqual([])
  }
})
