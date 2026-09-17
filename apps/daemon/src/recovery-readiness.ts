import type { DaemonReadiness } from '@podium/model'

/** Observational only: a quarantined binding never gates confirmed bindings. */
export function createRecoveryReadiness(changed: () => void) {
  let generation = 0
  let inventory = false
  let recovered = false
  let retrying = false
  let count = 0
  let current: DaemonReadiness = {
    state: 'attached',
    reason: 'inventory pending',
    quarantinedBindings: 0,
  }
  const publish = () => {
    const reason = retrying
      ? 'retrying handshake'
      : !inventory
        ? 'inventory pending'
        : count > 0
          ? `${count} quarantined`
          : !recovered
            ? 'recovering bindings'
            : ''
    const next: DaemonReadiness = {
      state: reason ? 'recovering' : 'ready',
      reason,
      quarantinedBindings: count,
    }
    if (JSON.stringify(current) === JSON.stringify(next)) return
    current = next
    changed()
  }
  return {
    snapshot: () => current,
    begin(quarantined: number) {
      generation++
      inventory = false
      recovered = false
      retrying = false
      count = quarantined
      current = { state: 'attached', reason: 'inventory pending', quarantinedBindings: count }
      changed()
      publish()
      return generation
    },
    inventoryReported() {
      inventory = true
      publish()
    },
    recovered(epoch: number, quarantined: number) {
      if (epoch !== generation) return
      recovered = true
      retrying = false
      count = quarantined
      publish()
    },
    failed(epoch: number) {
      if (epoch !== generation) return
      retrying = true
      publish()
    },
    quarantined(quarantined: number) {
      count = quarantined
      publish()
    },
  }
}
