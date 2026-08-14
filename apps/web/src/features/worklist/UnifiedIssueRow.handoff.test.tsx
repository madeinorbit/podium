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

    expect(screen.getByText('work continued in POD-815')).toBeTruthy()
    expect(screen.queryByTestId('spinoff-origin-tick')).toBeNull()
  })
})
