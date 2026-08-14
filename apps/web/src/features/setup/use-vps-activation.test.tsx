// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { serializeVpsActivation, vpsIntroState } from './vps-activation'

vi.mock('@/lib/use-persisted-ui-state', () => ({
  usePersistedUiValue: () => null,
}))

import { useConfirmedVpsActivation } from './use-vps-activation'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function trpcWithLayoutGet(query: () => Promise<Record<string, unknown>>): Trpc {
  // createTRPCClient returns a callable proxy in production. Keep this double callable so
  // React state setters cannot accidentally treat the transport itself as an updater.
  return Object.assign(() => undefined, {
    layout: {
      get: { query },
      set: { mutate: vi.fn() },
      clear: { mutate: vi.fn() },
    },
  }) as unknown as Trpc
}

describe('confirmed VPS activation hydration', () => {
  it('gates stale source state while a replacement transport restores its checkpoint', async () => {
    const source = vpsIntroState('welcome')
    const destination = vpsIntroState('local-project')
    const pendingDestination = deferred<Record<string, unknown>>()
    const sourceTrpc = trpcWithLayoutGet(async () => ({
      'onboarding.vps': serializeVpsActivation(source),
    }))
    const destinationTrpc = trpcWithLayoutGet(() => pendingDestination.promise)
    const view = renderHook(({ trpc }: { trpc: Trpc }) => useConfirmedVpsActivation(trpc), {
      initialProps: { trpc: sourceTrpc },
    })

    await waitFor(() => expect(view.result.current.state).toEqual(source))

    view.rerender({ trpc: destinationTrpc })
    await waitFor(() => expect(view.result.current.ready).toBe(false))
    expect(view.result.current.state).toBeNull()

    await act(async () => {
      pendingDestination.resolve({
        'onboarding.vps': serializeVpsActivation(destination),
      })
      await pendingDestination.promise
    })
    await waitFor(() => expect(view.result.current.state).toEqual(destination))
  })

  it('does not synthesize a checkpoint while authoritative absence is pending', async () => {
    const pending = deferred<Record<string, unknown>>()
    const trpc = trpcWithLayoutGet(() => pending.promise)
    const view = renderHook(() => useConfirmedVpsActivation(trpc))

    expect(view.result.current).toMatchObject({ ready: false, state: null })
    expect(trpc.layout.set.mutate).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve({})
      await pending.promise
    })
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    expect(view.result.current.state).toBeNull()
    expect(trpc.layout.set.mutate).not.toHaveBeenCalled()
  })
})
