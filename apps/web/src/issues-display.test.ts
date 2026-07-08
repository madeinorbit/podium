import { describe, expect, it } from 'vitest'
import {
  computeEpicProgress,
  DEFAULT_DISPLAY,
  filterBoardScope,
  orderIssues,
  readIssuesDisplay,
  writeIssuesDisplay,
} from './issues-display'
import { makeIssue as issue } from './test-issue'

describe('readIssuesDisplay', () => {
  it('defaults on null/garbage/partial input', () => {
    expect(readIssuesDisplay(null)).toEqual(DEFAULT_DISPLAY)
    expect(readIssuesDisplay('not json')).toEqual(DEFAULT_DISPLAY)
    const d = readIssuesDisplay(JSON.stringify({ layout: 'list' }))
    expect(d.layout).toBe('list')
    expect(d.ordering).toBe(DEFAULT_DISPLAY.ordering)
    expect(d.badges).toEqual(DEFAULT_DISPLAY.badges)
  })
  it('rejects unknown enum values', () => {
    expect(readIssuesDisplay(JSON.stringify({ layout: 'gantt' })).layout).toBe('board')
  })
  it('round-trips through write', () => {
    const d = { ...DEFAULT_DISPLAY, layout: 'list' as const, ordering: 'priority' as const }
    expect(readIssuesDisplay(writeIssuesDisplay(d))).toEqual(d)
  })
})

describe('orderIssues', () => {
  it('priority: ascending priority, then seq', () => {
    const a = issue({ id: 'a', seq: 2, priority: 2 })
    const b = issue({ id: 'b', seq: 1, priority: 0 })
    const c = issue({ id: 'c', seq: 3, priority: 2 })
    expect(orderIssues([a, c, b], 'priority').map((i) => i.id)).toEqual(['b', 'a', 'c'])
  })
  it('updated: most recently updated first; created likewise', () => {
    const old = issue({
      id: 'old',
      updatedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-02T00:00:00Z',
    })
    const fresh = issue({
      id: 'new',
      updatedAt: '2026-06-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
    })
    expect(orderIssues([old, fresh], 'updated')[0]?.id).toBe('new')
    expect(orderIssues([old, fresh], 'created')[0]?.id).toBe('old')
  })
  it('does not mutate its input', () => {
    const list = [issue({ id: 'a', priority: 3 }), issue({ id: 'b', priority: 0 })]
    orderIssues(list, 'priority')
    expect(list[0]?.id).toBe('a')
  })
})

describe('filterBoardScope audience (#198)', () => {
  it('hides internal (audience: agent) issues from the top level', () => {
    const human = issue({ id: 'h', audience: 'human' })
    const internal = issue({ id: 'a', audience: 'agent' })
    const ids = filterBoardScope([human, internal], false).map((i) => i.id)
    expect(ids).toEqual(['h'])
  })
  it('keys on audience, not origin: an agent-origin human-audience issue stays visible', () => {
    // The "agent cut a human-facing epic" case — origin agent but on the board.
    const agentEpic = issue({ id: 'e', origin: 'agent', audience: 'human' })
    expect(filterBoardScope([agentEpic], false).map((i) => i.id)).toEqual(['e'])
  })
  it('keeps an internal child nested under a human-audience ancestor', () => {
    const epic = issue({ id: 'e', audience: 'human' })
    const child = issue({ id: 'c', audience: 'agent', parentId: 'e' })
    const ids = filterBoardScope([epic, child], false)
      .map((i) => i.id)
      .sort()
    expect(ids).toEqual(['c', 'e'])
  })
  it('drops an orphan internal issue with no human-audience ancestor', () => {
    const orphan = issue({ id: 'o', audience: 'agent', parentId: undefined })
    const nested = issue({ id: 'n', audience: 'agent', parentId: 'o' })
    expect(filterBoardScope([orphan, nested], false)).toEqual([])
  })
  it('showAgentTasks reveals internal issues at the top level', () => {
    const internal = issue({ id: 'a', audience: 'agent' })
    expect(filterBoardScope([internal], true).map((i) => i.id)).toEqual(['a'])
  })
})

describe('computeEpicProgress (#198)', () => {
  it('returns null when the issue has no descendants', () => {
    expect(computeEpicProgress([issue({ id: 'e' })], 'e')).toBeNull()
  })
  it('counts done/total across the whole descendant subtree', () => {
    const epic = issue({ id: 'e' })
    const c1 = issue({ id: 'c1', parentId: 'e', stage: 'done' })
    const c2 = issue({ id: 'c2', parentId: 'e', stage: 'in_progress' })
    const grandchild = issue({ id: 'g', parentId: 'c2', stage: 'done' })
    const p = computeEpicProgress([epic, c1, c2, grandchild], 'e')
    expect(p).toEqual({ total: 3, done: 2, liveAgents: 0 })
  })
  it('counts descendants with a live session', () => {
    const epic = issue({ id: 'e' })
    const busy = issue({
      id: 'c',
      parentId: 'e',
      sessions: [{ status: 'live' } as never],
    })
    expect(computeEpicProgress([epic, busy], 'e')?.liveAgents).toBe(1)
  })
})

describe('flatten pref (#85)', () => {
  it('defaults to nested (flatten=false) and survives a stale blob missing the field', () => {
    expect(readIssuesDisplay(null).flatten).toBe(false)
    expect(readIssuesDisplay(JSON.stringify({ layout: 'list' })).flatten).toBe(false)
  })
  it('round-trips flatten=true through write/read', () => {
    const d = { ...readIssuesDisplay(null), flatten: true }
    expect(readIssuesDisplay(writeIssuesDisplay(d)).flatten).toBe(true)
  })
})
