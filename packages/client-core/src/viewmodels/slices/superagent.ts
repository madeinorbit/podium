/**
 * SUPERAGENT SLICE (POD-330, audit item zero) — the signed-in user's threads.
 *
 * This exists to delete a SHADOW MIRROR. `SuperagentView` declared its own
 * `SuperThread` interface, held the list in `useState`, refetched it from tRPC
 * itself, and was poked to refetch by a `superRefreshKey` counter that actions
 * bumped from the other side of the app. Three separate mechanisms — a private
 * type, a private copy, and a private invalidation protocol — where the store
 * already had one of each.
 *
 * A refresh KEY is the tell. It says "something changed somewhere, go and look
 * again", which is a subscription written by hand, badly: the counter cannot say
 * WHAT changed, so every bump refetches everything, and a bump that is forgotten
 * is a view that silently shows a stale list. The store publishes the threads;
 * anything that changes them refreshes them.
 *
 * PER-USER AND PRIVATE BY DEFAULT (doc §3.1.6 S2). Superagent threads, their
 * messages, queued inputs and pending turns belong to ONE human. The authority
 * scopes `listThreads` to the caller, so what arrives here is already only the
 * signed-in user's — and this slice therefore never addresses a thread by an id
 * it did not receive. That is the whole defence: there is no lookup here that
 * takes an arbitrary id, so there is nothing to point at someone else's thread.
 *
 * Platform-neutral: no DOM, no storage, no tRPC.
 */
import type { SessionId } from '@podium/model'
import { defineSlice, type SliceDefinition } from './publish'

/** One superagent thread, as the client renders it. The shape the VIEW may
 *  depend on — deliberately narrower than the server row, which also carries
 *  ownership and watermark bookkeeping the UI has no business reading. */
export interface SuperThreadView {
  id: string
  kind: 'global' | 'btw' | 'concierge'
  originSessionId?: string
  title?: string
  repoPath?: string
  /** The headless Podium session rendering this thread (set on the first turn). */
  podiumSessionId?: SessionId
  /** The harness's own session id — present once the thread has a real session. */
  harnessSessionId?: string
  /** Query-backed running state for reloads and late joiners; live events keep
   *  the embedded chat current after mount. */
  turnRunning?: boolean
}

/** The store fields this slice reads. Structural, so the slice does not depend
 *  on the engine's Store type (and mobile can satisfy it too). */
export interface SuperagentSource {
  readonly superThreads: readonly SuperThreadView[]
  readonly superThreadId: string
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

export const superagentSlice: SliceDefinition<SuperagentSource, SuperagentSliceValue> = defineSlice({
  name: 'superagent',
  derive: (s) => {
    const active = s.superThreads.find((t) => t.id === s.superThreadId)
    return {
      threads: s.superThreads,
      active,
      ...(active?.podiumSessionId !== undefined
        ? { activeSessionId: active.podiumSessionId }
        : { activeSessionId: undefined }),
    }
  },
  isEqual: (a, b) =>
    a.threads === b.threads && a.active === b.active && a.activeSessionId === b.activeSessionId,
})

/** The thread the view should render for an id, or undefined. Takes the LIST,
 *  never a store or a fetcher: a function that could go and get a thread by id
 *  is a function that could get someone else's. */
export function threadById(
  threads: readonly SuperThreadView[],
  id: string,
): SuperThreadView | undefined {
  return threads.find((t) => t.id === id)
}
