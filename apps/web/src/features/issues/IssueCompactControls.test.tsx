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

vi.mock('@/app/store', () => {
  const state = () => ({
    trpc: {
      issues: {
        start: { mutate: start },
        close: { mutate: vi.fn(async () => ({})) },
        update: { mutate: vi.fn(async () => ({})) },
        clearNeedsHuman: { mutate: vi.fn(async () => ({})) },
      },
      sessions: { sendText: { mutate: vi.fn(async () => ({})) } },
    },
    issues: [],
    setOpenIssueId,
    setView,
    navigateToSession,
    archiveSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
    markIssueRead: vi.fn(),
    markIssueUnread: vi.fn(),
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
  vi.clearAllMocks()
})

// The head offers exactly ONE primary action, and which one is a pure function
// of the issue's own state — the operator never has to choose between three
// buttons to find the next move.
describe('resolveTaskAction', () => {
  it('answers when the task needs a human', () => {
    expect(resolveTaskAction(makeIssue({ needsHuman: true }), [session()])).toEqual({
      kind: 'answer',
      label: 'Answer',
      warn: true,
    })
  })

  it('offers to close a handed-off origin rather than answer it', () => {
    // The work moved to the spin-off and no session is left here, so there is
    // nobody to answer — the only decision left is whether to close.
    const issue = makeIssue({
      stage: 'review',
      dependents: [{ id: 'spin', type: 'discovered-from' }],
    })
    expect(resolveTaskAction(issue, [])).toEqual({
      kind: 'mark-done',
      label: 'Mark done',
      warn: true,
    })
  })

  it('opens the coordinator when live sessions are working it', () => {
    expect(resolveTaskAction(makeIssue({}), [session()])).toEqual({
      kind: 'open-coordinator',
      label: 'Open coordinator',
      warn: false,
    })
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
  it('carries the warn treatment on the needs-you action', () => {
    render(<IssueCompactControls issue={makeIssue({ id: 'i', needsHuman: true })} />)

    const action = screen.getByTestId('task-primary-action')
    expect(action.dataset.action).toBe('answer')
    expect(action.textContent).toBe('Answer')
    expect(action.className).toContain('amber')
  })

  it('sends the primary action to the coordinator session', () => {
    mockSessions = [
      session({ sessionId: 'old', lastActiveAt: '2026-08-01T00:00:00.000Z' }),
      session({ sessionId: 'coord' }),
    ]
    render(<IssueCompactControls issue={makeIssue({ id: 'i', coordinatorSessionId: 'coord' })} />)

    fireEvent.click(screen.getByTestId('task-primary-action'))
    expect(navigateToSession).toHaveBeenCalledWith('coord')
  })

  it('starts the agent when the task has none', () => {
    render(<IssueCompactControls issue={makeIssue({ id: 'i' })} />)

    const action = screen.getByTestId('task-primary-action')
    expect(action.textContent).toBe('Start work')
    fireEvent.click(action)
    expect(start).toHaveBeenCalledWith({ id: 'i' })
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
