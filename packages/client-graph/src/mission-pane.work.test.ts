import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import type { IssueNavigationModel } from '@podium/client-core/values'
import type { SessionView } from '@podium/client-core/session-values'
import { missionView } from './mission-view'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'
import { readMissionPane } from '../../../apps/web/src/app/mission-pane-reader'

const stamp = '2026-10-01T12:00:00Z'
const VISIBLE = 24
function fixture(scale: number) {
  const issues = Array.from({ length: 128 * scale + 1 }, (_, index) => ({
    id: index ? `child-${String(index).padStart(4, '0')}` : 'root', seq: index + 1,
    parentId: index ? 'root' : null, title: `Task ${index}`, stage: 'in_progress',
    description: '', deps: [], repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, readAt: stamp,
  })) as unknown as IssueNavigationModel[]
  const sessions = issues.map((issue, index) => ({
    sessionId: `seat-${index}`, issueId: issue.id, title: `Agent ${index}`, cwd: '/synthetic',
    agentKind: 'codex', status: 'live', archived: false, createdAt: stamp, lastActiveAt: stamp,
    agentState: { phase: 'working', since: stamp },
  })) as unknown as SessionView[]
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) }, undefined, { worklist: 'demand' })
  pool.apply({ type: 'replace', rows: [
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
  ] })
  return { pool, sessions }
}
function click(pool: MobxPool, selectedIssueId: string) {
  const value = readMissionPane(pool, { selectedIssueId, paneA: null, paneB: null, split: false, mode: 'full', handoff: false })
  if (value !== LOADING && value.mission.deck) {
    const deck = value.mission.deck, ids = deck.rowIds()
    if (ids === LOADING) return LOADING
    // The actual spine consumes rich values only for mounted task bands.
    for (const id of ids.slice(0, VISIBLE)) {
      const row = deck.model(id)
      void row.issue; void row.title; void row.presentation; void row.sessions; void row.rollup
    }
  }
  return value
}

it('records first click and revisit once at 1x and 4x', () => {
  for (const scale of [1, 4]) {
    const { pool } = fixture(scale)
    const read = vi.spyOn(pool, 'row')
    const start = performance.now()
    let value: ReturnType<typeof click> = LOADING
    let stop = autorun(() => { value = click(pool, 'root') })
    const firstMs = performance.now() - start
    const summaries = (kind: string) => read.mock.calls.filter(([entity, , absent]) => entity === kind && absent === 'summary').length
    const first = { issue: summaries('issue'), session: summaries('session') }
    stop()
    read.mockClear()
    const revisit = performance.now()
    stop = autorun(() => { value = click(pool, 'child-0001') })
    const revisitMs = performance.now() - revisit
    try {
      expect(value).not.toBe(LOADING)
      console.info('[mission click]', JSON.stringify({ scale, visible: VISIBLE, firstMs, revisitMs, first, revisit: { issue: summaries('issue'), session: summaries('session') } }))
    } finally { stop(); read.mockRestore(); pool.dispose() }
  }
})

it('bounds click summary reads by the visible rows at 1x and 4x', () => {
  for (const scale of [1, 4]) {
    const { pool } = fixture(scale)
    const read = vi.spyOn(pool, 'row')
    const stop = autorun(() => click(pool, 'root'))
    try {
      for (const kind of ['issue', 'session'])
        expect(read.mock.calls.filter(([entity, , absent]) => entity === kind && absent === 'summary').length, `${kind} summaries at ${scale}x`).toBeLessThanOrEqual(VISIBLE * 4)
    } finally { stop(); read.mockRestore(); pool.dispose() }
  }
})

it('a heartbeat leaves mission shape and unchanged counts observed without rederiving the pane', () => {
  const { pool, sessions } = fixture(4)
  const reader = missionView(pool)
  const stop = autorun(() => click(pool, 'root'))
  const before = reader.stats.values
  try {
    runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'session', id: sessions[1]!.sessionId,
      value: { ...sessions[1]!, lastActiveAt: '2026-10-01T12:00:01Z' } }] }))
    expect(reader.stats.values - before).toBe(0)
  } finally { stop(); pool.dispose() }
})


it('recomputes only the changed issue and its ancestors, and stops unchanged scalar counts', () => {
  const { pool, sessions } = fixture(4)
  const reader = missionView(pool), deck = reader.deck('root')
  const publications: unknown[] = []
  const stop = autorun(() => { publications.push({ ids: deck.rowIds(), rollup: deck.model('root').rollup }) })
  const ran: string[] = []
  reader.stats.onRollup = id => ran.push(id)
  try {
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: sessions[1]!.sessionId,
      value: { ...sessions[1]!, lastActiveAt: '2026-10-01T12:00:01Z' } }] })
    expect(new Set(ran)).toEqual(new Set(['child-0001']))
    expect(publications).toHaveLength(1)
    ran.length = 0
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: sessions[1]!.sessionId,
      value: { ...sessions[1]!, agentState: { phase: 'idle' } } }] })
    expect(new Set(ran)).toEqual(new Set(['child-0001', 'root']))
    expect(publications).toHaveLength(2)
    expect(deck.model('root').workingAgentCount).toBe(512)
  } finally { reader.stats.onRollup = undefined; stop(); pool.dispose() }
})
