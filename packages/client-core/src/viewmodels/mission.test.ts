// POD-516 — the flight deck's pure mission projection.
//
// Everything here is the client-side derivation over an issue slice + a session
// slice: no React, no store. The cases below are the ones the operator workspace
// actually depends on — mission membership (formal parent edges AND agent-started
// provenance, but never a `discovered-from` spin-off), ancestor-preserving mode
// filters, and the per-row operational state that drives the status column.

import {
  asIssueId,
  ISSUE_STAGES,
  type SessionMeta,
  type SessionMetaInput,
  type UnbrandIds,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  buildFlightDeckRows,
  coordinatorCount,
  deckDestinationFor,
  deckIssueState,
  deckSessions,
  deckViewEmptyLine,
  type FlightDeckRow,
  issueContinuation,
  issueNeedsHuman,
  issueNote,
  isVacatedOrigin,
  liveSpinOffTip,
  type MissionProgress,
  missionCrewLabel,
  missionDepartures,
  missionIndexStats,
  missionIssueIds,
  missionProgress,
  missionRollup,
  missionRootFor,
  missionSessions,
  type OperationalState,
  operationalState,
  type PresenceKind,
  portfolioActionableCount,
  presenceNote,
  relationNote,
  reuseFlightDeckRows,
  selectedMissionRoot,
  sessionAsksOnIssue,
  sessionNeedsHuman,
  waitingNote,
} from './mission'
import { type IssueNavigationModel, issuePendingDecision } from './slices/issues'

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
// `network_error` is a class the harnesses really emit — the phrase table is an
// allowlist, so a made-up class here would silently test the fallback instead.
const erroredState = (retryable: boolean): AgentState => ({
  phase: 'errored',
  since: SINCE,
  nativeSubagentCount: 0,
  error: { class: 'network_error', retryable },
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
    expect(missionRootFor(issues, asIssueId('g2'))?.id).toBe('root')
    expect(missionRootFor(issues, asIssueId('c1'))?.id).toBe('root')
  })

  it('returns the issue itself when it is already top-level', () => {
    const { issues } = mission()
    expect(missionRootFor(issues, asIssueId('root'))?.id).toBe('root')
  })

  it.each<[string, string | null]>([
    ['no selection', null],
    ['an id the replica has not seen', 'ghost'],
  ])('is undefined for %s', (_name, selected) => {
    expect(
      missionRootFor(mission().issues, selected === null ? null : asIssueId(selected)),
    ).toBeUndefined()
  })

  it('stops below an archived or deleted parent rather than surfacing it', () => {
    const issues = [
      issue('dead', { archived: true }),
      issue('gone', { deletedAt: '2026-07-01T00:00:00.000Z' }),
      issue('a', { parentId: 'dead' }),
      issue('b', { parentId: 'gone' }),
    ]
    expect(missionRootFor(issues, asIssueId('a'))?.id).toBe('a')
    expect(missionRootFor(issues, asIssueId('b'))?.id).toBe('b')
  })

  it('terminates on a parentId cycle instead of hanging', () => {
    // a → b → c → a. A naive walk spins forever; this must return a member.
    const issues = [
      issue('a', { parentId: 'c' }),
      issue('b', { parentId: 'a' }),
      issue('c', { parentId: 'b' }),
    ]
    expect(['a', 'b', 'c']).toContain(missionRootFor(issues, asIssueId('a'))?.id)
  })
})

// ---------------------------------------------------------------------------
// selectedMissionRoot
// ---------------------------------------------------------------------------

describe('selectedMissionRoot', () => {
  const vessel = issue('vessel', { draft: true, title: 'Draft', stage: 'backlog' })

  it('resolves an ordinary selection exactly as missionRootFor does', () => {
    const { issues, sessions } = mission()
    expect(selectedMissionRoot(issues, sessions, asIssueId('g2'))?.id).toBe('root')
  })

  it('is undefined for an empty draft vessel — the cold deck (POD-1112)', () => {
    expect(selectedMissionRoot([vessel], [], asIssueId('vessel'))).toBeUndefined()
  })

  it('is undefined for a vessel whose only session was archived', () => {
    const sessions = [sess('s-dead', { issueId: 'vessel', archived: true })]
    expect(selectedMissionRoot([vessel], sessions, asIssueId('vessel'))).toBeUndefined()
  })

  it('keeps a draft that is FILLING — the live composer still has a deck', () => {
    const sessions = [sess('s-new', { issueId: 'vessel' })]
    expect(selectedMissionRoot([vessel], sessions, asIssueId('vessel'))?.id).toBe('vessel')
  })

  it('keeps a draft that grew a worktree of its own', () => {
    const real = issue('vessel', { draft: true, worktreePath: '/r/acme/.worktrees/v' })
    expect(selectedMissionRoot([real], [], asIssueId('vessel'))?.id).toBe('vessel')
  })

  it('is undefined for an archived selection — nothing is on screen (POD-1153)', () => {
    const gone = issue('gone', { archived: true })
    expect(selectedMissionRoot([gone], [], asIssueId('gone'))).toBeUndefined()
  })

  it('is undefined for a deleted selection', () => {
    const gone = issue('gone', { deletedAt: '2026-08-17T00:00:00.000Z' })
    expect(selectedMissionRoot([gone], [], asIssueId('gone'))).toBeUndefined()
  })

  it('still resolves an archived SUB-task to its live mission', () => {
    const root = issue('root')
    const child = issue('child', { parentId: 'root', archived: true })
    expect(selectedMissionRoot([root, child], [], asIssueId('child'))?.id).toBe('root')
  })
})

// ---------------------------------------------------------------------------
// deckDestinationFor
// ---------------------------------------------------------------------------

