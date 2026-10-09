import { issueBoardStats } from '../../../tests/worklist/harness/src/perf/issue-board'
import { asIssueId, CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS, ISSUE_BOARD_STAGES } from '@podium/model/browser'
import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { boardCards } from './issue-board-cards'
import { type BoardOptions, ISSUE_BOARD_SUMMARIES } from './issue-board-schema'
import { createIssueBoardSource } from './issue-board-source'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const now = Date.parse('2026-10-05T12:00:00Z')
const row = (id: string, patch: object = {}) => ({
  id, seq: 1, title: `Task ${id}`, description: { value: 'A document outside placement' },
  stage: 'backlog', priority: 2, type: 'task', labels: [], deps: [], audience: 'human',
  repoPath: '/fixture', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...patch,
})
const options: BoardOptions = {
  display: { layout: 'board', ordering: 'priority', showAgentTasks: false },
  filter: {}, expanded: [], isMobile: false, windowed: true, openIssueId: null, now,
}
/** What a mounted desktop card reads (POD-5828): shared issue fields, the
 * shared rollups and the board's own child stage counts. */
function readCard(pool: MobxPool, id: string) {
  const cards = boardCards(pool), issue = cards.issue(id)
  return [issue.title, issue.stage, issue.labels, issue.unread, issue.dependents, issue.childCount,
    issue.confirmedWorkingAgents, issue.taskProgress, issue.presentMembers, cards.card(issue, false).stageCounts]
}
function setup(scale: number) {
  const rows = ISSUE_BOARD_STAGES.flatMap(stage => Array.from({ length: 128 * scale }, (_, n) =>
    row(`${stage}-${n}`, { stage, seq: n + 1 })))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    load: vi.fn(), summaries: ISSUE_BOARD_SUMMARIES, schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows: rows.map(value => ({ kind: 'issue' as const, id: value.id, value })) })
  const source = createIssueBoardSource(pool)
  let descriptions = 0
  const read = pool.row.bind(pool)
  const spy = vi.spyOn(pool, 'row').mockImplementation(((entity: string, id: string, fields?: string) => {
    const value = (read as (...args: unknown[]) => unknown)(entity, id, fields)
    return entity === 'issue' && value && typeof value === 'object' ? new Proxy(value, {
      get(target, key, receiver) {
        if (key === 'description') descriptions++
        return Reflect.get(target, key, receiver)
      },
    }) : value
  }) as typeof pool.row)
  return { pool, source, rows, descriptions: () => descriptions,
    stop: () => { spy.mockRestore(); source.dispose(); pool.dispose() } }
}

it('keeps opening rich facts proportional to visible cards at 1x and 4x', () => {
  const measurements = [1, 4].map(scale => {
    const f = setup(scale), stops: (() => void)[] = []
    // Visible parent cards may have a large offscreen closure. Counts and
    // progress can read its scalars, but must not build those children's facts.
    f.pool.apply({ type: 'update', rows: ISSUE_BOARD_STAGES.flatMap(stage =>
      Array.from({ length: 8 }, (_, n) => `${stage}-${n}`).flatMap(parentId =>
        Array.from({ length: 8 * scale }, (_, child) => {
          const id = `${parentId}-child-${child}`
          return { kind: 'issue' as const, id, value: row(id, { parentId }) }
        }))) })
    issueBoardStats.enable()
    issueBoardStats.reset()
    try {
      stops.push(autorun(() => f.source.board(options)))
      for (const stage of ISSUE_BOARD_STAGES)
        for (let n = 0; n < 8; n++) stops.push(autorun(() => readCard(f.pool, `${stage}-${n}`)))
      const counts = issueBoardStats.read(), descriptions = f.descriptions()
      console.info('board opening work', JSON.stringify({ scale, counts, descriptions }))
      // This counter is on the actual declared summary's document access.
      // Today's board() builds facts for the corpus and fails this bound.
      expect(descriptions).toBeLessThanOrEqual(48 * 3)
      // One board rule per mounted card; cards build no row overlay or facts.
      expect(counts.cards).toBe(48)
      expect(counts.rowModels ?? 0).toBe(0)
      expect(counts.factReads ?? 0).toBe(0)
      expect(f.source.stats().residentRows).toBe(0)
      return { descriptions, facts: counts.factReads ?? 0, cards: counts.cards }
    } finally {
      for (const stop of stops.reverse()) stop()
      expect(f.source.stats().cached).toBe(0)
      f.stop()
      issueBoardStats.disable()
    }
  })
  expect(measurements[1]).toEqual(measurements[0])
})

