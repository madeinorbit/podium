// @vitest-environment happy-dom
import type { UnifiedIssueRow as UnifiedIssueRowView } from '@podium/client-core/viewmodels'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { UnifiedIssueRow } from './UnifiedIssueRow'

afterEach(cleanup)

describe('UnifiedIssueRow handoff copy', () => {
  it('names the forward continuation instead of showing done plus backward provenance', () => {
    const origin = makeIssue({
      id: 'origin',
      seq: 766,
      displayRef: 'POD-766',
      title: 'Original task',
    })
    const replacement = makeIssue({
      id: 'next',
      seq: 815,
      displayRef: 'POD-815',
      title: 'Replacement task',
    })
    const moved = makeIssue({
      id: 'moved',
      seq: 813,
      displayRef: 'POD-813',
      title: 'Superseded task',
      stage: 'done',
      closedReason: 'superseded',
      supersededBy: 'next',
      deps: [{ id: 'origin', type: 'discovered-from' }],
    })
    const row = {
      kind: 'issue',
      issue: moved,
      sessions: [],
      activityAt: Date.parse('2026-08-12T11:52:04.000Z'),
      // Stamped by the worklist slice, which owns the graph walk (POD-1193);
      // `rows.test.ts` covers that it is derived, this covers what it renders.
      continuation: 'continued · POD-815',
    } as UnifiedIssueRowView

    render(
      <UnifiedIssueRow
        row={row}
        sessions={[]}
        issues={[origin, moved, replacement]}
        allWorktreePaths={[]}
        selectedIssueId={null}
        paneA={null}
        now={Date.parse('2026-08-12T12:00:00.000Z')}
        onSelectIssue={vi.fn()}
        onSelectPanelForIssue={vi.fn()}
        onOpenIssue={vi.fn()}
        onRenameIssue={vi.fn()}
      />,
    )

    expect(screen.getByText('continued · POD-815')).toBeTruthy()
    expect(screen.queryByTestId('spinoff-origin-tick')).toBeNull()
  })

  /**
   * POD-1193, the row from the report — POD-1158 after it shipped, merged, and
   * handed its leftovers to a spin-off. Every fact on it was true and the row
   * still said the wrong thing three ways: amber "needs review" for a verdict
   * nothing could deliver, "1 commit ahead" for work already landed, and no
   * mention of where the agent actually went.
   */
  it('a shipped, merged, vacated row asks for nothing and says where the work went', () => {
    const shipped = makeIssue({
      id: 'shipped',
      seq: 1158,
      displayRef: 'POD-1158',
      title: 'Chat feed motion',
      stage: 'review',
      branch: null,
      gitState: {
        updatedAt: '2026-08-17T12:15:29.907Z',
        branch: 'worktree-POD-1158-chat-motion',
        shared: false,
        // Landed, and STILL one commit past a frozen cut-parent (POD-576).
        merged: true,
        ahead: 1,
        dirtyFiles: 4,
      },
    })
    const row = {
      kind: 'issue',
      issue: shipped,
      sessions: [],
      activityAt: Date.parse('2026-08-17T12:15:29.000Z'),
      continuation: 'continued · POD-1192',
    } as UnifiedIssueRowView

    render(
      <UnifiedIssueRow
        row={row}
        sessions={[]}
        issues={[shipped]}
        allWorktreePaths={[]}
        selectedIssueId={null}
        paneA={null}
        now={Date.parse('2026-08-17T12:18:00.000Z')}
        onSelectIssue={vi.fn()}
        onSelectPanelForIssue={vi.fn()}
        onOpenIssue={vi.fn()}
        onRenameIssue={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('needs-review-status')).toBeNull()
    expect(screen.getByText('continued · POD-1192')).toBeTruthy()
    const stamp = screen.getByTestId('git-stamp')
    expect(stamp.textContent).toContain('merged')
    expect(stamp.textContent).not.toContain('ahead')
  })
})
