import { asIssueId, asSessionId, isHeadlessSession, type SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type IssueMembershipRef,
  sessionOwnershipStats,
  sessionsForIssueNav,
} from './session-ownership'

// ---------------------------------------------------------------------------
// POD-1685 — THE EXPLICIT-MEMBERSHIP ANSWER, WITHOUT THE FULL-SLICE SCAN.
//
// `sessionsForIssueNav` answered "who is on this issue" by filtering the whole
// session slice, and the Flight Deck asks it once per VISIBLE ISSUE while
// building its `sessionsByIssue` map. On the corpus that prompted this (1,642
// issues, 1,311 sessions) that is 2.1M comparisons per replica publish, and the
// profile put this function's two lines near the top of main-thread self time.
//
// It walks the issue's own (short) member list against a per-slice index now.
// These cases pin the two things that must not change with it: the answer is
// byte-identical to the filter it replaces — same rows, SAME ORDER, same
// archived/headless/shell rules — and the index is built once per session
// slice, not once per issue.
// ---------------------------------------------------------------------------

function session(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: asSessionId(id),
    agentKind: 'claude-code',
    title: id,
    cwd: '/repo',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    busy: false,
    readAt: null,
    unread: false,
    ...over,
  } as unknown as SessionMeta
}

function ref(id: string, memberSessionIds: string[]): IssueMembershipRef {
  return { id: asIssueId(id), worktreePath: '/repo', memberSessionIds }
}

/** The body this replaced, kept verbatim as the oracle. */
function byFilter(
  issue: IssueMembershipRef,
  sessions: readonly SessionMeta[],
  includeShells: boolean,
): SessionMeta[] {
  const ids = new Set(issue.memberSessionIds ?? [])
  return sessions.filter((s) => {
    if (s.archived || isHeadlessSession(s)) return false
    if (!includeShells && s.agentKind === 'shell') return false
    return ids.has(s.sessionId)
  })
}

const slice = [
  session('s-4', { issueId: asIssueId('i-1') }),
  session('s-1', { issueId: asIssueId('i-1') }),
  session('s-shell', { agentKind: 'shell', issueId: asIssueId('i-1') }),
  session('s-gone', { archived: true, issueId: asIssueId('i-1') }),
  session('s-headless', { headless: true, issueId: asIssueId('i-1') } as Partial<SessionMeta>),
  session('s-2', { issueId: asIssueId('i-1') }),
  session('s-other', { issueId: asIssueId('i-2') }),
]

describe('sessionsForIssueNav — explicit membership over the slice index', () => {
  it('returns the members in SLICE order, not in member-list order', () => {
    // The member list is deliberately shuffled: the old filter walked the slice,
    // so slice order is what every caller that does not re-sort was reading.
    const issue = ref('i-1', ['s-2', 's-1', 's-4'])
    expect(sessionsForIssueNav(issue, slice, []).map((s) => s.sessionId)).toEqual([
      's-4',
      's-1',
      's-2',
    ])
  })

  it('agrees with the filter it replaced on archived, headless and shell rows', () => {
    const issue = ref('i-1', ['s-4', 's-1', 's-shell', 's-gone', 's-headless', 's-2', 's-missing'])
    for (const includeShells of [false, true]) {
      expect(sessionsForIssueNav(issue, slice, [], { includeShells })).toEqual(
        byFilter(issue, slice, includeShells),
      )
    }
  })

  it('yields nothing for an issue whose members are all outside the slice', () => {
    expect(sessionsForIssueNav(ref('i-3', ['s-nowhere']), slice, [])).toEqual([])
    expect(sessionsForIssueNav(ref('i-3', []), slice, [])).toEqual([])
  })

  it('indexes the slice once, however many issues ask about it', () => {
    sessionsForIssueNav(ref('i-1', ['s-1']), slice, [])
    const before = sessionOwnershipStats().lookups
    for (let i = 0; i < 200; i += 1) {
      sessionsForIssueNav(ref(`i-${i}`, ['s-1', 's-2']), slice, [])
    }
    expect(sessionOwnershipStats().lookups - before).toBe(0)
  })

  it('rebuilds when the slice is republished, so membership can never go stale', () => {
    const published = [...slice]
    sessionsForIssueNav(ref('i-1', ['s-1']), published, [])
    const before = sessionOwnershipStats().lookups
    const next = [...published, session('s-new', { issueId: asIssueId('i-1') })]
    expect(
      sessionsForIssueNav(ref('i-1', ['s-1', 's-new']), next, []).map((s) => s.sessionId),
    ).toEqual(['s-1', 's-new'])
    expect(sessionOwnershipStats().lookups - before).toBe(1)
  })
})
