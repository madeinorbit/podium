// @vitest-environment happy-dom
import { LOADING } from '@podium/client-graph/loading'
import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BodyPending } from './BodyPending'
import { IssueLoadingBlock } from './IssueLoadingBlock'

let offline = false
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => ({ collections: { reading: () => (offline ? 'offline' : 'loading') } }),
}))

function Sections({ pending = 3 }: { pending?: number }) {
  return (
    <IssueLoadingBlock>
      {['description', 'state line', 'issue panel'].map((what, index) =>
        index < pending ? (
          <BodyPending key={what} value={LOADING} what={what} />
        ) : (
          <button key={what} type="button">
            {what}
          </button>
        ),
      )}
    </IssueLoadingBlock>
  )
}

beforeEach(() => {
  offline = false
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the issue document loading block', () => {
  it('waits 300ms, then shows one placeholder for three pending sections', () => {
    render(<Sections />)
    expect(screen.queryByRole('status')).toBeNull()
    act(() => vi.advanceTimersByTime(299))
    expect(screen.queryByRole('status')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Loading issue details')
    expect(screen.getByTestId('issue-loading-block').getAttribute('aria-busy')).toBe('true')
  })

  it('never flashes a placeholder for a fast load', () => {
    const view = render(<Sections />)
    act(() => vi.advanceTimersByTime(200))
    view.rerender(<Sections pending={0} />)
    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'description' })).toBeTruthy()
    expect(screen.getByTestId('issue-loading-block').getAttribute('aria-busy')).toBe('false')
  })

  it('keeps partial content inaccessible until every pending section settles', () => {
    const view = render(<Sections />)
    act(() => vi.advanceTimersByTime(300))
    view.rerender(<Sections pending={1} />)
    expect(screen.queryByRole('button', { name: 'state line' })).toBeNull()
    expect(screen.getByTestId('issue-section-content').hasAttribute('inert')).toBe(true)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    view.rerender(<Sections pending={0} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByTestId('issue-section-content').hasAttribute('inert')).toBe(false)
  })

  it('shows settled unavailable and offline lines without a loading placeholder', () => {
    offline = true
    render(
      <IssueLoadingBlock>
        <BodyPending value={LOADING} what="description" unavailable />
        <BodyPending value={LOADING} what="sessions" />
      </IssueLoadingBlock>,
    )
    expect(screen.getByLabelText('Description: not available')).toBeTruthy()
    expect(screen.getByText('Not available offline')).toBeTruthy()
    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByLabelText('Loading issue details')).toBeNull()
    expect(screen.getByTestId('issue-loading-block').getAttribute('aria-busy')).toBe('false')
  })

  it('restarts the delay on issue navigation and balances StrictMode registrations', () => {
    const view = render(
      <StrictMode>
        <Sections key="first" />
      </StrictMode>,
    )
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getAllByRole('status')).toHaveLength(1)
    view.rerender(
      <StrictMode>
        <Sections key="second" />
      </StrictMode>,
    )
    expect(screen.queryByRole('status')).toBeNull()
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getAllByRole('status')).toHaveLength(1)
    view.rerender(
      <StrictMode>
        <Sections key="second" pending={0} />
      </StrictMode>,
    )
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })
})
