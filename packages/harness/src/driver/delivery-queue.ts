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
    admittedAt: number
    inFlight?: Promise<TurnReceipt>
  }
  const rows = new Map<string, Row>()
  type Outcome = Extract<RuntimeEventBody, { t: 'delivery' }>
  const finished = new Map<string, Outcome>()
  const send = handle.send.bind(handle)
  let draining = false
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  function settle(id: string, outcome: 'delivered' | 'failed' | 'dropped', reason?: string) {
    if (finished.has(id)) return
    const event: Outcome = { t: 'delivery', rowId: id, outcome, ...(reason ? { reason } : {}) }
    finished.set(id, event)
    rows.delete(id)
    emit(event)
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
        // A durable reservation from a previous owner is evidence of a
        // possible write, not permission to retry. Same-owner repeats never
        // reach here: rows/finished replay custody or its proven outcome.
        if (row.input.deliveryRecovery) {
          settle(id, 'failed', 'previous delivery could not be confirmed; check the transcript before retrying')
          continue
        }
        let receipt: TurnReceipt
        try {
          // These reads never leave the owning daemon. Drivers refuse a raced
          // busy/lease boundary for deliveryAttempt instead of creating a second queue.
          const state = await handle.state()
          if (row.abort.signal.aborted) continue
          if (state.phase !== 'idle' || !ready()) {
            const ceiling = (state.phase === 'working' || state.phase === 'compacting') ? 30 * 60_000 : 60_000
            if (Date.now() - row.admittedAt >= ceiling) {
              settle(id, 'failed', 'the agent did not become ready before the delivery deadline')
            } else {
              await pause(200)
            }
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
          if (Date.now() - row.admittedAt >= 30 * 60_000) {
            settle(id, 'failed', 'the agent stayed busy before accepting this input')
          } else {
            await pause(200)
          }
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
        // Neither an unverified write nor admission to another local queue
        // proves loss. Retyping either can open a duplicate turn. The durable
        // failure keeps the text recoverable for an explicit operator retry.
        settle(id, 'failed', row.input.initialPrompt
          ? 'the creation prompt was not confirmed; it will not be typed again automatically'
          : 'delivery could not be confirmed; check the transcript before retrying')
      }
    } finally {
      draining = false
    }
  }
  handle.send = async (input, options) => {
    if (!input.rowId) return send(input, options)
    // Durable delivery drains as when-ready. Never erase a boundary request.
    if (options.delivery === 'at-boundary') {
      return { outcome: 'refused', refusal: { reason: 'unsupported', detail: 'boundary delivery does not support durable rows' } }
    }
    const prior = finished.get(input.rowId)
    if (prior) emit(prior)
    if (!prior && !rows.has(input.rowId)) {
      rows.set(input.rowId, { input, options, abort: new AbortController(), admittedAt: Date.now() })
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
      if (receipt && receipt.outcome !== 'refused') {
        settle(id, 'failed', 'cancellation could not retract an unconfirmed delivery; check the transcript before retrying')
        return { reason: 'busy', detail: 'delivery may already have occurred' }
      }
      settle(id, 'dropped')
    } else if (finished.get(id)?.outcome === 'delivered') {
      emit(finished.get(id)!)
      return { reason: 'busy', detail: 'the row was already delivered' }
    } else if (!finished.has(id)) {
      // Cancel may arrive before an in-flight admission RPC. Keep a tombstone
      // so that late admission cannot resurrect work already retracted.
      settle(id, 'dropped')
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
