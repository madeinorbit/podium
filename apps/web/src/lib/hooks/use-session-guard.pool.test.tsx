// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionView } from '@podium/client-core/session-values'
import { asSessionId } from '@podium/model/browser'
const f = vi.hoisted(() => ({ sessions: [] as SessionView[], selectors: 0,
  actions: { killSession: vi.fn(async () => {}), archiveSession: vi.fn(async () => {}), endSession: vi.fn(async () => ({ ok: true })) },
  confirm: vi.fn(async () => true) }))
vi.mock('@/app/store', () => ({ useStoreSelector: (select: (state: unknown) => unknown) => { f.selectors++; return select({ sessions: f.sessions, ...f.actions }) } }))
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => ({ getSnapshot: () => f.actions }) }))
vi.mock('./use-confirm', () => ({ useConfirm: () => f.confirm }))
import { useSessionGuard } from './use-session-guard'
afterEach(() => { cleanup(); vi.clearAllMocks(); f.selectors = 0 })
it('preserves guard decisions while the supplied-session path makes zero store subscriptions', async () => {
  const id = asSessionId('guard-session')
  f.sessions = [{ sessionId: id, agentState: { phase: 'working' } } as SessionView]
  for (const supplied of [undefined, f.sessions]) {
    f.selectors = 0; vi.clearAllMocks()
    const hook = renderHook(() => useSessionGuard(undefined, undefined, supplied))
    await hook.result.current.guardedEnd(id)
    expect(f.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'End anyway' }))
    expect(f.actions.endSession).toHaveBeenCalledWith(id)
    await hook.result.current.guardedDelete(id)
    expect(f.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Delete', description: expect.stringContaining('still working') }))
    expect(f.actions.killSession).toHaveBeenCalledWith(id)
    expect(f.selectors).toBe(supplied ? 0 : 1)
    hook.unmount()
  }
})
