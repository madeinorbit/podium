import { asMachineId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { UpdateReconciler } from './modules/updates/reconciler'
import { SessionRegistry } from './relay'
import { captureLogs } from './test-support/capture-logs'

describe('fleet change event completion', () => {
  it.each(['bridge', 'reconciler'] as const)(
    'observes a delayed %s rejection without blocking machine events',
    async (failingTask) => {
      const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
      const logs = captureLogs()
      const failure = new Error(`${failingTask} failed`)
      let reject!: (reason: Error) => void
      const pending = new Promise<void>((_resolve, rejectPromise) => {
        reject = rejectPromise
      })
      // Keep the mutation arm's dropped promise from leaking out of this test;
      // only the bus's own log below proves production observed the rejection.
      void pending.catch(() => undefined)
      const bridge = registry.modules.updateFleetBridge
      if (!bridge) throw new Error('fleet bridge missing')
      const fleet = vi.spyOn(bridge, 'onFleetChanged')
        .mockImplementation(() => failingTask === 'bridge' ? pending : Promise.resolve())
      const reconnect = vi.spyOn(UpdateReconciler.prototype, 'onMachineConnected')
        .mockImplementation(() => failingTask === 'reconciler' ? pending : Promise.resolve())
      const sibling = vi.fn()
      const unsubscribe = registry.modules.bus.on('machine.connected', sibling)
      try {
        registry.modules.bus.emit('machine.connected', { machineId: asMachineId('fleet-test') })
        expect(sibling).toHaveBeenCalledOnce()
        expect(fleet).toHaveBeenCalledOnce()
        expect(reconnect).toHaveBeenCalledOnce()
        reject(failure)
        // Drain the promise reactions without sleeping or polling.
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(logs.records).toContainEqual(expect.objectContaining({
          msg: 'event listener rejected',
          event: 'machine.connected',
          err: expect.objectContaining({ message: failure.message }),
        }))
      } finally {
        unsubscribe()
        fleet.mockRestore()
        reconnect.mockRestore()
        logs.restore()
        registry.dispose()
      }
    },
  )
})
