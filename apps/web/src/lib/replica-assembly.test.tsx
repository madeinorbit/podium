import { BOOT_STALL_MS } from '@podium/client-core/replica-assembly'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncLoader } from '@/app/SyncLoader'
import { type KernelAssembly, openKernelAssembly } from './kernelReplica'
import { WebSyncProgressStore } from './sync-progress'
import { STORE_REFRESH_NOTICE, useKernelReplica } from './use-kernel-replica'

const principal = JSON.stringify(['installation-a', 'alice'])
/** One client for every render: a fresh object would re-run the boot effect. */
const stableTrpc = {} as never
let assembly: KernelAssembly | undefined
beforeEach(() => localStorage.clear())
afterEach(async () => {
  cleanup()
  await assembly?.dispose()
  assembly = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('web shared assembly adapter', () => {
  it.each([
    401, 403,
  ])('stops HTTP %i without replacing its cause or retrying the expired identity', async (status) => {
    const fetch = vi.fn(async () => new Response(null, { status }))
    vi.stubGlobal('fetch', fetch)
    const expired = vi.fn()
    window.addEventListener('podium:sync-auth-expired', expired)
    try {
      assembly = await openKernelAssembly({
        trpc: {} as never,
        principal,
        evidence: { kind: 'single-account', principal },
        factory: new IDBFactory() as never,
        broadcastChannelFactory: () => ({ onmessage: null, postMessage() {}, close() {} }),
      })
      assembly.feed.connected(false)
      await vi.waitFor(() => expect(assembly?.progress.getSnapshot().error).toBe('auth'))
      assembly.feed.connected(false)
      assembly.progress.retry()
      expect(assembly.progress.getSnapshot()).toMatchObject({
        error: 'auth',
        failure: `http-${status}`,
      })
      expect(expired).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('podium:sync-auth-expired', expired)
    }
  })

  it('keeps the loading gate through a slow open, with no stall screen', async () => {
    vi.useFakeTimers()
    const trpc = {} as never
    const dispose = vi.fn(async () => {})
    let finish!: (value: KernelAssembly) => void
    const openAssembly = vi.fn(
      () =>
        new Promise<KernelAssembly>((resolve) => {
          finish = resolve
        }),
    )
    const { result, unmount } = renderHook(() =>
      useKernelReplica({
        trpc,
        httpOrigin: '',
        auth: { kind: 'principal', principal },
        openAssembly,
      }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_STALL_MS)
    })
    expect(result.current.status).toBe('resolving')
    await act(async () => {
      finish({ principal, dispose } as unknown as KernelAssembly)
    })
    expect(result.current.status).toBe('kernel')
    expect(openAssembly).toHaveBeenCalledOnce()
    unmount()
    await act(async () => {})
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('keeps web progress phases: offline leaves the phase alone, a failed walk is a network failure', () => {
    const progress = new WebSyncProgressStore()
    progress.begin('stale')
    progress.beginAttempt()
    progress.noteEvent({ type: 'posture', posture: 'live', previous: 'healing' })
    progress.noteEvent({ type: 'posture', posture: 'stale', previous: 'live' })
    expect(progress.getSnapshot().phase).toBe('ready')
    progress.noteError('auth', 'http-401')
    progress.noteEvent({
      type: 'bootstrap-failed',
      cause: 'compacted',
      attempts: 3,
      error: 'exhausted',
    })
    expect(progress.getSnapshot()).toMatchObject({ phase: 'error', error: 'network' })
  })

  it('shows no stall notice on a slow first download', async () => {
    vi.useFakeTimers()
    const store = new WebSyncProgressStore()
    store.begin('cold')
    store.beginAttempt()
    render(<SyncLoader store={store} reposLoaded={false} repoCount={0} worktreeCount={0} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(screen.queryByText(/still trying to start/)).toBeNull()
  })

  it.each([
    ['legacy-cursor-discarded', undefined],
    ['principal-changed', STORE_REFRESH_NOTICE],
  ])('a store-not-adopted report (%s) gives notice %s', async (reason, notice) => {
    const openAssembly = vi.fn(async (options: { onDegraded?: (detail: unknown) => void }) => {
      options.onDegraded?.({ kind: 'store-not-adopted', reason })
      return { principal, dispose: async () => {} } as unknown as KernelAssembly
    })
    const { result } = renderHook(() =>
      useKernelReplica({
        trpc: stableTrpc,
        httpOrigin: '',
        auth: { kind: 'principal', principal },
        openAssembly: openAssembly as never,
      }),
    )
    await vi.waitFor(() => expect(result.current.status).toBe('kernel'))
    expect((result.current as { notice?: string }).notice).toBe(notice)
  })

  it('keeps the opened gate while a re-run opens the next assembly', async () => {
    const first = { principal, dispose: vi.fn(async () => {}) } as unknown as KernelAssembly
    const opens: Array<(value: KernelAssembly) => void> = []
    const openAssembly = vi.fn(
      () =>
        new Promise<KernelAssembly>((resolve) => {
          opens.push(resolve)
        }),
    )
    const other = JSON.stringify(['installation-a', 'bob'])
    const { result, rerender } = renderHook(
      ({ who }: { who: string }) =>
        useKernelReplica({
          trpc: stableTrpc,
          httpOrigin: '',
          auth: { kind: 'principal', principal: who },
          openAssembly,
        }),
      { initialProps: { who: principal } },
    )
    await vi.waitFor(() => expect(openAssembly).toHaveBeenCalledTimes(1))
    await act(async () => opens[0]?.(first))
    await vi.waitFor(() => expect(result.current.status).toBe('kernel'))
    rerender({ who: other })
    await vi.waitFor(() => expect(openAssembly).toHaveBeenCalledTimes(2))
    expect(result.current.status).toBe('kernel')
  })
})
