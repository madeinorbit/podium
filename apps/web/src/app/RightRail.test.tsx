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

  // The Superagent cell carried the portfolio attention count for as long as
  // the Superagent was in the rail. Pinned to that glyph the number claimed to
  // be about the superagent, which it never was — it counted tasks anywhere
  // waiting on a decision. It is gone from the rail; the Flight Deck's "Needs
  // you" filter and the explorer's Needs tab still report the same figure where
  // it is attached to the work it describes.
  it('reports on nothing — no cell wears a count, waiting work or not', () => {
    portfolioIssues.value = [
      makeIssue({ id: 'a', needsHuman: true }),
      makeIssue({ id: 'b', stage: 'review' }),
    ]
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
