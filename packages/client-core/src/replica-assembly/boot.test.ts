import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOT_STALL_MS, type ReplicaBootState, startReplicaBoot } from './boot'
import { ReplicaGateError } from './failure'

afterEach(() => vi.useRealTimers())

describe('shared boot supervision', () => {
  it('offers recovery for a slow open and accepts its later success', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    const states: ReplicaBootState<string>[] = []
    const dispose = vi.fn(async () => {})
    const stop = startReplicaBoot({
      open: () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
      onState: (state) => states.push(state),
      dispose,
    })
    await vi.advanceTimersByTimeAsync(BOOT_STALL_MS)
    expect(states.at(-1)).toEqual({ status: 'stalled' })
    finish('local data')
    await Promise.resolve()
    expect(states.at(-1)).toEqual({ status: 'ready', value: 'local data' })
    expect(dispose).not.toHaveBeenCalled()
    stop()
    expect(dispose).toHaveBeenCalledWith('local data')
  })

  it('keeps the classified failure when it arrives after the watchdog', async () => {
    vi.useFakeTimers()
    let fail!: (cause: unknown) => void
    const states: ReplicaBootState<never>[] = []
    const stop = startReplicaBoot({
      open: () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject
        }),
      onState: (state) => states.push(state),
      dispose: async () => {},
    })
    await vi.advanceTimersByTimeAsync(BOOT_STALL_MS)
    fail(new ReplicaGateError('disk full', { kind: 'replica-blocked' }))
    await Promise.resolve()
    expect(states.at(-1)).toEqual({
      status: 'failed',
      failure: 'disk full',
      cause: { kind: 'replica-blocked' },
    })
    await vi.advanceTimersByTimeAsync(BOOT_STALL_MS)
    expect(states).toHaveLength(3)
    stop()
  })

  it('disposes an abandoned result without publishing it to the replacement boot', async () => {
    let finish!: (value: string) => void
    const state = vi.fn()
    const dispose = vi.fn(async () => {})
    const stop = startReplicaBoot({
      open: () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
      onState: state,
      dispose,
    })
    stop()
    finish('old principal')
    await Promise.resolve()
    expect(dispose).toHaveBeenCalledWith('old principal')
    expect(state).toHaveBeenCalledExactlyOnceWith({ status: 'resolving' })
  })
})
