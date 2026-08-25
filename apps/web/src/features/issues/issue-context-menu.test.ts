import {
  asIssueId,
  asMachineId,
  asRepoId,
  asSessionId,
  type SessionMeta,
  type SessionMetaInput,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import {
  contextMenuTargets,
  deferDateFromNow,
  describeCascade,
  issueHandoffAvailability,
  issueHasCloseReason,
  issueMenuEligibility,
  resolveIssueHandoffSession,
  toggleLabelAcross,
} from './issue-context-menu'

const handoffRepos = [
  {
    repoId: asRepoId('r1'),
    machines: [
      { machineId: asMachineId('source'), path: '/a' },
      { machineId: asMachineId('target'), path: '/b' },
    ],
    // reposToViews always emits the repo root as a main worktree alongside the
    // linked ones — the drift cases depend on it being here.
    worktrees: [
      { path: '/a', isMain: true, machineId: asMachineId('source') },
      { path: '/a/.worktrees/x', isMain: false, machineId: asMachineId('source') },
    ],
  },
]
const handoffAgent = (state: 'in' | 'out' | 'unknown' = 'in', installed = true) => ({
  kind: 'codex',
  installed,
  login: { state },
})
const handoffMachines = [
  { id: asMachineId('source'), online: true, inventory: { agents: [handoffAgent()] } },
  { id: asMachineId('target'), online: true, inventory: { agents: [handoffAgent('unknown')] } },
]
const makeSession = (
  over: Partial<SessionMetaInput> & Pick<SessionMetaInput, 'sessionId'>,
): SessionMeta =>
  ({
    status: 'live',
    agentKind: 'codex',
    cwd: '/a/.worktrees/x',
    machineId: asMachineId('source'),
    harnessHandoff:
      over.harnessHandoff ?? ['claude-code', 'codex'].includes(over.agentKind ?? 'codex'),
    createdAt: 't',
    updatedAt: 't',
    unread: false,
    ...over,
  }) as unknown as SessionMeta

describe('issueMenuEligibility', () => {
  it('gates everything off for an empty target set', () => {
    const e = issueMenuEligibility([])
    expect(Object.values(e).every((v) => v === false)).toBe(true)
  })

  // The PALETTE's set, because it is the only surface that is not a list and so
  // the only one that still carries priority and labels (POD-1470).
  it('enables the full single-issue set for one open issue', () => {
    const e = issueMenuEligibility([makeIssue()], 'palette')
    expect(e).toEqual({
      canOpen: true,
      canRename: true,
      canSetStage: true,
      canSetPriority: true,
      canAssignAgent: true,
      canSetLabels: true,
      canSetColor: true,
      canClose: true,
      canDefer: true,
      canUndefer: false,
      canDuplicate: true,
      canPin: true,
      canRestore: false,
      canDelete: true,
      canArchive: true,
      canUnarchive: false,
      // A read issue offers "mark unread"; only an unread one offers "mark read".
      canMarkRead: false,
      canMarkUnread: true,
    })
  })

  // POD-697: the colour names a mission. A sub-issue runs under its parent's by
  // inheritance, so the entry is offered on top-level targets only — and one
  // sub-issue in a selection takes it away for the whole set.
  it('offers colour on top-level tasks only', () => {
    expect(issueMenuEligibility([makeIssue()]).canSetColor).toBe(true)
    expect(issueMenuEligibility([makeIssue({ parentId: 'iss_epic' })]).canSetColor).toBe(false)
    expect(
      issueMenuEligibility([makeIssue(), makeIssue({ parentId: 'iss_epic' })]).canSetColor,
    ).toBe(false)
    // Every other bulk item on that mixed selection is untouched.
    expect(
      issueMenuEligibility([makeIssue(), makeIssue({ parentId: 'iss_epic' })]).canSetStage,
    ).toBe(true)
  })

  // POD-1077: the flight deck is its own surface. Archive and Pin both act on
  // columns the deck is not, so a sub-task strip must not offer them.
  describe('the deck surface', () => {
    it('drops Archive and Pin, which act on the sidebar rather than the spine', () => {
      const deck = issueMenuEligibility([makeIssue()], 'deck')
      expect(deck.canArchive).toBe(false)
      expect(deck.canPin).toBe(false)
    })

    it('keeps Unarchive, so an archived strip is never a dead end', () => {
      const deck = issueMenuEligibility([makeIssue({ archived: true })], 'deck')
      expect(deck.canUnarchive).toBe(true)
      expect(deck.canArchive).toBe(false)
    })

    it('leaves every other entry alone', () => {
      const deck = issueMenuEligibility([makeIssue()], 'deck')
      expect(deck.canRename).toBe(true)
      expect(deck.canSetStage).toBe(true)
      expect(deck.canClose).toBe(true)
      expect(deck.canDelete).toBe(true)
      // Board-only triage stays board-only — the deck is not the board either.
      expect(deck.canDuplicate).toBe(false)
    })

    it('still offers Archive and Pin on the sidebar and the board', () => {
      for (const surface of ['sidebar', 'board'] as const) {
        const e = issueMenuEligibility([makeIssue()], surface)
        expect(e.canArchive).toBe(true)
        expect(e.canPin).toBe(true)
      }
    })
  })

  it('offers mark-unread on a read issue and mark-read on an unread one (#138)', () => {
    const read = issueMenuEligibility([makeIssue({ unread: false })])
    expect(read.canMarkUnread).toBe(true)
    expect(read.canMarkRead).toBe(false)
    const unread = issueMenuEligibility([makeIssue({ unread: true })])
    expect(unread.canMarkUnread).toBe(false)
    expect(unread.canMarkRead).toBe(true)
  })

  it('offers archive on an active issue and unarchive on an archived one', () => {
    const active = issueMenuEligibility([makeIssue()])
    expect(active.canArchive).toBe(true)
    expect(active.canUnarchive).toBe(false)
    const archived = issueMenuEligibility([makeIssue({ archived: true })])
    expect(archived.canArchive).toBe(false)
    expect(archived.canUnarchive).toBe(true)
  })

  it('drops close / defer / assign-agent on a closed issue', () => {
    const e = issueMenuEligibility([makeIssue({ closedReason: 'done' })])
    expect(e.canClose).toBe(false)
    expect(e.canDefer).toBe(false)
    expect(e.canAssignAgent).toBe(false)
    // still openable / re-stageable / deletable
    expect(e.canOpen).toBe(true)
    expect(e.canSetStage).toBe(true)
    expect(e.canDelete).toBe(true)
  })

  it('offers undefer only when a defer date is set', () => {
    expect(issueMenuEligibility([makeIssue()]).canUndefer).toBe(false)
    expect(
      issueMenuEligibility([makeIssue({ deferUntil: '2026-07-10', deferred: true })]).canUndefer,
    ).toBe(true)
  })

  it('hides duplicate once the issue already points at a canonical one', () => {
    expect(issueMenuEligibility([makeIssue({ duplicateOf: 'x' })]).canDuplicate).toBe(false)
  })

  // POD-169: "Duplicate of…" stays on the Issues board; the sidebar menu drops it.
  it('hides duplicate on the sidebar surface', () => {
    expect(issueMenuEligibility([makeIssue()], 'sidebar').canDuplicate).toBe(false)
    expect(issueMenuEligibility([makeIssue()], 'board').canDuplicate).toBe(true)
  })

  // POD-1457: the right dock's task panel is isolated from the Tasks tool —
  // entering that tool is a decision the operator makes in the toolbar, and the
  // only place `Open` could land was there. Everything else the dock offers is
  // exactly what the sidebar offers.
  it('hides open on the dock surface, and changes nothing else', () => {
    const dock = issueMenuEligibility([makeIssue()], 'dock')
    const sidebar = issueMenuEligibility([makeIssue()], 'sidebar')
    expect(dock.canOpen).toBe(false)
    expect(sidebar.canOpen).toBe(true)
    expect({ ...dock, canOpen: true }).toEqual(sidebar)
  })

  // POD-1470: a row in a LIST shows neither value back, so a menu offering to
  // change them was writing into the dark. They are set where the field is — the
  // task page, and on the board the `p` / `l` property menus and the bulk bar.
  it('drops priority, labels and the agent entry from every list', () => {
    for (const surface of ['sidebar', 'dock', 'board', 'deck'] as const) {
      const e = issueMenuEligibility([makeIssue()], surface)
      expect(e.canSetPriority).toBe(false)
      expect(e.canSetLabels).toBe(false)
      expect(e.canAssignAgent).toBe(false)
    }
    const palette = issueMenuEligibility([makeIssue()], 'palette')
    expect(palette.canSetPriority).toBe(true)
    expect(palette.canSetLabels).toBe(true)
    expect(palette.canAssignAgent).toBe(true)
  })

  // The palette borrowed `board` until POD-1470 and must keep everything that
  // came with it — "Duplicate of…" is the one board-only entry.
  it('leaves the palette everything the board offered it', () => {
    const board = issueMenuEligibility([makeIssue()], 'board')
    const palette = issueMenuEligibility([makeIssue()], 'palette')
    expect(palette.canDuplicate).toBe(true)
    expect({
      ...palette,
      canSetPriority: false,
      canSetLabels: false,
      canAssignAgent: false,
    }).toEqual(board)
  })

  it('offers only open and restore for deleted issues', () => {
    const e = issueMenuEligibility([makeIssue({ deletedAt: '2026-07-13T10:00:00.000Z' })])
    expect(e.canOpen).toBe(true)
    expect(e.canRestore).toBe(true)
    expect(e.canDelete).toBe(false)
    expect(e.canRename).toBe(false)
    expect(e.canSetStage).toBe(false)
    expect(e.canArchive).toBe(false)
  })

  it('supports bulk restore only when every selected issue is deleted', () => {
    const deleted = makeIssue({ id: asIssueId('gone'), deletedAt: '2026-07-13T10:00:00.000Z' })
    expect(
      issueMenuEligibility([deleted, { ...deleted, id: asIssueId('also-gone') }]).canRestore,
    ).toBe(true)
    expect(issueMenuEligibility([deleted, makeIssue({ id: asIssueId('live') })]).canRestore).toBe(
      false,
    )
  })
  it('keeps only bulk-capable actions on a multi-selection', () => {
    const e = issueMenuEligibility([
      makeIssue({ id: asIssueId('a') }),
      makeIssue({ id: asIssueId('b') }),
    ])
    expect(e.canSetStage).toBe(true)
    expect(e.canDelete).toBe(true)
    // Priority and labels are bulk-capable and STILL off a list (POD-1470) —
    // the board bulk-edits them from its own bar, not from this menu.
    expect(e.canSetPriority).toBe(false)
    expect(e.canSetLabels).toBe(false)
    expect(e.canOpen).toBe(false)
    // Rename is single-target (#170).
    expect(e.canRename).toBe(false)
    expect(e.canAssignAgent).toBe(false)
    expect(e.canClose).toBe(false)
    expect(e.canDefer).toBe(false)
    expect(e.canDuplicate).toBe(false)
    expect(e.canPin).toBe(false)
    expect(e.canArchive).toBe(false)
    expect(e.canUnarchive).toBe(false)
    // Read-state actions are single-target too.
    expect(e.canMarkRead).toBe(false)
    expect(e.canMarkUnread).toBe(false)
  })
})

describe('issueHasCloseReason', () => {
  it('closed ⇔ closedReason present', () => {
    expect(issueHasCloseReason(makeIssue())).toBe(false)
    expect(issueHasCloseReason(makeIssue({ closedReason: 'wontfix' }))).toBe(true)
  })
})

describe('contextMenuTargets', () => {
  it('right-click inside the selection keeps it and targets all selected', () => {
    const r = contextMenuTargets(
      { focusId: asIssueId('a'), selected: [asIssueId('a'), asIssueId('b'), asIssueId('c')] },
      asIssueId('b'),
    )
    expect(r.keyState).toEqual({ focusId: 'b', selected: ['a', 'b', 'c'] })
    expect(r.targetIds).toEqual(['a', 'b', 'c'])
  })

  it('right-click on an unselected issue re-focuses it and drops the selection', () => {
    const r = contextMenuTargets(
      { focusId: asIssueId('a'), selected: [asIssueId('a'), asIssueId('b')] },
      asIssueId('z'),
    )
    expect(r.keyState).toEqual({ focusId: 'z', selected: [] })
    expect(r.targetIds).toEqual(['z'])
  })

  it('right-click with no selection targets just the clicked issue', () => {
    const r = contextMenuTargets({ focusId: null, selected: [] }, asIssueId('x'))
    expect(r.keyState).toEqual({ focusId: 'x', selected: [] })
    expect(r.targetIds).toEqual(['x'])
  })
})

describe('deferDateFromNow', () => {
  it('formats now+days as local YYYY-MM-DD, rolling over month ends', () => {
    // 2026-06-30 12:00 local
    const base = new Date(2026, 5, 30, 12, 0, 0).getTime()
    expect(deferDateFromNow(base, 1)).toBe('2026-07-01')
    expect(deferDateFromNow(base, 7)).toBe('2026-07-07')
  })
})

describe('toggleLabelAcross', () => {
  it('adds the label to targets missing it (mixed selection)', () => {
    const a = makeIssue({ id: asIssueId('a'), labels: ['x'] })
    const b = makeIssue({ id: asIssueId('b'), labels: [] })
    expect(toggleLabelAcross([a, b], 'x')).toEqual([{ id: asIssueId('b'), labels: ['x'] }])
  })

  it('removes the label everywhere when every target has it', () => {
    const a = makeIssue({ id: asIssueId('a'), labels: ['x', 'y'] })
    const b = makeIssue({ id: asIssueId('b'), labels: ['x'] })
    expect(toggleLabelAcross([a, b], 'x')).toEqual([
      { id: asIssueId('a'), labels: ['y'] },
      { id: asIssueId('b'), labels: [] },
    ])
  })
})

describe('resolveIssueHandoffSession ([spec:SP-3f7a])', () => {
  it('returns the single eligible session and its targets', () => {
    const session = makeSession({ sessionId: 's1' })
    const issue = makeIssue({ memberSessionIds: ['s1'] })
    const result = resolveIssueHandoffSession(issue, [session], handoffRepos, handoffMachines)
    expect(result?.session.sessionId).toBe('s1')
    expect(result?.targets.map((m) => m.id)).toEqual(['target'])
  })

  it('still offers handoff after the session cwd drifted onto the main checkout', () => {
    // The live shape POD-657 fixes: the agent ran a command against the repo
    // root and got restamped there. The issue's worktree is still its home.
    const drifted = makeSession({ sessionId: asSessionId('s1'), cwd: '/a' })
    const issue = makeIssue({
      memberSessionIds: ['s1'],
      branch: 'issue/1-x',
      worktreePath: '/a/.worktrees/x',
    })
    expect(
      resolveIssueHandoffSession(issue, [drifted], handoffRepos, handoffMachines)?.session
        .sessionId,
    ).toBe('s1')
    // Without a worktree of its own the issue cannot anchor the drifted session.
    expect(
      resolveIssueHandoffSession(
        makeIssue({ memberSessionIds: ['s1'], worktreePath: null }),
        [drifted],
        handoffRepos,
        handoffMachines,
      ),
    ).toBeNull()
  })

  it('looks up SessionMeta from the store by memberSessionIds', () => {
    // Member ids resolve against the live SessionMeta rows held by the client.
    const issue = makeIssue({
      memberSessionIds: ['s1'],
    })
    const live = makeSession({
      sessionId: asSessionId('s1'),
      agentKind: 'codex',
      cwd: '/a/.worktrees/x',
    })
    const result = resolveIssueHandoffSession(issue, [live], handoffRepos, handoffMachines)
    expect(result?.session).toBe(live)
  })

  it('returns null when zero or more than one attached session is handoff-eligible', () => {
    const ineligible = makeSession({ sessionId: asSessionId('shell'), agentKind: 'shell' })
    const a = makeSession({ sessionId: asSessionId('a') })
    const b = makeSession({ sessionId: asSessionId('b') })
    expect(
      resolveIssueHandoffSession(
        makeIssue({ memberSessionIds: ['shell'] }),
        [ineligible],
        handoffRepos,
        handoffMachines,
      ),
    ).toBeNull()
    expect(
      resolveIssueHandoffSession(
        makeIssue({
          memberSessionIds: ['a', 'b'],
        }),
        [a, b],
        handoffRepos,
        handoffMachines,
      ),
    ).toBeNull()
  })

  it('ignores missing store sessions and still resolves a sole eligible one', () => {
    const eligible = makeSession({ sessionId: asSessionId('ok') })
    const result = resolveIssueHandoffSession(
      makeIssue({
        memberSessionIds: ['gone', 'ok'],
      }),
      [eligible],
      handoffRepos,
      handoffMachines,
    )
    expect(result?.session.sessionId).toBe('ok')
  })
})

describe('issueHandoffAvailability (POD-850)', () => {
  const issueWith = (refs: string[], over = {}) => makeIssue({ memberSessionIds: refs, ...over })

  it('surfaces the sole agent session and its candidate machines', () => {
    const session = makeSession({ sessionId: 's1' })
    const result = issueHandoffAvailability(
      issueWith(['s1']),
      [session],
      handoffRepos,
      handoffMachines,
    )
    expect('session' in result && result.session.sessionId).toBe('s1')
    // 'target' is logged-out-equivalent (login 'unknown' is fine, but here it's a
    // candidate) — the point is the machine is REPORTED, not silently dropped.
    expect(
      'availability' in result && result.availability.candidates.map((c) => c.machine.id),
    ).toEqual(['target'])
  })

  it('treats an UNKNOWN harness as not handoff-eligible without throwing (POD-1105)', () => {
    // agentKind comes off the wire, so it can name a harness this build has never
    // heard of. Eligibility now reads the manifest projection; an unknown id must
    // answer "not eligible" — the same thing the `claude-code || codex` pair of
    // comparisons returned — rather than throwing on a missing row.
    const future = makeSession({
      sessionId: asSessionId('f1'),
      agentKind: 'future-harness' as never,
    })
    expect(() =>
      issueHandoffAvailability(issueWith(['f1']), [future], handoffRepos, handoffMachines),
    ).not.toThrow()
    expect(
      issueHandoffAvailability(issueWith(['f1']), [future], handoffRepos, handoffMachines),
    ).toEqual({ blocker: 'no-agent-session' })
  })

  it('reports no-agent-session for a shell-only issue instead of hiding', () => {
    const shell = makeSession({ sessionId: 'sh', agentKind: 'shell' })
    expect(
      issueHandoffAvailability(issueWith(['sh']), [shell], handoffRepos, handoffMachines),
    ).toEqual({
      blocker: 'no-agent-session',
    })
    // No sessions at all is the same reason.
    expect(issueHandoffAvailability(issueWith([]), [], handoffRepos, handoffMachines)).toEqual({
      blocker: 'no-agent-session',
    })
  })

  it('reports multiple-sessions when more than one agent session is attached', () => {
    const a = makeSession({ sessionId: 'a' })
    const b = makeSession({ sessionId: 'b' })
    expect(
      issueHandoffAvailability(issueWith(['a', 'b']), [a, b], handoffRepos, handoffMachines),
    ).toEqual({ blocker: 'multiple-sessions' })
  })

  it('a shell alongside the one agent session does not count as multiple (POD-779 shape)', () => {
    const agent = makeSession({ sessionId: asSessionId('agent') })
    const shell = makeSession({ sessionId: asSessionId('shell'), agentKind: 'shell' })
    const result = issueHandoffAvailability(
      issueWith(['agent', 'shell']),
      [agent, shell],
      handoffRepos,
      handoffMachines,
    )
    expect('session' in result && result.session.sessionId).toBe('agent')
  })

  it("carries the agent session's own blocker when it cannot move (drifted onto main, no issue worktree)", () => {
    // POD-779 live shape: the agent's cwd is the main checkout and the issue has no
    // worktree of its own to anchor on → the session itself is blocked 'no-worktree'.
    const drifted = makeSession({ sessionId: asSessionId('s1'), cwd: '/a' })
    const result = issueHandoffAvailability(
      issueWith(['s1'], { worktreePath: null }),
      [drifted],
      handoffRepos,
      handoffMachines,
    )
    expect('availability' in result && result.availability.blocker).toBe('no-worktree')
  })
})

// POD-1077. The archive confirm used to name sub-tasks and say nothing about
// the agent processes it stops, which is the half that made archiving read as
// filing rather than as a teardown.
describe('describeCascade', () => {
  it('names the agents, not just the tasks', () => {
    expect(describeCascade(4, 5)).toBe('This affects 4 tasks and 5 agents.')
  })

  it('singularises both halves independently', () => {
    expect(describeCascade(1, 1)).toBe('This affects 1 task and 1 agent.')
    expect(describeCascade(1, 2)).toBe('This affects 1 task and 2 agents.')
    expect(describeCascade(2, 1)).toBe('This affects 2 tasks and 1 agent.')
  })

  // "and 0 agents" is noise on a task nothing is running under.
  it('omits the agent clause when there are none', () => {
    expect(describeCascade(3, 0)).toBe('This affects 3 tasks.')
  })
})