it('changes one card and two columns for a stage edit; clicks and minute ticks leave columns alone at 1x/4x', () => {
  for (const scale of [1, 4]) {
    const f = setup(scale), stops: (() => void)[] = []
    const selected = observable.box<string | null>(null)
    issueBoardStats.enable()
    try {
      let board: ReturnType<typeof f.source.board>
      stops.push(autorun(() => { board = f.source.board({ ...options, addressed: selected.get() ? [selected.get()!] : [] }) }))
      // Column components ask with a different object property order from
      // the navigation composer; they must share the same computed identity.
      for (const stage of ISSUE_BOARD_STAGES) stops.push(autorun(() => f.source.columnIds({
        stage, showAgentTasks: false, ordering: 'priority', filter: {},
      })))
      const reruns = new Map<string, number>()
      for (const stage of ISSUE_BOARD_STAGES)
        for (let n = 0; n < 8; n++) {
          const id = `${stage}-${n}`
          stops.push(autorun(() => { readCard(f.pool, id); reruns.set(id, (reruns.get(id) ?? 0) + 1) }))
        }
      issueBoardStats.reset()
      reruns.clear()
      const before = board!
      runInAction(() => selected.set('backlog-0'))
      expect(board!).toBe(before)
      expect(issueBoardStats.read()).toEqual({})
      runInAction(() => f.pool.clock.advance(now + 60_000))
      expect(issueBoardStats.read()).toEqual({})
      expect(reruns.size).toBe(0)
      f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'backlog-0',
        value: { ...f.rows.find(row => row.id === 'backlog-0')!, stage: 'planning' } }] })
      const counts = issueBoardStats.read()
      // Only the edited card's reader reruns; it builds no overlay.
      expect([...reruns.keys()]).toEqual(['backlog-0'])
      expect(counts.rowModels ?? 0).toBe(0)
      expect(counts['column.backlog']).toBe(1)
      expect(counts['column.planning']).toBe(1)
      expect(ISSUE_BOARD_STAGES.filter(stage => counts[`column.${stage}`])).toEqual(['backlog', 'planning'])
      expect(board! && board! !== LOADING && board!.view.orderedByStage.find(column => column.stage === 'planning')!.ids)
        .toContain(asIssueId('backlog-0'))
      console.info('board stage edit work', JSON.stringify({ scale, counts }))
    } finally {
      for (const stop of stops.reverse()) stop()
      f.stop()
      issueBoardStats.disable()
    }
  }
})

it('keeps filtered-parent promotion, nested rows, cycles and terminal reasons in the ID layout', () => {
  const f = setup(0)
  const rows = [row('parent'), row('child', { parentId: 'parent', stage: 'planning', audience: 'agent', priority: 1 }),
    row('a', { parentId: 'b' }), row('b', { parentId: 'a' }), row('draft', { isDraftVessel: true }),
    row('cancelled', { stage: 'done', closedReason: 'cancelled' }), row('shipping', { stage: 'shipping' })]
  f.pool.apply({ type: 'replace', rows: rows.map(value => ({ kind: 'issue' as const, id: value.id, value })) })
  try {
    const board = f.source.board(options)
    expect(board && board !== LOADING && board.rootIds).toEqual(['cancelled', 'parent', 'shipping', 'a'])
    expect(f.source.columnIds({ stage: 'done', ordering: 'priority', filter: { stage: 'cancelled' }, showAgentTasks: false }))
      .toEqual(['cancelled'])
    const list = f.source.board({ ...options, display: { ...options.display, layout: 'list' }, expanded: ['parent', 'a', 'b'] })
    expect(list && list !== LOADING && list.view.rowGroups.find(group => group.stage === 'backlog')).toMatchObject({
      count: 3, rows: [
        { id: 'parent', depth: 0 }, { id: 'child', depth: 1 }, { id: 'a', depth: 0 }, { id: 'b', depth: 1 },
      ],
    })
    const filtered = f.source.board({ ...options, filter: { priority: 1 } })
    expect(filtered && filtered !== LOADING && filtered.rootIds).toEqual(['child'])
    expect(f.pool.hydrate()).toBe(0)
    // A child whose ID precedes a closed cycle is also promoted by the shared
    // partition's unreached-item fallback, before that cycle's first member.
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: '0-child', value: row('0-child', { parentId: 'a' }) }] })
    const cycle = f.source.board(options)
    expect(cycle && cycle !== LOADING && cycle.rootIds).toEqual(['cancelled', 'parent', 'shipping', '0-child', 'a'])
  } finally { f.stop() }
})

