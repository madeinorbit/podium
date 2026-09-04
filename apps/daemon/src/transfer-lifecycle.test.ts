import { describe, expect, it, vi } from 'vitest'
import { restartAsServer, retireTargetDaemonAfterAcknowledgement } from './transfer-lifecycle'

describe('target transfer lifecycle parent seam', () => {
  it('retains the target daemon while the parent starts and proves the server', async () => {
    const requestTopology = vi.fn(async () => {})
    const input = { transferId: '11111111-1111-4111-8111-111111111111' }

    await restartAsServer(input, { requestTopology })
    await restartAsServer(input, { requestTopology })

    expect(requestTopology).toHaveBeenCalledTimes(2)
    expect(requestTopology).toHaveBeenNthCalledWith(1, {
      children: ['server', 'daemon'],
      health: 'server',
    })
  })

  it('does not retire the in-flight daemon when parent health proof fails', async () => {
    const requestTopology = vi.fn(async () => {
      throw new Error('topology health gate timed out')
    })

    await expect(
      restartAsServer({ transferId: '11111111-1111-4111-8111-111111111111' }, { requestTopology }),
    ).rejects.toThrow('health gate timed out')
  })

  it('removes the target daemon only after the acknowledgement flush delay', () => {
    const signalTopology = vi.fn(() => ({ ok: true as const, pid: 100, requestId: 'r1' }))
    let scheduled: (() => void) | undefined
    const schedule = vi.fn((callback: () => void, delayMs: number) => {
      expect(delayMs).toBe(50)
      scheduled = callback
    })

    retireTargetDaemonAfterAcknowledgement({ signalTopology, schedule })

    expect(signalTopology).not.toHaveBeenCalled()
    scheduled?.()
    expect(signalTopology).toHaveBeenCalledWith({ children: ['server'], health: 'none' })
  })
})
