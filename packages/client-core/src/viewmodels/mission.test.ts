// POD-516 — the flight deck's pure mission projection.
//
// Everything here is the client-side derivation over an issue slice + a session
// slice: no React, no store. The cases below are the ones the operator workspace
// actually depends on — mission membership (formal parent edges AND agent-started
// provenance, but never a `discovered-from` spin-off), ancestor-preserving mode
// filters, and the per-row operational state that drives the status column.

import {
  ISSUE_STAGES,
  type SessionMeta,
  type SessionMetaInput,
  type UnbrandIds,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  buildFlightDeckRows,
  coordinatorCount,
  deckIssueState,
  type FlightDeckRow,
  issueNeedsHuman,
  issueNote,
  type MissionProgress,
  missionIssueIds,
  missionProgress,
  missionRootFor,
  missionSessions,
  type OperationalState,
  operationalState,
  type PresenceKind,
  portfolioActionableCount,
  presenceNote,
  relationNote,
  sessionNeedsHuman,
  waitingNote,
} from './mission'
import type { IssueNavigationModel } from './slices/issues'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function issue(
  id: string,
  over: Partial<UnbrandIds<IssueNavigationModel>> = {},
): IssueNavigationModel {
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
    expect(
      missionSessions(issues, sessions, 'root')
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(['s-c1', 's-member', 's-root'])
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
    const issues = [
      issue('dead', { archived: true }),
      issue('gone', { deletedAt: '2026-07-01T00:00:00.000Z' }),
    ]
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
    expect(shape(buildFlightDeckRows(issues, sessions, 'root'))).toEqual(['root@0', 'a@1', 'b@2'])
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
    const issues = [
      issue('root'),
      issue('a', { parentId: 'invisible', startedBySession: 's-root' }),
    ]
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
    // …and therefore it cannot move the mission's progress either. (root + c1)
    expect(missionProgress(issues, [sess('s-root', { issueId: 'root' })], 'root').total).toBe(2)
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
  const cases: Array<[string, IssueNavigationModel[], MissionProgress]> = [
    ['no mission at all', [], { total: 0, done: 0, run: 0, block: 0, wait: 0 }],
    [
      'a lone root, which counts as a task like any other',
      [issue('root')],
      { total: 1, done: 0, run: 1, block: 0, wait: 0 },
    ],
    [
      'all four segments at once',
      [
        issue('root', { stage: 'planning' }),
        issue('a', { parentId: 'root', stage: 'done' }),
        issue('b', { parentId: 'root', stage: 'review' }),
        issue('c', { parentId: 'root', blocked: true }),
        issue('d', { parentId: 'root', stage: 'backlog' }),
      ],
      { total: 5, done: 1, run: 1, block: 1, wait: 2 },
    ],
    [
      'a child closed for another reason than stage=done',
      [
        issue('root', { stage: 'backlog' }),
        issue('a', { parentId: 'root', closedReason: 'duplicate' }),
      ],
      { total: 2, done: 1, run: 0, block: 0, wait: 1 },
    ],
    [
      'blocked in-progress work, counted once and as blocked',
      [issue('root', { stage: 'backlog' }), issue('a', { parentId: 'root', blocked: true })],
      { total: 2, done: 0, run: 0, block: 1, wait: 1 },
    ],
    [
      'done work that is also flagged blocked, counted once as done',
      [
        issue('root', { stage: 'backlog' }),
        issue('a', { parentId: 'root', stage: 'done', blocked: true }),
      ],
      { total: 2, done: 1, run: 0, block: 0, wait: 1 },
    ],
  ]

  it.each(cases)('reports %s', (_name, issues, expected) => {
    expect(missionProgress(issues, [], issues[0]?.id ?? null)).toEqual(expected)
  })

  it('the segments always sum to the total, so the bar can never overflow', () => {
    const issues = [
      issue('root', { stage: 'review' }),
      issue('a', { parentId: 'root', stage: 'done', blocked: true }),
      issue('b', { parentId: 'root', stage: 'in_progress', blocked: true }),
      issue('c', { parentId: 'root', stage: 'planning' }),
    ]
    const p = missionProgress(issues, [], 'root')
    expect(p.done + p.run + p.block + p.wait).toBe(p.total)
  })

  // THE bug this signature exists to fix: the filter is a display preference,
  // and the mission's shape is not. Computed from the rendered rows, `Active`
  // (which hides finished work) reported 0 done for a half-finished mission.
  it('is identical in every mode, because it never reads the filtered spine', () => {
    const issues = [
      issue('root'),
      issue('a', { parentId: 'root', seq: 1, stage: 'done' }),
      issue('b', { parentId: 'root', seq: 2, stage: 'done' }),
      issue('c', { parentId: 'root', seq: 3 }),
    ]
    const expected = { total: 4, done: 2, run: 2, block: 0, wait: 0 }
    for (const mode of ['full', 'active', 'needs-you'] as const) {
      // The spine really does shrink in the filtered modes…
      const rows = buildFlightDeckRows(issues, [], 'root', mode)
      expect(rows.length).toBeLessThanOrEqual(4)
      // …and the mission's progress really does not move with it.
      expect(missionProgress(issues, [], 'root')).toEqual(expected)
    }
    expect(shape(buildFlightDeckRows(issues, [], 'root', 'active'))).toEqual(['root@0', 'c@1'])
  })

  it('never divides by zero when the mission is only its root', () => {
    expect(missionProgress([issue('root', { stage: 'done' })], [], 'root')).toEqual({
      total: 1,
      done: 1,
      run: 0,
      block: 0,
      wait: 0,
    })
  })

  it('is empty rather than throwing when there is no mission root', () => {
    expect(missionProgress([issue('root')], [], null)).toEqual({
      total: 0,
      done: 0,
      run: 0,
      block: 0,
      wait: 0,
    })
  })

  it('ignores archived and deleted work', () => {
    const issues = [
      issue('root', { stage: 'backlog' }),
      issue('a', { parentId: 'root', archived: true }),
    ]
    expect(missionProgress(issues, [], 'root').total).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// workingAgentCount — what may drive the spinner
// ---------------------------------------------------------------------------

describe('workingAgentCount', () => {
  // The braille spinner is the app's only perpetual motion and may render ONLY
  // while an agent computes. Driving it off liveAgentCount would leave it
  // turning over a mission where every agent is idle or waiting on the human.
  it('counts only sessions actually computing, not every session present', () => {
    const issues = [issue('root'), issue('a', { parentId: 'root' })]
    const sessions = [
      sess('s-working', { issueId: 'a', agentState: workingState }),
      sess('s-idle', { issueId: 'a', agentState: finishedState }),
      sess('s-asking', { issueId: 'a', agentState: needsUserState }),
    ]
    const root = rowFor(buildFlightDeckRows(issues, sessions, 'root'), 'root')
    expect(root.liveAgentCount).toBe(3)
    expect(root.workingAgentCount).toBe(1)
  })

  it('never counts a retired session, however its last state read', () => {
    const issues = [issue('root')]
    const sessions = [
      sess('s-gone', { issueId: 'root', status: 'exited', agentState: workingState }),
      sess('s-away', { issueId: 'root', archived: true, agentState: workingState }),
    ]
    const root = rowFor(buildFlightDeckRows(issues, sessions, 'root'), 'root')
    expect(root.liveAgentCount).toBe(0)
    expect(root.workingAgentCount).toBe(0)
  })

  it('is zero, not absent, on a mission with no agents at all', () => {
    const root = rowFor(buildFlightDeckRows([issue('root')], [], 'root'), 'root')
    expect(root.workingAgentCount).toBe(0)
  })

  it('rolls the whole subtree up to the root row', () => {
    const issues = [
      issue('root'),
      issue('c1', { parentId: 'root', seq: 1 }),
      issue('g1', { parentId: 'c1', seq: 1 }),
    ]
    const sessions = [
      sess('s1', { issueId: 'c1', agentState: workingState }),
      sess('s2', { issueId: 'g1', agentState: workingState }),
    ]
    expect(rowFor(buildFlightDeckRows(issues, sessions, 'root'), 'root').workingAgentCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// collapsedSummary — what a fold says it is hiding
// ---------------------------------------------------------------------------

describe('collapsedSummary', () => {
  it('counts the descendants a fold hides, not the row itself', () => {
    const issues = [
      issue('root'),
      issue('a', { parentId: 'root', seq: 1, stage: 'done' }),
      issue('b', { parentId: 'root', seq: 2, stage: 'in_progress' }),
      issue('c', { parentId: 'root', seq: 3, stage: 'backlog' }),
    ]
    // `root` itself defaults to in_progress and needs nobody, so the attention
    // flag below is genuinely reporting the subtree.
    const rows = buildFlightDeckRows(issues, [], 'root')
    expect(rowFor(rows, 'root').collapsedSummary).toEqual({
      tasks: 3,
      done: 1,
      run: 1,
      kinds: [],
      needsYou: false,
    })
    // A leaf hides nothing.
    expect(rowFor(rows, 'a').collapsedSummary.tasks).toBe(0)
  })

  it('carries up to two distinct harness kinds from the live sessions it hides', () => {
    const issues = [
      issue('root'),
      issue('a', { parentId: 'root' }),
      issue('b', { parentId: 'root' }),
    ]
    const sessions = [
      sess('s1', { issueId: 'a', agentKind: 'claude-code' }),
      sess('s2', { issueId: 'a', agentKind: 'codex' }),
      sess('s3', { issueId: 'b', agentKind: 'cursor' }),
      // Retired agents are not part of what is running behind the fold.
      sess('s4', { issueId: 'b', agentKind: 'grok', status: 'exited' }),
    ]
    const kinds = rowFor(buildFlightDeckRows(issues, sessions, 'root'), 'root').collapsedSummary
      .kinds
    expect(kinds).toHaveLength(2)
    expect(kinds).not.toContain('grok')
  })

  // Folding replaces the row's own state mark with this payload, so the
  // attention flag has to cover the row itself or a needs-you task disappears
  // the moment you fold it.
  it('flags attention on the row itself, not only on what it hides', () => {
    const issues = [issue('root', { needsHuman: true }), issue('a', { parentId: 'root' })]
    expect(rowFor(buildFlightDeckRows(issues, [], 'root'), 'root').collapsedSummary.needsYou).toBe(
      true,
    )
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
    [
      'a live session is blocked on us',
      issue('i'),
      [sess('a', { agentState: needsUserState })],
      true,
    ],
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
    [
      'needs-you from a blocked agent',
      issue('i'),
      [sess('a', { agentState: needsUserState })],
      'needs-you',
    ],
    ['needs-you from a standing offer', issue('i'), [sess('a', { offer })], 'needs-you'],
    ['moved while handing off', issue('i'), [sess('a', { handoffTarget: 'mac-mini' })], 'moved'],
    ['working mid-turn', issue('i'), [sess('a', { agentState: workingState })], 'working'],
    ['done when the stage says so', issue('i', { stage: 'done' }), [], 'done'],
    ['done when closed for another reason', issue('i', { closedReason: 'duplicate' }), [], 'done'],
    ['waiting on a dependency', issue('i', { blocked: true }), [], 'waiting'],
    [
      'retired once every session is archived',
      issue('i'),
      [sess('a', { archived: true })],
      'retired',
    ],
    [
      'retired once every session is archived, exited or not',
      issue('i'),
      [sess('a', { archived: true, status: 'exited' }), sess('b', { archived: true })],
      'retired',
    ],
    ['ready with no sessions and a green light', issue('i', { ready: true }), [], 'ready'],
    ['ready with no sessions at all', issue('i'), [], 'ready'],
    [
      'idle when an agent is attached but quiet',
      issue('i'),
      [sess('a', { agentState: finishedState })],
      'idle',
    ],
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
    [
      'working beats a done stage',
      issue('i', { stage: 'done' }),
      [sess('a', { agentState: workingState })],
      'working',
    ],
    ['done beats blocked', issue('i', { stage: 'done', blocked: true }), [], 'done'],
    [
      'blocked beats retired',
      issue('i', { blocked: true }),
      [sess('a', { archived: true })],
      'waiting',
    ],
    [
      'retired beats ready',
      issue('i', { ready: true }),
      [sess('a', { archived: true })],
      'retired',
    ],
  ]

  it.each(precedence)('%s', (_name, target, sessions, expected) => {
    expect(operationalState(target, sessions).state).toBe(expected)
  })

  describe('the blocked label names its blocker when an issue index is supplied', () => {
    // An OUTGOING `blocks` dep means "this issue is blocked BY the target".
    // `issueDisplayRef` reads `displayRef` and falls back to `#seq` — `prefix`
    // is not what it consults, so the ref has to be spelled out here.
    const blocker = (
      id: string,
      seq: number,
      over: Partial<UnbrandIds<IssueNavigationModel>> = {},
    ) => issue(id, { seq, displayRef: `POD-${seq}`, ...over })
    const blockedBy = (...targets: string[]) =>
      issue('i', { blocked: true, deps: targets.map((id) => ({ id, type: 'blocks' })) })
    const index = (...issues: IssueNavigationModel[]) =>
      new Map(issues.map((entry) => [entry.id, entry]))

    const cases: Array<
      [string, IssueNavigationModel, ReadonlyMap<string, IssueNavigationModel> | undefined, string]
    > = [
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
      expect(
        operationalState(
          issue('i', { blocked: true, stage: 'done', deps: [{ id: 'dep', type: 'blocks' }] }),
          [],
          byId,
        ).state,
      ).toBe('done')
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
    expect(operationalState(issue('i'), [sess('a', { status: 'exited' })]).label).toBe(
      'Agent retired',
    )
  })

  it('is not retired while one session outlives the exited ones', () => {
    const sessions = [
      sess('dead', { status: 'exited' }),
      sess('live', { agentState: workingState }),
    ]
    expect(operationalState(issue('i'), sessions).state).toBe('working')
  })

  it('labels the two needs-you causes differently', () => {
    expect(operationalState(issue('i'), [sess('a', { agentState: needsUserState })]).label).toBe(
      'Needs you',
    )
    expect(
      operationalState(issue('i'), [sess('a', { agentState: erroredState(false) })]).label,
    ).toBe('Waiting on you')
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
    const sessions = [
      sess('s-root', { issueId: 'root' }),
      sess('s-other-lead', { issueId: 'outside' }),
    ]
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

// ---------------------------------------------------------------------------
// Presence — what a row says when there is no agent on it
// ---------------------------------------------------------------------------

describe('presenceNote', () => {
  const index = (issues: IssueNavigationModel[]): Map<string, IssueNavigationModel> =>
    new Map(issues.map((i) => [i.id, i]))

  // The artifact's table, verbatim. A blank where an agent row would be is the
  // one thing the deck must never render: "no session" is several situations
  // and only one of them is a problem.
  const table: Array<[string, IssueNavigationModel, SessionMeta[], PresenceKind, string]> = [
    [
      'a session that handed the work on',
      issue('a', { stage: 'in_progress' }),
      [sess('s', { issueId: 'a', status: 'exited', handoffTarget: 'POD-612' })],
      'moved',
      'Session moved to POD-612',
    ],
    ['blocked work', issue('a', { blocked: true }), [], 'blocked', 'Waiting on dependency'],
    ['finished work', issue('a', { stage: 'done' }), [], 'done', 'Completed · session retired'],
    [
      'work closed for another reason',
      issue('a', { closedReason: 'duplicate' }),
      [],
      'done',
      'Completed · session retired',
    ],
    [
      'work in review',
      issue('a', { stage: 'review' }),
      [],
      'review',
      'Review ready · session ended',
    ],
    ['planned work', issue('a', { stage: 'planning' }), [], 'ready', 'Ready to start'],
    ['backlogged work', issue('a', { stage: 'backlog' }), [], 'ready', 'Ready to start'],
    [
      'in-progress work whose agent left without a handoff',
      issue('a', { stage: 'in_progress' }),
      [],
      'attention',
      'Agent left · choose a handoff',
    ],
  ]

  it.each(table)('on %s', (_name, subject, sessions, kind, text) => {
    expect(presenceNote(subject, sessions)).toEqual({
      kind,
      text,
      // ONLY vacated in-progress work is amber. Done, review, ready and blocked
      // are all states the operator can read and then leave alone.
      attention: kind === 'attention',
    })
  })

  it('names the blocker when an issue index is available', () => {
    const blocker = issue('dep', { seq: 42 })
    const subject = issue('a', { blocked: true, deps: [{ id: 'dep', type: 'blocks' }] })
    expect(presenceNote(subject, [], index([blocker, subject]))?.text).toMatch(/^Blocked by /)
  })

  // Total over the stage vocabulary: an unhandled stage used to fall through to
  // null, which pushed the fallback line into every caller and let two columns
  // describe one task differently.
  it('has words for every stage in the model', () => {
    for (const stage of ISSUE_STAGES) {
      const note = presenceNote(issue('a', { stage }), [])
      expect(note, `no presence note for stage ${stage}`).not.toBeNull()
      expect(note?.text.length).toBeGreaterThan(0)
    }
  })

  it('does not call a proposed task ready — nobody has accepted it yet', () => {
    expect(presenceNote(issue('a', { stage: 'proposed' }), [])?.text).toBe('Proposed · not started')
  })

  it('says nothing at all while a live agent is on the task', () => {
    const subject = issue('a', { stage: 'in_progress' })
    expect(presenceNote(subject, [sess('s', { issueId: 'a' })])).toBeNull()
  })

  it('still explains a task whose only sessions are retired', () => {
    const subject = issue('a', { stage: 'in_progress' })
    expect(presenceNote(subject, [sess('s', { issueId: 'a', status: 'exited' })])?.kind).toBe(
      'attention',
    )
  })
})

describe('waitingNote', () => {
  const index = (issues: IssueNavigationModel[]): Map<string, IssueNavigationModel> =>
    new Map(issues.map((i) => [i.id, i]))

  it('names the unfinished task this one is waiting for', () => {
    const dep = issue('dep')
    const subject = issue('a', { deps: [{ id: 'dep', type: 'blocks' }] })
    expect(waitingNote(subject, index([dep, subject]))).toMatch(/^Waiting for .+ to complete$/)
  })

  it('counts them once there is more than one', () => {
    const deps = [issue('d1'), issue('d2')]
    const subject = issue('a', {
      deps: [
        { id: 'd1', type: 'blocks' },
        { id: 'd2', type: 'blocks' },
      ],
    })
    expect(waitingNote(subject, index([...deps, subject]))).toBe('Waiting for 2 tasks to complete')
  })

  it('goes quiet once the dependency lands', () => {
    const dep = issue('dep', { stage: 'done' })
    const subject = issue('a', { deps: [{ id: 'dep', type: 'blocks' }] })
    expect(waitingNote(subject, index([dep, subject]))).toBeNull()
  })

  // The band the artifact shows ALONGSIDE live agent rows: an agent can be
  // working flat out on something that still cannot land.
  it('is independent of whether anyone is working the task', () => {
    const dep = issue('dep')
    const subject = issue('a', { deps: [{ id: 'dep', type: 'blocks' }] })
    const withIndex = index([dep, subject])
    expect(waitingNote(subject, withIndex)).not.toBeNull()
    expect(presenceNote(subject, [sess('s', { issueId: 'a' })], withIndex)).toBeNull()
  })
})

describe('relationNote', () => {
  const index = (issues: IssueNavigationModel[]): Map<string, IssueNavigationModel> =>
    new Map(issues.map((i) => [i.id, i]))

  it('says where a spun-off task came from', () => {
    const origin = issue('origin')
    const subject = issue('a', { deps: [{ id: 'origin', type: 'discovered-from' }] })
    expect(relationNote(subject, index([origin, subject]))).toMatch(/^Discovered from /)
  })

  // `blocks` is the blocked/waiting band's job; saying it here too would read
  // as two separate dependencies.
  it('never repeats a blocking edge', () => {
    const dep = issue('dep')
    const subject = issue('a', { deps: [{ id: 'dep', type: 'blocks' }] })
    expect(relationNote(subject, index([dep, subject]))).toBeNull()
  })

  it('says nothing about an edge whose target this replica cannot see', () => {
    const subject = issue('a', { deps: [{ id: 'invisible', type: 'related' }] })
    expect(relationNote(subject, index([subject]))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// issueNote — the ONE fact about the issue that rides on its own strip
// (POD-516 round 3 §5). Presence deliberately stays out of it.
// ---------------------------------------------------------------------------

describe('issueNote', () => {
  const index = (issues: IssueNavigationModel[]): Map<string, IssueNavigationModel> =>
    new Map(issues.map((i) => [i.id, i]))
  // Distinct seqs so each ref prints differently — the strip's whole point is
  // that the operator can read WHICH task is holding this one.
  const dep = issue('dep', { seq: 7 })
  const other = issue('other', { seq: 8 })
  const origin = issue('origin', { seq: 9 })

  // Only one of these can be the reason a task is not moving, so the strip
  // prints the strongest and the rest stay in the inspector.
  const cases: Array<{
    name: string
    subject: IssueNavigationModel
    kind: string
    short: string
    full: RegExp
  }> = [
    {
      name: 'a server-declared block names its blocker',
      subject: issue('a', { blocked: true, deps: [{ id: 'dep', type: 'blocks' }] }),
      kind: 'blocked',
      short: '#7',
      full: /^Blocked by #7$/,
    },
    {
      name: 'several blockers collapse to a count',
      subject: issue('a', {
        blocked: true,
        deps: [
          { id: 'dep', type: 'blocks' },
          { id: 'other', type: 'blocks' },
        ],
      }),
      kind: 'blocked',
      short: '2 tasks',
      full: /^Blocked by 2 tasks$/,
    },
    {
      name: 'a blocked issue with no resolvable edge falls back to its prose',
      subject: issue('a', { blocked: true, blockedByNotes: ['Awaiting an API key'] }),
      kind: 'blocked',
      short: 'Awaiting an API key',
      full: /^Awaiting an API key$/,
    },
    {
      name: 'an unfinished dependency without a block is a wait',
      subject: issue('a', { deps: [{ id: 'dep', type: 'blocks' }] }),
      kind: 'waiting',
      short: '#7',
      full: /^Waiting for #7 to complete$/,
    },
    {
      name: 'provenance is the weakest note and still names its origin',
      subject: issue('a', { deps: [{ id: 'origin', type: 'discovered-from' }] }),
      kind: 'relation',
      short: '#9',
      full: /^Discovered from #9$/,
    },
  ]

  for (const { name, subject, kind, short, full } of cases) {
    it(name, () => {
      const note = issueNote(subject, index([dep, other, origin, subject]))
      expect(note?.kind).toBe(kind)
      expect(note?.short).toBe(short)
      expect(note?.full).toMatch(full)
    })
  }

  it('outranks provenance with the dependency the operator can act on', () => {
    const subject = issue('a', {
      blocked: true,
      deps: [
        { id: 'dep', type: 'blocks' },
        { id: 'origin', type: 'discovered-from' },
      ],
    })
    expect(issueNote(subject, index([dep, origin, subject]))?.kind).toBe('blocked')
  })

  it('goes quiet once the dependency lands', () => {
    const done = issue('dep', { stage: 'done' })
    const subject = issue('a', { deps: [{ id: 'dep', type: 'blocks' }] })
    expect(issueNote(subject, index([done, subject]))).toBeNull()
  })

  it('is null on a plain task, so the strip stays one line', () => {
    expect(issueNote(issue('a'), index([issue('a')]))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// deckIssueState — the word on the right of a strip
// ---------------------------------------------------------------------------

describe('deckIssueState', () => {
  // `Next` promised an order the deck could not keep (round 3 §7a): a proposal
  // is not scheduled, and neither is anything else with nobody on it.
  it('calls a proposal a proposal, not the next thing', () => {
    const state = deckIssueState(issue('a', { stage: 'proposed' }), [])
    expect(state.state).toBe('proposed')
    expect(state.label).toBe('Proposed')
  })

  it('claims no order for other unstaffed work', () => {
    expect(deckIssueState(issue('a', { stage: 'backlog' }), []).label).toBe('Not started')
  })

  it('still reads as running when an agent picks a proposal up', () => {
    const live = sess('s', { issueId: 'a', agentState: workingState })
    expect(deckIssueState(issue('a', { stage: 'proposed' }), [live]).state).toBe('working')
  })
})

// ---------------------------------------------------------------------------
// portfolioActionableCount — the Superagent rail badge
// ---------------------------------------------------------------------------

describe('portfolioActionableCount', () => {
  it('counts across every mission, not one', () => {
    const issues = [
      issue('m1', { needsHuman: true }),
      issue('m1-child', { parentId: 'm1' }),
      issue('m2', { stage: 'review' }),
      issue('m3'),
    ]
    expect(portfolioActionableCount(issues, [])).toBe(2)
  })

  it('counts a task whose SESSION is the one asking', () => {
    const issues = [issue('a')]
    expect(
      portfolioActionableCount(issues, [sess('s', { issueId: 'a', agentState: needsUserState })]),
    ).toBe(1)
  })

  it('reaches a session attached as a member rather than by issueId', () => {
    const issues = [issue('a', { memberSessionIds: ['s'] })]
    expect(portfolioActionableCount(issues, [sess('s', { agentState: needsUserState })])).toBe(1)
  })

  it('ignores finished, archived and deleted work', () => {
    const issues = [
      issue('done', { stage: 'done', needsHuman: true }),
      issue('closed', { closedReason: 'duplicate', needsHuman: true }),
      issue('archived', { archived: true, needsHuman: true }),
      issue('deleted', { deletedAt: '2026-07-01T00:00:00.000Z', needsHuman: true }),
    ]
    expect(portfolioActionableCount(issues, [])).toBe(0)
  })

  it('ignores an archived session that was mid-question when it was put away', () => {
    const issues = [issue('a')]
    expect(
      portfolioActionableCount(issues, [
        sess('s', { issueId: 'a', archived: true, agentState: needsUserState }),
      ]),
    ).toBe(0)
  })
})
