// @vitest-environment happy-dom
import { issueBoardStats, storeStats } from '@podium/client-core/perf'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import type { SessionView } from '@podium/client-core/session-values'
import { afterEach, expect, it, vi } from 'vitest'
import { EMPTY_BOARD, useBoardBase, useBoardData } from './board-pool-data'
import { useExplorerData } from './explorer/explorer-pool-data'
import { IssueBulkCloseDialog, useIssueCloseGuard } from './issue-lifecycle'
import { makeIssue } from '@/lib/test-issue'
import { DEFAULT_DISPLAY } from './issues-display'
import { useBoardCloseGuard } from './board-pool-row'
import { useIssueStatusApply } from './use-issue-status-apply'

const state = vi.hoisted(() => ({ pool: true, attached: false, issueReads: vi.fn(), sessionReads: vi.fn(), close: vi.fn(async () => {}), update: vi.fn(async () => {}) }))
vi.mock('./board-data-layer', () => ({ boardDataLayer: () => state.pool ? 'pool' : 'legacy' }))
vi.mock('@/app/store', () => ({ useReplicaIssues: () => { state.issueReads(); return [] }, useStoreSelector: (read: (store: object) => unknown) => read({
  get sessions() { state.sessionReads(); return [] }, openIssueId: null, closeIssue: state.close, updateIssue: state.update,
}) }))
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => ({ getSnapshot: () => ({}) }) }))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => null, useWorklistPoolProjection: (read: (pool: object) => unknown, empty: unknown) => state.attached ? read({ row: (entity: string, key: string) => entity === 'issueBoardWindow' ? { openIssueId: null } : entity === 'issueBoardProjection' ? { getSnapshot: () => JSON.parse(key)[0] === 'issueBoardModel' ? EMPTY_BOARD : undefined, subscribe: () => () => {} } : undefined }) : empty }))
afterEach(() => { cleanup(); state.pool = true; state.attached = false; state.issueReads.mockClear(); state.sessionReads.mockClear(); state.close.mockClear(); state.update.mockClear(); issueBoardStats.disable(); storeStats.enable(false); storeStats.reset() })
function useBoundary() {
  const base = useBoardBase()
  const board = useBoardData({ display: DEFAULT_DISPLAY, filter: {}, expanded: [], isMobile: false, openIssueId: base.openIssueId, now: 0 }, base)
  const explorer = useExplorerData(null, '')
  useBoardCloseGuard(board.sessions)
  return { board, explorer }
}
it('keeps board-only pool reads off both legacy collections before and after attachment', () => {
  issueBoardStats.enable(); storeStats.enable()
  const { rerender } = renderHook(useBoundary)
  state.attached = true; rerender()
  expect(state.issueReads).not.toHaveBeenCalled()
  expect(state.sessionReads).not.toHaveBeenCalled()
  expect(issueBoardStats.read()).toEqual({})
  expect(storeStats.snapshot().runtimes.reduce((n, runtime) => n + (runtime.slices['issueBoard.board'] ?? 0) + (runtime.slices['issueBoard.explorer'] ?? 0), 0)).toBe(0)
})
it('records actual legacy derivations as the switch-off positive control', () => {
  state.pool = false; issueBoardStats.enable(); storeStats.enable()
  renderHook(useBoundary)
  expect(state.issueReads).toHaveBeenCalled()
  expect(state.sessionReads).toHaveBeenCalled()
  expect(issueBoardStats.read()['legacy.board']).toBeGreaterThan(0)
  expect(issueBoardStats.read()['legacy.explorer']).toBeGreaterThan(0)
})
it('keeps the pool bulk-close dialog off the legacy session collection', () => {
  render(<IssueBulkCloseDialog issues={[makeIssue({ id: 'a' }), makeIssue({ id: 'b' })]} sessions={[]}
    reason="done" onOpenChange={() => {}} onConfirm={() => {}} />)
  expect(state.sessionReads).not.toHaveBeenCalled()
})
it('uses addressed pool sessions for a close guard and leaves a loading roster pending', () => {
  const issue = makeIssue({ id: 'task', memberSessionIds: ['agent'] })
  const seats = [{ sessionId: 'agent', issueId: issue.id, agentKind: 'codex', status: 'live', archived: false, agentState: { phase: 'working' } }] as SessionView[]
  const { result } = renderHook(() => useIssueStatusApply([], () => seats))
  act(() => result.current.pick(issue, 'close:done'))
  expect(result.current.dialog).not.toBeNull()
  expect(state.close).not.toHaveBeenCalled()
  expect(state.sessionReads).not.toHaveBeenCalled()
  const pending = renderHook(() => useIssueStatusApply([], () => Symbol('LOADING')))
  act(() => pending.result.current.pick(issue, 'close:done'))
  expect(state.close).not.toHaveBeenCalled()
})
