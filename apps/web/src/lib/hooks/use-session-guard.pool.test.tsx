// @vitest-environment happy-dom

import type { SessionView } from '@podium/client-core/session-values'
import { asSessionId } from '@podium/model/browser'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReferenceState } from '../../../../../tests/worklist/diagnostics/reference-state'

type Store = ReferenceState<import('@/app/trpc').Trpc>

const f = vi.hoisted(() => ({
  sessions: [] as SessionView[],
  selectors: 0,
  derivations: 0,
  actions: {
    killSession: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
    endSession: vi.fn<import('@podium/client-core/commands').Commands['sessions']['stop']>(
      async () => ({ ok: true }),
    ),
  },
  confirm: vi.fn(async () => true),
}))
vi.mock('@/app/store', () => ({
  readFixture: (select: (state: unknown) => unknown) => {
    f.selectors++
    return select({ sessions: f.sessions, ...f.actions })
  },
}))
vi.mock('@podium/client-core/react', async () => {
  const { fixtureRuntimeHooks } = await import('@podium/client-core/test-support/command-hooks')

  const owner = {
    get access() {
      return f.actions
    },
  }
  return { ...fixtureRuntimeHooks(() => owner) }
})
vi.mock('./use-confirm', () => ({ useConfirm: () => f.confirm }))
vi.mock('@podium/client-core/values', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/client-core/values')>()
  return {
    ...actual,
    isSessionWorking: (session: SessionView) => {
      f.derivations++
      return actual.isSessionWorking(session)
    },
  }
})

import { useSessionGuard } from './use-session-guard'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  f.selectors = 0
})
it('preserves guard decisions with pool sessions and zero store subscriptions', async () => {
  const id = asSessionId('guard-session')
  f.sessions = [{ sessionId: id, agentState: { phase: 'working' } } as SessionView]
  const supplied = f.sessions
  f.selectors = 0
  vi.clearAllMocks()
  const hook = renderHook(() => useSessionGuard(undefined, undefined, supplied))
  await hook.result.current.guardedEnd(id)
  expect(f.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'End anyway' }))
  expect(f.actions.endSession).toHaveBeenCalledWith(id)
  await hook.result.current.guardedDelete(id)
  expect(f.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      confirmLabel: 'Delete',
      description: expect.stringContaining('still working'),
    }),
  )
  expect(f.actions.killSession).toHaveBeenCalledWith(id)
  expect(f.selectors).toBe(0)
  hook.unmount()
})

it('ends with one edit, leaves a refusal to the session bar, and keeps cancellation', async () => {
  const id = asSessionId('guard-session')
  const hook = renderHook(() => useSessionGuard(id, false, []))
  // POD-6399: a stop is an edit; an unsaved-worktree refusal arrives later on
  // the session itself, whose bar offers "End anyway". No dialog here.
  f.actions.endSession.mockResolvedValueOnce({ ok: true })
  await hook.result.current.guardedEnd(id)
  expect(f.confirm).not.toHaveBeenCalled()
  expect(f.actions.endSession.mock.calls).toEqual([[id]])
  f.confirm.mockResolvedValueOnce(false)
  await hook.result.current.guardedDelete(id)
  expect(f.actions.killSession).not.toHaveBeenCalled()
  await hook.result.current.guardedArchive(id, false)
  expect(f.actions.archiveSession).toHaveBeenCalledWith(id, false)
})

it('reads one supplied neighbourhood per click at 1x and 4x without reading the old roster', async () => {
  const id = asSessionId('guard-session')
  const row = { sessionId: id, agentState: { phase: 'working' } } as SessionView
  const reads: number[] = []
  const derivations: number[] = []
  for (const scale of [1, 4]) {
    f.sessions = [
      row,
      ...Array.from({ length: 64 * scale - 1 }, (_, i) => ({
        ...row,
        sessionId: asSessionId(`unrelated-${i}`),
      })),
    ]
    let rowReads = 0
    const supplied = new Proxy([row], {
      get: (rows, key, receiver) => {
        if (typeof key === 'string' && /^\d+$/.test(key)) rowReads++
        return Reflect.get(rows, key, receiver)
      },
    })
    const hook = renderHook(() => useSessionGuard(undefined, undefined, supplied))
    rowReads = 0
    f.derivations = 0
    await hook.result.current.guardedEnd(id)
    reads.push(rowReads)
    derivations.push(f.derivations)
    expect(f.selectors).toBe(0)
    hook.unmount()
  }
  expect(reads).toEqual([1, 1])
  expect(derivations).toEqual([1, 1])
  expect(reads[1]! / reads[0]!).toBeLessThanOrEqual(1)
  console.info(
    'POD5438 guard click counters ' +
      JSON.stringify({
        totalSessionRows: [64, 256],
        visibleNeighbourhood: [1, 1],
        rowReads: reads,
        derivations,
      }),
  )
})
