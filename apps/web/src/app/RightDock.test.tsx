// @vitest-environment happy-dom

import type { IssueWire, SessionMeta } from '@podium/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RightDock } from './RightDock'

const selectedIssue = {
  id: 'selected',
  title: 'Selected closed issue',
  repoPath: '/repo',
  worktreePath: null,
  machineId: 'machine-selected',
} as IssueWire
const otherIssue = {
  id: 'other',
  title: 'Other live issue',
  repoPath: '/other',
  worktreePath: '/other/wt',
} as IssueWire
const otherSession = {
  sessionId: 'other-session',
  cwd: '/other/wt',
  issueId: otherIssue.id,
  archived: false,
  lastActiveAt: '2026-07-23T12:00:00.000Z',
} as SessionMeta

const state = {
  paneA: otherSession.sessionId,
  fileTabs: [],
  sessions: [otherSession],
  issues: [selectedIssue, otherIssue],
  selectedIssueId: selectedIssue.id,
}

vi.mock('./store', () => ({
  useStoreSelector: (selector: (store: typeof state) => unknown) => selector(state),
}))

vi.mock('@/features/issues/IssuePanelView', () => ({
  IssuePanelView: (props: { cwd: string; machineId?: string; issueId?: string }) => (
    <div
      data-testid="issue-panel"
      data-cwd={props.cwd}
      data-machine-id={props.machineId}
      data-issue-id={props.issueId}
    />
  ),
}))

afterEach(cleanup)

describe('RightDock task selection', () => {
  it('shows the selected issue when it has no active sessions', () => {
    render(<RightDock tab="issue" onClose={vi.fn()} />)

    const panel = screen.getByTestId('issue-panel')
    expect(panel.getAttribute('data-issue-id')).toBe(selectedIssue.id)
    expect(panel.getAttribute('data-cwd')).toBe(selectedIssue.repoPath)
    expect(panel.getAttribute('data-machine-id')).toBe(selectedIssue.machineId)
  })
})
