import type { IssueWire } from '@podium/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssueListView } from './IssueListView'
import type { IssueRow } from './issue-hierarchy'
import { DEFAULT_DISPLAY } from './issues-display'
import { ISSUE_RENDER_CHUNK } from './progressive-render'

afterEach(cleanup)

function issue(index: number): IssueWire {
  return {
    id: `issue-${index}`,
    repoPath: '/repo',
    seq: index + 1,
    title: `Task ${index}`,
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    priority: 2,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    archived: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    origin: 'human',
    draft: false,
  } as unknown as IssueWire
}

function rows(count: number): IssueRow[] {
  return Array.from({ length: count }, (_, index) => ({
    issue: issue(index),
    depth: 0,
    childCount: 0,
    expanded: false,
  }))
}

const baseProps = {
  display: { ...DEFAULT_DISPLAY, layout: 'list' as const },
  onOpen: vi.fn(),
  onCreateIn: vi.fn(),
  focusId: null,
  selected: [] as string[],
  onToggleSelect: vi.fn(),
  onToggleExpand: vi.fn(),
  onContextMenu: vi.fn(),
}

describe('IssueListView progressive rendering', () => {
  it('mounts one chunk and reveals the next chunk on request', () => {
    const { container } = render(
      <IssueListView groups={[{ stage: 'backlog', rows: rows(95) }]} {...baseProps} />,
    )

    expect(container.querySelectorAll('[data-issue-id]')).toHaveLength(ISSUE_RENDER_CHUNK)
    fireEvent.click(screen.getByRole('button', { name: 'Show 40 more tasks (55 remaining)' }))
    expect(container.querySelectorAll('[data-issue-id]')).toHaveLength(80)
    expect(screen.getByRole('button', { name: 'Show 15 more tasks (15 remaining)' })).toBeDefined()
  })

  it('resets a stale large reveal when a filtered stage is restored', () => {
    const large = [{ stage: 'backlog' as const, rows: rows(95) }]
    const { container, rerender } = render(<IssueListView groups={large} {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show 40 more tasks (55 remaining)' }))
    expect(container.querySelectorAll('[data-issue-id]')).toHaveLength(80)

    rerender(<IssueListView groups={[{ stage: 'backlog', rows: rows(5) }]} {...baseProps} />)
    expect(container.querySelectorAll('[data-issue-id]')).toHaveLength(5)

    rerender(<IssueListView groups={large} {...baseProps} />)
    expect(container.querySelectorAll('[data-issue-id]')).toHaveLength(ISSUE_RENDER_CHUNK)
  })

  it('mounts a focused issue beyond the ordinary boundary without truncating nav order', () => {
    const group = [{ stage: 'backlog' as const, rows: rows(95) }]
    const { container, rerender } = render(<IssueListView groups={group} {...baseProps} />)

    rerender(<IssueListView groups={group} {...baseProps} focusId="issue-70" />)
    expect(container.querySelectorAll('[data-issue-id]')).toHaveLength(71)
    expect(container.querySelector('[data-issue-id="issue-70"]')).not.toBeNull()
  })

  it('keeps row click behavior unchanged inside the mounted prefix', () => {
    const onOpen = vi.fn()
    const { container } = render(
      <IssueListView
        groups={[{ stage: 'backlog', rows: rows(95) }]}
        {...baseProps}
        onOpen={onOpen}
      />,
    )

    fireEvent.click(container.querySelector('[data-issue-id="issue-0"]') as HTMLElement)
    expect(onOpen).toHaveBeenCalledWith('issue-0')
  })

  it('reveals children inserted beyond the current boundary when their parent expands', () => {
    function ExpansionHarness() {
      const [expanded, setExpanded] = useState(false)
      const parentIssue = issue(39)
      parentIssue.title = 'Boundary parent'
      const parent: IssueRow = {
        issue: parentIssue,
        depth: 0,
        childCount: 1,
        expanded,
      }
      const childIssue = issue(40)
      childIssue.title = 'Boundary child'
      const child: IssueRow = {
        issue: childIssue,
        depth: 1,
        childCount: 0,
        expanded: false,
      }
      const groupRows = [...rows(39), parent, ...(expanded ? [child] : [])]
      return (
        <IssueListView
          groups={[{ stage: 'backlog', rows: groupRows }]}
          {...baseProps}
          onToggleExpand={() => setExpanded((value) => !value)}
        />
      )
    }

    const { container } = render(<ExpansionHarness />)
    expect(container.querySelectorAll('[data-issue-id]')).toHaveLength(ISSUE_RENDER_CHUNK)
    fireEvent.click(screen.getByRole('button', { name: 'Expand Boundary parent' }))
    expect(screen.getByText('Boundary child')).toBeDefined()
    expect(container.querySelectorAll('[data-issue-id]')).toHaveLength(ISSUE_RENDER_CHUNK + 1)
  })
})
