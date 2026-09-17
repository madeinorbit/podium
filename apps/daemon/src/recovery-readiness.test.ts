import { describe, expect, it } from 'vitest'
import { createRecoveryReadiness } from './recovery-readiness'

describe('daemon recovery readiness', () => {
  it('requires both inventory and completed binding recovery', () => {
    const states: string[] = []
    const readiness = createRecoveryReadiness(() => states.push(readiness.snapshot().state))
    const epoch = readiness.begin(0)
    expect(readiness.snapshot().reason).toBe('inventory pending')
    readiness.inventoryReported()
    expect(readiness.snapshot().state).toBe('recovering')
    readiness.recovered(epoch, 0)
    expect(readiness.snapshot()).toEqual({ state: 'ready', reason: '', quarantinedBindings: 0 })
    expect(states).toEqual(['attached', 'recovering', 'recovering', 'ready'])
  })

  it('reports quarantine counts until they clear, independently of inventory order', () => {
    const readiness = createRecoveryReadiness(() => {})
    const epoch = readiness.begin(2)
    readiness.recovered(epoch, 2)
    expect(readiness.snapshot().reason).toBe('inventory pending')
    readiness.inventoryReported()
    expect(readiness.snapshot()).toEqual({
      state: 'recovering',
      reason: '2 quarantined',
      quarantinedBindings: 2,
    })
    readiness.quarantined(1)
    expect(readiness.snapshot().reason).toBe('1 quarantined')
    readiness.quarantined(0)
    expect(readiness.snapshot().state).toBe('ready')
  })

  it('ignores completion and failure from superseded recovery attempts', () => {
    const readiness = createRecoveryReadiness(() => {})
    const old = readiness.begin(0)
    const next = readiness.begin(3)
    readiness.inventoryReported()
    readiness.failed(next)
    readiness.recovered(old, 0)
    expect(readiness.snapshot()).toEqual({
      state: 'recovering',
      reason: 'retrying handshake',
      quarantinedBindings: 3,
    })
    readiness.recovered(next, 0)
    readiness.failed(old)
    expect(readiness.snapshot().state).toBe('ready')
  })
})
