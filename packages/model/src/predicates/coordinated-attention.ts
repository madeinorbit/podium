/**
 * WHO MAY ASK THE HUMAN ON A COORDINATED TASK (POD-2171).
 *
 * A task whose coordinator seat (`coordinatorSessionId`) is held by a live
 * session is run by that session. The sessions under it, its own helpers and
 * every session in its sub-tree, report to the coordinator, not to the human.
 * Every surface that rolls attention up the tree (the sidebar row, its waiting
 * counts and timer, the phone row, the flight deck and `podium issue deck`)
 * follows one rule:
 *
 *  - ASKS come only from the coordinator session and the task's OWN decision
 *    (its review or merge, a decision-type issue, an explicit needs-human
 *    flag). A delegate's offer, a delegate's textual question, plan approval or
 *    interrupt, and a descendant task's review or merge decision are for the
 *    coordinator and do not make the task ask.
 *  - WORK rolls up from the whole sub-tree: a working delegate makes the task
 *    read Working while the coordinator idles.
 *  - EXCEPTIONS roll up from the whole sub-tree: an error, and a delegate held
 *    at a prompt only a human can answer ({@link delegateNeedsHuman}).
 *  - Without a live coordinator ({@link coordinatorLive}: none claimed, or its
 *    session exited or archived) nothing is set aside and every session and
 *    sub-task asks as before. That is right for a simple task.
 *
 * NESTED COORDINATORS. A coordinated sub-task keeps its own asks (its
 * coordinator's, its own decision) on its own row. To a coordinated ancestor
 * it is a delegate like any other, so only its exceptions travel further up:
 * the ancestor's coordinator answers for the whole tree beneath it, the
 * sub-coordinator included. Under an ancestor with no live coordinator the
 * sub-task's asks bubble up as they always did.
 */

/** The session facts the rule reads; a stored row, a wire view and a model all fit. */
export interface CoordinatedSessionFacts {
  readonly status?: string | null
  readonly archived?: boolean | null
  readonly agentState?: { readonly phase?: string | null } | null
}

/**
 * The coordinator seat is held by a session that can still act: it exists, is
 * not archived and has not exited. A hibernated coordinator still counts; it
 * resumes on the next message.
 */
export function coordinatorLive(session: CoordinatedSessionFacts | null | undefined): boolean {
  return session != null && session.archived !== true && session.status !== 'exited'
}

/**
 * A delegate is held at a prompt that only a human can answer, so it escalates
 * past its coordinator.
 *
 * Counted: `needs_user`, the harness's own modal (a tool permission prompt, or
 * a native question menu such as AskUserQuestion or a trust dialog; see
 * `AgentNeed` and `isNativeMenuLive`), and an open pending interaction row for
 * the session (the same permission requests and questions, as the server
 * stores them). A modal owns the delegate's terminal: the coordinator's mail
 * cannot answer it, only a person at the UI can.
 *
 * Not counted: `idle` with a `question`, `approval` or `interrupted` verdict.
 * The turn ended, so the coordinator can answer by mail, and an interrupt was
 * the human's own act. A delegate's offer is not counted either: a seated
 * delegate cannot post one, and if it does, judging it is the coordinator's
 * job. Errors are exceptions too, but every surface already reads them on
 * their own (`errored`), so they are not folded in here.
 */
export function delegateNeedsHuman(
  session: CoordinatedSessionFacts,
  pendingInteractions = 0,
): boolean {
  if (pendingInteractions > 0) return true
  return session.status !== 'exited' && session.agentState?.phase === 'needs_user'
}
