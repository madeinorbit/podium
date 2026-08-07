// POD-516 — the flight deck's pure mission projection.
//
// Everything here is the client-side derivation over an issue slice + a session
// slice: no React, no store. The cases below are the ones the operator workspace
// actually depends on — mission membership (formal parent edges AND agent-started
// provenance, but never a `discovered-from` spin-off), ancestor-preserving mode
// filters, and the per-row operational state that drives the status column.
import type { IssueNavigationModel } from '@podium/client-core/viewmodels'
import type { SessionMeta, SessionMetaInput, UnbrandIds } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  buildFlightDeckRows,
  coordinatorCount,
  issueNeedsHuman,
  missionIssueIds,
  missionProgress,
  missionRootFor,
  missionSessions,
  operationalState,
  sessionNeedsHuman,
  type FlightDeckRow,
  type OperationalState,
} from './mission'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function issue(id: string, over: Partial<UnbrandIds<IssueNavigationModel>> = {}): IssueNavigationModel {
  return {
    id,
    repoPath: '/r/acme',
    seq: 1,
    title: id,
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedByNotes: [],
    priority: 2,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: false,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archived: false,
    origin: 'human' as const,
    audience: 'human' as const,
    draft: false,
    ...over,
  } as IssueNavigationModel
}

function sess(id: string, over: Partial<SessionMetaInput> = {}): SessionMeta {
  return {
    sessionId: id,
    title: id,
    cwd: '/r/acme',
    agentKind: 'claude-code',
    status: 'live',
    busy: false,
    archived: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T01:00:00.000Z',
    ...over,
  } as unknown as SessionMeta
}

// The harness-state shapes the deck reads. Annotated (not inferred) so a phase
// or verdict that no longer exists in the model is a compile error here.
type AgentState = NonNullable<SessionMetaInput['agentState']>

const SINCE = '2026-07-01T01:00:00.000Z'

/** An instrumented agent mid-turn — the only shape that reads as `working`. */
const workingState: AgentState = { phase: 'working', since: SINCE, nativeSubagentCount: 0 }
/** Stopped on a question: needs the human. */
const needsUserState: AgentState = {
  phase: 'needs_user',
  since: SINCE,
  nativeSubagentCount: 0,
  need: { kind: 'question', summary: 'which one?' },
}
const erroredState = (retryable: boolean): AgentState => ({
  phase: 'errored',
  since: SINCE,
  nativeSubagentCount: 0,
  error: { class: 'network', retryable },
})
/** Ran to a natural stop — quiet, not a request. */
const finishedState: AgentState = {
  phase: 'idle',
  since: SINCE,
  nativeSubagentCount: 0,
  idle: { kind: 'done' },
}
const offer: NonNullable<SessionMetaInput['offer']> = {
  message: 'Ready to merge',
  actions: [],
  createdAt: SINCE,
}

/** Rows compress to `id@depth` — order and depth are the contract, so assert both. */
const shape = (rows: readonly FlightDeckRow[]): string[] =>
  rows.map((row) => `${row.issue.id}@${row.depth}`)

const rowFor = (rows: readonly FlightDeckRow[], id: string): FlightDeckRow => {
  const row = rows.find((candidate) => candidate.issue.id === id)
  if (!row) throw new Error(`no row for ${id}`)
  return row
}

/**
 * The canonical three-level mission used by most cases:
 *
 *   root ── c1 ── g1        (g1 is a leaf with a live agent)
 *        │     └ g2         (g2 is SESSIONLESS — a task with no agent yet)
 *        └─ c2
 */
function mission(): { issues: IssueNavigationModel[]; sessions: SessionMeta[] } {
  return {
    issues: [
      issue('root'),
      issue('c1', { parentId: 'root', seq: 1 }),
      issue('c2', { parentId: 'root', seq: 2 }),
      issue('g1', { parentId: 'c1', seq: 1 }),
      issue('g2', { parentId: 'c1', seq: 2 }),
    ],
    sessions: [sess('s-root', { issueId: 'root' }), sess('s-g1', { issueId: 'g1' })],
  }
}

// ---------------------------------------------------------------------------
// missionRootFor
// ---------------------------------------------------------------------------

