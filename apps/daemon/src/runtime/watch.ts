/**
 * THE FINE-WATCH LIFECYCLE (POD-2293).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A LIFECYCLE AND NOT TWO LINES IN A HANDLER
 * ---------------------------------------------------------------------------
 *
 * `handle.watch(level)` hands back a RELEASE FUNCTION, and the contract is
 * explicit about why: "a viewer disconnecting cannot leak a fine watch — an
 * always-on token stream with nobody reading it is the exact cost the two levels
 * exist to avoid." That release has to be held by something with the same
 * lifetime as the session, and dropped when the session goes — which is exactly
 * the state a per-frame handler cannot keep.
 *
 * Three things live here, and each is a leak the naive version has:
 *
 *   1. ONE WATCH PER SESSION, however many frames arrive. The server sends a
 *      DESIRED LEVEL, not an increment, so a repeated `fine` is a no-op rather
 *      than a second refcount nobody will ever release.
 *   2. A RELEASE DEBOUNCE. A viewer navigating between two sessions, or a socket
 *      reclaim, takes the subscriber count to zero and back within a second or
 *      two. Releasing immediately would tear a fine watch down and build it back
 *      up — and on codex that is a reconnect each way, which is far more
 *      expensive than the tokens it would have saved.
 *   3. CAPABILITY GATING. A driver that declares only `coarse` produces no
 *      fragments, so a fine watch on it is a refcount that buys nothing. The PTY
 *      family declares exactly that, and the point of gating here is that a
 *      degraded or terminal session takes NO new code path at all.
 *
 * WHAT THIS DOES NOT DO IS WAIT. `watch('fine')` resolves when the refcount
 * moves, not when the level is live — codex must reconnect to reach fine and
 * declines while a turn is open. So there is nothing to await and nothing to
 * report: the level is a request, and frames arriving (or not) is the answer.
 */

import type { AgentSessionHandle, DriverCapabilities } from '@podium/agent-runtime'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import type { RuntimeWatchLevel } from '@podium/protocol/daemon'

const log = createLogger('daemon:runtime-watch')

/** How long a session keeps its fine watch after the last viewer leaves. Sized
 *  for navigation and socket reclaim, not for idling: a viewer who left for good
 *  costs at most this much of a token stream nobody reads. */
export const FINE_WATCH_RELEASE_DELAY_MS = 30_000

export interface RuntimeWatchLifecycle {
  /** Reconcile one session's desired level. Idempotent and last-write-wins. */
  want(sessionId: SessionId, level: RuntimeWatchLevel): void
  /** Drop this session's watch NOW, debounce and all — the session is going
   *  away, or its binding was replaced and the release function belongs to a
   *  handle that no longer exists. */
  forget(sessionId: SessionId): void
  dispose(): void
  /** Sessions currently holding a fine watch. Test seam and diagnostics. */
  held(): readonly SessionId[]
}

export interface RuntimeWatchLifecycleDeps {
  handleFor(sessionId: SessionId): AgentSessionHandle | undefined
  /** The driver's declaration for this session, or undefined when it cannot be
   *  resolved — which is treated as "not capable", because acquiring a watch on
   *  a driver whose declaration we cannot read is the one case where guessing
   *  costs a stream nobody asked for. */
  capabilitiesFor(sessionId: SessionId): DriverCapabilities | undefined
  releaseDelayMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

interface Entry {
  release?: () => void
  acquiring: boolean
  /** The level the server last asked for. Re-read after every await, because a
   *  viewer can leave while `watch()` is still resolving. */
  wanted: RuntimeWatchLevel
  releaseTimer?: ReturnType<typeof setTimeout>
}

export function createRuntimeWatchLifecycle(
  deps: RuntimeWatchLifecycleDeps,
): RuntimeWatchLifecycle {
  const entries = new Map<SessionId, Entry>()
  const delay = deps.releaseDelayMs ?? FINE_WATCH_RELEASE_DELAY_MS
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle))

  const supportsFine = (sessionId: SessionId): boolean =>
    deps.capabilitiesFor(sessionId)?.observation.watchLevels.includes('fine') === true

  const cancelPendingRelease = (entry: Entry): void => {
    if (entry.releaseTimer === undefined) return
    clearTimer(entry.releaseTimer)
    entry.releaseTimer = undefined
  }

  const releaseNow = (sessionId: SessionId, entry: Entry): void => {
    cancelPendingRelease(entry)
    const release = entry.release
    entry.release = undefined
    if (release) {
      try {
        release()
      } catch (err) {
        // A release that throws must not take the daemon with it. The refcount
        // is the driver's, and a driver that failed to decrement it has a bug
        // this frame cannot fix.
        log.warn('fine watch release failed', { err, sessionId })
      }
    }
    if (!entry.acquiring) entries.delete(sessionId)
  }

  return {
    want(sessionId, level) {
      if (level === 'fine' && !supportsFine(sessionId)) {
        // A coarse-only driver. Not an error and not worth a log line per
        // subscribe: the chat renders complete items, which is the documented
        // degradation for a family that cannot produce a token stream.
        return
      }
      const entry = entries.get(sessionId) ?? { acquiring: false, wanted: level }
      entry.wanted = level
      entries.set(sessionId, entry)

      if (level === 'coarse') {
        if (!entry.release && !entry.acquiring) {
          entries.delete(sessionId)
          return
        }
        if (entry.releaseTimer !== undefined) return
        entry.releaseTimer = setTimer(() => {
          const live = entries.get(sessionId)
          // RE-READ, never remembered: a viewer that came back during the
          // debounce has already set `wanted` to fine, and tearing the watch
          // down now would be acting on a decision that has been reversed.
          if (!live || live.wanted !== 'coarse') return
          releaseNow(sessionId, live)
        }, delay)
        return
      }

      cancelPendingRelease(entry)
      if (entry.release || entry.acquiring) return
      const handle = deps.handleFor(sessionId)
      if (!handle) {
        entries.delete(sessionId)
        return
      }
      entry.acquiring = true
      void handle
        .watch('fine')
        .then((release) => {
          const live = entries.get(sessionId)
          if (live) live.acquiring = false
          // THE WINDOW THIS CLOSES. `watch()` is async, and everything can have
          // changed while it resolved: the session may have been forgotten, or
          // the last viewer may have left. Releasing immediately in either case
          // is the difference between a watch and a leak.
          if (!live || live.wanted !== 'fine') {
            try {
              release()
            } catch (err) {
              log.warn('fine watch release failed', { err, sessionId })
            }
            if (live && !live.release) entries.delete(sessionId)
            return
          }
          live.release = release
        })
        .catch((err: unknown) => {
          const live = entries.get(sessionId)
          if (live) {
            live.acquiring = false
            if (!live.release) entries.delete(sessionId)
          }
          // Best-effort by contract: a watch that could not be acquired means
          // the chat renders complete items. Logged, never escalated.
          log.warn('fine watch acquire failed', { err, sessionId })
        })
    },

    forget(sessionId) {
      const entry = entries.get(sessionId)
      if (!entry) return
      entry.wanted = 'coarse'
      releaseNow(sessionId, entry)
      entries.delete(sessionId)
    },

    dispose() {
      for (const [sessionId, entry] of [...entries]) {
        entry.wanted = 'coarse'
        releaseNow(sessionId, entry)
      }
      entries.clear()
    },

    held: () => [...entries].filter(([, e]) => e.release !== undefined).map(([id]) => id),
  }
}
