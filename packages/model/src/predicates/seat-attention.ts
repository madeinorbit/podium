/**
 * WHAT A SEAT WANTS FROM THE HUMAN, AND WHO MAY ASK ON A COORDINATED TASK
 * (POD-2171).
 *
 * ONE DERIVATION PER SEAT. {@link seatAttention} reads a session into three
 * raw facts: an error, a prompt only a human can answer, and any other ask;
 * {@link seatAsks} is the role policy over them. {@link coordinatedSeat} is
 * the whole verdict of one seat on a coordinated task: its role, its task's
 * lifecycle, its work, whether and since when it asks, and the class of its
 * error. On a coordinated task every surface reads that verdict (the sidebar
 * row, its counts and timers, the deck's words, counts and filters, the
 * CLI); none falls back to an older motion or needs-human predicate there.
 * An uncoordinated task keeps every surface exactly as it was.
 *
 * THE RULE. A task whose coordinator seat (`coordinatorSessionId`) is held by a
 * live session ({@link coordinatorLive}) is run by that session. The sessions
 * under it, its own helpers and every session in its sub-tree, are its
 * DELEGATES and report to it, not to the human:
 *
 *  - ASKS come only from the coordinator session and the task's OWN requests
 *    (its review or merge decision, a decision-type issue, an explicit
 *    needs-human flag). One known difference, kept on purpose: an open review
 *    alone asks on the sidebar row but not in the deck's task word, which asks
 *    for the offer posted with it (a deck rule for every task). A delegate's offer, its textual question, plan
 *    approval or interrupt, and a descendant task's own requests are for the
 *    coordinator. A descendant's own requests stay on that descendant's row.
 *  - WORK rolls up from the whole sub-tree, read apart from any ask: a working
 *    delegate makes the task read Working while the coordinator idles, even if
 *    the delegate also holds an offer.
 *  - EXCEPTIONS roll up from the whole sub-tree: an error (crash included) and a
 *    prompt only a human can answer.
 *  - Without a live coordinator (none claimed, or its session exited or
 *    archived) nothing is set aside and every session and sub-task asks as
 *    before. That is right for a simple task.
 *
 * NESTED COORDINATORS. A coordinated sub-task keeps its own asks (its
 * coordinator's, its own requests) on its own row. To a coordinated ancestor it
 * is a delegate like any other, so only its exceptions travel further up: the
 * ancestor's coordinator answers for the whole tree beneath it, the
 * sub-coordinator included. Under an ancestor with no live coordinator the
 * sub-task's asks bubble up as they always did.
 */

import type { IdleVerdict } from '../entities/session'
import { idleVerdictFinishedTurn, idleVerdictNeedsHuman } from './idle-verdict'

/** The session facts the seat facts read; a stored row, a wire view and a model all fit. */
export interface SeatSessionFacts {
  readonly status?: string | null
  /** Its machine's daemon link is down right now: the reader's derived condition
   *  ({@link isSessionReconnecting}), never a stored status (ADR 12 D1). A
   *  session model answers it; a stored row never carries it, so a row reader
   *  passes it as an argument instead. */
  readonly reconnecting?: boolean | null
  readonly busy?: boolean | null
  readonly archived?: boolean | null
  readonly exitCode?: number | null
  readonly spawnFailure?: string | null
  readonly stopReason?: string | null
  readonly stoppedAt?: string | null
  readonly offer?: unknown
  readonly agentState?: {
    readonly phase?: string | null
    readonly since?: string | null
    readonly idle?: { readonly kind?: IdleVerdict['kind'] | null } | null
    readonly error?: { readonly class?: string | null } | null
  } | null
}

/** A seat's open pending interactions: how many, and when the earliest was asked (ms). */
export interface SeatInteractions {
  readonly count: number
  readonly since?: number | null
}

export const NO_INTERACTIONS: SeatInteractions = Object.freeze({ count: 0, since: null })

