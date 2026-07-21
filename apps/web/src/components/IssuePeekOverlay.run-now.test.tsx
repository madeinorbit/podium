import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuePeekOverlay } from './IssuePeekOverlay'

// The drawer body is the full docked panel — not under test here.
vi.mock('@/features/issues/IssuePanelView', () => ({
  IssuePanelView: () => <div data-testid="panel-stub" />,
}))

const startMutate = vi.fn(async () => ({}))
const state: { peekIssueId: string | null; issues: unknown[] } = {
  peekIssueId: null,
  issues: [],
}

vi.mock('@/app/store', () => {
  const useStore = () => ({
    trpc: { issues: { start: { mutate: startMutate } } },
    peekIssueId: state.peekIssueId,
    setPeekIssueId: vi.fn(),
    issues: state.issues,
    sessions: [],
    paneA: null,
    fileTabs: [],
    setOpenIssueId: vi.fn(),
    setView: vi.fn(),
  })
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

afterEach(() => {
  cleanup()
  startMutate.mockClear()
  state.peekIssueId = null
  state.issues = []
})

describe('IssuePeekOverlay Run now (POD-110)', () => {
  it('offers Run now on a startable peeked issue and fires issues.start', () => {
    state.peekIssueId = 'i'
    state.issues = [makeIssue({ worktreePath: null, stage: 'backlog' })]
    render(<IssuePeekOverlay />)
    fireEvent.click(screen.getByTestId('peek-run-now'))
    expect(startMutate).toHaveBeenCalledWith({ id: 'i' })
  })

  it('hides Run now once the issue has a worktree', () => {
    state.peekIssueId = 'i'
    state.issues = [makeIssue()] // worktreePath set by default
    render(<IssuePeekOverlay />)
    expect(screen.queryByTestId('peek-run-now')).toBeNull()
  })

  it('hides Run now on a closed issue', () => {
    state.peekIssueId = 'i'
    state.issues = [makeIssue({ worktreePath: null, closedReason: 'done' })]
    render(<IssuePeekOverlay />)
    expect(screen.queryByTestId('peek-run-now')).toBeNull()
  })
})
