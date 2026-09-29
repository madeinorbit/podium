import { type HarnessRef, mergeHarnessRefs, type TranscriptItemRef } from '@podium/model'
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
    /** When the driver first refused the row as `not_running` while the
     *  session was still alive; unset by any other answer (POD-4839). */
    notRunningSince?: number
  }
  const rows = new Map<string, Row>()
  type Outcome = Extract<RuntimeEventBody, { t: 'delivery' }>
  const finished = new Map<string, Outcome>()
  /** Entries a driver named before its row settled (POD-4774). */
  const namedEarly = new Map<string, TranscriptItemRef>()
  /**
   * THE PROGRAM'S OWN IDS FOR A ROW NOT SETTLED YET (POD-4841): from its
   * receipt and from anything named beside its entry. They ride on the row's
   * outcome, whichever it is; learning one never moves the row.
   */
  const idsOf = new Map<string, HarnessRef>()
  function learn(id: string, harnessRef: HarnessRef | undefined): void {
    const merged = mergeHarnessRefs(idsOf.get(id), harnessRef)
    if (merged) idsOf.set(id, merged)
  }
  /**
   * TYPED, AND HELD BY THE PROGRAM WITHOUT A RECORD YET (POD-4849): rows whose
   * receipt said `held`, and how. Not delivered and not waiting: the next row
   * may be typed, a retract is too late, and the row settles on what the
   * driver says next — its entry, or, held in memory only, that it will not
   * be recorded. A durable hold (POD-4886) settles only on its entry; `watch`
   * ends the driver's renewed watch of one at teardown.
   */
  const held = new Map<string, { kind: 'memory' | 'durable'; watch?: AbortController }>()
  /**
   * THE SERVER HEARS THE HOLD (POD-4886): `accepted`, and how the program
   * holds it, with the program's ids known so far. Not a settlement — nothing
   * is recorded in `finished`, and the row's `delivered` or `failed` follows.
   * Whether the server can read it is the daemon link's to decide.
   */
  function hold(id: string, kind: 'memory' | 'durable'): void {
    held.set(id, { kind })
    const ids = idsOf.get(id)
    emit({
      t: 'delivery',
      rowId: id,
      outcome: 'accepted',
      held: kind,
      ...(ids ? { harnessRef: ids } : {}),
    })
  }
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
    harnessRef?: HarnessRef,
  ) {
    if (finished.has(id)) return
    const named = outcome === 'delivered' ? (transcriptItem ?? namedEarly.get(id)) : undefined
    const ids = mergeHarnessRefs(idsOf.get(id), harnessRef)
    namedEarly.delete(id)
    idsOf.delete(id)
    unrecordedEarly.delete(id)
    held.delete(id)
    const event: Outcome = {
      t: 'delivery',
      rowId: id,
      outcome,
      ...(reason ? { reason } : {}),
      ...(cause ? { cause } : {}),
      ...(named ? { transcriptItem: named } : {}),
      ...(ids ? { harnessRef: ids } : {}),
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
  function name(id: string, transcriptItem: TranscriptItemRef, harnessRef?: HarnessRef): void {
    if (held.has(id)) {
      // The record a held row waited for: this is its delivery.
      settle(id, 'delivered', undefined, undefined, transcriptItem, harnessRef)
      return
    }
    const prior = finished.get(id)
    if (!prior) {
      if (rows.has(id)) {
        namedEarly.set(id, transcriptItem)
        learn(id, harnessRef)
      }
      return
    }
    if (prior.outcome !== 'delivered' || prior.transcriptItem) return
    const ids = mergeHarnessRefs(prior.harnessRef, harnessRef)
    const event: Outcome = { ...prior, transcriptItem, ...(ids ? { harnessRef: ids } : {}) }
    finished.set(id, event)
    emit(event)
  }
  /**
   * A HELD ROW THE PROGRAM WILL NOT RECORD (POD-4849): what held it ended
   * first. Unconfirmed — the server's `unknown` — and never `failed`: nothing
   * here proves the model did not see it, and a retry could run it twice.
   */
  function unrecorded(id: string, reason: string): void {
    // A DURABLE HOLD HAS NO SUCH END (POD-4886): the program keeps the message
    // across the end of a turn, of the session, of its own process, and may
    // still run it. Only its record settles it.
    if (held.get(id)?.kind === 'durable') return
    if (held.has(id)) {
      settle(id, 'failed', reason, 'unconfirmed')
      return
    }
    if (rows.has(id) && !finished.has(id)) unrecordedEarly.set(id, reason)
  }
  /**
   * AN UNCONFIRMED ROW, PROVEN LATE (POD-4840): the driver's watch outlived
   * the window and the harness recorded the prompt after all. The row's
   * `failed`/`unconfirmed` outcome moves forward to `delivered`, once, and
   * the `finished` replay carries that from here on. Only that outcome moves:
   * a row that failed without being typed, or was dropped, has nothing a
   * late record could prove, and nothing ever leaves `delivered`. The driver
   * arms the late watch only after answering `unverified`, and the row
   * settles on that answer before any transcript read can resolve it.
   */
  function proveLate(
    id: string,
    transcriptItem?: TranscriptItemRef,
    harnessRef?: HarnessRef,
  ): void {
    const prior = finished.get(id)
    if (prior?.outcome !== 'failed' || prior.cause !== 'unconfirmed') return
    const ids = mergeHarnessRefs(prior.harnessRef, harnessRef)
    const event: Outcome = {
      t: 'delivery',
      rowId: id,
      outcome: 'delivered',
      ...(transcriptItem ? { transcriptItem } : {}),
      ...(ids ? { harnessRef: ids } : {}),
    }
    finished.set(id, event)
    emit(event)
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
        if (row.input.deliveryRecovery && row.input.held === 'durable') {
          // THE PROGRAM KEEPS IT ACROSS ITS OWN RESTART (POD-4886; POD-4819
          // §9), and an earlier owner saw it take it: nothing to type, nothing
          // to give up on. Watch for its record again; a driver that cannot
          // leaves it held, open, never unconfirmed.
          rows.delete(id)
          held.set(id, { kind: 'durable', watch: row.abort })
          handle.watchHeld?.(
            { ...row.input, rowId: undefined },
            {
              onTranscriptItem: (item, harnessRef) => name(id, item, harnessRef),
              signal: row.abort.signal,
            },
          )
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
              onTranscriptItem: (item, harnessRef) => name(id, item, harnessRef),
              onUnrecorded: (reason) => unrecorded(id, reason),
              onLateProof: ({ transcriptItem, harnessRef }) =>
                proveLate(id, transcriptItem, harnessRef),
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
        if (receipt.outcome !== 'refused' || receipt.refusal.reason !== 'not_running') {
          delete row.notRunningSince
        }
        if (receipt.outcome === 'accepted') {
          learn(id, receipt.harnessRef)
          if (receipt.held && !receipt.transcriptItem && !namedEarly.has(id)) {
            // TAKEN, NOT RECORDED (POD-4849): typed, so never typed again and
            // never retractable, but not delivered until the driver says so.
            const lost = receipt.held === 'memory' ? unrecordedEarly.get(id) : undefined
            if (lost !== undefined) {
              settle(id, 'failed', lost, 'unconfirmed')
              continue
            }
            unrecordedEarly.delete(id)
            rows.delete(id)
            hold(id, receipt.held)
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
        if (receipt.outcome === 'refused' && receipt.refusal.reason === 'not_running') {
          delete row.inFlight
          if (!alive()) {
            // THE SESSION ENDED UNDER THE ROW (POD-4839): hibernated, stopped,
            // or its process gone and torn down. Nothing was typed, and the
            // server still holds the row and forwards it again on the next
            // bind, so it waits there for the resume. The next pass clears it
            // with the teardown rule above.
            continue
          }
          // NO PROCESS, AND THE SESSION NOT TORN DOWN YET: the exit that
          // clears it usually follows at once. Until then the row waits like
          // a composer that is not accepting input, for the same ceiling, and
          // a reading of an idle agent does not restart that wait. The
          // ceiling is Phase C's to tune (POD-4820).
          const now = Date.now()
          row.notRunningSince ??= now
          if (now - row.notRunningSince >= STUCK_CEILING_MS) {
            settle(id, 'failed', 'agent not accepting input', 'not-accepting-input')
          } else {
            await pause(200)
          }
          continue
        }
        if (receipt.outcome === 'refused') {
          // A REFUSAL IS A PROVEN "NO" (POD-4839; POD-4819 §6.1 N1, N2). By
          // contract a driver refuses only before it writes a byte of the
          // message, or on the program's own explicit refusal of the request,
          // which records nothing (a Codex JSON-RPC error, an OpenCode 400 or
          // 404). A driver that may have written answers `unverified` or
          // throws instead, below. So the row was never typed: `failed`
          // without the `unconfirmed` cause, which the server reports as not
          // delivered and safe to resend (POD-4778).
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
      // A late proof of an `unverified` direct send says `delivered` under
      // the same id (POD-4840).
      const turnId = input.id
      if (turnId === undefined) return send(input, options)
      // The program's ids ride along (POD-4841): those the receipt named, and
      // any named with the entry, since the server keeps ids from outcomes.
      let known: HarnessRef | undefined
      const delivered = (transcriptItem?: TranscriptItemRef, harnessRef?: HarnessRef) => {
        const ids = mergeHarnessRefs(known, harnessRef)
        emit({
          t: 'delivery',
          rowId: turnId,
          outcome: 'delivered',
          ...(transcriptItem ? { transcriptItem } : {}),
          ...(ids ? { harnessRef: ids } : {}),
        })
      }
      const receipt = await send(input, {
        ...options,
        onTranscriptItem: options.onTranscriptItem ?? delivered,
        onLateProof:
          options.onLateProof ??
          (({ transcriptItem, harnessRef }) => delivered(transcriptItem, harnessRef)),
      })
      if (receipt.outcome === 'accepted') known = receipt.harnessRef
      return receipt
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
      for (const entry of held.values()) entry.watch?.abort()
      held.clear()
      unrecordedEarly.clear()
      idsOf.clear()
      return original()
    }
  }
  return handle
}