/** The raw attention facts of one seat. */
export interface SeatAttention {
  /** An error ({@link sessionErrorFact}): an agent error, a crash, out-of-memory, a failed start. */
  readonly error: boolean
  /**
   * Held at a prompt only a human can answer: `needs_user` while the process
   * lives (a tool permission prompt, or a native question menu such as
   * AskUserQuestion or a trust dialog), or an open pending interaction row
   * (the same asks as the server stores them; they outlive the process). The
   * modal owns the session's terminal, so a coordinator's mail cannot answer
   * it.
   */
  readonly humanOnly: boolean
  /**
   * Any other request to a human: a standing offer (it outlives the process),
   * or a stopped turn whose idle verdict needs the human (a question, plan
   * approval, or an interrupt) while the process can still take the answer. A
   * coordinator can answer these by mail, and an interrupt was the human's own
   * act.
   */
  readonly ask: boolean
}

/**
 * Error (D5): any agent error, a crash, out-of-memory, or a failed start.
 *
 * The `errored` phase stays until the next turn replaces it, which is the "a new
 * turn clears Error" rule; nothing here needs to remember it. A crash is an exit
 * nobody asked for (`stopReason: 'exited'`) with a non-zero code: a requested
 * stop (`self`, `parent`, `forced`) is Done whatever code the process returned.
 */
export function sessionErrorFact(session: SeatSessionFacts): boolean {
  if (session.agentState?.phase === 'errored') return true
  if (session.status !== 'exited') return false
  if (session.stopReason === 'oom') return true
  if (session.exitCode === -1 || session.spawnFailure) return true
  return session.stopReason === 'exited' && session.exitCode != null && session.exitCode !== 0
}

/**
 * Working (D5): working, compacting, starting or reconnecting.
 *
 * A hibernated or exited process cannot be working, however stale its last
 * phase: a harness killed mid-turn freezes `working`. An agent with no phase
 * evidence (`unknown`, a shell) is working only while its PTY is busy. Read
 * apart from any ask: an offer never hides the work.
 */
export function sessionWorkingFact(
  session: SeatSessionFacts,
  reconnecting: boolean = session.reconnecting === true,
): boolean {
  const status = session.status
  if (status === 'starting') return true
  if (status !== 'live') return false
  if (reconnecting) return true
  const phase = session.agentState?.phase
  if (phase === 'working' || phase === 'compacting') return true
  if (phase == null || phase === 'unknown') return session.busy === true
  return false
}

/** One seat's {@link SeatAttention}; `pendingInteractions` counts its open interaction rows. */
export function seatAttention(session: SeatSessionFacts, pendingInteractions = 0): SeatAttention {
  const alive = session.status !== 'exited'
  const phase = session.agentState?.phase
  return {
    error: sessionErrorFact(session),
    humanOnly: pendingInteractions > 0 || (alive && phase === 'needs_user'),
    ask:
      Boolean(session.offer) ||
      (alive &&
        phase === 'idle' &&
        idleVerdictNeedsHuman(session.agentState?.idle?.kind ?? undefined)),
  }
}

/**
 * THE POLICY: whether a seat's asks reach the human. On its own task every ask
 * does; as a delegate under a live coordinator only a prompt only a human can
 * answer does. Errors are not asks: every surface reads `error` on its own and
 * it always rolls up.
 */
export function seatAsks(attention: SeatAttention, delegate = false): boolean {
  return attention.humanOnly || (!delegate && attention.ask)
}

/** A seat's role on a coordinated task. */
export type SeatRole = 'coordinator' | 'delegate'

