// @vitest-environment happy-dom
import { issueBoardStats, storeStats } from '@podium/client-core/perf'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EMPTY_BOARD, useBoardBase, useBoardData } from './board-pool-data'
import { useExplorerData } from './explorer/explorer-pool-data'
import { useIssueCloseGuard } from './issue-lifecycle'
import { DEFAULT_DISPLAY } from './issues-display'

const state = vi.hoisted(() => ({ pool: true, attached: false, issueReads: vi.fn(), sessionReads: vi.fn() }))
vi.mock('./board-data-layer', () => ({ boardDataLayer: () => state.pool ? 'pool' : 'legacy' }))
vi.mock('@/app/store', () => ({ useReplicaIssues: () => { state.issueReads(); return [] }, useStoreSelector: (read: (store: object) => unknown) => read({
  get sessions() { state.sessionReads(); return [] }, openIssueId: null,
}) }))
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => ({ getSnapshot: () => ({}) }) }))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPoolProjection: (read: (pool: object) => unknown, empty: unknown) => state.attached ? read({ row: (entity: string) => entity === 'issueBoardWindow' ? { openIssueId: null } : entity === 'issueBoardModel' ? EMPTY_BOARD : undefined }) : empty }))
afterEach(() => { cleanup(); state.pool = true; state.attached = false; state.issueReads.mockClear(); state.sessionReads.mockClear(); issueBoardStats.disable(); storeStats.disable() })
function useBoundary() {
  const base = useBoardBase()
  const board = useBoardData({ display: DEFAULT_DISPLAY, filter: {}, expanded: [], isMobile: false, openIssueId: base.openIssueId, now: 0 }, base)
  const explorer = useExplorerData(null, '')
  useIssueCloseGuard(base.pool ? board.sessions : undefined)
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