describe('deckDestinationFor', () => {
  it('answers the top-level ancestor a sub-task hangs from', () => {
    // The whole point: the sidebar selects MISSIONS, so showing a grandchild
    // means selecting the root and focusing the child inside it.
    const { issues, sessions } = mission()
    expect(deckDestinationFor(issues, sessions, asIssueId('g2'))?.id).toBe('root')
  })

  it('answers a top-level task with itself', () => {
    const { issues, sessions } = mission()
    expect(deckDestinationFor(issues, sessions, asIssueId('root'))?.id).toBe('root')
  })

  it.each<[string, string | null]>([
    ['nothing named', null],
    ['an id the replica has not seen', 'ghost'],
  ])('is undefined for %s', (_name, target) => {
    const { issues, sessions } = mission()
    expect(
      deckDestinationFor(issues, sessions, target === null ? null : asIssueId(target)),
    ).toBeUndefined()
  })

  it('is undefined for an archived or deleted target — the deck lists neither', () => {
    // `missionRootFor` checks ANCESTORS, so a retired top-level task would
    // otherwise resolve happily to itself and offer a jump to a row that is not
    // there. This is the target's own reachability (POD-1151).
    const issues = [
      issue('dead', { archived: true }),
      issue('gone', { deletedAt: '2026-07-01T00:00:00.000Z' }),
    ]
    expect(deckDestinationFor(issues, [], asIssueId('dead'))).toBeUndefined()
    expect(deckDestinationFor(issues, [], asIssueId('gone'))).toBeUndefined()
  })

  it('is undefined when the mission is an empty draft vessel', () => {
    // Same cold case `selectedMissionRoot` answers: the deck renders its empty
    // state, so there is nothing for the jump to arrive at.
    const vessel = issue('vessel', { draft: true, title: 'Draft', stage: 'backlog' })
    expect(deckDestinationFor([vessel], [], asIssueId('vessel'))).toBeUndefined()
  })

  it('keeps a live child whose retired parent broke the walk', () => {
    // `missionRootFor` stops below an archived parent, and the child is exactly
    // what the sidebar promotes to a row of its own in that case.
    const issues = [issue('dead', { archived: true }), issue('a', { parentId: 'dead' })]
    expect(deckDestinationFor(issues, [], asIssueId('a'))?.id).toBe('a')
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

  /**
   * The case above passes for the wrong reason on real data: `issues.create`
   * stamps `startedBySession` on EVERY agent create, so the started-by fallback
   * dragged every spin-off straight back onto the origin's spine — where it was
   * counted in the mission's progress and could never be released (POD-679).
   */
  it('a STARTED spin-off leaves, even though a mission session filed it', () => {
    const issues = [
      issue('root'),
      issue('c1', { parentId: 'root' }),
      issue('spin', {
        startedBySession: 's-c1',
        stage: 'in_progress',
        deps: [{ id: 'c1', type: 'discovered-from' }],
      }),
    ]
    const sessions = [sess('s-c1', { issueId: 'c1' })]
    expect([...missionIssueIds(issues, 'root', sessions)].sort()).toEqual(['c1', 'root'])
  })

  it('keeps a spin-off that is still PROPOSED — the deck is where it gets triaged', () => {
    const issues = [
      issue('root'),
      issue('c1', { parentId: 'root' }),
      issue('spin', {
        startedBySession: 's-c1',
        stage: 'proposed',
        deps: [{ id: 'c1', type: 'discovered-from' }],
      }),
    ]
    const sessions = [sess('s-c1', { issueId: 'c1' })]
    expect([...missionIssueIds(issues, 'root', sessions)].sort()).toEqual(['c1', 'root', 'spin'])
  })

  it('keeps an approved-but-unstarted spin-off — nothing has gone anywhere yet', () => {
    const issues = [
      issue('root'),
      issue('c1', { parentId: 'root' }),
      issue('spin', {
        startedBySession: 's-c1',
        stage: 'backlog',
        deps: [{ id: 'c1', type: 'discovered-from' }],
      }),
    ]
    const sessions = [sess('s-c1', { issueId: 'c1' })]
    expect([...missionIssueIds(issues, 'root', sessions)].sort()).toEqual(['c1', 'root', 'spin'])
  })

  it('a departed spin-off stops counting against the mission it came from', () => {
    const issues = [
      issue('root', { stage: 'done' }),
      issue('c1', { parentId: 'root', stage: 'done' }),
      issue('spin', {
        startedBySession: 's-c1',
        stage: 'in_progress',
        deps: [{ id: 'c1', type: 'discovered-from' }],
      }),
    ]
    const sessions = [sess('s-c1', { issueId: 'c1' })]
    // ONE unit, not two — and the point of the case is which one is missing.
    // Two rules compose here, from two different changes: POD-679 took the
    // departed spin-off out of `missionIssueIds`, and POD-710 stopped counting
    // the mission ROOT beside its own members (a root with one child reported
    // two units and lit two segments for one task). So `root` is the container
    // and `spin` is gone, leaving `c1` — done, and the mission legitimately
    // reads 100%, which is the outcome this test exists to protect.
    expect(missionProgress(issues, sessions, 'root')).toEqual({
      total: 1,
      done: 1,
      run: 0,
      review: 0,
      stall: 0,
      block: 0,
      wait: 0,
    })
  })

  // -------------------------------------------------------------------------
  // The shared index. `missionIssueIds` used to rebuild its `children` map from
  // the whole issue slice on EVERY call, and `knownTabIdsForWorkspace` calls it
  // once per session — 827 sessions x 1,027 issues per inbound feed frame in the
  // profile that prompted this. The map depends on the issue array alone, so it
  // is built once per array identity. These cases pin both halves of that: that
  // it really is once, and that a changed slice really does rebuild.
  // -------------------------------------------------------------------------

  it('builds its index once per issue slice, not once per call', () => {
    const { issues, sessions } = mission()
    // Prime it: the slice may already be indexed from an earlier case.
    missionIssueIds(issues, 'root', sessions)
    const before = missionIndexStats().builds
    for (let i = 0; i < 50; i += 1) missionIssueIds(issues, 'root', sessions)
    // Different roots over the SAME slice share the index too — the map is
    // keyed by parentId and knows nothing about which mission is being walked.
    for (let i = 0; i < 50; i += 1) missionIssueIds(issues, 'c1', sessions)
    expect(missionIndexStats().builds - before).toBe(0)
  })

  it('rebuilds when the slice does, so membership can never go stale', () => {
    const { sessions } = mission()
    const before = [issue('root'), issue('c1', { parentId: 'root' })]
    expect([...missionIssueIds(before, 'root', sessions)].sort()).toEqual(['c1', 'root'])
    // A new array is what the replica publishes for any change (see the
    // identity contract in replica/kernel/facade.ts), and it is the only signal
    // this memo has.
    const after = [...before, issue('c2', { parentId: 'root' })]
    const builds = missionIndexStats().builds
    expect([...missionIssueIds(after, 'root', sessions)].sort()).toEqual(['c1', 'c2', 'root'])
    expect(missionIndexStats().builds - builds).toBe(1)
  })

  it('shares one membership set between every surface asking for the same root', () => {
    const { issues, sessions } = mission()
    missionIssueIds(issues, 'root', sessions)
    const before = missionIndexStats().memberComputes
    const first = missionIssueIds(issues, 'root', sessions)
    for (let i = 0; i < 50; i += 1) {
      // Identical to the reference, not merely equal: `Workspace`, `FlightDeck`,
      // the explorer and `use-unified-work` all ask this in the same publish.
      expect(missionIssueIds(issues, 'root', sessions)).toBe(first)
    }
    expect(missionIndexStats().memberComputes - before).toBe(0)
  })

  it('recomputes membership when EITHER slice is republished', () => {
    const { issues, sessions } = mission()
    missionIssueIds(issues, 'root', sessions)
    const before = missionIndexStats().memberComputes
    // A sessions-only change still moves membership: provenance grafting reads
    // which sessions are in the mission, so the memo may not key on issues alone.
    missionIssueIds(issues, 'root', [...sessions])
    missionIssueIds([...issues], 'root', sessions)
    expect(missionIndexStats().memberComputes - before).toBe(2)
  })

  it('indexes the session slice once, however many issues ask about it', () => {
    const { issues, sessions } = mission()
    missionProgress(issues, sessions, 'root')
    const before = missionIndexStats().sessionBuilds
    for (let i = 0; i < 50; i += 1) {
      missionProgress([...issues], sessions, 'root')
      missionIssueIds([...issues], 'root', sessions)
    }
    // Fifty fresh ISSUE slices, one session slice: the session index is keyed on
    // the session array alone and must not be dragged along by the other.
    expect(missionIndexStats().sessionBuilds - before).toBe(0)
    const after = missionIndexStats().sessionBuilds
    missionProgress(issues, [...sessions], 'root')
    expect(missionIndexStats().sessionBuilds - after).toBe(1)
  })

  it('still claims an ARCHIVED issue through provenance, as it always did', () => {
    // The pre-filtered candidate list must not inherit the parent-child walk's
    // archived/deleted rule: the fallback never had one. `arch` is archived and
    // was started by root's agent, so it is in the mission — and `deep`, which
    // ITS agent started, comes with it.
    const issues = [
      issue('root'),
      issue('arch', { startedBySession: 's-root', archived: true }),
      issue('deep', { startedBySession: 's-arch' }),
    ]
    const sessions = [sess('s-root', { issueId: 'root' }), sess('s-arch', { issueId: 'arch' })]
    expect([...missionIssueIds(issues, 'root', sessions)].sort()).toEqual(['arch', 'deep', 'root'])
  })
})

// ---------------------------------------------------------------------------
// missionDepartures — what the mission discovered and no longer owns
// ---------------------------------------------------------------------------

describe('missionDepartures', () => {
  const departed = (over: Partial<UnbrandIds<IssueNavigationModel>> = {}) =>
    issue('spin', {
      seq: 44,
      startedBySession: 's-c1',
      stage: 'in_progress',
      deps: [{ id: 'c1', type: 'discovered-from' }],
      ...over,
    })
  const base = [issue('root'), issue('c1', { parentId: 'root' })]
  const sessions = [sess('s-c1', { issueId: 'c1' })]

  it('names the work that left, and the task it left from', () => {
    const out = missionDepartures([...base, departed()], sessions, 'root')
    expect(out.map((d) => [d.issue.id, d.originId])).toEqual([['spin', 'c1']])
    // It reports what the work is doing OUT THERE, in the spine's own words.
    expect(out[0]?.state.label).toBe('Not started')
  })

  it('keeps concurrent sibling spin-offs from the same task', () => {
    const first = departed({ id: 'first', seq: 44 })
    const second = departed({ id: 'second', seq: 45 })
    const active = [
      ...sessions,
      sess('s-first', { issueId: 'first' }),
      sess('s-second', { issueId: 'second' }),
    ]

    const out = missionDepartures([...base, first, second], active, 'root')

    expect(out.map((d) => [d.issue.id, d.originId])).toEqual([
      ['first', 'c1'],
      ['second', 'c1'],
    ])
  })

  it('says nothing about a proposal — that one is still on the spine', () => {
    const proposal = departed({ stage: 'proposed' })
    expect(missionDepartures([...base, proposal], sessions, 'root')).toEqual([])
  })

  it('drops a finished departure rather than growing a permanent footer', () => {
    expect(missionDepartures([...base, departed({ stage: 'done' })], sessions, 'root')).toEqual([])
    expect(
      missionDepartures([...base, departed({ closedReason: 'wontfix' })], sessions, 'root'),
    ).toEqual([])
  })

  it('on an empty origin, names the live tip even when the first hop is done', () => {
    const empty = [issue('root'), issue('c1', { parentId: 'root' })]
    const mid = departed({
      id: 'mid',
      seq: 962,
      stage: 'done',
      closedReason: 'done',
      deps: [{ id: 'c1', type: 'discovered-from' }],
    })
    const tip = issue('tip', {
      seq: 963,
      stage: 'in_progress',
      deps: [{ id: 'mid', type: 'discovered-from' }],
    })
    const out = missionDepartures([...empty, mid, tip], [sess('s-tip', { issueId: 'tip' })], 'root')
    expect(out.map((d) => [d.issue.id, d.originId])).toEqual([['tip', 'c1']])
  })

  it('ignores work discovered from some OTHER mission', () => {
    const elsewhere = issue('spin', {
      stage: 'in_progress',
      deps: [{ id: 'stranger', type: 'discovered-from' }],
    })
    expect(missionDepartures([...base, issue('stranger'), elsewhere], sessions, 'root')).toEqual([])
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
  it('reuses unchanged keyed rows when unrelated session activity changes', () => {
    const { issues, sessions } = mission()
    const previous = buildFlightDeckRows(issues, sessions, 'root')
    const next = buildFlightDeckRows(
      issues,
      [...sessions, sess('outside', { issueId: 'outside' })],
      'root',
    )
    const reused = reuseFlightDeckRows(previous, next)
    expect(reused).toEqual(next)
    expect(reused).not.toBe(next)
    expect(reused.map((row, index) => row === previous[index])).toEqual(previous.map(() => true))
  })

  it('keeps a changed row fresh and preserves a reordered result', () => {
    const { issues, sessions } = mission()
    const previous = buildFlightDeckRows(issues, sessions, 'root')
    const changed = buildFlightDeckRows(
      issues.map((candidate) =>
        candidate.id === 'c1' ? { ...candidate, title: 'changed' } : candidate,
      ),
      sessions,
      'root',
    )
    const reordered = [...changed].reverse()
    const reused = reuseFlightDeckRows(previous, reordered)
    expect(reused.map((row) => row.issue.id)).toEqual(reordered.map((row) => row.issue.id))
    expect(reused.find((row) => row.issue.id === 'c1')).toBe(
      changed.find((row) => row.issue.id === 'c1'),
    )
    expect(reused.find((row) => row.issue.id === 'root')).toBe(
      previous.find((row) => row.issue.id === 'root'),
    )
  })

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

  it('lists a task\u2019s agents lead-first, then in the order they started', () => {
    const issues = [issue('root', { coordinatorSessionId: 'lead' })]
    // Deliberately handed over newest-first, and with the lead last: neither the
    // input order nor the id order may decide what the deck shows.
    const sessions = [
      sess('zulu', { issueId: 'root', createdAt: '2026-07-03T00:00:00.000Z' }),
      sess('alpha', { issueId: 'root', createdAt: '2026-07-02T00:00:00.000Z' }),
      sess('lead', { issueId: 'root', createdAt: '2026-07-09T00:00:00.000Z' }),
    ]
    const rows = buildFlightDeckRows(issues, sessions, 'root')
    expect(rowFor(rows, 'root').sessions.map((session) => session.sessionId)).toEqual([
      'lead',
      'alpha',
      'zulu',
    ])
  })

  it('breaks a same-instant tie on id so the crew never flickers', () => {
    const issues = [issue('root')]
    const at = '2026-07-02T00:00:00.000Z'
    const rows = buildFlightDeckRows(
      issues,
      [
        sess('b', { issueId: 'root', createdAt: at }),
        sess('a', { issueId: 'root', createdAt: at }),
      ],
      'root',
    )
    expect(rowFor(rows, 'root').sessions.map((session) => session.sessionId)).toEqual(['a', 'b'])
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
    // …and therefore it cannot move the mission's progress either: the mission
    // is one unit of work, c1, with the root as its container.
    expect(missionProgress(issues, [sess('s-root', { issueId: 'root' })], 'root').total).toBe(1)
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

    it('in Working keeps unfinished work plus finished work an agent is still WORKING on', () => {
      const withRevival = [...issues, issue('c3', { parentId: 'root', seq: 3, stage: 'done' })]
      const revived = [...sessions, sess('s-c3', { issueId: 'c3', agentState: workingState })]
      // g2 and c2 are done and agent-less → dropped. c3 is done but an agent is
      // mid-turn on it → kept. c1 is unfinished and matches on its own.
      expect(shape(buildFlightDeckRows(withRevival, revived, 'root', 'working'))).toEqual([
        'root@0',
        'c1@1',
        'g1@2',
        'c3@1',
      ])
    })

    /**
     * POD-1245. `Active` asked whether a finished task still had a session
     * PRESENT — not archived, not exited — and parking is how an agent normally
     * ends, so four closed tasks in five kept a hibernated session and came
     * straight back into the one view whose job is hiding them. The question is
     * now whether an agent is WORKING, which a parked one never is.
     */
    it.each([
      ['parked mid-turn', { status: 'hibernated' as const, agentState: workingState }],
      [
        'parked after a finished turn',
        { status: 'hibernated' as const, agentState: finishedState },
      ],
      ['awake but finished its turn', { agentState: finishedState }],
      ['awake and uninstrumented', {}],
    ])('in Working drops a done task whose agent is only %s', (_label, over) => {
      const withParked = [...issues, issue('c3', { parentId: 'root', seq: 3, stage: 'done' })]
      const parked = [...sessions, sess('s-c3', { issueId: 'c3', ...over })]
      expect(shape(buildFlightDeckRows(withParked, parked, 'root', 'working'))).not.toContain(
        'c3@1',
      )
    })

    // Same mechanism, and deliberately so: `issueClosed` already treats every
    // ending alike, so cancelling a task hides it on exactly the terms finishing
    // one does. No second rule to drift.
    it.each([
      'cancelled',
      'duplicate',
      'superseded',
    ] as const)('in Working drops a %s task whose agent is merely parked', (closedReason) => {
      const withCancelled = [
        ...issues,
        issue('c3', { parentId: 'root', seq: 3, stage: 'done', closedReason }),
      ]
      const parked = [...sessions, sess('s-c3', { issueId: 'c3', status: 'hibernated' })]
      const rows = buildFlightDeckRows(withCancelled, parked, 'root', 'working')
      expect(shape(rows)).not.toContain('c3@1')
    })

    // The escape hatch still exists — an agent really can be running on a task
    // somebody already closed, and losing sight of that is the thing the hatch
    // was for.
    it.each([
      'cancelled',
      'duplicate',
      'superseded',
    ] as const)('in Working KEEPS a %s task an agent is still working on', (closedReason) => {
      const withCancelled = [
        ...issues,
        issue('c3', { parentId: 'root', seq: 3, stage: 'done', closedReason }),
      ]
      const working = [...sessions, sess('s-c3', { issueId: 'c3', agentState: workingState })]
      expect(shape(buildFlightDeckRows(withCancelled, working, 'root', 'working'))).toContain(
        'c3@1',
      )
    })

    /**
     * POD-1245. The ancestor path is kept on purpose — an exception that loses
     * its path is one you cannot place — but until now the row carried no record
     * of WHY it was there, so `Needs you` drew a done parent exactly like the
     * task that was actually asking. `matched` is what the deck reads to render
     * one as a strip and the other as scaffolding.
     */
    it('marks path-only rows as unmatched so the deck can quieten them', () => {
      const rows = buildFlightDeckRows(issues, sessions, 'root', 'needs-you')
      expect(rows.map((row) => [row.issue.id, row.matched])).toEqual([
        ['root', false],
        ['c1', false],
        ['g1', true],
      ])
    })

    it('marks every row matched in full mode', () => {
      const rows = buildFlightDeckRows(issues, sessions, 'root', 'full')
      expect(rows.every((row) => row.matched)).toBe(true)
    })

    it('marks a row kept only as an ancestor as unmatched in Working', () => {
      // Only `leaf` has an agent in flight; `root` and `mid` survive as its path.
      const tree = [
        issue('root'),
        issue('mid', { parentId: 'root', seq: 1, stage: 'done', closedReason: 'done' }),
        issue('leaf', { parentId: 'mid', seq: 1 }),
      ]
      const rows = buildFlightDeckRows(
        tree,
        [sess('s-leaf', { issueId: 'leaf', agentState: workingState })],
        'root',
        'working',
      )
      expect(rows.map((row) => [row.issue.id, row.matched])).toEqual([
        ['root', false],
        ['mid', false],
        ['leaf', true],
      ])
    })

    /**
     * POD-1452. `Active` matched `!issueClosed(issue)`, so it kept every open
     * task whether or not anybody was on it — a backlog row, an untriaged
     * proposal and a task in `review` all read as live work under a tab
     * promising the opposite. It asks about AGENTS now, which is what makes the
     * three views nest: `Needs you` ⊂ `Active` ⊂ `Full spine`.
     */
    it('in Working drops an open task with no agent on it', () => {
      const idle = [issue('root'), issue('c', { parentId: 'root', seq: 1, stage: 'planning' })]
      expect(shape(buildFlightDeckRows(idle, [], 'root', 'working'))).toEqual(['root@0'])
    })

    it.each([
      ['mid-turn', { agentState: workingState }],
      ['still starting up', { status: 'starting' as const }],
      ['reconnecting', { status: 'reconnecting' as const }],
    ])('in Working keeps an open task whose agent is %s', (_label, over) => {
      const idle = [issue('root'), issue('c', { parentId: 'root', seq: 1, stage: 'planning' })]
      const staffed = [sess('s-c', { issueId: 'c', ...over })]
      expect(shape(buildFlightDeckRows(idle, staffed, 'root', 'working'))).toEqual([
        'root@0',
        'c@1',
      ])
    })

    /**
     * THE TWO NARROWED VIEWS ARE DISJOINT (POD-1452). `Working` used to contain
     * `Needs you`, so every row in the strictest view was already in the middle
     * one and switching between them looked like the filter had done nothing.
     * Busy and stuck-on-you are different facts, and each tab now answers one.
     */
    it.each([
      ['a standing offer', { offer }],
      ['a question', { agentState: needsUserState }],
    ])('sorts an agent stopped on %s into Needs you and out of Working', (_label, over) => {
      const tree = [issue('root'), issue('c', { parentId: 'root', seq: 1, stage: 'planning' })]
      const asking = [sess('s-c', { issueId: 'c', ...over })]
      expect(shape(buildFlightDeckRows(tree, asking, 'root', 'needs-you'))).toEqual([
        'root@0',
        'c@1',
      ])
      expect(shape(buildFlightDeckRows(tree, asking, 'root', 'working'))).toEqual(['root@0'])
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
  // The fourth element is the mission's SESSIONS, and it is optional because
  // most of these cases are about the denominator rather than about who is on
  // the work. Where it is omitted nothing is staffed, so a started task reads as
  // `stall` rather than `run` (POD-1314) — that is the arithmetic, not an
  // oversight, and the split itself is exercised in its own block below.
  const cases: Array<[string, IssueNavigationModel[], MissionProgress, SessionMeta[]?]> = [
    [
      'no mission at all',
      [],
      { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 },
    ],
    [
      'a lone root, which IS the single unit because it contains nothing',
      [issue('root')],
      { total: 1, done: 0, run: 0, review: 0, stall: 1, block: 0, wait: 0 },
    ],
    [
      // POD-710, the whole complaint: one sub-issue is ONE unit of work. The
      // root is what the meter is measuring, so it cannot also be a segment of
      // it — this used to report `total: 2` with the root running beside its
      // untouched child.
      'a root with one child, as one unit and one only',
      [issue('root', { stage: 'in_progress' }), issue('a', { parentId: 'root', stage: 'backlog' })],
      { total: 1, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 1 },
    ],
    [
      'a root with N children, every one of them a unit and the root none',
      [
        issue('root', { stage: 'in_progress' }),
        issue('a', { parentId: 'root', stage: 'done' }),
        issue('b', { parentId: 'root', stage: 'in_progress' }),
        issue('c', { parentId: 'root', stage: 'backlog' }),
      ],
      { total: 3, done: 1, run: 1, review: 0, stall: 0, block: 0, wait: 1 },
      [sess('s-b', { issueId: 'b' })],
    ],
    [
      'grandchildren, which are units at any depth',
      [
        issue('root'),
        issue('a', { parentId: 'root', stage: 'done' }),
        issue('a1', { parentId: 'a', stage: 'done' }),
        issue('a2', { parentId: 'a', stage: 'backlog' }),
      ],
      { total: 3, done: 2, run: 0, review: 0, stall: 0, block: 0, wait: 1 },
    ],
    [
      'all six segments at once',
      [
        issue('root', { stage: 'planning' }),
        issue('a', { parentId: 'root', stage: 'done' }),
        issue('b', { parentId: 'root', stage: 'review' }),
        issue('c', { parentId: 'root', blocked: true }),
        issue('d', { parentId: 'root', stage: 'backlog' }),
        issue('e', { parentId: 'root', stage: 'in_progress' }),
        // Same stage as `e`, and the only difference between them is that
        // nobody is here — which is the whole of the sixth band (POD-1314).
        issue('f', { parentId: 'root', stage: 'in_progress' }),
      ],
      { total: 6, done: 1, run: 1, review: 1, stall: 1, block: 1, wait: 1 },
      [sess('s-e', { issueId: 'e' })],
    ],
    [
      // POD-1181. `run` matched `in_progress` alone, so these two fell through to
      // the `wait` remainder — the band whose word is `TO GO`, i.e. "nobody has
      // picked this up" — about a task an agent is designing in and a task
      // already in Shipping's custody.
      'planning and shipping as work underway, never as work still to go',
      [
        issue('root', { stage: 'in_progress' }),
        issue('a', { parentId: 'root', stage: 'planning' }),
        issue('b', { parentId: 'root', stage: 'shipping' }),
        issue('c', { parentId: 'root', stage: 'backlog' }),
      ],
      // `b` runs on nobody: shipping's work is the service's, so it is the one
      // started stage a missing session does not stall (POD-1314).
      { total: 3, done: 0, run: 2, review: 0, stall: 0, block: 0, wait: 1 },
      [sess('s-a', { issueId: 'a' })],
    ],
    [
      'a child closed as done by reason rather than by stage',
      [issue('root', { stage: 'backlog' }), issue('a', { parentId: 'root', closedReason: 'done' })],
      { total: 1, done: 1, run: 0, review: 0, stall: 0, block: 0, wait: 0 },
    ],
    [
      // POD-1074's split, arriving in the meter: `duplicate` is a state in the
      // CANCELLED category, so this mission has nothing left to measure but its
      // own root — not one unit it can claim it finished.
      'a lone cancelled child, which leaves the count rather than filling it',
      [
        issue('root', { stage: 'backlog' }),
        issue('a', { parentId: 'root', closedReason: 'duplicate' }),
      ],
      { total: 1, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 1 },
    ],
    [
      'cancelled work among live work, out of both halves of the fraction',
      [
        issue('root', { stage: 'in_progress' }),
        issue('a', { parentId: 'root', stage: 'done' }),
        issue('b', { parentId: 'root', closedReason: 'cancelled' }),
        issue('c', { parentId: 'root', closedReason: 'wontfix' }),
        issue('d', { parentId: 'root', stage: 'in_progress' }),
      ],
      { total: 2, done: 1, run: 1, review: 0, stall: 0, block: 0, wait: 0 },
      [sess('s-d', { issueId: 'd' })],
    ],
    [
      'blocked in-progress work, counted once and as blocked',
      [issue('root', { stage: 'backlog' }), issue('a', { parentId: 'root', blocked: true })],
      { total: 1, done: 0, run: 0, review: 0, stall: 0, block: 1, wait: 0 },
    ],
    [
      'done work that is also flagged blocked, counted once as done',
      [
        issue('root', { stage: 'backlog' }),
        issue('a', { parentId: 'root', stage: 'done', blocked: true }),
      ],
      { total: 1, done: 1, run: 0, review: 0, stall: 0, block: 0, wait: 0 },
    ],
  ]

  // REST PARAMS, NOT FOUR NAMED ONES. A four-argument test callback is a
  // done-callback signature to the runner, so every case in this table was
  // being handed the runner's `done` as its `sessions` and timing out or
  // throwing instead of asserting — eight silent holes in the one table that
  // defines what the gauge says. Rest params make the callback zero-arity.
  it.each(cases)('reports %s', (...args) => {
    const [, issues, expected, sessions] = args as [
      string,
      IssueNavigationModel[],
      MissionProgress,
      SessionMeta[] | undefined,
    ]
    expect(missionProgress(issues, sessions ?? [], issues[0]?.id ?? null)).toEqual(expected)
  })

  it('records whether status comes from the root or its accepted child tasks', () => {
    const root = issue('root', { stage: 'in_progress' })
    const child = issue('child', { parentId: 'root', stage: 'backlog' })
    expect(missionRollup([root], [], 'root').fromChildren).toBe(false)
    expect(missionRollup([root, child], [], 'root').fromChildren).toBe(true)
    expect(
      missionRollup([root, issue('proposal', { parentId: 'root', stage: 'proposed' })], [], 'root')
        .fromChildren,
    ).toBe(false)
  })

  // POD-1179 IN THE FLESH: a lone root in `planning` with an agent working in it,
  // and the gauge's only band read `1 TO GO`. The stage says the work was picked
  // up and the session says someone is on it right now; `to go` denied both.
  it('does not call a planning root with an agent in it work still to go', () => {
    const root = issue('root', { stage: 'planning' })
    const sessions = [sess('s-root', { issueId: 'root', agentState: workingState })]
    expect(missionProgress([root], sessions, 'root')).toEqual({
      total: 1,
      done: 0,
      run: 1,
      review: 0,
      stall: 0,
      block: 0,
      wait: 0,
    })
    // Blocked still wins over the stage: a planning task waiting on a dependency
    // is stopped, and the exclusive ladder has to keep saying so.
    expect(missionProgress([{ ...root, blocked: true }], sessions, 'root')).toEqual({
      total: 1,
      done: 0,
      run: 0,
      review: 0,
      stall: 0,
      block: 1,
      wait: 0,
    })
  })

  // POD-1314 IN THE FLESH. One task, in progress, its only session exited six
  // minutes earlier: the header carried a `no agent` seat, a `0 agents` crew
  // chip and a strip reading `Retired` — and, across the middle of all three,
  // a gauge reading `1 UNDERWAY`.
  describe('the underway/stalled split', () => {
    const root = issue('root', { stage: 'in_progress' })

    it('does not call a started task with a retired agent underway', () => {
      const gone = [sess('s-root', { issueId: 'root', status: 'exited' })]
      expect(missionProgress([root], gone, 'root')).toMatchObject({ total: 1, run: 0, stall: 1 })
      // An archived session is gone the same way, and a task nobody ever
      // started on is stalled without ever having had one to lose.
      const archived = [sess('s-root', { issueId: 'root', archived: true })]
      expect(missionProgress([root], archived, 'root')).toMatchObject({ run: 0, stall: 1 })
      expect(missionProgress([root], [], 'root')).toMatchObject({ run: 0, stall: 1 })
    })

    it('calls it underway again the moment an agent is on it', () => {
      const crew = [sess('s-root', { issueId: 'root' })]
      expect(missionProgress([root], crew, 'root')).toMatchObject({ total: 1, run: 1, stall: 0 })
      // Presence, not activity: a parked agent is still on the task (POD-756),
      // and the march over the band is what gates on computing.
      const parked = [sess('s-root', { issueId: 'root', status: 'hibernated' })]
      expect(missionProgress([root], parked, 'root')).toMatchObject({ run: 1, stall: 0 })
    })

    it('counts the crew of the whole subtree, so a container is not stalled', () => {
      // `a` holds nobody, but the work under it is moving. Both are units — the
      // root is the container — and neither is stalled.
      const issues = [
        issue('root', { stage: 'in_progress' }),
        issue('a', { parentId: 'root', stage: 'in_progress' }),
        issue('a1', { parentId: 'a', stage: 'in_progress' }),
      ]
      const crew = [sess('s-a1', { issueId: 'a1', agentState: workingState })]
      expect(missionProgress(issues, crew, 'root')).toMatchObject({ total: 2, run: 2, stall: 0 })
      // Take the one agent out and the whole chain stalls together.
      expect(missionProgress(issues, [], 'root')).toMatchObject({ total: 2, run: 0, stall: 2 })
    })

    it("never stalls shipping, whose work is the service's and not a session's", () => {
      const shipping = issue('root', { stage: 'shipping' })
      expect(missionProgress([shipping], [], 'root')).toMatchObject({ run: 1, stall: 0 })
    })

    it('keeps blocked, review and done ahead of it in the exclusive ladder', () => {
      expect(missionProgress([{ ...root, blocked: true }], [], 'root')).toMatchObject({
        block: 1,
        stall: 0,
      })
      expect(missionProgress([issue('root', { stage: 'review' })], [], 'root')).toMatchObject({
        review: 1,
        stall: 0,
      })
      expect(missionProgress([issue('root', { stage: 'done' })], [], 'root')).toMatchObject({
        done: 1,
        stall: 0,
      })
    })
  })

  it('classifies a review-stage root with no agents as review, not running', () => {
    expect(missionProgress([issue('root', { stage: 'review' })], [], 'root')).toEqual({
      total: 1,
      done: 0,
      run: 0,
      review: 1,
      stall: 0,
      block: 0,
      wait: 0,
    })
  })

  it('does not count an empty hopscotch origin as a running unit', () => {
    const origin = issue('root', {
      stage: 'review',
      dependents: [{ id: 'tip', type: 'discovered-from' }],
    })
    const tip = issue('tip', {
      stage: 'in_progress',
      deps: [{ id: 'root', type: 'discovered-from' }],
    })
    expect(missionProgress([origin, tip], [sess('s-tip', { issueId: 'tip' })], 'root')).toEqual({
      total: 0,
      done: 0,
      run: 0,
      review: 0,
      stall: 0,
      block: 0,
      wait: 0,
    })
  })

  // POD-993 IN THE FLESH. Its deck filled to a single `1 DONE` band, at full
  // track, while the root sat in review with an agent working — because the one
  // thing it was measuring was a top-level task that session had FILED (no
  // parentId, no discovered-from, mission membership by `startedBySession`
  // alone) and someone had since cancelled. Two rules had to be wrong at once
  // for that reading: a provenance graft counted as a unit, and a cancelled
  // unit counted as done.
  it('does not measure a mission by the work its agent merely filed', () => {
    const issues = [
      issue('root', { stage: 'review' }),
      issue('filed', { closedReason: 'cancelled', startedBySession: 's-root' }),
      issue('offered', { stage: 'proposed', startedBySession: 's-root' }),
    ]
    const sessions = [sess('s-root', { issueId: 'root', agentState: workingState })]
    // Both grafts are on the deck — that is provenance, and it earns a row.
    expect(missionIssueIds(issues, 'root', sessions)).toEqual(new Set(['root', 'filed', 'offered']))
    // Neither is in the meter, so the root is the unit again and the bar
    // reports the state the operator can actually see an agent working on.
    expect(missionProgress(issues, sessions, 'root')).toEqual({
      total: 1,
      done: 0,
      run: 0,
      review: 1,
      stall: 0,
      block: 0,
      wait: 0,
    })
  })

  it('the segments always sum to the total, so the bar can never overflow', () => {
    const issues = [
      issue('root', { stage: 'review' }),
      issue('a', { parentId: 'root', stage: 'done', blocked: true }),
      issue('b', { parentId: 'root', stage: 'in_progress', blocked: true }),
      issue('c', { parentId: 'root', stage: 'planning' }),
    ]
    const p = missionProgress(issues, [], 'root')
    expect(p.done + p.run + p.review + p.stall + p.block + p.wait).toBe(p.total)
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
    const expected = { total: 3, done: 2, run: 0, review: 0, stall: 1, block: 0, wait: 0 }
    for (const mode of ['full', 'working', 'needs-you'] as const) {
      // The spine really does shrink in the filtered modes…
      const rows = buildFlightDeckRows(issues, [], 'root', mode)
      expect(rows.length).toBeLessThanOrEqual(4)
      // …and the mission's progress really does not move with it.
      expect(missionProgress(issues, [], 'root')).toEqual(expected)
    }
    // Nobody is on any of them, so `Active` is down to the root — and the
    // progress numbers above are unmoved by that.
    expect(shape(buildFlightDeckRows(issues, [], 'root', 'working'))).toEqual(['root@0'])
  })

  it('never divides by zero when the mission is only its root', () => {
    expect(missionProgress([issue('root', { stage: 'done' })], [], 'root')).toEqual({
      total: 1,
      done: 1,
      run: 0,
      review: 0,
      stall: 0,
      block: 0,
      wait: 0,
    })
  })

  it('measures the root as a container, not as one more segment beside it', () => {
    // The same root, in two missions. Alone it is the unit and reads as running;
    // the moment it has a member it is only the thing being measured, and the
    // member's own state is the whole reading.
    const crew = [sess('s-root', { issueId: 'root' })]
    const alone = missionProgress([issue('root', { stage: 'in_progress' })], crew, 'root')
    const container = missionProgress(
      [issue('root', { stage: 'in_progress' }), issue('a', { parentId: 'root', stage: 'done' })],
      [],
      'root',
    )
    expect(alone).toEqual({ total: 1, done: 0, run: 1, review: 0, stall: 0, block: 0, wait: 0 })
    expect(container).toEqual({ total: 1, done: 1, run: 0, review: 0, stall: 0, block: 0, wait: 0 })
  })

  it('is empty rather than throwing when there is no mission root', () => {
    expect(missionProgress([issue('root')], [], null)).toEqual({
      total: 0,
      done: 0,
      run: 0,
      review: 0,
      stall: 0,
      block: 0,
      wait: 0,
    })
  })

  it('ignores archived and deleted work', () => {
    const issues = [
      issue('root', { stage: 'backlog' }),
      issue('a', { parentId: 'root', archived: true }),
      issue('b', { parentId: 'root', deletedAt: '2026-07-01T00:00:00.000Z' }),
      issue('c', { parentId: 'root', stage: 'done' }),
    ]
    // Three members on paper, one unit of work: retired work is not work.
    expect(missionProgress(issues, [], 'root')).toEqual({
      total: 1,
      done: 1,
      run: 0,
      review: 0,
      stall: 0,
      block: 0,
      wait: 0,
    })
  })

  it('falls back to the root when every member has been retired', () => {
    // Nothing left to be the container OF, so the root is the unit again —
    // never `total: 0`, which would render as a mission that does not exist.
    const issues = [
      issue('root', { stage: 'backlog' }),
      issue('a', { parentId: 'root', archived: true }),
    ]
    expect(missionProgress(issues, [], 'root')).toEqual({
      total: 1,
      done: 0,
      run: 0,
      review: 0,
      stall: 0,
      block: 0,
      wait: 1,
    })
  })

  it('does not count proposed members as work remaining', () => {
    // The spine already keeps proposals in their own section. Counting them as
    // "to go" made a working parent with three discoveries read as nothing
    // happening — the bar said 3 to go while an agent ran on the root.
    const onlyProposed = [
      issue('root', { stage: 'in_progress' }),
      issue('a', { parentId: 'root', stage: 'proposed' }),
      issue('b', { parentId: 'root', stage: 'proposed' }),
      issue('c', { parentId: 'root', stage: 'proposed' }),
    ]
    expect(missionProgress(onlyProposed, [sess('s-root', { issueId: 'root' })], 'root')).toEqual({
      total: 1,
      done: 0,
      run: 1,
      review: 0,
      stall: 0,
      block: 0,
      wait: 0,
    })

    const acceptedAndProposed = [
      issue('root', { stage: 'in_progress' }),
      issue('a', { parentId: 'root', stage: 'in_progress' }),
      issue('b', { parentId: 'root', stage: 'proposed' }),
      issue('c', { parentId: 'root', stage: 'proposed' }),
    ]
    expect(missionProgress(acceptedAndProposed, [sess('s-a', { issueId: 'a' })], 'root')).toEqual({
      total: 1,
      done: 0,
      run: 1,
      review: 0,
      stall: 0,
      block: 0,
      wait: 0,
    })

    const backlogAndProposed = [
      issue('root', { stage: 'in_progress' }),
      issue('a', { parentId: 'root', stage: 'backlog' }),
      issue('b', { parentId: 'root', stage: 'proposed' }),
    ]
    expect(missionProgress(backlogAndProposed, [], 'root')).toEqual({
      total: 1,
      done: 0,
      run: 0,
      review: 0,
      stall: 0,
      block: 0,
      wait: 1,
    })

    // The screenshot case: discoveries grafted by startedBySession, no parentId.
    const grafted = [
      issue('root', { stage: 'in_progress' }),
      issue('a', { stage: 'proposed', startedBySession: 's-root' }),
      issue('b', { stage: 'proposed', startedBySession: 's-root' }),
      issue('c', { stage: 'proposed', startedBySession: 's-root' }),
    ]
    expect(missionProgress(grafted, [sess('s-root', { issueId: 'root' })], 'root')).toEqual({
      total: 1,
      done: 0,
      run: 1,
      review: 0,
      stall: 0,
      block: 0,
      wait: 0,
    })
  })

  // -------------------------------------------------------------------------
  // ONE COMPUTE PER PUBLISH, PER ROOT (POD-1685).
  //
  // Four surfaces ask this about the same root inside one replica publish —
  // `UnifiedIssueRow` once per visible row, `SidebarRail` once per root, the
  // Flight Deck and its folded bar once each — and each of them used to walk the
  // whole mission from scratch, filtering the entire session slice once per
  // member issue. The answer depends on the two slices and the root and nothing
  // else, so it is computed once and read by the rest.
  // -------------------------------------------------------------------------

  it('computes once per (issue slice, session slice, root), however many callers ask', () => {
    const { issues, sessions } = mission()
    const first = missionProgress(issues, sessions, 'root')
    const before = missionIndexStats().progressComputes
    for (let i = 0; i < 50; i += 1) {
      expect(missionProgress(issues, sessions, 'root')).toBe(first)
    }
    expect(missionIndexStats().progressComputes - before).toBe(0)
    // A DIFFERENT root over the same slices is a different question and gets its
    // own compute — once, and then it is shared too.
    const child = missionProgress(issues, sessions, 'c1')
    expect(missionProgress(issues, sessions, 'c1')).toBe(child)
    expect(missionIndexStats().progressComputes - before).toBe(1)
  })

  it('recomputes when either slice is republished, so the meter can never go stale', () => {
    const issues = [issue('root'), issue('c1', { parentId: 'root', stage: 'in_progress' })]
    const sessions: SessionMeta[] = []
    expect(missionProgress(issues, sessions, 'root')).toEqual({
      total: 1,
      done: 0,
      run: 0,
      review: 0,
      stall: 1,
      block: 0,
      wait: 0,
    })
    // An agent arrives. Nothing about the ISSUE slice changed — only the session
    // slice — and `stall` must become `run` all the same.
    const staffed = [sess('s1', { issueId: 'c1' })]
    expect(missionProgress(issues, staffed, 'root')).toEqual({
      total: 1,
      done: 0,
      run: 1,
      review: 0,
      stall: 0,
      block: 0,
      wait: 0,
    })
    // And the other way round: same sessions, a republished issue slice.
    const closed = [
      issues[0] as IssueNavigationModel,
      issue('c1', { parentId: 'root', stage: 'done' }),
    ]
    expect(missionProgress(closed, staffed, 'root').done).toBe(1)
  })

  it('hands out a frozen result, because every caller now reads the same object', () => {
    const { issues, sessions } = mission()
    const progress = missionProgress(issues, sessions, 'root') as MissionProgress & {
      total: number
    }
    expect(Object.isFrozen(progress)).toBe(true)
    // No caller in the app writes to it (verified across apps/web, apps/mobile
    // and engine/state.ts); the freeze is what keeps that true.
    expect(() => {
      progress.total = 99
    }).toThrow()
    expect(missionProgress(issues, sessions, 'root').total).toBe(progress.total)
  })

  it('shares the staffed-subtree walk between roots over the same slices', () => {
    const { issues, sessions } = mission()
    missionProgress(issues, sessions, 'root')
    const before = missionIndexStats().staffedComputes
    // Fresh roots, same slices: the walk is root-independent, so asking about
    // three more missions must not walk the crew three more times.
    for (const root of ['c1', 'c2', 'g1']) missionProgress(issues, sessions, root)
    expect(missionIndexStats().staffedComputes - before).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// missionCrewLabel — the gauge chip, never "live"
// ---------------------------------------------------------------------------

describe('missionCrewLabel', () => {
  it('names who is computing when someone is, otherwise who is on the task', () => {
    expect(missionCrewLabel(3, 1)).toBe('1 working')
    expect(missionCrewLabel(1, 1)).toBe('1 working')
    expect(missionCrewLabel(5, 2)).toBe('2 working')
    expect(missionCrewLabel(3, 0)).toBe('3 agents')
    expect(missionCrewLabel(1, 0)).toBe('1 agent')
    expect(missionCrewLabel(0, 0)).toBe('0 agents')
  })

  it('never says live', () => {
    expect(missionCrewLabel(3, 1)).not.toMatch(/live/i)
    expect(missionCrewLabel(3, 0)).not.toMatch(/live/i)
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
      crew: [],
      needsYou: false,
    })
    // A leaf hides nothing.
    expect(rowFor(rows, 'a').collapsedSummary.tasks).toBe(0)
  })

  // POD-1181's other half. This meter's `run` is "started and not done" — that is
  // why it takes `review` — so the stages the gauge folded into `UNDERWAY` belong
  // in it too. They used to count in `tasks` and in neither tier, which paints
  // picked-up work into the trough.
  it('paints planning, shipping and review as started, never as trough', () => {
    const issues = [
      issue('root'),
      issue('a', { parentId: 'root', seq: 1, stage: 'planning' }),
      issue('b', { parentId: 'root', seq: 2, stage: 'shipping' }),
      issue('c', { parentId: 'root', seq: 3, stage: 'review' }),
      issue('d', { parentId: 'root', seq: 4, stage: 'backlog' }),
    ]
    const summary = rowFor(buildFlightDeckRows(issues, [], 'root'), 'root').collapsedSummary
    expect(summary.tasks).toBe(4)
    expect(summary.done).toBe(0)
    expect(summary.run).toBe(3)
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

  // THE CENSUS KEEPS THE RETIRED AGENT (POD-758). `kinds` answers "what is
  // running in there"; `crew` answers "who is in there", and an agent that
  // finished is still someone the operator can open — it arrives last and the
  // strip draws it dimmed rather than dropping it.
  it('lists the crew behind the fold, working first and settled last', () => {
    const issues = [
      issue('root'),
      issue('a', { parentId: 'root' }),
      issue('b', { parentId: 'root' }),
    ]
    const sessions = [
      sess('gone', { issueId: 'a', status: 'exited' }),
      sess('idle', { issueId: 'b' }),
      sess('busy', { issueId: 'b', agentState: workingState }),
    ]
    const crew = rowFor(buildFlightDeckRows(issues, sessions, 'root'), 'root').collapsedSummary.crew
    expect(crew.map((session) => session.sessionId)).toEqual(['busy', 'idle', 'gone'])
  })

  // One agent that is a member of two issues in the subtree is one icon.
  it('deduplicates a session that sits on two tasks', () => {
    const issues = [
      issue('root'),
      issue('a', { parentId: 'root', memberSessionIds: ['s1'] }),
      issue('b', { parentId: 'root', memberSessionIds: ['s1'] }),
    ]
    const rows = buildFlightDeckRows(issues, [sess('s1', { issueId: 'a' })], 'root')
    expect(rowFor(rows, 'root').collapsedSummary.crew).toHaveLength(1)
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
    // WAS `false`, AND THAT WAS THE BUG (POD-1601). Retryability decides which
    // control the row offers, not whether a dead run is worth mentioning — so
    // the failure Continue cannot fix used to be the one that asked for nothing.
    ['errored and not retryable', sess('a', { agentState: erroredState(false) }), true],
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
    // A CLOSED TASK NEVER NEEDS YOU (POD-1072) — whatever is still standing on
    // it. The offer case is the one that bit: agents close and then post their
    // closing offer, which the close-time sweep has already run past.
    [
      'closed, with an offer posted after the close',
      issue('i', { stage: 'done' }),
      [sess('a', { offer })],
      false,
    ],
    [
      'closed by reason while a session sits in needs_user',
      issue('i', { closedReason: 'done' }),
      [sess('a', { agentState: needsUserState })],
      false,
    ],
    [
      'closed with the needsHuman flag still set',
      issue('i', { stage: 'done', needsHuman: true }),
      [],
      false,
    ],
    // The same offer on an OPEN issue is still a real ask — the gate is the
    // close, not the offer.
    ['open, with a standing offer', issue('i'), [sess('a', { offer })], true],
  ]

  it.each(cases)('is %s', (_name, target, sessions, expected) => {
    expect(issueNeedsHuman(target, sessions)).toBe(expected)
  })
})

/**
 * The session-level half of the same rule (POD-1072). `sessionNeedsHuman` cannot
 * see the task, so every attention surface that draws a session — the deck's
 * agent row, its `Needs you` filter — has to ask this one instead, or a closed
 * task goes on flying an amber mark on the strength of an offer nobody can act
 * on any more.
 */
describe('sessionAsksOnIssue', () => {
  const asking = sess('a', { offer })

  it('is true on an open task and false the moment it closes', () => {
    expect(sessionAsksOnIssue(issue('i'), asking)).toBe(true)
    expect(sessionAsksOnIssue(issue('i', { stage: 'done' }), asking)).toBe(false)
    expect(sessionAsksOnIssue(issue('i', { closedReason: 'done' }), asking)).toBe(false)
  })

  it('still ignores an archived session and a session with nothing pending', () => {
    expect(sessionAsksOnIssue(issue('i'), sess('a', { offer, archived: true }))).toBe(false)
    expect(sessionAsksOnIssue(issue('i'), sess('a', { agentState: workingState }))).toBe(false)
  })
})

describe('deckSessions', () => {
  const row = (over: Parameters<typeof issue>[1], sessions: SessionMeta[], matched = true) =>
    ({ issue: issue('i', over), sessions, matched }) as Pick<
      FlightDeckRow,
      'issue' | 'sessions' | 'matched'
    >

  it('narrows an open task to the agents that asked', () => {
    const quiet = sess('quiet', { agentState: workingState })
    const loud = sess('loud', { offer })
    expect(deckSessions(row({}, [quiet, loud]), 'needs-you')).toEqual([loud])
    expect(deckSessions(row({}, [quiet, loud]), 'full')).toEqual([quiet, loud])
  })

  it('narrows an open task to the agents actually at work', () => {
    const busy = sess('busy', { agentState: workingState })
    const spawning = sess('spawning', { status: 'starting' })
    const asking = sess('asking', { offer })
    const finished = sess('finished', { agentState: finishedState })
    const parked = sess('parked', { status: 'hibernated' })
    const crew = [busy, spawning, asking, finished, parked]
    // Disjoint, not nested: the asker belongs to the other tab and to no other.
    expect(deckSessions(row({}, crew), 'working')).toEqual([busy, spawning])
    expect(deckSessions(row({}, crew), 'needs-you')).toEqual([asking])
  })

  /**
   * POD-1452. A closed task retires nothing on its own, so `stale`'s offer is
   * not an ask — and the view used to fall back to the whole crew whenever no
   * session was asking, which handed a `Needs you` row two agents that were not.
   * The row is the exception; its settled agents are not.
   */
  it('does not treat a closed task offer as an ask, and shows no agents either', () => {
    const quiet = sess('quiet', { agentState: workingState })
    const stale = sess('stale', { offer })
    expect(deckSessions(row({ stage: 'done' }, [quiet, stale]), 'needs-you')).toEqual([])
  })

  // The other half of the same rule: a task in `review` whose agent finished and
  // left is still an obligation, so its ROW stays in `Needs you` — but the ✓ that
  // agent is wearing does not get to stand under a tab that means "stopped and
  // asking" (POD-1452).
  it('keeps a review row whole while dropping the agent that finished it', () => {
    const done = sess('done', { agentState: finishedState })
    expect(deckSessions(row({ stage: 'review' }, [done]), 'needs-you')).toEqual([])
    expect(deckSessions(row({ stage: 'review' }, [done]), 'working')).toEqual([])
    expect(deckSessions(row({ stage: 'review' }, [done]), 'full')).toEqual([done])
  })

  // POD-1245. A row kept only as the PATH to a match has nothing asking on it,
  // so it used to fall through to "keep every session" and arrive carrying its
  // whole crew — which is what made `Needs you` read as a list of busy agents
  // rather than of stopped ones.
  it('shows no agents at all on a row that is only context', () => {
    const busy = sess('busy', { agentState: workingState })
    const asking = sess('asking', { offer })
    expect(deckSessions(row({}, [busy, asking], false), 'needs-you')).toEqual([])
    // `Active` quietens a path row on the same terms now (POD-1452) — it filters
    // agents too, so a row it kept only for the path has none of its own.
    expect(deckSessions(row({}, [busy, asking], false), 'working')).toEqual([])
    // `Full spine` hides nothing, path row or not.
    expect(deckSessions(row({}, [busy, asking], false), 'full')).toEqual([busy, asking])
  })
})

/**
 * POD-1356. A view that removed everything left the same blank column as a
 * mission nobody is on, and the deck described both with the mission's presence
 * note — so a task with a live agent read as "no sessions or sub-tasks are
 * attached" the moment `Needs you` was chosen.
 */
describe('deckViewEmptyLine', () => {
  /**
   * POD-1452. Splitting the askers out of `Working` is what makes the two tabs
   * distinct, and it creates the one shape that could mislead: a mission whose
   * every agent is blocked on the operator draws a blank `Working` column, which
   * reads as "nothing here" when the truth is "all of it is waiting on you".
   */
  it('counts the agents the other tab has, when Working is what emptied the column', () => {
    expect(deckViewEmptyLine('working', 3)).toBe('No agent is working — 3 are waiting on you.')
    expect(deckViewEmptyLine('working', 1)).toBe('No agent is working — 1 is waiting on you.')
    // Nobody is waiting either: the plain sentence, with no count to explain.
    expect(deckViewEmptyLine('working', 0)).toBe('No agent in this mission is working right now.')
    // The count belongs to `Working` alone — it is the tab that lost them.
    expect(deckViewEmptyLine('needs-you', 3)).toBe('No agent in this mission is asking for you.')
    expect(deckViewEmptyLine('full', 3)).toBeNull()
  })

  it('names the view that emptied the column, and leaves Full to the mission', () => {
    expect(deckViewEmptyLine('needs-you')).toBe('No agent in this mission is asking for you.')
    expect(deckViewEmptyLine('working')).toBe('No agent in this mission is working right now.')
    expect(deckViewEmptyLine('full')).toBeNull()
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
    // It reached `needs-you` before POD-1601, through the late `motionPhase`
    // fallback, and said `Waiting on you` — a sentence about a question nobody
    // is asking. `error` is its own state now, above `needs-you`.
    [
      'error when a fatal error leaves the agent parked on us',
      issue('i'),
      [sess('a', { agentState: erroredState(false) })],
      'error',
    ],
    [
      'error when the error is retryable too',
      issue('i'),
      [sess('a', { agentState: erroredState(true) })],
      'error',
    ],
  ]

  it.each(states)('is %s', (_name, target, sessions, expected) => {
    expect(operationalState(target, sessions).state).toBe(expected)
  })

  // The order these are checked in is the product decision: an ask of the human
  // outranks a machine move, which outranks work in flight, which outranks a
  // stage the issue has not caught up with.
  const precedence: Case[] = [
    // THE ARM ABOVE `needs-you` (POD-1601). Both mean "this is on you", so the
    // only question is which sentence the operator gets — and `Needs you` on a
    // task whose agent is dead sends them hunting for a question.
    [
      'error beats needs-you',
      issue('i', { needsHuman: true }),
      [sess('a', { agentState: erroredState(false) })],
      'error',
    ],
    // A closed task never errors, for the same reason it never needs you: the
    // operator's own "this is finished" flip retires the question.
    [
      'a close beats the error',
      issue('i', { stage: 'done' }),
      [sess('a', { agentState: erroredState(false) })],
      'done',
    ],
    // Presence, not history: a session nobody is looking at any more cannot put
    // its task into an error state.
    [
      'an archived errored session does not error the task',
      issue('i'),
      [sess('a', { archived: true, agentState: erroredState(false) })],
      'retired',
    ],
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
    // A WRITTEN PHRASE, NOT THE CLASS TOKEN (POD-1601). `network_error` is what
    // the harness stores; `Network error` is what a person reads. The difference
    // between "wait for it" and "go and look" is worth a label of its own — it
    // is just never worth spelling `Errored: network_error` to say it.
    expect(
      operationalState(issue('i'), [sess('a', { agentState: erroredState(false) })]).label,
    ).toBe('Network error')
  })

  // The phrase table is an ALLOWLIST, and this is why. `error.class` carries
  // whatever the harness put there: Claude Code forwards its hook's raw
  // `error_type`, Cursor sends the literal string `error`, and `unknown` is the
  // classifier admitting it could not tell. None of those are words for a UI, so
  // anything without a phrase written for it reads as the plain sentence.
  it.each([
    ['unknown'],
    ['error'],
    ['failed'],
    ['some_new_provider_code'],
  ])('falls back to a plain sentence for the %s class', (cls) => {
    const state = {
      phase: 'errored',
      since: SINCE,
      nativeSubagentCount: 0,
      error: { class: cls, retryable: true },
    } as AgentState
    expect(operationalState(issue('i'), [sess('a', { agentState: state })]).label).toBe(
      'Agent errored',
    )
  })

  // The one the report was written about: red plus two plain words is the whole
  // message, and `Error: overloaded` was never the way to say it.
  it('names an overloaded agent in words', () => {
    const overloaded = {
      phase: 'errored',
      since: SINCE,
      nativeSubagentCount: 0,
      error: { class: 'overloaded', retryable: true },
    } as AgentState
    expect(operationalState(issue('i'), [sess('a', { agentState: overloaded })]).label).toBe(
      'Agent overloaded',
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
      // Still the `done` KIND — the work has stopped and the note's job is to
      // say the session went home. Only the verb changes, because "completed"
      // is the one thing this ending did not do.
      'work cancelled rather than completed',
      issue('a', { closedReason: 'duplicate' }),
      [],
      'done',
      'Cancelled · session retired',
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

  it('names the forward continuation instead of calling a superseded task retired', () => {
    const replacement = issue('next', { seq: 15 })
    const subject = issue('a', {
      stage: 'done',
      closedReason: 'superseded',
      supersededBy: 'next',
    })
    expect(presenceNote(subject, [], index([subject, replacement]))).toEqual({
      kind: 'moved',
      text: 'Work continued in #15',
      attention: false,
    })
  })

  it('names the live spin-off tip instead of calling an empty review ended', () => {
    const origin = issue('a', {
      seq: 959,
      stage: 'review',
      dependents: [{ id: 'mid', type: 'discovered-from' }],
    })
    const mid = issue('mid', {
      seq: 962,
      stage: 'done',
      closedReason: 'done',
      deps: [{ id: 'a', type: 'discovered-from' }],
    })
    const tip = issue('tip', {
      seq: 963,
      stage: 'in_progress',
      deps: [{ id: 'mid', type: 'discovered-from' }],
    })
    const sessions = [sess('s-tip', { issueId: 'tip' })]
    const byId = index([origin, mid, tip])
    expect(presenceNote(origin, [], byId)).toEqual({
      kind: 'moved',
      text: 'Work continued in #963',
      attention: false,
    })
    expect(issueContinuation(origin, byId, sessions)).toMatchObject({
      kind: 'spinoff',
      short: '#963',
      full: 'Work continued in #963',
    })
    expect(isVacatedOrigin(origin, [], byId)).toBe(true)
    expect(issueNeedsHuman(origin, [], byId)).toBe(false)
    expect(liveSpinOffTip(origin, byId, sessions)?.id).toBe('tip')
  })

  // POD-1073, replayed. `attach --spinoff` files the new issue in BACKLOG and
  // re-homes the session onto it in one step, so between the hop and whatever
  // stages it later, the origin's only explanation was a stage that said
  // "nobody has picked this up" about the issue the agent was sitting on.
  it('names a spin-off an agent already moved onto, even while it sits in the backlog', () => {
    const origin = issue('a', {
      seq: 1073,
      stage: 'done',
      closedReason: 'done',
      dependents: [{ id: 'tip', type: 'discovered-from' }],
    })
    const tip = issue('tip', {
      seq: 1085,
      stage: 'backlog',
      deps: [{ id: 'a', type: 'discovered-from' }],
    })
    const sessions = [sess('s-tip', { issueId: 'tip' })]
    const byId = index([origin, tip])
    expect(liveSpinOffTip(origin, byId, sessions)?.id).toBe('tip')
    expect(issueContinuation(origin, byId, sessions)).toMatchObject({
      kind: 'spinoff',
      full: 'Work continued in #1085',
    })
    expect(presenceNote(origin, [], byId, sessions)?.text).toBe('Work continued in #1085')
    expect(
      missionDepartures([origin, tip], sessions, 'a').map((departure) => departure.issue.id),
    ).toEqual(['tip'])
  })

  // The other half of the rule, untouched: work nobody has picked up has not
  // gone anywhere. It stays on the origin's spine to be triaged there.
  it('stays silent about a spin-off nobody is on yet', () => {
    const origin = issue('a', {
      seq: 1073,
      stage: 'done',
      closedReason: 'done',
      dependents: [{ id: 'tip', type: 'discovered-from' }],
    })
    const tip = issue('tip', {
      seq: 1085,
      stage: 'backlog',
      deps: [{ id: 'a', type: 'discovered-from' }],
    })
    const byId = index([origin, tip])
    expect(liveSpinOffTip(origin, byId, [])).toBeNull()
    expect(issueContinuation(origin, byId, [])).toBeNull()
    expect(missionDepartures([origin, tip], [], 'a')).toEqual([])
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

  it('agrees with the sidebar that blocked review work is waiting, not merge-ready', () => {
    const dep = issue('dep')
    const subject = issue('a', {
      stage: 'review',
      branch: 'issue/a',
      blocked: true,
      deps: [{ id: 'dep', type: 'blocks' }],
      gitState: {
        updatedAt: '2026-07-01T00:00:00.000Z',
        branch: 'issue/a',
        shared: false,
        merged: false,
        ahead: 3,
        dirtyFiles: 0,
      },
    })

    expect(waitingNote(subject, index([dep, subject]))).toMatch(/^Waiting for .+ to complete$/)
    expect(issuePendingDecision(subject)).toBeNull()
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

  it('puts the forward continuation ahead of backward provenance', () => {
    const replacement = issue('next', { seq: 15 })
    const subject = issue('a', {
      stage: 'done',
      closedReason: 'superseded',
      supersededBy: 'next',
      deps: [{ id: 'origin', type: 'discovered-from' }],
    })
    expect(issueNote(subject, index([origin, subject, replacement]))).toEqual({
      kind: 'continued',
      label: 'continued in',
      short: '#15',
      full: 'Work continued in #15',
    })
  })

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

  /**
   * A PROPOSAL STATES ITS SHAPE (POD-679). Provenance is a fact about the past;
   * the operator reading a proposal is about to decide the future, so the chip
   * names the consequence of starting it as it stands.
   */
  it('a proposed spin-off says it will start on its own, and what that frees', () => {
    const subject = issue('a', {
      stage: 'proposed',
      deps: [{ id: 'origin', type: 'discovered-from' }],
    })
    const note = issueNote(subject, index([origin, subject]))
    expect(note?.kind).toBe('shape-own')
    expect(note?.short).toBe('on its own')
    expect(note?.full).toBe('Starts on its own — #9 can close without it')
  })

  it('a proposed sub-task says it belongs to the task that found it', () => {
    const subject = issue('a', { stage: 'proposed', parentId: 'origin' })
    const note = issueNote(subject, index([origin, subject]))
    expect(note?.kind).toBe('shape-mission')
    expect(note?.short).toBe('in this mission')
    expect(note?.full).toBe('Part of #9 — that task is not done until this is')
  })

  it('goes back to plain provenance once the proposal has been started', () => {
    const subject = issue('a', {
      stage: 'in_progress',
      deps: [{ id: 'origin', type: 'discovered-from' }],
    })
    expect(issueNote(subject, index([origin, subject]))?.kind).toBe('relation')
  })

  it('still puts a real blocker above the shape', () => {
    const subject = issue('a', {
      stage: 'proposed',
      blocked: true,
      deps: [
        { id: 'dep', type: 'blocks' },
        { id: 'origin', type: 'discovered-from' },
      ],
    })
    expect(issueNote(subject, index([dep, origin, subject]))?.kind).toBe('blocked')
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

  // POD-1074 gave the strip its cancel glyph (`issueStatusOf` → `StatusGlyph`)
  // and left the word beside it reading `Done`, so a cancelled row contradicted
  // itself twice in 70px. Every spelling of the cancelled CATEGORY answers
  // here, including the legacy `wontfix` rows that never migrate.
  it.each([
    ['cancelled'],
    ['duplicate'],
    ['superseded'],
    ['wontfix'],
    ["won't fix"],
  ])('says Cancelled, not Done, for %s', (reason) => {
    const state = deckIssueState(issue('a', { closedReason: reason }), [])
    expect(state.state).toBe('cancelled')
    expect(state.label).toBe('Cancelled')
  })

  it.each([['done'], [undefined]])('still says Done for a completed task (%s)', (reason) => {
    const target = reason ? issue('a', { closedReason: reason }) : issue('a', { stage: 'done' })
    expect(deckIssueState(target, []).label).toBe('Done')
  })

  // An UNRECOGNISED reason is still a close, and `done` is the honest
  // stage-level answer — the same call `issueStatusOf` makes.
  it('does not read an unknown close reason as cancelled', () => {
    expect(deckIssueState(issue('a', { closedReason: 'shipped' }), []).state).toBe('done')
  })

  // POD-1601 — the strip used to cover a dead agent with whatever its STAGE
  // implied. A task in `review` whose only agent errored read `Standing by`.
  describe('an agent that stopped on an error', () => {
    const dead = (over = {}) =>
      sess('s', { issueId: 'a', agentState: erroredState(false), ...over })

    it('says Errored instead of the stage word', () => {
      const state = deckIssueState(issue('a', { stage: 'review' }), [dead()])
      expect(state.state).toBe('errored')
      expect(state.label).toBe('Errored')
    })

    // The attention channel is separate from the state channel by design, and
    // this is the case that proves both are wired: the word says what happened,
    // the dot says there is something in here.
    it('lights the attention indicator with it', () => {
      expect(deckIssueState(issue('a', { stage: 'review' }), [dead()]).attention).toBe(true)
    })

    it('does not shout over a task that is genuinely still running', () => {
      const alive = sess('t', { issueId: 'a', agentState: workingState })
      expect(deckIssueState(issue('a'), [dead(), alive]).state).toBe('working')
    })

    it('stays quiet once the task is closed', () => {
      expect(deckIssueState(issue('a', { stage: 'done' }), [dead()]).state).toBe('done')
    })

    it('outranks a blocked or unstarted reading', () => {
      expect(deckIssueState(issue('a', { blocked: true }), [dead()]).state).toBe('errored')
    })
  })
})

// ---------------------------------------------------------------------------
// portfolioActionableCount — the portfolio-wide attention total. No chrome
// renders it since the Superagent rail badge came off; it is the shared
// definition the explorer's Needs tab count is checked against.
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