/** One seat's verdict on a coordinated task ({@link coordinatedSeat}). */
export interface CoordinatedSeat {
  /** It counts at all: its task is open and it is not archived. A seat that does not asks nothing. */
  readonly counted: boolean
  /** It errored ({@link sessionErrorFact}), and counts. */
  readonly error: boolean
  /** It wants the human: an error, a prompt only a human can answer, or, as the coordinator, any other ask. */
  readonly asks: boolean
  /** When the earliest want it counts began (ms): an error at its state change (a crash at its
   *  stop), a prompt at its state change or the earliest open interaction, an offer when posted. */
  readonly asksSince: number | null
  /** Its error's class: the harness's for an `errored` phase, else `oom`, `spawn_failed` or `crashed`. */
  readonly errorClass: string | null
  /** It computes ({@link sessionWorkingFact}), read apart from any ask. */
  readonly working: boolean
  /**
   * Its turn reached a natural end, or the agent ended, and it is not working:
   * a reconnecting or starting session keeps its last phase, and work wins.
   * So `working` and `done` are never both true, and no reader has to choose.
   */
  readonly done: boolean
  /** Its process is gone: exited, or the agent ended. The session word's Done. */
  readonly stopped: boolean
}

const ms = (iso: string | null | undefined): number | null => {
  const at = Date.parse(iso ?? '')
  return Number.isFinite(at) ? at : null
}
const earliest = (...at: (number | null | undefined)[]): number | null => {
  let first: number | null = null
  for (const value of at) if (value != null && (first === null || value < first)) first = value
  return first
}

/** The class of a seat's error, or null: the harness's own, or what kind of exit it was. */
export function seatErrorClass(session: SeatSessionFacts): string | null {
  if (!sessionErrorFact(session)) return null
  if (session.agentState?.phase === 'errored') return session.agentState.error?.class ?? 'unknown'
  if (session.stopReason === 'oom') return 'oom'
  if (session.exitCode === -1 || session.spawnFailure) return 'spawn_failed'
  return 'crashed'
}

/**
 * THE ONE DERIVATION of a seat on a coordinated task (POD-2171): the raw facts
 * ({@link seatAttention}), the role policy ({@link seatAsks}) and the task's
 * lifecycle in one verdict. A closed task or an archived seat asks nothing,
 * as the session word says (D5).
 */
export function coordinatedSeat(
  session: SeatSessionFacts,
  role: SeatRole,
  interactions: SeatInteractions = NO_INTERACTIONS,
  taskOpen = true,
  /** The reader's derived condition, for a stored row that cannot answer it
   *  ({@link SeatSessionFacts.reconnecting}); a session model answers it itself. */
  reconnecting: boolean = session.reconnecting === true,
): CoordinatedSeat {
  const attention = seatAttention(session, interactions.count)
  const counts = taskOpen && session.archived !== true
  const error = counts && attention.error
  const delegate = role === 'delegate'
  const asks = counts && (attention.error || seatAsks(attention, delegate))
  const state = session.agentState
  const stateSince = ms(state?.since)
  const alive = session.status !== 'exited'
  const working = sessionWorkingFact(session, reconnecting)
  return {
    counted: counts,
    error,
    asks,
    asksSince: asks
      ? earliest(
          error ? (alive ? stateSince : (ms(session.stoppedAt) ?? stateSince)) : null,
          attention.humanOnly && alive && state?.phase === 'needs_user' ? stateSince : null,
          interactions.count > 0 ? interactions.since : null,
          !delegate && attention.ask
            ? session.offer
              ? (ms((session.offer as { createdAt?: string }).createdAt) ?? stateSince)
              : stateSince
            : null,
        )
      : null,
    errorClass: error ? seatErrorClass(session) : null,
    working,
    done:
      !working &&
      (state?.phase === 'ended' ||
        (state?.phase === 'idle' && idleVerdictFinishedTurn(state.idle?.kind ?? undefined))),
    stopped: !alive || state?.phase === 'ended',
  }
}

/** The coordinator-session facts {@link coordinatorLive} reads. */
export interface CoordinatorFacts {
  readonly status?: string | null
  readonly archived?: boolean | null
}

/**
 * The coordinator seat is held by a session that can still act: it exists, is
 * not archived and has not exited. A hibernated coordinator still counts; it
 * resumes on the next message.
 */
export function coordinatorLive(session: CoordinatorFacts | null | undefined): boolean {
  return session != null && session.archived !== true && session.status !== 'exited'
}
