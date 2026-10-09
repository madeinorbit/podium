// @vitest-environment happy-dom
import { storeStats } from '@podium/client-core/perf'
import { issueBoardStats } from '../../../../../tests/worklist/harness/src/perf/issue-board'
import type { SessionView } from '@podium/client-core/session-values'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { EMPTY_BOARD, readBoardCatalog, useBoardBase, useBoardCatalog, useBoardData } from './board-pool-data'
import { useBoardCloseGuard } from './board-pool-row'
import { useExplorerData } from './explorer/explorer-pool-data'
import { IssueBulkCloseDialog } from './issue-lifecycle'
import { DEFAULT_DISPLAY } from './issues-display'
import { useIssueStatusApply } from './use-issue-status-apply'

const state = vi.hoisted(() => ({
  attached: false,
  issueReads: vi.fn(),
  sessionReads: vi.fn(),
  poolReads: vi.fn(),
  close: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
}))
vi.mock('@/app/store', () => ({
  useRuntimeSelector: (read: (store: object) => unknown) =>
    read({
      get sessions() {
        state.sessionReads()
        return []
      },
      openIssueId: null,
      closeIssue: state.close,
      updateIssue: state.update,
    }),
}))
vi.mock('@podium/client-core/react', () => ({
  useStoreHandle: () => ({ get access() { return ({}) } }),
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => null,
  useWorklistPoolProjection: (read: (pool: object) => unknown, empty: unknown) =>
    state.attached
      ? read({
          row: (entity: string, key: string) => {
            state.poolReads(entity, key)
            return entity === 'issueBoardWindow'
              ? { openIssueId: null }
              : entity === 'issueBoardModel'
                ? EMPTY_BOARD
                : undefined
          },
        })
      : empty,
}))
afterEach(() => {
  cleanup()
  state.attached = false
  state.issueReads.mockClear()
  state.sessionReads.mockClear()
  state.poolReads.mockClear()
  state.close.mockClear()
  state.update.mockClear()
  issueBoardStats.disable()
  storeStats.enable(false)
  storeStats.reset()
})
it('keeps card time and addressed interaction state out of layout keys and defers catalog demand', () => {
  state.attached = true
  const board = renderHook(({ now, id }) => useBoardData({
    display: DEFAULT_DISPLAY, filter: {}, expanded: [], isMobile: false,
    now, openIssueId: id, addressed: id ? [id] : [], menu: !!id,
  }), { initialProps: { now: 0, id: null as import('@podium/model/browser').IssueId | null } })
  const demand = state.poolReads.mock.calls.find(([entity]) => entity === 'issueBoardModel')?.[1]
  expect(state.poolReads.mock.calls.some(([entity]) => entity === 'issueBoardCatalog')).toBe(false)
  state.poolReads.mockClear()
  board.rerender({ now: 60_000, id: 'one' as import('@podium/model/browser').IssueId })
  expect(state.poolReads.mock.calls.filter(([entity]) => entity === 'issueBoardModel').every(([, key]) => key === demand)).toBe(true)
  const catalog = renderHook(({ open }) => useBoardCatalog(open, false), { initialProps: { open: false } })
  expect(state.poolReads.mock.calls.some(([entity]) => entity === 'issueBoardCatalog')).toBe(false)
  catalog.rerender({ open: true })
  expect(state.poolReads).toHaveBeenCalledWith('issueBoardCatalog', 'false')
  state.poolReads.mockClear()
  catalog.rerender({ open: false })
  expect(state.poolReads.mock.calls.some(([entity]) => entity === 'issueBoardCatalog')).toBe(false)
})
it('uses the same closed-menu reader in the hook and structural harness, and reads an open catalogue', () => {
  const choices = { scope: ['one'], projectPaths: ['/fixture'], assignees: ['owner'], labels: ['bug'] }
  const row = vi.fn(() => choices)
  const pool = { row } as unknown as import('@podium/client-graph').MobxPool
  expect(readBoardCatalog(pool, false, false)).toBeUndefined()
  expect(row).not.toHaveBeenCalled()
  expect(readBoardCatalog(pool, true, false)).toBe(choices)
  expect(row).toHaveBeenCalledExactlyOnceWith('issueBoardCatalog', 'false')
})
function useBoundary() {
  const base = useBoardBase()
  const board = useBoardData({
    display: DEFAULT_DISPLAY,
    filter: {},
    expanded: [],
    isMobile: false,
    openIssueId: base.openIssueId,
    now: 0,
  })
  const explorer = useExplorerData(null, '')
  useBoardCloseGuard([])
  return { base, board, explorer }
}
it('keeps board-only pool reads off both legacy collections before and after attachment', () => {
  issueBoardStats.enable()
  storeStats.enable()
  const { result, rerender } = renderHook(useBoundary)
  expect(result.current.base.openIssueId).toBeNull()
  expect(result.current.board).toEqual(EMPTY_BOARD)
  expect(result.current.explorer.rows).toEqual([])
  state.attached = true
  rerender()
  expect(result.current.base.openIssueId).toBeNull()
  expect(result.current.board).toEqual(EMPTY_BOARD)
  expect(result.current.explorer.rows).toEqual([])
  expect(state.issueReads).not.toHaveBeenCalled()
  expect(state.sessionReads).not.toHaveBeenCalled()
  expect(issueBoardStats.read()).toEqual({})
  expect(
    storeStats
      .snapshot()
      .runtimes.reduce(
        (n, runtime) =>
          n +
          (runtime.slices['issueBoard.board'] ?? 0) +
          (runtime.slices['issueBoard.explorer'] ?? 0),
        0,
      ),
  ).toBe(0)
})
it('keeps the pool bulk-close dialog off the legacy session collection', () => {
  render(
    <IssueBulkCloseDialog
      issues={[makeIssue({ id: 'a' }), makeIssue({ id: 'b' })]}
      sessions={[]}
      reason="done"
      onOpenChange={() => {}}
      onConfirm={() => {}}
    />,
  )
  expect(state.sessionReads).not.toHaveBeenCalled()
})
it('uses addressed pool sessions for a close guard and leaves a loading roster pending', () => {
  const issue = makeIssue({ id: 'task', memberSessionIds: ['agent'] })
  const seats = [
    {
      sessionId: 'agent',
      issueId: issue.id,
      agentKind: 'codex',
      status: 'live',
      archived: false,
      agentState: { phase: 'working' },
    },
  ] as SessionView[]
  const { result } = renderHook(() => useIssueStatusApply([], () => seats))
  act(() => result.current.pick(issue, 'close:done'))
  expect(result.current.dialog).not.toBeNull()
  expect(state.close).not.toHaveBeenCalled()
  expect(state.sessionReads).not.toHaveBeenCalled()
  const pending = renderHook(() => useIssueStatusApply([], () => Symbol('LOADING')))
  act(() => pending.result.current.pick(issue, 'close:done'))
  expect(state.close).not.toHaveBeenCalled()
})
