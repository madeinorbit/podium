import type { TranscriptItemRef } from '@podium/model'
import type { DeliveryFailureCause, QueueDrainAbandonedReason } from '@podium/protocol/daemon'
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
 * Phases a row waits through with NO deadline: each ends on its own — a turn
 * finishes, a compaction completes, the human answers the question. The
 * message is durable on the server; the user sees it pending and can retract
 * it. Only the daemon decides when to type, so the queue waits for the turn
 * boundary however long that takes. Every other phase (`unknown`: no signal
 * at all; `errored`: the turn stopped and a continue is a new send; `ended`)
 * and a composer that never reports ready get the short
 * {@link STUCK_CEILING_MS}, so a row that cannot land is reported as
 * `agent not accepting input` rather than held forever. (A never-ready
 * composer reads `idle`, so it takes the short ceiling too.)
 */
const ENDS_ON_ITS_OWN: ReadonlySet<string> = new Set(['working', 'compacting', 'needs_user'])
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
  /** Entries a driver named before its row settled (POD-4774). */
  const namedEarly = new Map<string, TranscriptItemRef>()
  const send = handle.send.bind(handle)
  let draining = false
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  function settle(
    id: string,
    outcome: 'delivered' | 'failed' | 'dropped',
    reason?: string,
    cause?: DeliveryFailureCause,
    transcriptItem?: TranscriptItemRef,
  ) {
    if (finished.has(id)) return
    const named = outcome === 'delivered' ? (transcriptItem ?? namedEarly.get(id)) : undefined
    namedEarly.delete(id)
    const event: Outcome = {
      t: 'delivery',
      rowId: id,
      outcome,
      ...(reason ? { reason } : {}),
      ...(cause ? { cause } : {}),
      ...(named ? { transcriptItem: named } : {}),
    }
    finished.set(id, event)
    rows.delete(id)
    emit(event)
  }
  /**
   * A DELIVERED ROW'S ENTRY, LEARNED LATE (POD-4774): a second `delivered`
   * outcome for the same id, now naming the entry. Forward-only like every
   * outcome — it never moves a row, only names the entry once — and the
   * `finished` replay carries it from here on.
   */
  function name(id: string, transcriptItem: TranscriptItemRef): void {
    const prior = finished.get(id)
    if (!prior) {
      if (rows.has(id)) namedEarly.set(id, transcriptItem)
      return
    }
    if (prior.outcome !== 'delivered' || prior.transcriptItem) return
    const event: Outcome = { ...prior, transcriptItem }
    finished.set(id, event)
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
          settle(
            id,
            'failed',
            'previous delivery could not be confirmed; check the transcript before retrying',
            'unconfirmed',
          )
          continue
        }
        let receipt: TurnReceipt
        try {
          // These reads never leave the owning daemon. Drivers refuse a raced
          // busy/lease boundary for deliveryAttempt instead of creating a second queue.
          const state = await handle.state()
          if (row.abort.signal.aborted) continue
          if (state.phase !== 'idle' || !ready()) {
            if (ENDS_ON_ITS_OWN.has(state.phase)) {
              // A live turn ends on its own: wait for the boundary with no
              // deadline, however long the agent stays busy. The row is
              // durable on the server and retractable while it waits.
              await pause(200)
              continue
            }
            if (Date.now() - row.admittedAt >= STUCK_CEILING_MS) {
              // The composer is genuinely stuck, not mid-turn: nothing will
              // end this state on its own. A durable row's failure stays
              // recoverable for an operator retry; a held row (POD-4700) has
              // no ledger row to keep it alive, so its turn id goes out
              // through abandonment instead of vanishing with a delivery
              // event nobody settles.
              if (isHeld(row)) abandonHeld([row], 'never-live')
              settle(id, 'failed', 'agent not accepting input', 'not-accepting-input')
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
              onTranscriptItem: (item) => name(id, item),
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
          // The driver's pairing travels with the outcome, and a replay of it
          // (`finished`) carries the same item (POD-4774).
          settle(id, 'delivered', undefined, undefined, receipt.transcriptItem)
          continue
        }
        if (
          receipt.outcome === 'refused' &&
          ['busy', 'needs_user', 'lease_held'].includes(receipt.refusal.reason)
        ) {
          // The agent went busy between the state read and the send: the same
          // turn-boundary wait as above, with the same no-deadline rule.
          // Bounding this race would fail rows on long turns through the back
          // door. Re-checks the state on the next pass.
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
        // Neither an unverified write nor admission to another local queue
        // proves loss. Retyping either can open a duplicate turn. The durable
        // failure keeps the text recoverable for an explicit operator retry.
        // A held row is left on its delivery event here too: the write may
        // have landed, and the transcript echo remains its settler — an
        // abandonment would dead-letter a turn that was actually typed.
        settle(
          id,
          'failed',
          row.input.initialPrompt
            ? 'the creation prompt was not confirmed; it will not be typed again automatically'
            : 'delivery could not be confirmed; check the transcript before retrying',
          'unconfirmed',
        )
      }
    } finally {
      draining = false
    }
  }
  handle.send = async (input, options) => {
    if (!input.rowId) {
      // A direct send names its entry by its turn id, the id the server's
      // message carries, when the driver learns it after the receipt went
      // back (POD-4774). Same outcome frame as a row's, for the same reason.
      const turnId = input.id
      if (turnId === undefined || options.onTranscriptItem) return send(input, options)
      return send(input, {
        ...options,
        onTranscriptItem: (transcriptItem) =>
          emit({ t: 'delivery', rowId: turnId, outcome: 'delivered', transcriptItem }),
      })
    }
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
        settle(id, 'delivered', undefined, undefined, receipt.transcriptItem)
        return { reason: 'busy', detail: 'the row was already delivered' }
      }
      if (receipt && receipt.outcome !== 'refused') {
        settle(
          id,
          'failed',
          'cancellation could not retract an unconfirmed delivery; check the transcript before retrying',
          'unconfirmed',
        )
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