describe('missionRootFor', () => {
  it('walks a deep descendant up to the top-level ancestor', () => {
    const { issues } = mission()
    expect(missionRootFor(issues, 'g2')?.id).toBe('root')
    expect(missionRootFor(issues, 'c1')?.id).toBe('root')
  })

  it('returns the issue itself when it is already top-level', () => {
    const { issues } = mission()
    expect(missionRootFor(issues, 'root')?.id).toBe('root')
  })

  it.each<[string, string | null]>([
    ['no selection', null],
    ['an id the replica has not seen', 'ghost'],
  ])('is undefined for %s', (_name, selected) => {
    expect(missionRootFor(mission().issues, selected)).toBeUndefined()
  })

  it('stops below an archived or deleted parent rather than surfacing it', () => {
    const issues = [
      issue('dead', { archived: true }),
      issue('gone', { deletedAt: '2026-07-01T00:00:00.000Z' }),
      issue('a', { parentId: 'dead' }),
      issue('b', { parentId: 'gone' }),
    ]
    expect(missionRootFor(issues, 'a')?.id).toBe('a')
    expect(missionRootFor(issues, 'b')?.id).toBe('b')
  })

  it('terminates on a parentId cycle instead of hanging', () => {
    // a → b → c → a. A naive walk spins forever; this must return a member.
    const issues = [
      issue('a', { parentId: 'c' }),
      issue('b', { parentId: 'a' }),
      issue('c', { parentId: 'b' }),
    ]
    expect(['a', 'b', 'c']).toContain(missionRootFor(issues, 'a')?.id)
  })
})

// ---------------------------------------------------------------------------
// missionIssueIds
// ---------------------------------------------------------------------------

describe('missionIssueIds', () => {
  it('collects the whole formal subtree', () => {
    const { issues, sessions } = mission()
    expect([...missionIssueIds(issues, 'root', sessions)].sort()).toEqual([
      'c1',
      'c2',
      'g1',
      'g2',
      'root',
    ])
  })

  it('drops archived and deleted issues, and everything beneath them', () => {
    const issues = [
      issue('root'),
      issue('c1', { parentId: 'root', archived: true }),
      issue('c2', { parentId: 'root', deletedAt: '2026-07-02T00:00:00.000Z' }),
      // Reachable only through an archived / deleted parent — must not leak in.
      issue('g1', { parentId: 'c1' }),
      issue('g2', { parentId: 'c2' }),
      issue('c3', { parentId: 'root' }),
    ]
    expect([...missionIssueIds(issues, 'root', [])].sort()).toEqual(['c3', 'root'])
  })

  it('pulls in agent-started issues recursively, one hop per generation', () => {
    // root's agent files `a`; a's OWN agent then files `b`. Both belong.
    const issues = [
      issue('root'),
      issue('a', { startedBySession: 's-root' }),
      issue('b', { startedBySession: 's-a' }),
    ]
    const sessions = [sess('s-root', { issueId: 'root' }), sess('s-a', { issueId: 'a' })]
    expect([...missionIssueIds(issues, 'root', sessions)].sort()).toEqual(['a', 'b', 'root'])
  })

  it('leaves out an issue started by a session outside the mission', () => {
    const issues = [issue('root'), issue('other'), issue('x', { startedBySession: 's-other' })]
    const sessions = [sess('s-root', { issueId: 'root' }), sess('s-other', { issueId: 'other' })]
    expect([...missionIssueIds(issues, 'root', sessions)]).toEqual(['root'])
  })

  it('never follows a discovered-from edge — a spin-off is a separate mission', () => {
    const issues = [
      issue('root'),
      issue('c1', { parentId: 'root' }),
      // Exactly what `attach --spinoff` produces: top level, provenance edge only.
      issue('spin', { deps: [{ id: 'c1', type: 'discovered-from' }] }),
    ]
    const sessions = [sess('s-c1', { issueId: 'c1' })]
    expect([...missionIssueIds(issues, 'root', sessions)].sort()).toEqual(['c1', 'root'])
  })
})

// ---------------------------------------------------------------------------
// missionSessions
// ---------------------------------------------------------------------------

