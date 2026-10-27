/**
 * WHAT A SEAT WANTS FROM THE HUMAN, AND WHO MAY ASK ON A COORDINATED TASK
 * (POD-2171).
 *
 * ONE SET OF FACTS PER SEAT. {@link seatAttention} reads a session once into
 * three raw facts: an error, a prompt only a human can answer, and any other
 * ask. Every surface that says whether a task wants the human (the session and
 * task words of the deck, the CLI and the phone, the deck's counts and
 * Needs-you filter, the sidebar's delegate verdicts, counts and timers) derives
 * from these facts through {@link seatAsks}. None of them restates a part of
 * the rule.
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
import { idleVerdictNeedsHuman } from './idle-verdict'

/** The session facts the seat facts read; a stored row, a wire view and a model all fit. */
export interface SeatSessionFacts {
  readonly status?: string | null
  readonly archived?: boolean | null
  readonly exitCode?: number | null
  readonly spawnFailure?: string | null
  readonly stopReason?: string | null
  readonly offer?: unknown
  readonly agentState?: {
    readonly phase?: string | null
    readonly idle?: { readonly kind?: IdleVerdict['kind'] | null } | null
  } | null
}

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
