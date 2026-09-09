import type { AgentSessionHandle } from './driver.js'
import type { RuntimeEventBody } from './events.js'
import type { SendOptions, TurnInput, TurnReceipt } from './turns.js'

/** Disposable daemon delivery state. Admission, ordering and holds belong to the server. */
export function withDeliveryQueue(
  handle: AgentSessionHandle,
  emit: (event: RuntimeEventBody) => void,
  ready: () => boolean = () => true,
  alive: () => boolean = () => true,
): AgentSessionHandle {
  type Row = {
    input: TurnInput
    options: SendOptions
    abort: AbortController
    attempts: number
    inFlight?: Promise<TurnReceipt>
  }
  const rows = new Map<string, Row>()
  const finished = new Map<string, 'delivered' | 'failed' | 'dropped'>()
  const send = handle.send.bind(handle)
  let draining = false
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  function settle(id: string, outcome: 'delivered' | 'failed' | 'dropped', reason?: string) {
    if (finished.has(id)) return
    finished.set(id, outcome)
    rows.delete(id)
    emit({ t: 'delivery', rowId: id, outcome, ...(reason ? { reason } : {}) })
  }
  async function drain() {
    if (draining) return
    draining = true
    try {
      while (rows.size) {
        if (!alive()) {
          for (const row of rows.values()) row.abort.abort()
          rows.clear()
          return
        }
        const [id, row] = rows.entries().next().value!
        if (row.abort.signal.aborted) {
          rows.delete(id)
          continue
        }
        let receipt: TurnReceipt
        try {
          // These reads never leave the owning daemon. Drivers refuse a raced
          // busy/lease boundary for deliveryAttempt instead of creating a second queue.
          const state = await handle.state()
          if (row.abort.signal.aborted) continue
          if (state.phase !== 'idle' || !ready()) {
            await pause(200)
            continue
          }
          row.inFlight = send(
            { ...row.input, rowId: undefined },
            {
              ...row.options,
              delivery: 'when-ready',
              deliveryAttempt: true,
              signal: row.abort.signal,
            },
          )
          receipt = await row.inFlight
        } catch {
          receipt = {
            outcome: 'unverified',
            deliveredAs: 'when-ready',
            verificationWindowMs: 0,
            at: new Date().toISOString(),
          }
        }
        if (row.abort.signal.aborted) continue
        if (receipt.outcome === 'accepted') {
          settle(id, 'delivered')
          continue
        }
        if (
          receipt.outcome === 'refused' &&
          ['busy', 'needs_user', 'lease_held'].includes(receipt.refusal.reason)
        ) {
          await pause(200)
          continue
        }
        if (
          receipt.outcome === 'refused' &&
          ['unsupported', 'session_ended', 'staging_failed', 'invalid_value'].includes(
            receipt.refusal.reason,
          )
        ) {
          settle(id, 'failed', receipt.refusal.detail ?? receipt.refusal.reason)
          continue
        }
        row.attempts++
        if (row.attempts >= 5) {
          settle(id, 'failed', 'delivery could not be confirmed after 5 attempts')
        } else {
          await pause(2000 * row.attempts)
        }
      }
    } finally {
      draining = false
    }
  }
  handle.send = async (input, options) => {
    if (!input.rowId) return send(input, options)
    if (!finished.has(input.rowId) && !rows.has(input.rowId)) {
      rows.set(input.rowId, { input, options, abort: new AbortController(), attempts: 0 })
      void drain()
    }
    return {
      outcome: 'queued',
      position: Math.max(1, [...rows.keys()].indexOf(input.rowId) + 1),
      deliveredAs: 'queue',
      at: new Date().toISOString(),
    }
  }
  handle.cancelDelivery = async (id) => {
    const row = rows.get(id)
    if (row) {
      row.abort.abort()
      // Cancellation cannot retract a protocol acknowledgement already in flight.
      // Preserve that proof and tell the server the row could not be retracted.
      const receipt = await row.inFlight?.catch(() => undefined)
      if (receipt?.outcome === 'accepted') {
        settle(id, 'delivered')
        return { reason: 'busy', detail: 'the row was already delivered' }
      }
      settle(id, 'dropped')
    } else if (finished.get(id) === 'delivered') {
      return { reason: 'busy', detail: 'the row was already delivered' }
    }
    return { ok: true }
  }
  for (const method of ['stop', 'kill', 'hibernate'] as const) {
    if (!handle[method]) continue
    const original = handle[method].bind(handle)
    // Teardown discards delivery state, not durable work. A new owner receives
    // remaining rows again; only explicit cancel produces a dropped outcome.
    ;(handle as any)[method] = async () => {
      if (method === 'hibernate' && !handle.binding.resume) return original()
      for (const row of rows.values()) row.abort.abort()
      rows.clear()
      return original()
    }
  }
  return handle
}
