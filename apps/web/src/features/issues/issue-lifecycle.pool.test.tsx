// @vitest-environment happy-dom
import { act, cleanup, renderHook, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobxPool } from '@podium/client-graph'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import { makeIssue } from '@/lib/test-issue'
const f = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  projections: vi.fn(), globalSessions: vi.fn(), close: vi.fn(async () => {}), update: vi.fn(async () => {}),
}))
vi.mock('@/app/store', () => ({ useRuntimeSelector: (select: (state: unknown) => unknown) => select({
  closeIssue: f.close, updateIssue: f.update,
  get sessions() { f.globalSessions(); throw new Error('Global session roster requested') },
}) }))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => f.pool,
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T, empty: T): T => {
    f.projections(); return f.pool ? read(f.pool) : empty
  },
}))
import { useIssueCloseGuard, IssueCloseDialog, IssueBulkCloseDialog } from './issue-lifecycle'
import { useIssueStatusApply } from './use-issue-status-apply'

const old = '2020-01-01T00:00:00Z'
const issue = makeIssue({ id: 'guard-issue', memberSessionIds: [] })
function setup() {
  f.pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-05') }, undefined, {
    load: () => undefined, summaries: ISSUE_PAGE_SUMMARIES, worklist: 'demand', schedule: () => () => {},
  })
  f.pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: issue.id, value: { ...issue, needsHuman: false } as never },
    { kind: 'session', id: 'guard-session', value: {
      sessionId: 'guard-session', issueId: issue.id, agentKind: 'codex', cwd: '/fixture',
      status: 'live', lastActiveAt: old, createdAt: old, agentState: { phase: 'working', since: old },
    } as never },
  ] })
  return f.pool
}
afterEach(() => { cleanup(); f.pool?.dispose(); f.pool = null; vi.clearAllMocks() })

it('has no concern demand while single/bulk dialogs and status controls are closed', () => {
  const pool = setup(), row = vi.spyOn(pool, 'row')
  render(<IssueCloseDialog issue={issue} reason={null} onOpenChange={() => {}} onConfirm={() => {}} />)
  render(<IssueBulkCloseDialog issues={[issue, makeIssue({ id: 'another' })]} reason={null} onOpenChange={() => {}} onConfirm={() => {}} />)
  const hook = renderHook(() => useIssueStatusApply())
  expect(hook.result.current.dialog).toBeNull()
  expect(f.projections).not.toHaveBeenCalled()
  expect(row).not.toHaveBeenCalled()
  expect(f.globalSessions).not.toHaveBeenCalled()
})

it('uses current addressed concern counts even when the captured catalog has empty member IDs', () => {
  const pool = setup()
  const hook = renderHook(() => useIssueCloseGuard())
  expect(hook.result.current(issue)).toBe(true)
  const dialog = render(<IssueCloseDialog issue={issue} reason="done" onOpenChange={() => {}} onConfirm={() => {}} />)
  expect(screen.getByTestId('issue-close-concerns').textContent).toContain('working')
  pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'guard-session', value: {
    sessionId: 'guard-session', issueId: issue.id, agentKind: 'codex', cwd: '/fixture',
    status: 'exited', lastActiveAt: old, createdAt: old,
  } as never }] })
  dialog.rerender(<IssueCloseDialog issue={issue} reason="done" onOpenChange={() => {}} onConfirm={() => {}} />)
  expect(hook.result.current(issue)).toBe(false)
  expect(screen.queryByTestId('issue-close-concerns')).toBeNull()
  expect(f.globalSessions).not.toHaveBeenCalled()
})

it('shows pending facts and disables close when attachment or the named issue is unavailable', () => {
  const confirm = vi.fn()
  const hook = renderHook(() => useIssueCloseGuard())
  expect(hook.result.current(issue)).toBe(true)
  const dialog = render(<IssueCloseDialog issue={issue} reason="done" onOpenChange={() => {}} onConfirm={confirm} />)
  expect(screen.getByText('Checking this issue…')).toBeTruthy()
  const button = screen.getByRole('button', { name: 'Close issue' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  act(() => button.click())
  expect(confirm).not.toHaveBeenCalled()
  setup().apply({ type: 'replace', rows: [] })
  dialog.rerender(<IssueCloseDialog issue={issue} reason="done" onOpenChange={() => {}} onConfirm={confirm} />)
  expect(screen.getByText('Checking this issue…')).toBeTruthy()
})

it('does not call a legacy roster callback when applying one status', () => {
  setup()
  const roster = vi.fn(() => { throw new Error('History roster rebuilt') })
  const hook = renderHook(() => useIssueStatusApply([], roster))
  act(() => hook.result.current.pick(issue, 'close:done'))
  expect(hook.result.current.dialog).not.toBeNull()
  expect(roster).not.toHaveBeenCalled()
  expect(f.close).not.toHaveBeenCalled()
  expect(f.globalSessions).not.toHaveBeenCalled()
})
