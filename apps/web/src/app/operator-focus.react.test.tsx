// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  issues: [{ id: 'root', parentId: null }] as Array<{ id: string; parentId: string | null }>,
  workspaces: { 'mission:root': { deck: { focusedIssueId: 'late-child' } } },
  update: vi.fn(),
}))

vi.mock('./store', () => ({
  useStoreSelector: (selector: (state: unknown) => unknown) => selector({
    workspaces: fixture.workspaces,
    workspaceKey: () => 'mission:root',
    updateWorkspaceDeck: fixture.update,
    sessions: [],
  }),
  useReplicaIssues: () => fixture.issues,
}))

const { OperatorFocusProvider, useOperatorFocus } = await import('./operator-focus')

function Probe(): ReactElement {
  const focus = useOperatorFocus()
  return <output data-testid="focus">{focus.focusedIssueId}:{focus.focusLoading ? 'loading' : 'ready'}</output>
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  fixture.issues = [{ id: 'root', parentId: null }]
  fixture.workspaces = { 'mission:root': { deck: { focusedIssueId: 'late-child' } } }
  fixture.update.mockClear()
})

describe('saved inspector resolution', () => {
  it('keeps an unknown child loading until the issue arrives, without rewriting focus', () => {
    const view = render(<OperatorFocusProvider missionId="root"><Probe /></OperatorFocusProvider>)
    expect(screen.getByTestId('focus').textContent).toBe('late-child:loading')
    fixture.issues = [{ id: 'root', parentId: null }, { id: 'late-child', parentId: 'root' }]
    view.rerender(<OperatorFocusProvider missionId="root"><Probe /></OperatorFocusProvider>)
    expect(screen.getByTestId('focus').textContent).toBe('late-child:ready')
    expect(fixture.update).not.toHaveBeenCalled()
  })

  it('reconciles an unavailable saved child only after the bounded grace', () => {
    vi.useFakeTimers()
    render(<OperatorFocusProvider missionId="root"><Probe /></OperatorFocusProvider>)
    expect(screen.getByTestId('focus').textContent).toBe('late-child:loading')
    act(() => { vi.advanceTimersByTime(20_001) })
    expect(screen.getByTestId('focus').textContent).toBe('root:ready')
    expect(fixture.update).toHaveBeenCalledWith({ focusedIssueId: 'root' }, { passive: true })
  })
})
