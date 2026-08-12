import { asMachineId } from '@podium/model'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Store } from '@/app/store'
import {
  SERVER_TRANSFER_CONFIRMATION,
  isValidServerTransferUrl,
  type ServerTransferStatusController,
  type ServerTransferStatusSnapshot,
  transferDisplayState,
  useServerTransfer,
  useServerTransferStatus,
} from './server-transfer'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function transfer(
  overrides: Partial<NonNullable<ServerTransferStatusSnapshot['transfer']>> = {},
): NonNullable<ServerTransferStatusSnapshot['transfer']> {
  return {
    targetMachineId: asMachineId('target'),
    state: 'committed',
    phase: 'switching',
    sourceFenced: true,
    targetProof: false,
    sourceConnected: false,
    transferId: 'transfer-1',
    publicUrl: 'https://new-podium.example.com',
    ...overrides,
  } as NonNullable<ServerTransferStatusSnapshot['transfer']>
}

function snapshot(
  current: ServerTransferStatusSnapshot['transfer'] = null,
): ServerTransferStatusSnapshot {
  return {
    sourceMachineId: asMachineId('source'),
    targetEligibility: [],
    transfer: current,
  }
}

function statusTrpc(query: () => Promise<ServerTransferStatusSnapshot>): Store['trpc'] {
  return {
    machines: { serverTransferStatus: { query } },
  } as unknown as Store['trpc']
}

describe('server transfer durable status', () => {
  it('lets the newest overlapping read publish and ignores the stale result', async () => {
    const older = deferred<ServerTransferStatusSnapshot>()
    const newer = deferred<ServerTransferStatusSnapshot>()
    const query = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const trpc = statusTrpc(query)
    const { result, unmount } = renderHook(() => useServerTransferStatus(trpc))
    let newerRead!: Promise<ServerTransferStatusSnapshot | null>

    act(() => {
      newerRead = result.current.refresh()
    })
    const newest = snapshot(
      transfer({ transferId: 'newer', state: 'preparing', phase: 'preparing' }),
    )
    await act(async () => {
      newer.resolve(newest)
      await newerRead
    })
    expect(result.current.snapshot).toBe(newest)

    await act(async () => {
      older.resolve(snapshot(transfer({ transferId: 'older' })))
      await older.promise
    })
    expect(result.current.snapshot).toBe(newest)
    unmount()
  })

  it('does not publish an in-flight read after unmount', async () => {
    const pending = deferred<ServerTransferStatusSnapshot>()
    const trpc = statusTrpc(() => pending.promise)
    const { result, unmount } = renderHook(() => useServerTransferStatus(trpc))

    unmount()
    await act(async () => {
      pending.resolve(snapshot(transfer()))
      await pending.promise
    })

    expect(result.current.snapshot).toBeNull()
  })

  it('does not let an old trpc generation overwrite the replacement transport', async () => {
    const oldRead = deferred<ServerTransferStatusSnapshot>()
    const newRead = deferred<ServerTransferStatusSnapshot>()
    const oldTrpc = statusTrpc(() => oldRead.promise)
    const newTrpc = statusTrpc(() => newRead.promise)
    const { result, rerender, unmount } = renderHook(
      ({ trpc }: { trpc: Store['trpc'] }) => useServerTransferStatus(trpc),
      { initialProps: { trpc: oldTrpc } },
    )

    rerender({ trpc: newTrpc })
    const newest = snapshot(transfer({ transferId: 'new-transport' }))
    await act(async () => {
      newRead.resolve(newest)
      await newRead.promise
    })
    await act(async () => {
      oldRead.resolve(snapshot(transfer({ transferId: 'old-transport' })))
      await oldRead.promise
    })

    expect(result.current.snapshot).toBe(newest)
    unmount()
  })
})

