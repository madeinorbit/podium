import type { TranscriptItemRef } from '@podium/model'
import type { DeliveryFailureCause } from '@podium/protocol/daemon'
import type { AgentSessionHandle } from './driver.js'
import type { RuntimeEventBody } from './events.js'
import type { SendOptions, TurnInput, TurnReceipt } from './turns.js'

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
 *
 * The ceiling counts only a CONTINUOUS not-accepting stretch, never the time
 * since the row arrived (POD-4826): state readings are imperfect, so one
 * wrong reading after a long wait behind a busy turn must not fail the row.
 * Any reading of a live turn, or of an idle agent whose composer is ready,
 * ends the stretch.
 */
const ENDS_ON_ITS_OWN: ReadonlySet<string> = new Set(['working', 'compacting', 'needs_user'])
const STUCK_CEILING_MS = 60_000

/** Disposable daemon delivery state. Admission belongs to the server; when to
 *  type, and in which order, belongs here [POD-4661].
 *
 *  ONE QUEUE, TWO DELIVERY MODES (POD-4795). Every durable row waits here under
 *  its row id; a row sent as `interrupt` differs only in WHERE it waits and in
 *  what the drain does before typing it: it goes ahead of every row still
 *  waiting (after earlier interrupts), and when it reaches the head of a
 *  running turn the drain asks the driver to cut that turn, then types it at
 *  the boundary like any other row. The server never sends an interrupt
 *  around the queue, so dedupe by id, retraction and restart recovery are the
 *  same for both modes. */
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
    /** When the current continuous not-accepting stretch began; unset while
     *  the agent reads as busy or as ready to type. */
    stuckSince?: number
    /** Sent as `interrupt`: waits ahead of plain rows and cuts a running turn. */
    interrupt: boolean
    /** The cut was asked for once; the row now waits for the boundary. */
    interruptRequested?: boolean
    /** Set the moment the driver is asked to type the row, cleared only by a
     *  refusal that proves nothing was typed. While set, a retract loses. */
    inFlight?: Promise<TurnReceipt>
  }
  const rows = new Map<string, Row>()
  type Outcome = Extract<RuntimeEventBody, { t: 'delivery' }>
  const finished = new Map<string, Outcome>()
  /** Entries a driver named before its row settled (POD-4774). */
  const namedEarly = new Map<string, TranscriptItemRef>()
  /**
   * TYPED, AND HELD BY THE PROGRAM WITHOUT A RECORD YET (POD-4849): rows whose
   * receipt said `held`. Not delivered and not waiting: the next row may be
   * typed, a retract is too late, and the row settles on what the driver says
   * next — its entry, or that it will not be recorded.
   */
  const held = new Set<string>()
  /** Rows the driver said it will not record before their receipt came back. */
  const unrecordedEarly = new Map<string, string>()
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
    unrecordedEarly.delete(id)
    held.delete(id)
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
    if (held.has(id)) {
      // The record a held row waited for: this is its delivery.
      settle(id, 'delivered', undefined, undefined, transcriptItem)
      return
    }
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
   * A HELD ROW THE PROGRAM WILL NOT RECORD (POD-4849): what held it ended
   * first. Unconfirmed — the server's `unknown` — and never `failed`: nothing
   * here proves the model did not see it, and a retry could run it twice.
   */
  function unrecorded(id: string, reason: string): void {
    if (held.has(id)) {
      settle(id, 'failed', reason, 'unconfirmed')
      return
    }
    if (rows.has(id) && !finished.has(id)) unrecordedEarly.set(id, reason)
  }
  /**
   * An interrupt row waits ahead of every plain row, behind earlier
   * interrupts. A plain row the driver is already typing keeps its own
   * attempt — the drain holds it until it settles — so the interrupt cuts the
   * turn that row opens.
   */
  function admit(id: string, row: Row): void {
    if (!row.interrupt) {
      rows.set(id, row)
      return
    }
    const entries = [...rows]
    const at = entries.findIndex(([, waiting]) => !waiting.interrupt)
    entries.splice(at < 0 ? entries.length : at, 0, [id, row])
    rows.clear()
    for (const [key, value] of entries) rows.set(key, value)
  }
  async function drain() {
    if (draining) return
    draining = true
    try {
      while (rows.size) {
        if (!alive()) {
          // Teardown discards delivery state, not durable work: a new owner
          // receives the durable rows again, so they are cleared silently.
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
          const accepting = state.phase === 'idle' && ready()
          if (accepting || ENDS_ON_ITS_OWN.has(state.phase)) delete row.stuckSince
          if (row.interrupt && !row.interruptRequested && ENDS_ON_ITS_OWN.has(state.phase)) {
            // CUT THE RUNNING TURN, ONCE, then wait for its boundary below
            // like any row. The driver owns the stop (its manifest key, its
            // idle guard); the typing that follows is the ordinary when-ready
            // attempt, so an interrupt is never typed over a turn that has
            // not ended and never takes a second pipeline.
            row.interruptRequested = true
            await handle.interrupt().catch(() => undefined)
            continue
          }
          if (!accepting) {
            if (ENDS_ON_ITS_OWN.has(state.phase)) {
              // A live turn ends on its own: wait for the boundary with no
              // deadline, however long the agent stays busy. The row is
              // durable on the server and retractable while it waits.
              await pause(200)
              continue
            }
            const now = Date.now()
            row.stuckSince ??= now
            if (now - row.stuckSince >= STUCK_CEILING_MS) {
              // The composer has been stuck for the whole ceiling, not
              // mid-turn: nothing will end this state on its own. The row's
              // failure stays recoverable for an operator retry.
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
              onUnrecorded: (reason) => unrecorded(id, reason),
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
          if (receipt.held && !receipt.transcriptItem && !namedEarly.has(id)) {
            // TAKEN, NOT RECORDED (POD-4849): typed, so never typed again and
            // never retractable, but not delivered until the driver says so.
            const lost = unrecordedEarly.get(id)
            if (lost !== undefined) {
              settle(id, 'failed', lost, 'unconfirmed')
              continue
            }
            rows.delete(id)
            held.add(id)
            continue
          }
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
          // door. Re-checks the state on the next pass. Nothing was typed, so
          // the row is retractable again while it waits.
          delete row.inFlight
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
    // Durable delivery drains as when-ready, or cuts in as an interrupt.
    // Never erase a boundary request.
    if (options.delivery === 'at-boundary') {
      return { outcome: 'refused', refusal: { reason: 'unsupported', detail: 'boundary delivery does not support durable rows' } }
    }
    const prior = finished.get(input.rowId)
    if (prior) emit(prior)
    if (!prior && !rows.has(input.rowId) && !held.has(input.rowId)) {
      // Answered `queued` AT ONCE: the reply must land inside the server's
      // RPC window, never after the turn the row waits on.
      admit(input.rowId, {
        input,
        options,
        abort: new AbortController(),
        interrupt: options.delivery === 'interrupt',
      })
      void drain()
    }
    return {
      outcome: 'queued',
      position: Math.max(1, [...rows.keys()].indexOf(input.rowId) + 1),
      deliveredAs: 'queue',
      at: new Date().toISOString(),
    }
  }
  /**
   * A RETRACT WINS ONLY BEFORE TYPING (POD-4776; POD-4720 §4 rule 5).
   *
   * A row still waiting is dropped and never typed: `ok`, and the `dropped`
   * outcome goes to the server on the durable path like any other. Once the
   * driver has been asked to type it, nothing is withdrawn — aborting a send
   * mid-way is how a paste was left in the agent's prompt without its Enter —
   * so the row runs to its own outcome and the answer says how far it got.
   * An id never seen keeps a `dropped` tombstone, so a delayed admission of
   * the same row cannot type what was retracted.
   */
  handle.cancelDelivery = async (id) => {
    const row = rows.get(id)
    if (row?.inFlight || held.has(id)) {
      return { reason: 'busy', detail: 'typing already started', tooLate: 'typing' }
    }
    if (row) {
      row.abort.abort()
      settle(id, 'dropped')
      return { ok: true }
    }
    const prior = finished.get(id)
    if (!prior) {
      settle(id, 'dropped')
      return { ok: true }
    }
    if (prior.outcome === 'dropped') return { ok: true }
    // The retract lost to an outcome the server may not have yet: say it again.
    emit(prior)
    return prior.outcome === 'delivered'
      ? { reason: 'busy', detail: 'the row was already delivered', tooLate: 'delivered' }
      : { reason: 'busy', detail: 'the row already settled as a failure', tooLate: 'failed' }
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
      held.clear()
      unrecordedEarly.clear()
      return original()
    }
  }
  return handle
}