it('expires a confirmed descendant worker at its deadline without minute card keys', () => {
  const f = setup(0)
  f.pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: 'parent', value: row('parent') },
    { kind: 'issue', id: 'child', value: row('child', { parentId: 'parent', memberSessionIds: ['worker'] }) },
    { kind: 'session', id: 'worker', value: { sessionId: 'worker', issueId: 'child', status: 'live', agentKind: 'codex',
      lastActiveAt: new Date(now).toISOString(), agentState: { phase: 'working', since: new Date(now).toISOString() } } },
  ] })
  let progress: unknown, runs = 0
  const stop = autorun(() => { progress = boardCards(f.pool).issue('parent').taskProgress; runs++ })
  try {
    expect(progress).toEqual({ total: 1, done: 0, liveAgents: 1 })
    const before = progress, ran = runs
    runInAction(() => f.pool.clock.advance(now + 60_000))
    expect(progress).toBe(before)
    runInAction(() => f.pool.clock.advance(now + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS))
    expect(progress).toBe(before)
    expect(runs).toBe(ran)
    runInAction(() => f.pool.clock.advance(now + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS + 1))
    expect(progress).toEqual({ total: 1, done: 0, liveAgents: 0 })
  } finally { stop(); f.stop() }
})

it('keeps a drawn card flat through archived session history while preserving unread', () => {
  for (const scale of [1, 4]) {
    const f = setup(0)
    const readAt = new Date(now - 60_000).toISOString()
    const archived = Array.from({ length: 32 * scale }, (_, n) => ({ kind: 'session' as const, id: `history-${n}`,
      value: { sessionId: `history-${n}`, issueId: 'parent', status: 'exited', agentKind: 'codex', archived: true,
        lastActiveAt: new Date(now).toISOString(), agentState: { phase: 'ended' } } }))
    f.pool.apply({ type: 'replace', rows: [
      { kind: 'issue', id: 'parent', value: row('parent', { readAt, updatedAt: readAt }) },
      { kind: 'session', id: 'worker', value: { sessionId: 'worker', issueId: 'parent', status: 'live', agentKind: 'codex',
        lastActiveAt: readAt, agentState: { phase: 'idle' } } }, ...archived,
    ] })
    let card!: { unread: boolean; stage: string; sessions: string[] }
    const stop = autorun(() => {
      const cards = boardCards(f.pool), issue = cards.issue('parent')
      readCard(f.pool, 'parent')
      card = { unread: issue.unread, stage: issue.stage, sessions: cards.explorerRow(issue).sessions.map(seat => seat.id) }
    })
    const read = vi.spyOn(f.pool, 'row')
    try {
      expect(card.unread).toBe(true)
      expect(card.sessions).toEqual(['worker'])
      read.mockClear()
      f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'parent', value: row('parent', {
        readAt, updatedAt: readAt, stage: 'planning',
      }) }] })
      expect(card.stage).toBe('planning')
      expect(read.mock.calls.filter(([entity, id]) => entity === 'session' && id.startsWith('history-'))).toHaveLength(0)
    } finally { read.mockRestore(); stop(); f.stop() }
  }
})
