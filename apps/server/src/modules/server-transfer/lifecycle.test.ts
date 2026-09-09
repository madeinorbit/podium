import { describe, expect, it, vi } from 'vitest'
import { retireSourceAfterTransfer } from './lifecycle'

type Spawn = typeof import('node:child_process').spawn

function scheduleHarness() {
  const work: Array<{ callback: () => void | Promise<void>; delayMs: number }> = []
  return {
    work,
    schedule: (callback: () => void | Promise<void>, delayMs: number) =>
      work.push({ callback, delayMs }),
  }
}

describe('retireSourceAfterTransfer', () => {
  it('asks the live parent to retire the server and restart the daemon remotely', async () => {
    const harness = scheduleHarness()
    const signalTopology = vi.fn(async () => ({ ok: true as const, pid: 10 }))
    const spawnProcess = vi.fn() as unknown as Spawn
    const exit = vi.fn()

    retireSourceAfterTransfer('wss://podium.example.com', {
      signalTopology,
      spawnProcess,
      schedule: harness.schedule,
      exit,
    })

    expect(signalTopology).not.toHaveBeenCalled()
    await harness.work[0]?.callback()
    expect(signalTopology).toHaveBeenCalledWith({
      children: ['daemon'],
      restartDaemon: true,
      health: 'daemon',
    })
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('lets the desktop supervisor own the replacement daemon', async () => {
    const harness = scheduleHarness()
    const spawnMock = vi.fn()
    const spawnProcess = spawnMock as unknown as Spawn
    const exit = vi.fn()

    retireSourceAfterTransfer('wss://podium.example.com', {
      env: { PODIUM_DESKTOP_SUPERVISED: '1' },
      signalTopology: async () => ({ ok: false as const, reason: 'no-parent' }),
      spawnProcess,
      schedule: harness.schedule,
      exit,
    })

    expect(harness.work).toHaveLength(1)
    expect(harness.work[0]?.delayMs).toBe(250)
    await harness.work[0]?.callback()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('starts a lifecycle-aware takeover for a headless source after reply flush', async () => {
    const harness = scheduleHarness()
    const child = { unref: vi.fn(), once: vi.fn() }
    const spawnMock = vi.fn((_command: string, _args: readonly string[]) => child)
    const spawnProcess = spawnMock as unknown as Spawn
    const exit = vi.fn()

    retireSourceAfterTransfer('wss://podium.example.com', {
      env: {},
      signalTopology: async () => ({ ok: false as const, reason: 'no-parent' }),
      spawnProcess,
      schedule: harness.schedule,
      exit,
    })

    await harness.work[0]?.callback()
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['daemon', '--server', 'wss://podium.example.com', '--takeover']),
    )
    expect(child.unref).toHaveBeenCalledOnce()
    expect(harness.work[1]?.delayMs).toBe(50)
    harness.work[1]?.callback()
    expect(exit).toHaveBeenCalledWith(0)
  })
})
