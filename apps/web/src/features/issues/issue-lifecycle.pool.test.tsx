// @vitest-environment happy-dom
import { cleanup, renderHook, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionView } from '@podium/client-core/session-values'
import { makeIssue } from '@/lib/test-issue'
const f = vi.hoisted(() => ({ sessions: [] as SessionView[], selectors: 0 }))
vi.mock('@/app/store', () => ({ useRuntimeSelector: (select: (state: unknown) => unknown) => { f.selectors++; return select(f) } }))
import { useIssueCloseGuard, IssueCloseDialog } from './issue-lifecycle'
afterEach(() => { cleanup(); f.selectors = 0 })
it('preserves issue close concerns without a legacy reader on supplied sessions', () => {
  const issue = makeIssue({ id: 'guard-issue', memberSessionIds: ['guard-session'] })
  f.sessions = [{ sessionId: 'guard-session', status: 'live', agentState: { phase: 'working' } } as SessionView]
  for (const supplied of [undefined, f.sessions]) {
    f.selectors = 0
    const hook = renderHook(() => useIssueCloseGuard(supplied))
    expect(hook.result.current(issue)).toBe(true)
    const dialog = render(<IssueCloseDialog issue={issue} reason="done" sessions={supplied} onOpenChange={() => {}} onConfirm={() => {}} />)
    expect(screen.getByText('This issue still needs attention')).toBeTruthy()
    expect(screen.getByTestId('issue-close-concerns').textContent).toContain('working')
    expect(f.selectors).toBe(supplied ? 0 : 2)
    dialog.unmount(); hook.unmount()
  }
})
