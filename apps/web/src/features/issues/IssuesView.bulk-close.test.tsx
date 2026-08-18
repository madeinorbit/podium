// @vitest-environment happy-dom

/**
 * The board's bulk status bar closes a whole SELECTION (POD-1126). Every other
 * close in the app asks first; this one used to fire on the pick, which made a
 * mis-picked "Done" over twelve rows the one close nothing could catch.
 */
import { asSessionId, type SessionMeta } from '@podium/model/browser'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuesView } from './IssuesView'

const closeIssue = vi.fn(async () => {})
const updateIssue = vi.fn(async () => {})

/** The real bar opens a Base UI menu to reach the terminal picks. This test is
 *  about what the HOST does with the pick, so the bar is reduced to the pick
 *  itself — the menu's own contents are `issueStatusMenuEntries`' business. */
vi.mock('./IssuesFilters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./IssuesFilters')>()
  return {
    ...actual,
    BulkBar: ({
      count,
      onStatus,
    }: {
      count: number
      onStatus: (value: string) => void
    }): JSX.Element => (
      <div>
        <button type="button" onClick={() => onStatus('close:done')}>
          bulk done ({count})
        </button>
        <button type="button" onClick={() => onStatus('stage:review')}>
          bulk review
        </button>
      </div>
    ),
  }
})

const working: SessionMeta = {
  sessionId: asSessionId('agent'),
  agentKind: 'claude-code',
  title: 'POD-1126-A',
  cwd: '/r/wt',
  status: 'live',
  agentState: { phase: 'working' },
  createdAt: 't',
  updatedAt: 't',
  unread: false,
  archived: false,
} as unknown as SessionMeta

const issues = [
  makeIssue({
    id: 'a',
    seq: 1,
    displayRef: 'POD-1',
    title: 'Still running',
    stage: 'in_progress',
    memberSessionIds: ['agent'],
  }),
  makeIssue({ id: 'b', seq: 2, displayRef: 'POD-2', title: 'Nothing pending', stage: 'review' }),
]

vi.mock('@/app/store', () => {
  // Built per read, not once: `vi.mock` is hoisted above every const in this
  // file, so a store captured at factory time would close over undefined spies.
  const store = () => ({
    openIssueId: null,
    setOpenIssueId: vi.fn(),
    trpc: { issues: { promote: { mutate: vi.fn(async () => {}) } } },
    updateIssue,
    setIssueLabels: vi.fn(async () => {}),
    deleteIssue: vi.fn(async () => {}),
    closeIssue,
    sessions: [working],
    // Display options are replicated; a client without the collection falls back
    // to the defaults, which is the board layout this test selects cards on.
    uiState: undefined,
  })
  return {
    useReplicaIssues: () => issues,
    useStoreSelector: (select: (s: unknown) => unknown) => select(store()),
  }
})

function selectBoth(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Select POD-1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Select POD-2' }))
}

afterEach(() => {
  cleanup()
  closeIssue.mockClear()
  updateIssue.mockClear()
})

describe('board bulk close guard (POD-1126)', () => {
  it('asks before closing a selection, naming the tasks that still hold work', () => {
    render(<IssuesView />)
    selectBoth()
    fireEvent.click(screen.getByRole('button', { name: /bulk done \(2\)/ }))

    expect(closeIssue).not.toHaveBeenCalled()
    const flagged = screen.getByTestId('issue-bulk-close-concerns').textContent ?? ''
    expect(flagged).toContain('POD-1')
    expect(flagged).toContain('still working')
    // The clean half is counted, not listed — and NOT flagged.
    expect(flagged).not.toContain('POD-2')
    expect(screen.getByText(/The other 1 task has nothing unresolved/)).toBeTruthy()
  })

  it('closes every selected task with the picked ending once confirmed', () => {
    render(<IssuesView />)
    selectBoth()
    fireEvent.click(screen.getByRole('button', { name: /bulk done/ }))
    fireEvent.click(screen.getByRole('button', { name: /Close 2 anyway/ }))

    expect(closeIssue.mock.calls).toEqual([
      ['a', 'done'],
      ['b', 'done'],
    ])
  })

  it('closes nothing when the guard is declined', () => {
    render(<IssuesView />)
    selectBoth()
    fireEvent.click(screen.getByRole('button', { name: /bulk done/ }))
    fireEvent.click(screen.getByRole('button', { name: /Keep open/ }))

    expect(closeIssue).not.toHaveBeenCalled()
  })

  // POD-1278. A selection of one is handed to the SINGLE-issue dialog, so it
  // follows the single-issue rule: the guard rises only when it has something to
  // name. The batch above keeps its dialog either way — its headline carries a
  // count of what is about to close.
  it('closes a lone tidy task on the press, with no guard in between', () => {
    render(<IssuesView />)
    fireEvent.click(screen.getByRole('button', { name: 'Select POD-2' }))
    fireEvent.click(screen.getByRole('button', { name: /bulk done \(1\)/ }))

    expect(closeIssue.mock.calls).toEqual([['b', 'done']])
    expect(screen.queryByText('Close this issue?')).toBeNull()
  })

  it('still asks about a lone task that holds work', () => {
    render(<IssuesView />)
    fireEvent.click(screen.getByRole('button', { name: 'Select POD-1' }))
    fireEvent.click(screen.getByRole('button', { name: /bulk done \(1\)/ }))

    expect(closeIssue).not.toHaveBeenCalled()
    expect(screen.getByTestId('issue-close-concerns').textContent).toContain('still working')
  })

  it('leaves the reversible lane arm immediate', () => {
    render(<IssuesView />)
    selectBoth()
    fireEvent.click(screen.getByRole('button', { name: /bulk review/ }))

    expect(screen.queryByTestId('issue-bulk-close-concerns')).toBeNull()
    expect(updateIssue.mock.calls).toEqual([
      ['a', { stage: 'review' }],
      ['b', { stage: 'review' }],
    ])
  })
})
