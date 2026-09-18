// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { asIssueId, asSessionId } from '@podium/model/browser'
import type { IssueNavigationModel } from '@podium/client-core/viewmodels'
import { useEffect, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperatorFocusProvider, useOperatorFocus } from '@/app/operator-focus'
import { useUnifiedWork } from './use-unified-work'

const fixture = vi.hoisted(() => ({ store: {} as Record<string, unknown>, issues: [] as unknown[] }))
vi.mock('@/app/store', () => ({
  useStoreSelector: (select: (s: Record<string, unknown>) => unknown) => select(fixture.store),
  useReplicaIssues: () => fixture.issues,
  useSlice: () => ({ now: Date.now(), sections: { pinnedRepos: [], repos: [] },
    allWorktreePaths: ['/repo'], work: [], pinned: [], groups: [] }),
}))
const root = { id: asIssueId('root'), parentId: null, archived: false, title: 'Root',
  worktreePath: '/repo', updatedAt: '2026-09-01T00:00:00Z' } as unknown as IssueNavigationModel
const child = { ...root, id: asIssueId('child'), parentId: root.id,
  deferUntil: '2026-09-01T00:00:00Z' } as IssueNavigationModel

beforeEach(() => {
  fixture.issues = [root, child]
  fixture.store = { repos: [], sessions: [], pins: {}, selectedIssueId: null,
    selectedWorktree: null, paneA: null, fileTabs: [],
    navigateWorkspace: vi.fn().mockReturnValueOnce(true).mockReturnValue(false),
    setSelectedIssueId: vi.fn(), markIssueRead: vi.fn(async () => {}),
    markSessionRead: vi.fn(async () => {}), deferIssue: vi.fn(async () => {}) }
})
afterEach(cleanup)

describe('issue navigation gesture', () => {
  it('commits once, focuses the child once, and does not repeat read/defer commands', () => {
    const commits = vi.fn()
    function Wrapper({ children }: { children: ReactNode }) {
      return <OperatorFocusProvider missionId={null}>{children}</OperatorFocusProvider>
    }
    const { result } = renderHook(() => {
      const work = useUnifiedWork()
      const focus = useOperatorFocus()
      useEffect(() => { commits(focus.focusedIssueId) }, [focus.focusedIssueId])
      return { work, focus }
    }, { wrapper: Wrapper })
    commits.mockClear()
    act(() => result.current.work.selectPanelForIssue(child, asSessionId('member')))
    expect(fixture.store.navigateWorkspace).toHaveBeenCalledExactlyOnceWith({
      selectedIssueId: root.id, selectedWorktree: '/repo', tabId: 'member', firstPane: true,
    })
    expect(result.current.focus.focusedIssueId).toBe(child.id)
    expect(commits).toHaveBeenCalledTimes(1)
    expect(fixture.store.markIssueRead).toHaveBeenCalledExactlyOnceWith(child.id)
    expect(fixture.store.markSessionRead).toHaveBeenCalledExactlyOnceWith('member')
    expect(fixture.store.deferIssue).toHaveBeenCalledExactlyOnceWith(child.id, null)
    act(() => result.current.work.selectPanelForIssue(child, asSessionId('member')))
    expect(fixture.store.markIssueRead).toHaveBeenCalledTimes(1)
    expect(fixture.store.markSessionRead).toHaveBeenCalledTimes(1)
    expect(fixture.store.deferIssue).toHaveBeenCalledTimes(1)
  })

  it('focuses and marks a sessionless child even when the mission layout is unchanged', () => {
    vi.mocked(fixture.store.navigateWorkspace as () => boolean).mockReset().mockReturnValue(false)
    const { result } = renderHook(() => ({ work: useUnifiedWork(), focus: useOperatorFocus() }), {
      wrapper: ({ children }) => <OperatorFocusProvider missionId={root.id}>{children}</OperatorFocusProvider>,
    })
    act(() => result.current.work.selectIssue(child))
    expect(result.current.focus.focusedIssueId).toBe(child.id)
    expect(fixture.store.markIssueRead).toHaveBeenCalledExactlyOnceWith(child.id)
    expect(fixture.store.markSessionRead).not.toHaveBeenCalled()
    expect(fixture.store.navigateWorkspace).toHaveBeenCalledWith(expect.objectContaining({ tabId: null }))
  })

  it('does not change focus or send commands if navigation validation fails', () => {
    vi.mocked(fixture.store.navigateWorkspace as () => boolean).mockReset().mockImplementation(() => { throw new Error('invalid plan') })
    const { result } = renderHook(() => ({ work: useUnifiedWork(), focus: useOperatorFocus() }), {
      wrapper: ({ children }) => <OperatorFocusProvider missionId={root.id}>{children}</OperatorFocusProvider>,
    })
    expect(() => result.current.work.selectIssue(child)).toThrow('invalid plan')
    expect(result.current.focus.focusedIssueId).toBe(root.id)
    expect(fixture.store.markIssueRead).not.toHaveBeenCalled()
    expect(fixture.store.deferIssue).not.toHaveBeenCalled()
  })
})
