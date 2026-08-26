// @vitest-environment happy-dom

import type { SessionMeta } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import {
  IssueCompactControls,
  IssueDecisionBand,
  IssueGitScope,
  resolveTaskAction,
} from './IssueCompactControls'

vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))
// The launch box's model/effort segments read the live catalog through this
// shim, which hangs off the REAL store provider rather than the mock below.
vi.mock('@/lib/use-model-catalog', () => ({ useModelCatalog: () => ({}) }))

const setOpenIssueId = vi.fn()
const setView = vi.fn()
const navigateToSession = vi.fn()
const start = vi.fn(async () => ({}))
const setPlacement = vi.fn(async () => ({}))
const updateIssue = vi.fn(async () => {})
const closeIssue = vi.fn(async () => {})

/** Ids are branded on `SessionMeta`; fixtures are built from string literals,
 *  so the override side is the unbranded spelling. */
type SessionOverride = Partial<Omit<SessionMeta, 'sessionId' | 'issueId'>> & {
  sessionId?: string
  issueId?: string
}

const session = (over: SessionOverride = {}): SessionMeta =>
  ({
    sessionId: 's1',
    issueId: 'i',
    agentKind: 'claude-code',
    archived: false,
    status: 'live',
    lastActiveAt: '2026-08-06T00:00:00.000Z',
    ...over,
  }) as unknown as SessionMeta

let mockSessions: SessionMeta[] = []
/** The replica the controls resolve an origin ref against. */
let mockIssues: ReturnType<typeof makeIssue>[] = []

vi.mock('@/app/store', () => {
  const state = () => ({
    trpc: {
      issues: {
        start: { mutate: start },
        setPlacement: { mutate: setPlacement },
        close: { mutate: vi.fn(async () => ({})) },
        update: { mutate: vi.fn(async () => ({})) },
        clearNeedsHuman: { mutate: vi.fn(async () => ({})) },
      },
      sessions: { sendText: { mutate: vi.fn(async () => ({})) } },
    },
    issues: mockIssues,
    setOpenIssueId,
    setView,
    navigateToSession,
    archiveSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
    markIssueRead: vi.fn(),
    markIssueUnread: vi.fn(),
    updateIssue,
    closeIssue,
    sessions: mockSessions,
    repos: [],
    machines: [],
    httpOrigin: '',
  })
  return {
    useStore: () => state(),
    useReplicaIssues: () => state().issues,
    useStoreSelector: (selector: (value: ReturnType<typeof state>) => unknown) => selector(state()),
  }
})

afterEach(() => {
  cleanup()
  mockSessions = []
  mockIssues = []
  vi.clearAllMocks()
})

// The head offers exactly ONE primary action, and which one is a pure function
// of the issue's own state — the operator never has to choose between three
// buttons to find the next move.
describe('resolveTaskAction', () => {
  it('offers nothing when the task needs a human — the band already says so', () => {
    // POD-1269: this used to resolve to an "Answer" chip that jumped to whoever
    // was waiting. Three things on this surface already carry that obligation —
    // the amber decision band, the waiting session's attention rule, and the row
    // that opens its conversation — and a filled yellow button that only
    // navigates read as the place the answer gets typed.
    expect(resolveTaskAction(makeIssue({ needsHuman: true }), [session()])).toBeNull()
  })

  it('offers to close a handed-off origin rather than answer it', () => {
    // The work moved to the spin-off and no session is left here, so there is
    // nobody to answer — the only decision left is whether to close.
    //
    // `needsHuman` is explicit because REVIEW STAGE ALONE no longer reaches this
    // branch: b8b13c01d made a vacated review origin "a signpost, not a review
    // item" (issueNeedsHuman in client-core's mission.ts), which is asserted as
    // its own case below. What survives that change, and is what this case is
    // about, is the choice of verb once the issue DOES want a human: with the
    // work gone and no session to carry a reply, the offer is to close it, not
    // to answer into an empty room.
    const issue = makeIssue({
      stage: 'review',
      needsHuman: true,
      dependents: [{ id: 'spin', type: 'discovered-from' }],
    })
    expect(resolveTaskAction(issue, [])).toEqual({
      kind: 'mark-done',
      label: 'Mark done',
      warn: true,
    })
  })

  it('leaves a vacated review origin as ordinary work, not a review item', () => {
    // The counterpart to the case above (b8b13c01d): the same shape WITHOUT an
    // explicit needsHuman is a signpost the operator can pick back up, so it
    // resolves to plain "Start work" and never demands a decision it has no
    // question for.
    const issue = makeIssue({
      stage: 'review',
      dependents: [{ id: 'spin', type: 'discovered-from' }],
    })
    expect(resolveTaskAction(issue, [])).toEqual({
      kind: 'start-work',
      label: 'Start work',
      warn: false,
    })
  })

  it('offers nothing while live sessions are working it', () => {
    // POD-1151: this used to be an "Open coordinator" chip. It never worked —
    // the panel is the right dock, which does not move, so from the workspace
    // the click landed on the session already in the pane. Work in flight asks
    // nothing of the operator, so the head simply carries no primary chip; the
    // session rows below are how you reach the agents.
    expect(resolveTaskAction(makeIssue({}), [session()])).toBeNull()
  })

  it('starts work when nobody is on it', () => {
    expect(resolveTaskAction(makeIssue({}), [])).toEqual({
      kind: 'start-work',
      label: 'Start work',
      warn: false,
    })
  })
})

