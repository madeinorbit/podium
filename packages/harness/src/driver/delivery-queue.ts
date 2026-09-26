import type { QueueDrainAbandonedReason } from '@podium/protocol/daemon'
import type { AgentSessionHandle } from './driver.js'
import type { RuntimeEventBody } from './events.js'
import type { InputOrigin, SendOptions, TurnInput, TurnReceipt } from './turns.js'

/**
 * One daemon-held direct send (POD-4700) that will never be typed. Carries
 * the server's turn id, which is what the server's failure channel keys on —
 * the same `{ id, text }` shape the terminal injection queue reports, so the
 * daemon can forward both through one abandonment frame.
 */
export interface HeldAbandonedTurn {
  readonly id: string
  readonly text: string
  readonly origin: InputOrigin
}

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
  /**
   * Reported when a daemon-held direct send (POD-4700) leaves the queue
   * without being typed. Durable rows are never reported here: teardown
   * discards delivery state, not durable work, and the next owner recovers
   * those rows. A held row has no server ledger row behind it and nobody
   * waiting on its delivery event, so without this report it would vanish
   * silently — the server dead-letters the turn ids instead.
   * Absent on hosts with no receipt to correct.
   */
  onHeldAbandoned?: (input: {
    turns: readonly HeldAbandonedTurn[]
    // The terminal family's arms only, mirroring its invariant
    // (families/terminal/injection.ts): a queue that never got the session
    // typeable cannot honestly report `delivery-failed` — these rows were
    // never attempted, only waited on and then given up. Typed as an
    // Extract so widening the wire enum can never silently widen this
    // report; a new arm here is a conscious decision, not an accident.
    reason: Extract<QueueDrainAbandonedReason, 'never-live' | 'teardown'>
  }) => void,
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
  /**
   * Report daemon-held rows (POD-4700) that will never be typed. Only rows
   * carrying the server's turn id are reported — a held row with no id has
   * nothing the server could settle, and the daemon logs the loss instead
   * (see the terminal driver's adapter). Durable rows are the caller's to
   * filter: every call site below passes only held rows.
   */
  function abandonHeld(
    held: readonly Row[],
    reason: Extract<QueueDrainAbandonedReason, 'never-live' | 'teardown'>,
  ): void {
    const turns = held.flatMap((row) =>
      row.input.id === undefined
        ? []
        : [{ id: row.input.id, text: row.input.text, origin: row.options.origin }],
    )
    if (turns.length) onHeldAbandoned?.({ turns, reason })
  }
  const isHeld = (row: Row): boolean => row.options.daemonHeld === true
  async function drain() {
    if (draining) return
    draining = true
    try {
      while (rows.size) {
        if (!alive()) {
          // Teardown discards delivery state, not durable work: a new owner
          // receives the durable rows again, so they are cleared silently.
          // Daemon-held rows (POD-4700) have no next owner — report them, so
          // the server dead-letters the turns instead of dropping them.
          abandonHeld([...rows.values()].filter(isHeld), 'teardown')
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
            const ceiling = ENDS_ON_ITS_OWN.has(state.phase) ? BOUNDARY_CEILING_MS : STUCK_CEILING_MS
            if (Date.now() - row.admittedAt >= ceiling) {
              // The readiness wait is over and the turn was never typed. A
              // durable row's failure stays recoverable for an operator retry;
              // a held row (POD-4700) has no ledger row to keep it alive, so
              // its turn id goes out through abandonment instead of vanishing
              // with a delivery event nobody settles.
              if (isHeld(row)) abandonHeld([row], 'never-live')
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
          if (Date.now() - row.admittedAt >= BOUNDARY_CEILING_MS) {
            // Same never-typed rule as the readiness ceiling above: a held
            // row's turn id is reported, a durable row's failure stays on the
            // delivery event for an operator retry.
            if (isHeld(row)) abandonHeld([row], 'never-live')
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
        // A held row is left on its delivery event here too: the write may
        // have landed, and the transcript echo remains its settler — an
        // abandonment would dead-letter a turn that was actually typed.
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
      // A daemon-held direct send (POD-4700) joins the same FIFO under the
      // server's turn id and answers `queued` AT ONCE — the reply must land
      // inside the server's RPC window, never after the turn it waits on.
      // Success settles the way direct sends always do (transcript echo /
      // the optimistic injection mark); only a never-typed loss is reported,
      // through abandonment.
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
      // An explicit retraction, owned by its caller: the holder of the
      // `queued` receipt knows it cancelled, so a held row needs no
      // abandonment report — that channel is for losses nobody ordered.
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
      // Same split as the alive() path above: durable rows go quietly to
      // their next owner, held rows (POD-4700) are reported by turn id.
      abandonHeld([...rows.values()].filter(isHeld), 'teardown')
      for (const row of rows.values()) row.abort.abort()
      rows.clear()
      return original()
    }
  }
  return handle
}
