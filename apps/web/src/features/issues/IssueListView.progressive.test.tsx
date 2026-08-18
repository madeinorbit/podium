import type { IssueWire } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssueListView } from './IssueListView'
import type { IssueRow } from './issue-hierarchy'
import { DEFAULT_DISPLAY } from './issues-display'
import { ISSUE_VIRTUAL_MAX_ITEMS } from './use-bounded-virtual-list'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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
    blockedByNotes: [],
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
  onStatusPick: vi.fn(),
}

describe('IssueListView bounded rendering', () => {
  it('keeps the 674-row list DOM and accessibility metadata bounded', () => {
    const { container } = render(
      <IssueListView groups={[{ stage: 'backlog', rows: rows(674) }]} {...baseProps} />,
    )

    const mounted = container.querySelectorAll('[data-issue-id]')
    expect(mounted.length).toBeLessThanOrEqual(ISSUE_VIRTUAL_MAX_ITEMS)
    expect(mounted[0]?.parentElement?.getAttribute('aria-posinset')).toBe('1')
    expect(mounted[0]?.parentElement?.getAttribute('aria-setsize')).toBe('674')
    expect(screen.queryByText(/more tasks/)).toBeNull()
  })

  it('mounts and scrolls a focused issue without retaining its prefix', () => {
    const group = [{ stage: 'backlog' as const, rows: rows(95) }]
    const { container, rerender } = render(<IssueListView groups={group} {...baseProps} />)
    const scroll = screen.getByTestId('issues-list')
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 240 })

    rerender(<IssueListView groups={group} {...baseProps} focusId="issue-70" />)
    expect(container.querySelectorAll('[data-issue-id]').length).toBeLessThanOrEqual(
      ISSUE_VIRTUAL_MAX_ITEMS + 1,
    )
    expect(container.querySelector('[data-issue-id="issue-70"]')).not.toBeNull()
    expect(scroll.scrollTop).toBeGreaterThan(2_000)
  })

  it('keeps click and context-menu routing on windowed rows', () => {
    const onOpen = vi.fn()
    const onContextMenu = vi.fn()
    const { container } = render(
      <IssueListView
        groups={[{ stage: 'backlog', rows: rows(95) }]}
        {...baseProps}
        onOpen={onOpen}
        onContextMenu={onContextMenu}
      />,
    )

    const first = container.querySelector('[data-issue-id="issue-0"]') as HTMLElement
    fireEvent.click(first)
    fireEvent.contextMenu(first)
    expect(onOpen).toHaveBeenCalledWith('issue-0')
    expect(onContextMenu).toHaveBeenCalledWith('issue-0', expect.anything())
    expect(first.parentElement?.getAttribute('aria-posinset')).toBe('1')
    expect(first.parentElement?.getAttribute('aria-setsize')).toBe('95')
  })

  it('restores and reports the list scroll position across layout remounts', () => {
    const onScrollTop = vi.fn()
    render(
      <IssueListView
        groups={[{ stage: 'backlog', rows: rows(95) }]}
        {...baseProps}
        initialScrollTop={1_200}
        onScrollTop={onScrollTop}
      />,
    )
    const scroll = screen.getByTestId('issues-list')
    expect(scroll.scrollTop).toBe(1_200)
    scroll.scrollTop = 1_450
    fireEvent.scroll(scroll)
    expect(onScrollTop).toHaveBeenLastCalledWith(1_450)
  })

  it('restores selected styling when a row leaves and re-enters the list scope', () => {
    const group = [{ stage: 'backlog' as const, rows: rows(95) }]
    const { container, rerender } = render(
      <IssueListView groups={group} {...baseProps} selected={['issue-3']} />,
    )
    expect(container.querySelector('[data-issue-id="issue-3"]')?.className).toContain(
      'issue-mix-20',
    )

    rerender(
      <IssueListView
        groups={[{ stage: 'backlog', rows: rows(95).slice(20) }]}
        {...baseProps}
        selected={['issue-3']}
      />,
    )
    expect(container.querySelector('[data-issue-id="issue-3"]')).toBeNull()

    rerender(<IssueListView groups={group} {...baseProps} selected={['issue-3']} />)
    expect(container.querySelector('[data-issue-id="issue-3"]')?.className).toContain(
      'issue-mix-20',
    )
  })

  it('mounts children inserted at the current window boundary when their parent expands', () => {
    vi.useFakeTimers()
    function ExpansionHarness() {
      const [expanded, setExpanded] = useState(false)
      const boundary = 15
      const parentIssue = issue(boundary)
      parentIssue.title = 'Boundary parent'
      const parent: IssueRow = {
        issue: parentIssue,
        depth: 0,
        childCount: 1,
        expanded,
      }
      const childIssue = issue(boundary + 1)
      childIssue.title = 'Boundary child'
      const child: IssueRow = {
        issue: childIssue,
        depth: 1,
        childCount: 0,
        expanded: false,
      }
      const groupRows = [...rows(boundary), parent, ...(expanded ? [child] : [])]
      return (
        <IssueListView
          groups={[{ stage: 'backlog', rows: groupRows }]}
          {...baseProps}
          onToggleExpand={() => setExpanded((value) => !value)}
        />
      )
    }

    const { container } = render(<ExpansionHarness />)
    const scroll = screen.getByTestId('issues-list')
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 600 })
    fireEvent.scroll(scroll)
    act(() => vi.runOnlyPendingTimers())
    expect(container.querySelectorAll('[data-issue-id]')).toHaveLength(16)
    fireEvent.click(screen.getByRole('button', { name: 'Expand Boundary parent' }))
    act(() => vi.runOnlyPendingTimers())
    expect(screen.getByText('Boundary child')).toBeDefined()
    expect(container.querySelectorAll('[data-issue-id]')).toHaveLength(17)
  })
})
