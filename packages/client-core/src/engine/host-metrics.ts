import type { HostMetricsWire } from '@podium/model'

/** Ephemeral telemetry owned by one principal's runtime, outside entity snapshots. */
export function createHostMetricsStore() {
  let snapshot: HostMetricsWire[] = []
  let destroyed = false
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (!destroyed) listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish(next: HostMetricsWire[]) {
      if (destroyed || Object.is(snapshot, next)) return
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    destroy() {
      destroyed = true
      snapshot = []
      listeners.clear()
    },
  }
}
