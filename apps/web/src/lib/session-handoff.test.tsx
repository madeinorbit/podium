import { asMachineId, asSessionId } from '@podium/model/browser'
import { renderHook, waitFor } from '@testing-library/react'
import { runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionHandoff } from './session-handoff'

/**
 * A MOVE FROM A MENU (POD-6422): the hook writes a `session.handoff` effect
 * record through the action owner and tells, once, how the record ended.
 */

const handoffSession = vi.hoisted(() => vi.fn())
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
/** The pool's effect table, which `awaitEffect` reads. */
const held = vi.hoisted(() => {
  const { observable } = require('mobx') as typeof import('mobx')
  return observable.map<string, Record<string, unknown>>({}, { deep: false })
})
vi.mock('@podium/client-core/react', async () => {
  const { fixtureRuntimeHooks } = await import('@podium/client-core/test-support/command-hooks')
  return {
    ...fixtureRuntimeHooks(() => ({ access: { handoffSession } })),
  }
})
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => ({
    tables: { effect: held },
    model: (_entity: string, id: string) => held.get(id),
  }),
}))
vi.mock('sonner', () => ({ toast: toasts }))

const S = asSessionId('s1')
const M = asMachineId('m2')
const NAMES = { session: 'Reviewer', machine: 'Laptop' }

/** The record as the feed brings it into the pool. */
function ends(status: string, over: Record<string, unknown> = {}): void {
  runInAction(() =>
    held.set('eff_1', {
      id: 'eff_1',
      kind: 'session.handoff',
      status,
      inFlight: status === 'pending' || status === 'running',
      ...over,
    }),
  )
}

beforeEach(() => {
  handoffSession.mockReset()
  handoffSession.mockResolvedValue('eff_1')
})
afterEach(() => {
  runInAction(() => held.clear())
  toasts.success.mockReset()
  toasts.error.mockReset()
})

describe('useSessionHandoff', () => {
  it('writes the record and names where the session landed once it succeeded', async () => {
    const { result } = renderHook(() => useSessionHandoff())
    result.current(S, M, NAMES)
    expect(handoffSession).toHaveBeenCalledWith(S, M)
    ends('running')
    await Promise.resolve()
    expect(toasts.success).not.toHaveBeenCalled()
    ends('succeeded', { result: { ok: true, newCwd: '/t/x' } })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Reviewer resumed on Laptop'))
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('tells the record’s own reason when the move did not happen', async () => {
    const { result } = renderHook(() => useSessionHandoff())
    result.current(S, M, NAMES)
    ends('failed', { error: { code: 'unreachable', message: 'target machine is offline' } })
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith(
        'Handover to Laptop failed — target machine is offline',
      ),
    )
    expect(toasts.success).not.toHaveBeenCalled()
  })

  it('tells a write the device could not queue', async () => {
    handoffSession.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useSessionHandoff())
    result.current(S, M, NAMES)
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith('Handover to Laptop failed — offline'),
    )
  })
})
