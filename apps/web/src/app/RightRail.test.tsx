import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'

const portfolioIssues = vi.hoisted(() => ({ value: [] as unknown[] }))
const portfolioSessions = vi.hoisted(() => ({ value: [] as unknown[] }))
vi.mock('./store', () => ({
  useReplicaIssues: () => portfolioIssues.value,
  useStoreSelector: (selector: (store: { sessions: unknown[] }) => unknown) =>
    selector({ sessions: portfolioSessions.value }),
}))

import { RightRail } from './RightRail'

const featureEnabled = vi.hoisted(() => ({ value: true }))
vi.mock('@/lib/use-feature', () => ({
  useFeature: () => featureEnabled.value,
}))

afterEach(() => {
  cleanup()
  featureEnabled.value = true
  portfolioIssues.value = []
  portfolioSessions.value = []
})

describe('RightRail', () => {
  it('switches one panel at a time and exposes Superagent in the rail', () => {
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel={null} onPanelChange={onPanelChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Files' }))

    expect(onPanelChange).toHaveBeenLastCalledWith('files')

    fireEvent.click(screen.getByRole('button', { name: 'Superagent' }))
    expect(onPanelChange).toHaveBeenLastCalledWith('superagent')
  })

  // Moving the Superagent out of its own column removed the one place the
  // shell always showed how much was waiting on the human. The rail cell
  // carries that count instead — and it must be the app's own corner badge, so
  // it matches the ID square's badge 50px above it rather than inventing a
  // second numbered-badge language on the same 44px rail.
  //
  // POD-516 removed the web Tray, which used to be where the number came from.
  // The count is the PORTFOLIO attention count now — every task anywhere that
  // needs a decision — which is what the copilot's own copy claims it is.
  it('carries the portfolio attention count on the Superagent cell', () => {
    portfolioIssues.value = [
      makeIssue({ id: 'a', needsHuman: true }),
      // Review-ready work needs a decision too — the same predicate the Flight
      // Deck's "Needs you" filter uses.
      makeIssue({ id: 'b', stage: 'review' }),
      makeIssue({ id: 'quiet' }),
    ]
    render(<RightRail rightPanel={null} onPanelChange={vi.fn()} />)
    expect(screen.getByRole('img', { name: '2 waiting on you' })).toBeTruthy()
  })

  it('never counts finished or dead work — a closed task keeps no claim on you', () => {
    portfolioIssues.value = [
      makeIssue({ id: 'done', stage: 'done', needsHuman: true }),
      makeIssue({ id: 'closed', closedReason: 'superseded', needsHuman: true }),
      makeIssue({ id: 'archived', archived: true, needsHuman: true }),
      makeIssue({ id: 'gone', deletedAt: 't', needsHuman: true }),
    ]
    render(<RightRail rightPanel={null} onPanelChange={vi.fn()} />)
    expect(screen.queryByRole('img', { name: /waiting on you/ })).toBeNull()
  })

  // The first cut of this badge resolved an issue's sessions through
  // `memberSessionIds` only. `session.issueId` is the common attachment, so an
  // agent that stopped on a question was counted by the Flight Deck's "Needs
  // you" filter and NOT by the badge that summarizes it. Same selector now.
  it('counts an agent attached by session.issueId, not just by memberSessionIds', () => {
    portfolioIssues.value = [makeIssue({ id: 'a', memberSessionIds: [] })]
    portfolioSessions.value = [
      {
        sessionId: 's1',
        issueId: 'a',
        agentKind: 'claude-code',
        status: 'live',
        cwd: '/r/wt',
        createdAt: 't',
        lastActiveAt: 't',
        agentState: { phase: 'needs_user', since: 't', nativeSubagentCount: 0 },
      },
    ]
    render(<RightRail rightPanel={null} onPanelChange={vi.fn()} />)
    expect(screen.getByRole('img', { name: '1 waiting on you' })).toBeTruthy()
  })

  it('shows no badge when nothing is waiting', () => {
    render(<RightRail rightPanel={null} onPanelChange={vi.fn()} />)
    expect(screen.queryByRole('img', { name: /waiting on you/ })).toBeNull()
  })

  it('hides experimental panels behind their feature flags', () => {
    featureEnabled.value = false
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel={null} onPanelChange={onPanelChange} />)

    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Messages' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Queues' })).toBeNull()
  })

  it('toggles the active panel closed', () => {
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel="shell" onPanelChange={onPanelChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Shell' }))
    expect(onPanelChange).toHaveBeenCalledWith(null)
  })

  it('opens the opt-in queues panel when its feature is enabled', () => {
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel={null} onPanelChange={onPanelChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Queues' }))
    expect(onPanelChange).toHaveBeenCalledWith('merge-queue')
  })

  // POD-743: the Tasks cell is an ordinary rail cell now. The panel it opens is
  // an explorer over every task in the repo, so the selected issue's coloured
  // ID square — and the working/waiting badge it carried — named a task this
  // panel is not about and reported on an agent it does not show.
  it('opens the explorer from a plain Tasks cell, with no issue identity on it', () => {
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel={null} onPanelChange={onPanelChange} />)

    expect(screen.queryByTestId('issue-id-square')).toBeNull()
    const cell = screen.getByRole('button', { name: 'Tasks' })
    fireEvent.click(cell)
    expect(onPanelChange).toHaveBeenLastCalledWith('issue')
  })

  it('toggles the explorer closed when it is already open', () => {
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel="issue" onPanelChange={onPanelChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    expect(onPanelChange).toHaveBeenLastCalledWith(null)
  })

  // POD-516 item 9: the right dock and its rail are a DARK DEFAULT surface.
  it('wears no issue tint', () => {
    render(<RightRail rightPanel={null} onPanelChange={vi.fn()} />)
    const rail = screen.getByTestId('right-rail')
    expect(rail.className).not.toContain('issue-fade')
    expect(rail.className).not.toContain('issue-base-')
  })
})
