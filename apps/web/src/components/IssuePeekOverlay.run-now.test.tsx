import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuePeekOverlay } from './IssuePeekOverlay'

// The drawer body is the full docked panel — not under test here.
vi.mock('@/features/issues/IssuePanelView', () => ({
  IssuePanelView: ({ issueId }: { issueId: string }) => (
    <div data-testid="panel-stub" data-issue-id={issueId} />
  ),
}))

const state: { peekIssueId: string | null; issues: unknown[] } = {
  peekIssueId: null,
  issues: [],
}

vi.mock('@/app/store', () => {
  const useStore = () => ({
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
  state.peekIssueId = null
  state.issues = []
})

describe('IssuePeekOverlay compact shell', () => {
  it('delegates issue identity and actions to the shared compact panel', () => {
    state.peekIssueId = 'i'
    state.issues = [makeIssue({ worktreePath: null, stage: 'backlog' })]
    render(<IssuePeekOverlay />)

    expect(screen.getByText('Issue peek')).toBeTruthy()
    expect(screen.getByTestId('panel-stub').getAttribute('data-issue-id')).toBe('i')
    expect(screen.queryByTestId('peek-run-now')).toBeNull()
  })

  it('explains an archived issue instead of mounting contradictory controls', () => {
    state.peekIssueId = 'i'
    state.issues = [makeIssue({ archived: true })]
    render(<IssuePeekOverlay />)

    expect(screen.getByText('This issue is archived.')).toBeTruthy()
    expect(screen.queryByTestId('panel-stub')).toBeNull()
  })
})
