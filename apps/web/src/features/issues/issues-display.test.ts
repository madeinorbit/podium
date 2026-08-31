import { asIssueId, asSessionId, type SessionMeta } from '@podium/model/browser'
import { describe, expect, it } from 'vitest'
import { makeIssue as issue } from '@/lib/test-issue'
import {
  confirmedWorkingAgentCount,
  computeEpicProgress,
  computeEpicProgressMap,
  DEFAULT_DISPLAY,
  filterBoardScope,
  readIssuesDisplay,
  writeIssuesDisplay,
} from './issues-display'

const NOW = Date.parse('2026-08-28T12:00:00.000Z')
const ACTIVE_AT = new Date(NOW).toISOString()

function session(id: string, issueId: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: asSessionId(id),
    issueId: asIssueId(issueId),
    agentKind: 'claude-code',
    title: id,
    cwd: '/r/wt',
    status: 'live',
    agentState: {
      phase: 'working',
      since: ACTIVE_AT,
      stateObservedAt: ACTIVE_AT,
      nativeSubagentCount: 0,
    },
    lastActiveAt: ACTIVE_AT,
    createdAt: ACTIVE_AT,
    updatedAt: ACTIVE_AT,
    unread: false,
    archived: false,
    ...over,
  } as SessionMeta
}

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
    const d = { ...DEFAULT_DISPLAY, layout: 'list' as const, ordering: 'created' as const }
    expect(readIssuesDisplay(writeIssuesDisplay(d))).toEqual(d)
  })
  it('defaults the board to priority ordering', () => {
    expect(DEFAULT_DISPLAY.ordering).toBe('priority')
    expect(readIssuesDisplay(null).ordering).toBe('priority')
  })
  it('keeps an explicitly persisted ordering over the default', () => {
    expect(readIssuesDisplay(JSON.stringify({ ordering: 'updated' })).ordering).toBe('updated')
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
  it('keeps deleted drafts and internal issues reachable for recovery', () => {
    const draft = issue({ id: 'draft', draft: true, deletedAt: '2026-07-13T10:00:00Z' })
    const internal = issue({
      id: 'internal',
      audience: 'agent',
      deletedAt: '2026-07-13T10:00:00Z',
    })
    expect(filterBoardScope([draft, internal], false).map((i) => i.id)).toEqual([
      'draft',
      'internal',
    ])
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
  it('counts confirmed working agents, not descendant tasks with attached sessions', () => {
    const epic = issue({ id: 'e' })
    const child = issue({
      id: 'c',
      parentId: 'e',
      memberSessionIds: [
        'working',
        'compacting',
        'idle',
        'parked',
        'exited',
        'stale',
        'shell',
        'headless',
      ],
      sessionSummary: { total: 8, byPhase: { working: 6, compacting: 1, idle: 1 } },
    })
    const staleAt = new Date(NOW - 16 * 60_000).toISOString()
    const sessions = [
      session('working', 'c'),
      session('compacting', 'c', {
        agentState: {
          phase: 'compacting',
          since: ACTIVE_AT,
          stateObservedAt: ACTIVE_AT,
          nativeSubagentCount: 0,
        },
      }),
      session('idle', 'c', {
        agentState: { phase: 'idle', since: ACTIVE_AT, nativeSubagentCount: 0 },
      }),
      session('parked', 'c', { status: 'hibernated' }),
      session('exited', 'c', { status: 'exited' }),
      session('stale', 'c', {
        lastActiveAt: staleAt,
        agentState: {
          phase: 'working',
          since: staleAt,
          stateObservedAt: staleAt,
          nativeSubagentCount: 0,
        },
      }),
      session('shell', 'c', { agentKind: 'shell' }),
      session('headless', 'c', { headless: true }),
    ]

    // Generic issue surfaces exclude terminal shells and embedded headless
    // harness sessions before applying the shared confirmed-computing rule.
    expect(confirmedWorkingAgentCount(sessions, NOW)).toBe(2)
    expect(computeEpicProgress([epic, child], 'e', sessions, NOW)?.liveAgents).toBe(2)
  })
  it('map form computes every root over one shared index', () => {
    const list = [
      issue({ id: 'e1' }),
      issue({ id: 'c1', parentId: 'e1', stage: 'done' }),
      issue({ id: 'e2' }), // no descendants → null
    ]
    const map = computeEpicProgressMap(list, ['e1', 'e2'])
    expect(map.get('e1')).toEqual({ total: 1, done: 1, liveAgents: 0 })
    expect(map.get('e2')).toBeNull()
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