describe('missionSessions', () => {
  const issues = [
    issue('root', { memberSessionIds: ['s-member'] }),
    issue('c1', { parentId: 'root' }),
    issue('outside'),
  ]
  const sessions = [
    sess('s-root', { issueId: 'root' }),
    sess('s-c1', { issueId: 'c1' }),
    sess('s-member'), // attached only via the root's member list
    sess('s-out', { issueId: 'outside' }),
    sess('s-old', { issueId: 'c1', archived: true }),
  ]

  it('takes attached and member sessions across the subtree, skipping archived', () => {
    expect(missionSessions(issues, sessions, 'root').map((s) => s.sessionId).sort()).toEqual([
      's-c1',
      's-member',
      's-root',
    ])
  })

  it('opts archived members back in on request', () => {
    expect(
      missionSessions(issues, sessions, 'root', true)
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(['s-c1', 's-member', 's-old', 's-root'])
  })
})

// ---------------------------------------------------------------------------
// buildFlightDeckRows
// ---------------------------------------------------------------------------

describe('buildFlightDeckRows', () => {
  it('projects three levels parent-first with depth, keeping a sessionless task', () => {
    const { issues, sessions } = mission()
    // g2 has no session at all and still earns a row: the deck is issue-first.
    expect(shape(buildFlightDeckRows(issues, sessions, 'root'))).toEqual([
      'root@0',
      'c1@1',
      'g1@2',
      'g2@2',
      'c2@1',
    ])
    expect(rowFor(buildFlightDeckRows(issues, sessions, 'root'), 'g2').sessions).toEqual([])
  })

  it('orders siblings by sortKey when both carry one, else by seq', () => {
    const issues = [
      issue('root'),
      issue('a', { parentId: 'root', seq: 3, sortKey: 'm' }),
      issue('b', { parentId: 'root', seq: 2, sortKey: 'a' }),
      issue('c', { parentId: 'root', seq: 1 }),
    ]
    // b/a sort by key; c has none so it falls back to the seq comparison.
    expect(shape(buildFlightDeckRows(issues, [], 'root'))).toEqual(['root@0', 'c@1', 'b@1', 'a@1'])
  })

  it.each<[string, string]>([
    ['unknown', 'ghost'],
    ['archived', 'dead'],
    ['deleted', 'gone'],
  ])('returns no rows for a(n) %s root', (_name, rootId) => {
    const issues = [issue('dead', { archived: true }), issue('gone', { deletedAt: '2026-07-01T00:00:00.000Z' })]
    expect(buildFlightDeckRows(issues, [], rootId)).toEqual([])
  })

  it('omits archived and deleted issues and their subtrees', () => {
    const issues = [
      issue('root'),
      issue('c1', { parentId: 'root', seq: 1, archived: true }),
      issue('g1', { parentId: 'c1' }),
      issue('c2', { parentId: 'root', seq: 2, deletedAt: '2026-07-02T00:00:00.000Z' }),
      issue('c3', { parentId: 'root', seq: 3 }),
    ]
    expect(shape(buildFlightDeckRows(issues, [], 'root'))).toEqual(['root@0', 'c3@1'])
  })

  it('terminates on a parentId cycle and emits each issue exactly once', () => {
    const issues = [
      issue('root', { parentId: 'c' }),
      issue('b', { parentId: 'root' }),
      issue('c', { parentId: 'b' }),
    ]
    const rows = buildFlightDeckRows(issues, [], 'root')
    expect(shape(rows)).toEqual(['root@0', 'b@1', 'c@2'])
    expect(new Set(rows.map((row) => row.issue.id)).size).toBe(rows.length)
  })

  it('does not double-count the roll-ups under a parentId cycle', () => {
    // root → b → c → root. An issue that is its own descendant would count its
    // sessions twice and inflate the header the operator reads.
    const issues = [
      issue('root', { parentId: 'c' }),
      issue('b', { parentId: 'root' }),
      issue('c', { parentId: 'b', stage: 'review' }),
    ]
    const sessions = [
      sess('s-root', { issueId: 'root' }),
      sess('s-b', { issueId: 'b' }),
      sess('s-c', { issueId: 'c' }),
    ]
    const rows = buildFlightDeckRows(issues, sessions, 'root')
    // No row may list itself as one of its own descendants.
    for (const row of rows) expect(row.descendantIds).not.toContain(row.issue.id)
    const root = rowFor(rows, 'root')
    expect(root.descendantIds).toEqual(['b', 'c'])
    expect(root.liveAgentCount).toBe(3) // three issues, one live session each
    expect(root.actionableCount).toBe(1) // only c is in review
  })

  it('rolls descendants, needs-you count and live agents up the subtree', () => {
    const issues = [
      issue('root'),
      issue('c1', { parentId: 'root', seq: 1 }),
      issue('g1', { parentId: 'c1', stage: 'review' }), // review ⇒ needs a human
      issue('c2', { parentId: 'root', seq: 2 }),
    ]
    const sessions = [
      sess('s-root', { issueId: 'root' }),
      sess('s-g1', { issueId: 'g1' }),
      sess('s-dead', { issueId: 'c2', status: 'exited' }), // present but not live
    ]
    const rows = buildFlightDeckRows(issues, sessions, 'root')
    const root = rowFor(rows, 'root')
    expect(root.descendantIds).toEqual(['c1', 'g1', 'c2'])
    expect(root.actionableCount).toBe(1)
    expect(root.liveAgentCount).toBe(2) // s-root + s-g1; the exited one does not count
    expect(rowFor(rows, 'c2').liveAgentCount).toBe(0)
    expect(rowFor(rows, 'c1').descendantIds).toEqual(['g1'])
  })

  it('grafts an agent-started top-level issue under the root that started it', () => {
    const issues = [
      issue('root'),
      issue('c1', { parentId: 'root', seq: 1 }),
      issue('spawned', { startedBySession: 's-root', seq: 2 }),
    ]
    const sessions = [sess('s-root', { issueId: 'root' })]
    expect(shape(buildFlightDeckRows(issues, sessions, 'root'))).toEqual([
      'root@0',
      'c1@1',
      'spawned@1',
    ])
  })

  it('sorts a grafted sibling among the formal ones rather than appending it', () => {
    // seq 2 puts the grafted issue BETWEEN the two formal children — an order
    // that is impossible if grafting happens after the sort.
    const issues = [
      issue('root'),
      issue('formal-a', { parentId: 'root', seq: 1 }),
      issue('formal-b', { parentId: 'root', seq: 3 }),
      issue('spawned', { startedBySession: 's-root', seq: 2 }),
    ]
    const sessions = [sess('s-root', { issueId: 'root' })]
    expect(shape(buildFlightDeckRows(issues, sessions, 'root'))).toEqual([
      'root@0',
      'formal-a@1',
      'spawned@1',
      'formal-b@1',
    ])
  })

  it('orders a grafted sibling by sortKey, not just seq', () => {
    const issues = [
      issue('root'),
      issue('formal', { parentId: 'root', seq: 1, sortKey: 'm' }),
      issue('spawned', { startedBySession: 's-root', seq: 9, sortKey: 'a' }),
    ]
    const sessions = [sess('s-root', { issueId: 'root' })]
    // sortKey wins over the much higher seq, exactly as for two formal siblings.
    expect(shape(buildFlightDeckRows(issues, sessions, 'root'))).toEqual([
      'root@0',
      'spawned@1',
      'formal@1',
    ])
  })

  it('renders a second-generation agent-started issue under its provenance parent', () => {
    // root's agent files `a`; a's OWN agent then files `b`. `b` must render under
    // `a` — the issue that owns the session that started it — not flat under root.
    const issues = [
      issue('root'),
      issue('a', { startedBySession: 's-root' }),
      issue('b', { startedBySession: 's-a' }),
    ]
    const sessions = [sess('s-root', { issueId: 'root' }), sess('s-a', { issueId: 'a' })]
    expect(shape(buildFlightDeckRows(issues, sessions, 'root'))).toEqual([
      'root@0',
      'a@1',
      'b@2',
    ])
  })

  it('keeps the grafted ancestor path when a filter matches only the deep spawn', () => {
    // The rendered tree is the one filters walk: `a` has no parentId at all, so a
    // raw parentId walk would strand `b` and lose its context.
    const issues = [
      issue('root'),
      issue('a', { startedBySession: 's-root' }),
      issue('b', { startedBySession: 's-a', stage: 'review' }),
    ]
    const sessions = [sess('s-root', { issueId: 'root' }), sess('s-a', { issueId: 'a' })]
    expect(shape(buildFlightDeckRows(issues, sessions, 'root', 'needs-you'))).toEqual([
      'root@0',
      'a@1',
      'b@2',
    ])
  })

  it('grafts a mission issue whose formal parent is outside the mission', () => {
    // `a` nests under a parent this replica cannot see, so the parentId edge is a
    // dead end — provenance is the only thing left to hang it on.
    const issues = [issue('root'), issue('a', { parentId: 'invisible', startedBySession: 's-root' })]
    const sessions = [sess('s-root', { issueId: 'root' })]
    expect(shape(buildFlightDeckRows(issues, sessions, 'root'))).toEqual(['root@0', 'a@1'])
  })

  it('never renders a discovered-from spin-off inside the mission', () => {
    const issues = [
      issue('root'),
      issue('c1', { parentId: 'root' }),
      issue('spin', { deps: [{ id: 'root', type: 'discovered-from' }] }),
    ]
    const rows = buildFlightDeckRows(issues, [sess('s-root', { issueId: 'root' })], 'root')
    expect(shape(rows)).toEqual(['root@0', 'c1@1'])
    // …and therefore it cannot move the mission's progress either.
    expect(missionProgress(rows).total).toBe(1)
  })

  describe('mode filters', () => {
    // root ── c1 ── g1 (needs you / live)
    //      │     └ g2 (quiet, done)
    //      └─ c2 (quiet, done)
    const issues = [
      issue('root'),
      issue('c1', { parentId: 'root', seq: 1 }),
      issue('g1', { parentId: 'c1', seq: 1, stage: 'review' }),
      issue('g2', { parentId: 'c1', seq: 2, stage: 'done' }),
      issue('c2', { parentId: 'root', seq: 2, stage: 'done' }),
    ]
    const sessions = [sess('s-g1', { issueId: 'g1', agentState: workingState })]

    it('keeps the ancestor path to the root for a deep needs-you match', () => {
      // c1 does not match on its own; it survives only as g1's ancestor.
      expect(shape(buildFlightDeckRows(issues, sessions, 'root', 'needs-you'))).toEqual([
        'root@0',
        'c1@1',
        'g1@2',
      ])
    })

    it('keeps the root row even when nothing in the mission matches', () => {
      const quiet = issues.map((i) => (i.id === 'g1' ? issue('g1', { parentId: 'c1', seq: 1 }) : i))
      expect(shape(buildFlightDeckRows(quiet, [], 'root', 'needs-you'))).toEqual(['root@0'])
    })

    it('in active mode keeps unfinished work plus finished work that still has an agent', () => {
      const withRevival = [...issues, issue('c3', { parentId: 'root', seq: 3, stage: 'done' })]
      const revived = [...sessions, sess('s-c3', { issueId: 'c3' })]
      // g2 and c2 are done and agent-less → dropped. c3 is done but still has a
      // live session → kept. c1 is unfinished and matches on its own.
      expect(shape(buildFlightDeckRows(withRevival, revived, 'root', 'active'))).toEqual([
        'root@0',
        'c1@1',
        'g1@2',
        'c3@1',
      ])
    })

    it('in full mode shows everything', () => {
      expect(shape(buildFlightDeckRows(issues, sessions, 'root', 'full'))).toEqual([
        'root@0',
        'c1@1',
        'g1@2',
        'g2@2',
        'c2@1',
      ])
    })
  })
})

// ---------------------------------------------------------------------------
// missionProgress
// ---------------------------------------------------------------------------

describe('missionProgress', () => {
  const row = (id: string, over: Partial<UnbrandIds<IssueNavigationModel>> = {}): FlightDeckRow => ({
    issue: issue(id, over),
    depth: 0,
    sessions: [],
    descendantIds: [],
    actionableCount: 0,
    liveAgentCount: 0,
  })

  const cases: Array<[string, FlightDeckRow[], { done: number; total: number; percent: number }]> = [
    ['no rows at all', [], { done: 0, total: 0, percent: 0 }],
    ['a lone root', [row('root')], { done: 0, total: 0, percent: 0 }],
    [
      'a root that is itself done (root is never counted)',
      [row('root', { stage: 'done' }), row('a'), row('b')],
      { done: 0, total: 2, percent: 0 },
    ],
    [
      'half the subtree done',
      [row('root'), row('a', { stage: 'done' }), row('b')],
      { done: 1, total: 2, percent: 50 },
    ],
    [
      'a child closed for another reason than stage=done',
      [row('root'), row('a', { closedReason: 'duplicate' })],
      { done: 1, total: 1, percent: 100 },
    ],
  ]

  it.each(cases)('reports %s', (_name, rows, expected) => {
    expect(missionProgress(rows)).toEqual(expected)
  })

  it('never divides by zero when the mission is only its root', () => {
    const rows = buildFlightDeckRows([issue('root', { stage: 'done' })], [], 'root')
    expect(missionProgress(rows).percent).toBe(0)
    expect(Number.isNaN(missionProgress(rows).percent)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// needs-human predicates
// ---------------------------------------------------------------------------

describe('sessionNeedsHuman', () => {
  const cases: Array<[string, SessionMeta, boolean]> = [
    ['stopped on a question', sess('a', { agentState: needsUserState }), true],
    ['errored but retryable', sess('a', { agentState: erroredState(true) }), true],
    ['errored and not retryable', sess('a', { agentState: erroredState(false) }), false],
    ['standing offer', sess('a', { offer }), true],
    ['mid-turn', sess('a', { agentState: workingState }), false],
    ['finished quietly', sess('a', { agentState: finishedState }), false],
  ]

  it.each(cases)('%s', (_name, session, expected) => {
    expect(sessionNeedsHuman(session)).toBe(expected)
  })
})

describe('issueNeedsHuman', () => {
  const cases: Array<[string, IssueNavigationModel, SessionMeta[], boolean]> = [
    ['the flag is set', issue('i', { needsHuman: true }), [], true],
    ['it is in review', issue('i', { stage: 'review' }), [], true],
    ['a live session is blocked on us', issue('i'), [sess('a', { agentState: needsUserState })], true],
    [
      'only an ARCHIVED session is blocked on us',
      issue('i'),
      [sess('a', { archived: true, agentState: needsUserState })],
      false,
    ],
    ['nothing is pending', issue('i'), [sess('a', { agentState: workingState })], false],
  ]

  it.each(cases)('is %s', (_name, target, sessions, expected) => {
    expect(issueNeedsHuman(target, sessions)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// operationalState
// ---------------------------------------------------------------------------

describe('operationalState', () => {
  type Case = [string, IssueNavigationModel, SessionMeta[], OperationalState]

  const states: Case[] = [
    ['needs-you from a blocked agent', issue('i'), [sess('a', { agentState: needsUserState })], 'needs-you'],
    ['needs-you from a standing offer', issue('i'), [sess('a', { offer })], 'needs-you'],
    ['moved while handing off', issue('i'), [sess('a', { handoffTarget: 'mac-mini' })], 'moved'],
    ['working mid-turn', issue('i'), [sess('a', { agentState: workingState })], 'working'],
    ['done when the stage says so', issue('i', { stage: 'done' }), [], 'done'],
    ['done when closed for another reason', issue('i', { closedReason: 'duplicate' }), [], 'done'],
    ['waiting on a dependency', issue('i', { blocked: true }), [], 'waiting'],
    ['retired once every session is archived', issue('i'), [sess('a', { archived: true })], 'retired'],
    [
      'retired once every session is archived, exited or not',
      issue('i'),
      [sess('a', { archived: true, status: 'exited' }), sess('b', { archived: true })],
      'retired',
    ],
    ['ready with no sessions and a green light', issue('i', { ready: true }), [], 'ready'],
    ['ready with no sessions at all', issue('i'), [], 'ready'],
    ['idle when an agent is attached but quiet', issue('i'), [sess('a', { agentState: finishedState })], 'idle'],
    [
      'needs-you when a fatal error leaves the agent parked on us',
      issue('i'),
      [sess('a', { agentState: erroredState(false) })],
      'needs-you',
    ],
  ]

  it.each(states)('is %s', (_name, target, sessions, expected) => {
    expect(operationalState(target, sessions).state).toBe(expected)
  })

  // The order these are checked in is the product decision: an ask of the human
  // outranks a machine move, which outranks work in flight, which outranks a
  // stage the issue has not caught up with.
  const precedence: Case[] = [
    [
      'needs-you beats moved',
      issue('i', { needsHuman: true }),
      [sess('a', { handoffTarget: 'mac-mini' })],
      'needs-you',
    ],
    [
      'moved beats working',
      issue('i'),
      [sess('a', { handoffTarget: 'mac-mini', agentState: workingState })],
      'moved',
    ],
    ['working beats a done stage', issue('i', { stage: 'done' }), [sess('a', { agentState: workingState })], 'working'],
    ['done beats blocked', issue('i', { stage: 'done', blocked: true }), [], 'done'],
    ['blocked beats retired', issue('i', { blocked: true }), [sess('a', { archived: true })], 'waiting'],
    ['retired beats ready', issue('i', { ready: true }), [sess('a', { archived: true })], 'retired'],
  ]

  it.each(precedence)('%s', (_name, target, sessions, expected) => {
    expect(operationalState(target, sessions).state).toBe(expected)
  })

  describe('the blocked label names its blocker when an issue index is supplied', () => {
    // An OUTGOING `blocks` dep means "this issue is blocked BY the target".
    // `issueDisplayRef` reads `displayRef` and falls back to `#seq` — `prefix`
    // is not what it consults, so the ref has to be spelled out here.
    const blocker = (id: string, seq: number, over: Partial<UnbrandIds<IssueNavigationModel>> = {}) =>
      issue(id, { seq, displayRef: `POD-${seq}`, ...over })
    const blockedBy = (...targets: string[]) =>
      issue('i', { blocked: true, deps: targets.map((id) => ({ id, type: 'blocks' })) })
    const index = (...issues: IssueNavigationModel[]) =>
      new Map(issues.map((entry) => [entry.id, entry]))

    const cases: Array<[string, IssueNavigationModel, ReadonlyMap<string, IssueNavigationModel> | undefined, string]> = [
      [
        'names a single open blocker',
        blockedBy('dep'),
        index(blocker('dep', 42)),
        'Blocked by POD-42',
      ],
      [
        'counts two or more open blockers',
        blockedBy('dep', 'dep2'),
        index(blocker('dep', 42), blocker('dep2', 43)),
        'Blocked by 2 tasks',
      ],
      [
        'names only the blockers that are still open',
        blockedBy('dep', 'dep2'),
        index(blocker('dep', 42, { stage: 'done' }), blocker('dep2', 43)),
        'Blocked by POD-43',
      ],
      [
        'falls back when the blocker finished by stage',
        blockedBy('dep'),
        index(blocker('dep', 42, { stage: 'done' })),
        'Waiting on dependency',
      ],
      [
        'falls back when the blocker was closed for another reason',
        blockedBy('dep'),
        index(blocker('dep', 42, { closedReason: 'duplicate' })),
        'Waiting on dependency',
      ],
      [
        'falls back when the blocker is not in the index at all',
        blockedBy('evicted'),
        index(blocker('dep', 42)),
        'Waiting on dependency',
      ],
      [
        'falls back when no index is supplied',
        blockedBy('dep'),
        undefined,
        'Waiting on dependency',
      ],
      [
        'ignores dep types that are not `blocks`',
        issue('i', { blocked: true, deps: [{ id: 'dep', type: 'discovered-from' }] }),
        index(blocker('dep', 42)),
        'Waiting on dependency',
      ],
    ]

    it.each(cases)('%s', (_name, target, byId, label) => {
      const result = operationalState(target, [], byId)
      expect(result.state).toBe('waiting')
      expect(result.label).toBe(label)
    })

    it('still yields to the states that outrank waiting', () => {
      const byId = index(blocker('dep', 42))
      // A named blocker must not resurrect a finished issue or preempt a live agent.
      expect(operationalState(issue('i', { blocked: true, stage: 'done', deps: [{ id: 'dep', type: 'blocks' }] }), [], byId).state).toBe('done')
      expect(
        operationalState(
          issue('i', { blocked: true, deps: [{ id: 'dep', type: 'blocks' }] }),
          [sess('a', { agentState: workingState })],
          byId,
        ).state,
      ).toBe('working')
    })
  })

  it('retires an issue whose only session has exited, archived or not', () => {
    // "Active" is liveness, not tidiness: an exited process nobody archived yet
    // must not read as an agent standing by on the task.
    expect(operationalState(issue('i'), [sess('a', { status: 'exited' })]).state).toBe('retired')
    expect(operationalState(issue('i'), [sess('a', { status: 'exited' })]).label).toBe('Agent retired')
  })

  it('is not retired while one session outlives the exited ones', () => {
    const sessions = [sess('dead', { status: 'exited' }), sess('live', { agentState: workingState })]
    expect(operationalState(issue('i'), sessions).state).toBe('working')
  })

  it('labels the two needs-you causes differently', () => {
    expect(operationalState(issue('i'), [sess('a', { agentState: needsUserState })]).label).toBe('Needs you')
    expect(operationalState(issue('i'), [sess('a', { agentState: erroredState(false) })]).label).toBe(
      'Waiting on you',
    )
  })
})

// ---------------------------------------------------------------------------
// coordinatorCount
// ---------------------------------------------------------------------------

describe('coordinatorCount', () => {
  const rowsFor = (issues: IssueNavigationModel[], sessions: SessionMeta[]): FlightDeckRow[] =>
    buildFlightDeckRows(issues, sessions, 'root')

  it('counts the designated coordinator of every issue in the mission', () => {
    const issues = [
      issue('root', { coordinatorSessionId: 's-lead' }),
      issue('c1', { parentId: 'root', seq: 1, coordinatorSessionId: 's-c1-lead' }),
      issue('c2', { parentId: 'root', seq: 2 }),
    ]
    const sessions = [
      sess('s-lead', { issueId: 'root' }),
      sess('s-c1-lead', { issueId: 'c1' }),
      sess('s-worker', { issueId: 'c2' }),
    ]
    expect(coordinatorCount(rowsFor(issues, sessions), sessions)).toBe(2)
  })

  it('counts a coordinator once even though every row scans every session', () => {
    const issues = [
      issue('root', { coordinatorSessionId: 's-lead' }),
      issue('c1', { parentId: 'root' }),
    ]
    const sessions = [sess('s-lead', { issueId: 'root' }), sess('s-worker', { issueId: 'c1' })]
    expect(coordinatorCount(rowsFor(issues, sessions), sessions)).toBe(1)
  })

  it('is zero when no issue names a coordinator, or the named one is gone', () => {
    const plain = [issue('root'), issue('c1', { parentId: 'root' })]
    const sessions = [sess('s-worker', { issueId: 'root' })]
    expect(coordinatorCount(rowsFor(plain, sessions), sessions)).toBe(0)

    const dangling = [issue('root', { coordinatorSessionId: 's-evicted' })]
    expect(coordinatorCount(rowsFor(dangling, sessions), sessions)).toBe(0)
  })

  it('ignores coordinators of issues outside the mission', () => {
    const issues = [issue('root'), issue('outside', { coordinatorSessionId: 's-other-lead' })]
    const sessions = [sess('s-root', { issueId: 'root' }), sess('s-other-lead', { issueId: 'outside' })]
    expect(coordinatorCount(rowsFor(issues, sessions), sessions)).toBe(0)
  })

  it('counts one session leading both an epic and its sub-issue as ONE lead', () => {
    const issues = [
      issue('root', { coordinatorSessionId: 's-lead' }),
      issue('c1', { parentId: 'root', coordinatorSessionId: 's-lead' }),
    ]
    const sessions = [sess('s-lead', { issueId: 'root' })]
    expect(coordinatorCount(rowsFor(issues, sessions), sessions)).toBe(1)
  })
})