describe('server transfer controller', () => {
  it('requires proof and source reconnection before displaying Connected', () => {
    expect(transferDisplayState(transfer({ targetProof: true, sourceConnected: false }))).toBe(
      'switching',
    )
    expect(
      transferDisplayState(
        transfer({ phase: 'connected', targetProof: true, sourceConnected: true }),
      ),
    ).toBe('connected')
  })

  it('accepts only complete HTTP(S) target URLs', () => {
    expect(isValidServerTransferUrl('https://podium.example.com')).toBe(true)
    expect(isValidServerTransferUrl('http://127.0.0.1:3000')).toBe(true)
    expect(isValidServerTransferUrl('podium.example.com')).toBe(false)
    expect(isValidServerTransferUrl('ssh://podium.example.com')).toBe(false)
  })

  it('starts with the exact protocol confirmation and reconciles through durable status', async () => {
    const mutate = vi.fn().mockResolvedValue({ state: 'committed' })
    const refresh = vi.fn().mockResolvedValue(null)
    const status: ServerTransferStatusController = { snapshot: null, error: null, refresh }
    const trpc = {
      machines: { transferServer: { mutate } },
    } as unknown as Store['trpc']
    const { result } = renderHook(() =>
      useServerTransfer({ trpc, targetMachineId: asMachineId('target'), status }),
    )

    act(() => {
      result.current.setPublicUrl(' https://new-podium.example.com ')
      result.current.setConfirmation(SERVER_TRANSFER_CONFIRMATION)
    })
    expect(result.current.canStart).toBe(true)
    await act(() => result.current.start())

    expect(mutate).toHaveBeenCalledWith({
      targetMachineId: asMachineId('target'),
      publicUrl: 'https://new-podium.example.com',
      confirmation: SERVER_TRANSFER_CONFIRMATION,
    })
    expect(refresh).toHaveBeenCalledOnce()
    expect(result.current.awaitingStatus).toBe(true)
  })

  it('clears awaiting as soon as a matching durable transfer is published', async () => {
    const mutate = vi.fn().mockResolvedValue({ state: 'committed' })
    const status: ServerTransferStatusController = {
      snapshot: null,
      error: null,
      refresh: vi.fn().mockResolvedValue(null),
    }
    const trpc = { machines: { transferServer: { mutate } } } as unknown as Store['trpc']
    const { result, rerender } = renderHook(
      ({ status }: { status: ServerTransferStatusController }) =>
        useServerTransfer({ trpc, targetMachineId: asMachineId('target'), status }),
      { initialProps: { status } },
    )

    act(() => {
      result.current.setPublicUrl('https://new-podium.example.com')
      result.current.setConfirmation(SERVER_TRANSFER_CONFIRMATION)
    })
    await act(() => result.current.start())
    expect(result.current.awaitingStatus).toBe(true)

    rerender({
      status: {
        ...status,
        snapshot: snapshot(transfer({ state: 'commit-uncertain', phase: 'commit-uncertain' })),
      },
    })

    expect(result.current.awaitingStatus).toBe(false)
    expect(result.current.displayState).toBe('commit-uncertain')
  })

  it('keeps a successful retry busy while refreshes and polls repeat the old aborted journal', async () => {
    const aborted = transfer({
      transferId: 'old-aborted',
      state: 'aborted',
      phase: 'aborted',
      sourceFenced: false,
    })
    const firstStatus: ServerTransferStatusController = {
      snapshot: snapshot(aborted),
      error: null,
      refresh: vi.fn().mockResolvedValue(snapshot(aborted)),
    }
    const trpc = {
      machines: { transferServer: { mutate: vi.fn().mockResolvedValue({ state: 'committed' }) } },
    } as unknown as Store['trpc']
    const { result, rerender } = renderHook(
      ({ status }: { status: ServerTransferStatusController }) =>
        useServerTransfer({ trpc, targetMachineId: asMachineId('target'), status }),
      { initialProps: { status: firstStatus } },
    )

    act(() => {
      result.current.setPublicUrl('https://retry.example.com')
      result.current.setConfirmation(SERVER_TRANSFER_CONFIRMATION)
    })
    await act(() => result.current.start())

    expect(result.current.awaitingStatus).toBe(true)
    expect(result.current.showProgress).toBe(true)
    expect(result.current.transfer).toBeNull()
    expect(result.current.displayState).toBeNull()

    rerender({
      status: {
        ...firstStatus,
        snapshot: snapshot({ ...aborted }),
      },
    })
    expect(result.current.awaitingStatus).toBe(true)
    expect(result.current.displayState).toBeNull()

    rerender({
      status: {
        ...firstStatus,
        snapshot: snapshot(
          transfer({
            transferId: 'new-retry',
            state: 'preparing',
            phase: 'preparing',
            sourceFenced: false,
          }),
        ),
      },
    })
    expect(result.current.awaitingStatus).toBe(false)
    expect(result.current.displayState).toBe('preparing')
  })

  it('resets state and ignores an old target operation after retargeting', async () => {
    const mutation = deferred<unknown>()
    const refresh = vi
      .fn()
      .mockResolvedValue(
        snapshot(transfer({ state: 'commit-uncertain', phase: 'commit-uncertain' })),
      )
    const status: ServerTransferStatusController = {
      snapshot: snapshot(transfer({ state: 'commit-uncertain', phase: 'commit-uncertain' })),
      error: null,
      refresh,
    }
    const trpc = {
      machines: { transferServer: { mutate: vi.fn(() => mutation.promise) } },
    } as unknown as Store['trpc']
    const { result, rerender } = renderHook(
      ({ targetMachineId }: { targetMachineId: ReturnType<typeof asMachineId> }) =>
        useServerTransfer({ trpc, targetMachineId, status }),
      { initialProps: { targetMachineId: asMachineId('target') } },
    )

    act(() => {
      result.current.setPublicUrl('https://old-target.example.com')
      result.current.setConfirmation(SERVER_TRANSFER_CONFIRMATION)
    })
    let pendingCheck!: Promise<void>
    act(() => {
      pendingCheck = result.current.checkTarget()
    })
    rerender({ targetMachineId: asMachineId('replacement') })

    expect(result.current.publicUrl).toBe('')
    expect(result.current.confirmation).toBe('')
    expect(result.current.checkingTarget).toBe(false)
    await act(async () => {
      mutation.reject(new Error('old target unavailable'))
      await pendingCheck
    })
    expect(result.current.error).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('does not reconcile a rejected retry against a pre-existing aborted journal', async () => {
    const aborted = transfer({
      transferId: 'old-aborted',
      state: 'aborted',
      phase: 'aborted',
      sourceFenced: false,
    })
    const durable = snapshot(aborted)
    const mutate = vi.fn().mockRejectedValue(new Error('retry was rejected'))
    const status: ServerTransferStatusController = {
      snapshot: durable,
      error: null,
      refresh: vi.fn().mockResolvedValue(durable),
    }
    const trpc = { machines: { transferServer: { mutate } } } as unknown as Store['trpc']
    const { result } = renderHook(() =>
      useServerTransfer({ trpc, targetMachineId: asMachineId('target'), status }),
    )

    act(() => {
      result.current.setPublicUrl('https://retry.example.com')
      result.current.setConfirmation(SERVER_TRANSFER_CONFIRMATION)
    })
    await act(() => result.current.start())

    expect(result.current.awaitingStatus).toBe(false)
    expect(result.current.error).toBe('retry was rejected')
  })

  it('treats a new durable journal as recovery from a lost start reply', async () => {
    const aborted = transfer({
      transferId: 'old-aborted',
      state: 'aborted',
      phase: 'aborted',
      sourceFenced: false,
    })
    const recovered = snapshot(
      transfer({
        transferId: 'new-transfer',
        state: 'preparing',
        phase: 'preparing',
        sourceFenced: false,
      }),
    )
    const status: ServerTransferStatusController = {
      snapshot: snapshot(aborted),
      error: null,
      refresh: vi.fn().mockResolvedValue(recovered),
    }
    const trpc = {
      machines: { transferServer: { mutate: vi.fn().mockRejectedValue(new Error('reply lost')) } },
    } as unknown as Store['trpc']
    const { result, rerender } = renderHook(
      ({ status }: { status: ServerTransferStatusController }) =>
        useServerTransfer({ trpc, targetMachineId: asMachineId('target'), status }),
      { initialProps: { status } },
    )

    act(() => {
      result.current.setPublicUrl('https://new-target.example.com')
      result.current.setConfirmation(SERVER_TRANSFER_CONFIRMATION)
    })
    await act(() => result.current.start())

    expect(result.current.error).toBeNull()
    expect(result.current.awaitingStatus).toBe(true)
    expect(result.current.displayState).toBeNull()

    rerender({ status: { ...status, snapshot: recovered } })

    expect(result.current.awaitingStatus).toBe(false)
    expect(result.current.displayState).toBe('preparing')
  })

  it('invalidates an in-flight start when the surface closes', async () => {
    const mutation = deferred<unknown>()
    const refresh = vi.fn().mockResolvedValue(null)
    const status: ServerTransferStatusController = { snapshot: null, error: null, refresh }
    const trpc = {
      machines: { transferServer: { mutate: vi.fn(() => mutation.promise) } },
    } as unknown as Store['trpc']
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useServerTransfer({ trpc, targetMachineId: asMachineId('target'), status, active }),
      { initialProps: { active: true } },
    )

    act(() => {
      result.current.setPublicUrl('https://new-target.example.com')
      result.current.setConfirmation(SERVER_TRANSFER_CONFIRMATION)
    })
    let pendingStart!: Promise<void>
    act(() => {
      pendingStart = result.current.start()
    })
    rerender({ active: false })
    expect(result.current.awaitingStatus).toBe(false)

    await act(async () => {
      mutation.resolve({ state: 'committed' })
      await pendingStart
    })
    expect(refresh).not.toHaveBeenCalled()

    rerender({ active: true })
    expect(result.current).toMatchObject({
      publicUrl: '',
      confirmation: '',
      awaitingStatus: false,
      error: null,
    })
  })

  it('invalidates an in-flight target check when the surface closes', async () => {
    const uncertain = transfer({ state: 'commit-uncertain', phase: 'commit-uncertain' })
    const mutation = deferred<unknown>()
    const refresh = vi.fn().mockResolvedValue(snapshot(uncertain))
    const status: ServerTransferStatusController = {
      snapshot: snapshot(uncertain),
      error: null,
      refresh,
    }
    const trpc = {
      machines: { transferServer: { mutate: vi.fn(() => mutation.promise) } },
    } as unknown as Store['trpc']
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useServerTransfer({ trpc, targetMachineId: asMachineId('target'), status, active }),
      { initialProps: { active: true } },
    )

    let pendingCheck!: Promise<void>
    act(() => {
      pendingCheck = result.current.checkTarget()
    })
    rerender({ active: false })
    expect(result.current.checkingTarget).toBe(false)

    await act(async () => {
      mutation.reject(new Error('closed check failed'))
      await pendingCheck
    })
    expect(refresh).not.toHaveBeenCalled()

    rerender({ active: true })
    expect(result.current.checkingTarget).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('clears a failed target check when refreshed durable status proves resolution', async () => {
    const uncertain = transfer({ state: 'commit-uncertain', phase: 'commit-uncertain' })
    const resolved = snapshot(
      transfer({
        state: 'committed',
        phase: 'connected',
        targetProof: true,
        sourceConnected: true,
      }),
    )
    const status: ServerTransferStatusController = {
      snapshot: snapshot(uncertain),
      error: null,
      refresh: vi.fn().mockResolvedValue(resolved),
    }
    const trpc = {
      machines: {
        transferServer: { mutate: vi.fn().mockRejectedValue(new Error('inspection reply lost')) },
      },
    } as unknown as Store['trpc']
    const { result } = renderHook(() =>
      useServerTransfer({ trpc, targetMachineId: asMachineId('target'), status }),
    )

    await act(() => result.current.checkTarget())

    expect(result.current.checkingTarget).toBe(false)
    expect(result.current.error).toBeNull()
  })
})
