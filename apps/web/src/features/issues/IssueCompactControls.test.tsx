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

describe('IssueCompactControls', () => {
  it('carries no chip at all when the task needs a human', () => {
    mockSessions = [session({ sessionId: 'coord' })]
    render(<IssueCompactControls issue={makeIssue({ id: 'i', needsHuman: true })} />)

    expect(screen.queryByTestId('task-primary-action')).toBeNull()
  })

  it('takes the filled chip for Work on this when the state resolved no action', () => {
    // The panel keeps its one-filled-object rule: with no primary action of its
    // own — the needs-you case, now that Answer is gone — the crossing into the
    // work tool is the thing to press, so it is the thing that is filled.
    const onWorkOnThis = vi.fn()
    render(
      <IssueCompactControls
        issue={makeIssue({ id: 'i', needsHuman: true })}
        onWorkOnThis={onWorkOnThis}
      />,
    )

    const work = screen.getByTestId('task-work-on-this')
    expect(work.className).toContain('btn-primary-rim')
    fireEvent.click(work)
    expect(onWorkOnThis).toHaveBeenCalledTimes(1)
  })

  it('stands the work crossing down beside a real action, and hides it on a closed task', () => {
    render(<IssueCompactControls issue={makeIssue({ id: 'i' })} onWorkOnThis={vi.fn()} />)
    // Nothing is on this task, so Start work is the filled chip and the crossing
    // is the outline beside it.
    expect(screen.getByTestId('task-primary-action').textContent).toBe('Start work')
    expect(screen.getByTestId('task-work-on-this').className).not.toContain('btn-primary-rim')

    cleanup()
    render(
      <IssueCompactControls
        issue={makeIssue({ id: 'i', closedReason: 'done' })}
        onWorkOnThis={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('task-work-on-this')).toBeNull()
  })

  it('offers no crossing where there is nowhere to go', () => {
    // The workspace's own dock hands in no callback: it is already the work
    // tool, so a button pointing at it would land where you stand.
    render(<IssueCompactControls issue={makeIssue({ id: 'i', needsHuman: true })} />)

    expect(screen.queryByTestId('task-work-on-this')).toBeNull()
  })

  it('carries no primary chip while sessions are working the task', () => {
    mockSessions = [session({ sessionId: 'coord' })]
    render(<IssueCompactControls issue={makeIssue({ id: 'i' })} />)

    expect(screen.queryByTestId('task-primary-action')).toBeNull()
  })

  it('starts the agent when the task has none', () => {
    render(<IssueCompactControls issue={makeIssue({ id: 'i' })} />)

    const action = screen.getByTestId('task-primary-action')
    expect(action.textContent).toBe('Start work')
    fireEvent.click(action)
    expect(start).toHaveBeenCalledWith({ id: 'i' })
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
    const proposal = makeIssue({
      id: 'i',
      stage: 'proposed',
      startedBySession: 's-agent',
      deps: [{ id: 'origin', type: 'discovered-from' }],
    })

    it('is absent on a plain task — there is nowhere else for it to live', () => {
      render(<IssueCompactControls issue={makeIssue({ id: 'i' })} />)
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
  // bare stage write: the entry hands off to the guard dialog so a reason is
  // recorded.
  it('routes the status menu terminal entries through the guard dialog', async () => {
    render(<IssueCompactControls issue={makeIssue({ id: 'i' })} />)

    fireEvent.click(screen.getByLabelText('Status'))
    fireEvent.click(await screen.findByText('Done'))

    expect(await screen.findByText('Close this issue?')).toBeTruthy()
  })

  it('confirms the close through the optimistic store action', async () => {
    render(<IssueCompactControls issue={makeIssue({ id: 'i' })} />)

    fireEvent.click(screen.getByLabelText('Status'))
    fireEvent.click(await screen.findByText('Done'))
    fireEvent.click(await screen.findByText('Close issue'))

    expect(closeIssue).toHaveBeenCalledWith('i', 'done')
  })

  // POD-1074: cancelled and duplicate are their own endings, not one "wontfix".
  it('closes as cancelled from the status menu', async () => {
    render(<IssueCompactControls issue={makeIssue({ id: 'i' })} />)

    fireEvent.click(screen.getByLabelText('Status'))
    fireEvent.click(await screen.findByText('Cancelled'))
    fireEvent.click(await screen.findByText('Close as cancelled'))

    expect(closeIssue).toHaveBeenCalledWith('i', 'cancelled')
  })

  it('closes as duplicate from the status menu', async () => {
    render(<IssueCompactControls issue={makeIssue({ id: 'i' })} />)

    fireEvent.click(screen.getByLabelText('Status'))
    fireEvent.click(await screen.findByText('Duplicate'))
    fireEvent.click(await screen.findByText('Close as duplicate'))

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
