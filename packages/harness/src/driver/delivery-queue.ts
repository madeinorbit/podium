import type { AgentSessionHandle } from './driver.js'
import type { RuntimeEventBody } from './events.js'
import type { RefusalReason, SendOptions, TurnInput, TurnReceipt } from './turns.js'

/**
 * Phases a row waits through for up to {@link BOUNDARY_CEILING_MS}: each ends on
 * its own — a turn finishes, a compaction completes, the human answers the
 * question. The server does not hold a message for any of them [POD-4661], so
 * this queue must. Every other phase (`unknown`: no signal at all; `errored`: the
 * turn stopped and a continue is a new send; `ended`) and a composer that never
 * reports ready get the short {@link STUCK_CEILING_MS}, so a row that cannot land
 * is reported rather than held for half an hour. (A never-ready composer reads
 * `idle`, so it takes the short ceiling too.)
 */
const ENDS_ON_ITS_OWN: ReadonlySet<string> = new Set(['working', 'compacting', 'needs_user'])
const BOUNDARY_CEILING_MS = 30 * 60_000
const STUCK_CEILING_MS = 60_000

/** Disposable daemon delivery state. Admission and ordering belong to the server;
 *  waiting for the agent belongs here [POD-4661]. */
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
  /**
   * Opt-in settlement waits (POD-4700), keyed by row id and INDEPENDENT of
   * `rows` on purpose: an aborted row can leave `rows` through the drain's
   * delete-without-settle path while its canceller is still settling it, and
   * a teardown clear drops rows without settling at all. Looking the resolver
   * up here means `settle()` reaches it in every case, and the teardown paths
   * below resolve every entry they own — so an admitted marked row always
   * settles exactly once and an awaiter can never hang.
   */
  const settlements = new Map<string, (receipt: TurnReceipt) => void>()
  const send = handle.send.bind(handle)
  let draining = false
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  function refused(reason: RefusalReason, detail?: string): TurnReceipt {
    return { outcome: 'refused', refusal: detail === undefined ? { reason } : { reason, detail } }
  }
  function settle(id: string, outcome: 'delivered' | 'failed' | 'dropped', reason?: string, receipt?: TurnReceipt) {
    const settleMarked = settlements.get(id)
    if (finished.has(id) && !settleMarked) return
    const event: Outcome = { t: 'delivery', rowId: id, outcome, ...(reason ? { reason } : {}) }
    finished.set(id, event)
    rows.delete(id)
    emit(event)
    // A marked row id is minted fresh per hold, so it never replays a prior
    // outcome; the finished guard above stays the durable rows' idempotency
    // exactly. The receipt is the drain's own where it has one (accepted,
    // refused, unverified); the thin paths synthesize the truthful refusal —
    // a ceiling expiry is still busy, a retraction is not_running.
    settlements.delete(id)
    // A `queued` inner receipt parks the text in another local queue the
    // waiter cannot follow (the drain never produces one; defensively mapped
    // so a marked send always resolves to something its caller can settle).
    settleMarked?.(
      receipt === undefined || receipt.outcome === 'queued'
        ? outcome === 'dropped'
          ? refused('not_running')
          : refused('busy', reason)
        : receipt,
    )
  }
  /** Teardown discards delivery state: resolve every marked row this queue
   * owns rather than hanging a caller that never stops waiting. Never emits:
   * the server never learned these ids, so there is no receipt to correct. */
  function resolveMarkedRows(reason: RefusalReason): void {
    for (const [id, resolve] of settlements) {
      settlements.delete(id)
      resolve(refused(reason))
    }
  }
  async function drain() {
    if (draining) return
    draining = true
    try {
      while (rows.size) {
        if (!alive()) {
          for (const row of rows.values()) row.abort.abort()
          rows.clear()
          resolveMarkedRows('not_running')
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
            const ceiling = ENDS_ON_ITS_OWN.has(state.phase) ? BOUNDARY_CEILING_MS : STUCK_CEILING_MS
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
          settle(id, 'delivered', undefined, receipt)
          continue
        }
        if (
          receipt.outcome === 'refused' &&
          ['busy', 'needs_user', 'lease_held'].includes(receipt.refusal.reason)
        ) {
          if (Date.now() - row.admittedAt >= BOUNDARY_CEILING_MS) {
            settle(id, 'failed', 'the agent stayed busy before accepting this input', receipt)
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
          settle(id, 'failed', receipt.refusal.detail ?? receipt.refusal.reason, receipt)
          continue
        }
        // Neither an unverified write nor admission to another local queue
        // proves loss. Retyping either can open a duplicate turn. The durable
        // failure keeps the text recoverable for an explicit operator retry.
        settle(id, 'failed', row.input.initialPrompt
          ? 'the creation prompt was not confirmed; it will not be typed again automatically'
          : 'delivery could not be confirmed; check the transcript before retrying', receipt)
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
    if (prior && !options.awaitSettlement) emit(prior)
    if (!prior && !rows.has(input.rowId)) {
      rows.set(input.rowId, { input, options, abort: new AbortController(), admittedAt: Date.now() })
      // A daemon-held direct send (POD-4700) adopts its row's settlement
      // instead of the stub: the holder minted a fresh id, so no prior row or
      // receipt can exist for it, and the resolver is registered before the
      // drain runs so no settle can slip past it.
      let awaited: Promise<TurnReceipt> | undefined
      if (options.awaitSettlement && input.rowId) {
        const rowId = input.rowId
        awaited = new Promise<TurnReceipt>((resolve) => {
          settlements.set(rowId, resolve)
        })
      }
      void drain()
      if (awaited) return awaited
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
        settle(id, 'delivered', undefined, receipt)
        return { reason: 'busy', detail: 'the row was already delivered' }
      }
      if (receipt && receipt.outcome !== 'refused') {
        settle(id, 'failed', 'cancellation could not retract an unconfirmed delivery; check the transcript before retrying', receipt.outcome === 'queued' ? undefined : receipt)
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
      resolveMarkedRows('not_running')
      return original()
    }
  }
  return handle
}
