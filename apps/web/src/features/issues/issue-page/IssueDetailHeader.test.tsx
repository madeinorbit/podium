// @vitest-environment happy-dom

/**
 * The header's job is TRANSIENT URGENCY: needs-you and how many agents are
 * computing. Git state is the rail's, once (POD-635) — the header chip and the
 * rail's Branch section were showing the same branch, the same merge axis and
 * the same dirty count side by side.
 */
import type { SessionMeta } from '@podium/model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssueDetailHeader } from './IssueDetailHeader'

vi.mock('@/app/store', () => ({ useReplicaIssues: () => [] }))

const working = (id: string): SessionMeta =>
  ({
    sessionId: id,
    issueId: 'issue',
    agentKind: 'codex',
    name: `Agent ${id}`,
    status: 'live',
    archived: false,
    lastActiveAt: '2026-08-10T12:00:00.000Z',
    agentState: { phase: 'working', since: '2026-08-10T12:00:00.000Z', nativeSubagentCount: 0 },
  }) as unknown as SessionMeta

const renderHeader = (sessions: SessionMeta[] = []): ReturnType<typeof render> =>
  render(
    <IssueDetailHeader
      issue={makeIssue({
        id: 'issue',
        branch: 'issue/628-bug-codex-terminal-reflow',
        worktreePath: '/repo/.worktrees/issue-628',
        gitState: {
          branch: 'issue/628-bug-codex-terminal-reflow',
          updatedAt: '2026-08-10T12:00:00.000Z',
          shared: false,
          dirtyFiles: 2,
        },
      })}
      repoName="podium"
      busy={false}
      commands={{} as never}
      targets={[]}
      sessions={sessions}
      onBack={vi.fn()}
      onNavigate={vi.fn()}
    />,
  )

afterEach(cleanup)

describe('IssueDetailHeader', () => {
  it('leaves git state to the rail', () => {
    const { container } = renderHeader()

    expect(container.querySelector('[data-testid="git-stamp"]')).toBeNull()
    expect(screen.queryByText(/issue\/628-bug-codex-terminal-reflow/)).toBeNull()
  })

  it('still reports what is waiting on the operator', () => {
    renderHeader([working('one')])

    expect(screen.getByText('1 working')).toBeTruthy()
  })
})
