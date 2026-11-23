/**
 * SUPERAGENT SLICE (POD-330, audit item zero) — the signed-in user's threads.
 *
 * PER-USER AND PRIVATE BY DEFAULT (doc §3.1.6 S2). Superagent threads belong to
 * ONE human. Since POD-6675 each is a synced `superagentThread` record that the
 * feed delivers to its owner only (`per-user-state`), so every thread a device
 * holds is the signed-in user's own, and a thread made or renamed on another of
 * their devices arrives without a request. The pool's readers
 * (`@podium/client-graph/superagent`) build this view from those records.
 *
 * Platform-neutral: no DOM, no storage, no tRPC.
 */
import type { SessionId, SuperagentTurnFailureWire } from '@podium/model'

/** One superagent thread, as the client renders it. The shape the VIEW may
 *  depend on — deliberately narrower than the server row, which also carries
 *  the harness session id, watermarks and the terminal lock, none of which
 *  leave the server. */
export interface SuperThreadView {
  /** The thread id the superagent commands take (`global`, `btw_<session>`, …). */
  id: string
  kind: 'global' | 'btw' | 'concierge'
  originSessionId?: SessionId
  title?: string
  repoPath?: string
  /** The headless Podium session rendering this thread (set on the first turn). */
  podiumSessionId?: SessionId
  /** Archived threads are not listed. */
  archived?: boolean
  /** The server holds a harness conversation, so "open in terminal" can work. */
  resumable?: boolean
  /** A turn is running: synced status, set at turn start and cleared at its
   *  end, so a reload and every other device read it. */
  turnRunning?: boolean
  /** The last turn failed: synced status, cleared when the next turn starts. */
  lastTurnFailure?: SuperagentTurnFailureWire | null
  /** The harness last run on the thread. The prompt box lists every connector;
   *  a model pick from another CLI switches this on the next send. */
  agentKind?: string
  /** The thread's own model / effort (POD-782). UNDEFINED IS MEANINGFUL and is
   *  the common case: it means "follow the `superagent` settings role", which is
   *  what the pickers render as `auto`. A value is an explicit choice made in
   *  the prompt box, and it survives reloads because it lives on the thread. */
  model?: string
  effort?: string
}

export interface SuperagentSliceValue {
  /** Every thread the signed-in user has. Never anyone else's. */
  readonly threads: readonly SuperThreadView[]
  /** The active thread, or undefined when it has not arrived (or does not
   *  exist). Undefined is NOT rendered as "deleted" — a thread the user has not
   *  started simply is not there yet, and the view shows its empty composer
   *  rather than an error. */
  readonly active: SuperThreadView | undefined
  /** The active thread's headless session, when it has one. */
  readonly activeSessionId: SessionId | undefined
}

/** The thread the view should render for an id, or undefined. Takes the LIST,
 *  never a store or a fetcher: a function that could go and get a thread by id
 *  is a function that could get someone else's. */
export function threadById(
  threads: readonly SuperThreadView[],
  id: string,
): SuperThreadView | undefined {
  return threads.find((t) => t.id === id)
}