/** NOT YET BEGUN. `makeIssue` defaults to an `in_progress` task that already
 *  has a checkout, and both of those are proof that somebody picked the work up
 *  (POD-1457) — so every test about STARTING has to say otherwise explicitly. */
const unstarted = (over: Parameters<typeof makeIssue>[0] = {}) =>
  makeIssue({ id: 'i', stage: 'backlog', worktreePath: null, ...over })

describe('IssueCompactControls', () => {
  it('carries no chip at all when the task needs a human', () => {
    mockSessions = [session({ sessionId: 'coord' })]
    render(<IssueCompactControls issue={makeIssue({ id: 'i', needsHuman: true })} />)

    expect(screen.queryByTestId('task-primary-action')).toBeNull()
  })

  it('carries no crossing into the Work view at all', () => {
    // It was `Work on this`, one gap from `Start work` — two adjacent controls
    // whose labels both promised to begin the work. Going to Work is navigation
    // and left the action row entirely; the head owns the link now (POD-1457).
    render(<IssueCompactControls issue={makeIssue({ id: 'i' })} />)

    expect(screen.queryByTestId('task-work-on-this')).toBeNull()
  })

  it('carries no primary chip while sessions are working the task', () => {
    mockSessions = [session({ sessionId: 'coord' })]
    render(<IssueCompactControls issue={unstarted()} />)

    expect(screen.queryByTestId('task-primary-action')).toBeNull()
  })

  it('starts the agent when the task has none', () => {
    render(<IssueCompactControls issue={unstarted()} />)

    const action = screen.getByTestId('task-primary-action')
    expect(action.textContent).toBe('Start work')
    fireEvent.click(action)
    expect(start).toHaveBeenCalledWith({ id: 'i' })
  })

  /**
   * THE LAUNCH BOX (POD-1457). The panel's start used to be a bare chip: it
   * could say whether to start, and — for discovered work — where, but never
   * with what. Setting an agent meant leaving the explorer for the full issue
   * page. It is now the same box the page's Sessions block wears.
   */
  describe('the launch box', () => {
    it('stands where the start chip stood, with the agent this task launches with', () => {
      render(<IssueCompactControls issue={unstarted()} />)

      const box = screen.getByTestId('launch-box')
      expect(box.contains(screen.getByTestId('task-primary-action'))).toBe(true)
      expect(screen.getByLabelText('Agent').textContent).toContain('Claude Code')
    })

    it('writes the picked agent to the issue, resetting the model it is not for', async () => {
      // Models are per-agent ([spec:SP-7ff1]) — the write that changes the
      // harness clears the model and effort with it, so the optimistic row never
      // shows the previous agent's model.
      render(<IssueCompactControls issue={unstarted()} />)

      fireEvent.click(screen.getByLabelText('Agent'))
      fireEvent.click(await screen.findByText('Codex'))

      expect(updateIssue).toHaveBeenCalledWith('i', {
        defaultAgent: 'codex',
        defaultModel: 'auto',
        defaultEffort: 'auto',
      })
    })

    /**
     * NO `Start work` ON WORK THAT HAS BEGUN (POD-1457). Three independent
     * proofs settle it — an agent on it, a checkout, or a stage whose name says
     * somebody picked it up — and any one of them turns the foot into the
     * `+ Session` / `+ Shell` face instead.
     */
    it.each([
      ['a live agent', { sessions: true, over: {} }],
      ['a checkout', { sessions: false, over: { worktreePath: '/r/wt' } }],
      ['a stage that says so', { sessions: false, over: { stage: 'in_progress' as const } }],
      ['a task under review', { sessions: false, over: { stage: 'review' as const } }],
    ])('offers sessions rather than a start when the work has begun — %s', (_name, spec) => {
      if (spec.sessions) mockSessions = [session({ sessionId: 'coord' })]
      render(<IssueCompactControls issue={unstarted(spec.over)} />)

      expect(screen.getByTestId('launch-box')).not.toBeNull()
      expect(screen.queryByTestId('task-primary-action')).toBeNull()
      expect(screen.getByText('+ Session')).not.toBeNull()
    })

    it('stands down entirely on a finished task', () => {
      // A closure, an archive or the `done` lane is the end of the work: the
      // strip offers Reopen there, and there is nothing to launch.
      const finished: Parameters<typeof unstarted>[0][] = [
        { closedReason: 'done' },
        { stage: 'done' },
        { archived: true },
      ]
      for (const over of finished) {
        render(<IssueCompactControls issue={unstarted(over)} />)
        expect(screen.queryByTestId('launch-box')).toBeNull()
        cleanup()
      }
    })
  })

  /**
   * THE START CLICK IS THE TRIAGE MOMENT (POD-679). The plain button keeps the
   * shape the filing agent chose; the fork beside it is how the operator says
   * "this is something else" before anything runs.
   */
  describe('the placement fork', () => {
    const origin = makeIssue({ id: 'origin', seq: 9, title: 'Flight deck spine' })
    // `startedBySession` is what marks this as work an AGENT filed — the fork
    // is for the decision the operator inherited, not for their own planning.
    const proposal = unstarted({
      stage: 'proposed',
      startedBySession: 's-agent',
      deps: [{ id: 'origin', type: 'discovered-from' }],
    })

    it('is absent on a plain task — there is nowhere else for it to live', () => {
      render(<IssueCompactControls issue={unstarted()} />)
      expect(screen.queryByTestId('task-placement-trigger')).toBeNull()
    })

    it('is absent on a sub-task the operator planned themselves', () => {
      const planned = makeIssue({ id: 'i', stage: 'proposed', parentId: 'origin' })
      mockIssues = [origin, planned]
      render(<IssueCompactControls issue={planned} />)
      expect(screen.queryByTestId('task-placement-trigger')).toBeNull()
    })

    it('names both destinations by what they do to the origin', async () => {
      mockIssues = [origin, proposal]
      render(<IssueCompactControls issue={proposal} />)

      fireEvent.click(screen.getByTestId('task-placement-trigger'))
      expect(await screen.findByText('START WORK')).toBeTruthy()
      expect(screen.getByText('PLACEMENT')).toBeTruthy()
      expect(screen.getByText('Current')).toBeTruthy()
      expect((await screen.findByTestId('task-placement-own')).textContent).toContain(
        '#9 can close without it',
      )
      expect(screen.getByTestId('task-placement-mission').textContent).toContain(
        '#9 is not done until this is',
      )
    })

    it('starts without moving anything when the agent already had it right', async () => {
      mockIssues = [origin, proposal]
      render(<IssueCompactControls issue={proposal} />)

      fireEvent.click(screen.getByTestId('task-placement-trigger'))
      fireEvent.click(await screen.findByTestId('task-placement-own'))

      expect(setPlacement).not.toHaveBeenCalled()
      expect(start).toHaveBeenCalledWith({ id: 'i' })
    })

    it('moves the work first, then starts it, when the operator disagrees', async () => {
      mockIssues = [origin, proposal]
      render(<IssueCompactControls issue={proposal} />)

      fireEvent.click(screen.getByTestId('task-placement-trigger'))
      fireEvent.click(await screen.findByTestId('task-placement-mission'))

      expect(setPlacement).toHaveBeenCalledWith({
        id: 'i',
        placement: 'mission',
        originId: 'origin',
      })
      // The start waits on the move: an agent must never boot into the shape
      // the operator just rejected.
      await vi.waitFor(() => expect(start).toHaveBeenCalledWith({ id: 'i' }))
      expect(setPlacement.mock.invocationCallOrder[0]).toBeLessThan(
        start.mock.invocationCallOrder[0] as number,
      )
    })
  })

  // The terminal statuses are reachable from the status menu, but never as a
  // bare stage write: the entry records an ENDING. Whether the guard stands in
  // between is POD-1278's question — it does when there is something to weigh.
  const unresolved = { id: 'i', childCount: 1, childDoneCount: 0 } as const

  it('routes the status menu terminal entries through the guard dialog', async () => {
    render(<IssueCompactControls issue={makeIssue(unresolved)} />)

    fireEvent.click(screen.getByLabelText('Status'))
    fireEvent.click(await screen.findByText('Done'))

    expect(await screen.findByText('This issue still needs attention')).toBeTruthy()
    expect(closeIssue).not.toHaveBeenCalled()
  })

  it('confirms the close through the optimistic store action', async () => {
    render(<IssueCompactControls issue={makeIssue(unresolved)} />)

    fireEvent.click(screen.getByLabelText('Status'))
    fireEvent.click(await screen.findByText('Done'))
    fireEvent.click(await screen.findByText('Close anyway'))

    expect(closeIssue).toHaveBeenCalledWith('i', 'done')
  })

  // POD-1278: a tidy task has nothing for the guard to list, and a dialog that
  // rises to say so is asking again for the press just made.
  it('records the ending on the press when nothing is unresolved', async () => {
    render(<IssueCompactControls issue={makeIssue({ id: 'i' })} />)

    fireEvent.click(screen.getByLabelText('Status'))
    fireEvent.click(await screen.findByText('Done'))

    expect(closeIssue).toHaveBeenCalledWith('i', 'done')
    expect(screen.queryByText('Close this issue?')).toBeNull()
  })

  // POD-1074: cancelled and duplicate are their own endings, not one "wontfix".
  it('closes as cancelled from the status menu', async () => {
    render(<IssueCompactControls issue={makeIssue({ id: 'i' })} />)

    fireEvent.click(screen.getByLabelText('Status'))
    fireEvent.click(await screen.findByText('Cancelled'))

    expect(closeIssue).toHaveBeenCalledWith('i', 'cancelled')
  })

  it('closes as duplicate from the status menu', async () => {
    render(<IssueCompactControls issue={makeIssue({ id: 'i' })} />)

    fireEvent.click(screen.getByLabelText('Status'))
    fireEvent.click(await screen.findByText('Duplicate'))

    expect(closeIssue).toHaveBeenCalledWith('i', 'duplicate')
  })
})

describe('IssueDecisionBand', () => {
  it('names the decision when the issue needs a human', () => {
    render(
      <IssueDecisionBand
        issue={makeIssue({ needsHuman: true, humanQuestion: 'Merge or send back?' })}
      />,
    )

    const band = screen.getByTestId('dock-decision-band')
    expect(band.textContent).toContain('Needs you')
    expect(band.textContent).toContain('Merge or send back?')
  })

  it('stays out of the way when nothing is waiting', () => {
    render(<IssueDecisionBand issue={makeIssue({})} />)
    expect(screen.queryByTestId('dock-decision-band')).toBeNull()
  })
})

describe('IssueGitScope', () => {
  it('omits unrelated shared checkout dirt', () => {
    render(
      <IssueGitScope
        issue={makeIssue({
          gitState: {
            updatedAt: '2026-07-22T00:00:00.000Z',
            branch: 'main',
            shared: true,
            dirtyFiles: 26,
            fallback: true,
          },
        })}
      />,
    )

    expect(screen.queryByText(/26 dirty/)).toBeNull()
  })
})
