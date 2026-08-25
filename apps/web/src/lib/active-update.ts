/**
 * "AN UPDATE WAS RUNNING WHEN THE LIGHTS WENT OUT" (POD-2762).
 *
 * ---------------------------------------------------------------------------
 * WHY A PAGE NEEDS THIS AT ALL
 * ---------------------------------------------------------------------------
 *
 * When a chunk fetch is refused because the server is mid-restart, the page has
 * to decide how long to wait before it gives up and calls the situation a
 * failure. It cannot ask anybody: the one party that knows how long a handover
 * takes is the server, and the server is precisely what is not answering.
 *
 * But the page was ALREADY TOLD, seconds earlier. The update panel polls
 * `operations.active` once a second while anything is running, so the last
 * successful poll before the outage is a dated statement about whether this
 * outage is an update or something else. Remembering it costs one boolean and
 * turns "retry for a while and hope" into a decision with evidence behind it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A MODULE, AND WHY IT IS IN `lib/`
 * ---------------------------------------------------------------------------
 *
 * The reader is the error boundary and the chunk recovery path — code that runs
 * when the tree it would otherwise read this from has already failed, so a
 * context or a store hook is exactly the wrong shape (the same reasoning as
 * `skew-notice`). And the writer is `features/updates` while the readers are
 * `app/` and `lib/`, so it cannot live in either feature: a feature may not
 * import another feature (features/README.md).
 *
 * It must also stay TINY and dependency-free. `features/updates` is deferred out
 * of the eager graph on purpose (POD-2190) and the boundary is not; a shared
 * fact that dragged the update chunk's imports into the entry bundle would undo
 * that split to save a boolean.
 *
 * ---------------------------------------------------------------------------
 * IT IS A LAST-KNOWN FACT, NOT A LIVE ONE
 * ---------------------------------------------------------------------------
 *
 * Nothing here refreshes. During an outage the value is by definition stale, and
 * that is the point: it is what the server said while it could still speak. So
 * it may only ever be used to choose how PATIENT to be — never to claim an
 * update is running, and never to take an action that would be wrong if it had
 * finished a moment ago.
 */

/** What the last successful `operations.active` poll said. */
let running = false
/** When that poll landed, so a stale fact can be recognised as stale. */
let observedAt: number | null = null

export function noteActiveUpdate(isRunning: boolean, now: number = Date.now()): void {
  running = isRunning
  observedAt = now
}

/**
 * Was an update running as of the last poll that got through?
 *
 * `withinMs` bounds how old the fact may be. A tab left open overnight that saw
 * an update finish yesterday must not spend a long patience budget on an
 * unrelated outage this morning, so an observation older than the window is not
 * an observation.
 */
export function updateWasRunning(withinMs = 60_000, now: number = Date.now()): boolean {
  if (!running || observedAt === null) return false
  return now - observedAt <= withinMs
}

/** Test-only reset. Module state outlives a test file's cases. */
export function resetActiveUpdate(): void {
  running = false
  observedAt = null
}
