// @vitest-environment happy-dom

import type { SessionMeta } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssueNow } from './IssueNow'

const session = (id: string): SessionMeta =>
  ({
    sessionId: id,
    issueId: 'issue',
    agentKind: 'codex',
    name: `Agent ${id}`,
    status: 'live',
    archived: false,
    lastActiveAt: '2026-08-08T12:00:00.000Z',
    agentState: {
      phase: 'working',
      since: '2026-08-08T12:00:00.000Z',
      nativeSubagentCount: 0,
    },
  }) as unknown as SessionMeta

afterEach(cleanup)

describe('IssueNow', () => {
  it('keeps the live summary compact and leaves branch state to the rail', () => {
    const open = vi.fn()
    const issue = makeIssue({
      id: 'issue',
      branch: 'issue/641-task-detail-visual-polish',
      gitState: {
        branch: 'issue/641-task-detail-visual-polish',
        updatedAt: '2026-08-08T12:00:00.000Z',
        shared: false,
        dirtyFiles: 2,
      },
    })

    render(
      <IssueNow
        issue={issue}
        sessions={[session('one'), session('two'), session('three')]}
        onOpenSession={open}
      />,
    )

    expect(screen.getByText('Agent one')).toBeTruthy()
    expect(screen.getByText('Agent two')).toBeTruthy()
    expect(screen.queryByText('Agent three')).toBeNull()
    expect(screen.getByText('1 more session — see the roster')).toBeTruthy()
    expect(screen.queryByText('issue/641-task-detail-visual-polish')).toBeNull()

    fireEvent.click(screen.getByText('Agent one'))
    expect(open).toHaveBeenCalledWith('one')
  })

  it('does not create a duplicate branch-only block', () => {
    const issue = makeIssue({
      branch: 'issue/641-task-detail-visual-polish',
      worktreePath: '/repo/.worktrees/issue-641',
    })
    const { container } = render(<IssueNow issue={issue} sessions={[]} onOpenSession={vi.fn()} />)

    expect(container.innerHTML).toBe('')
  })
})
