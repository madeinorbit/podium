import type { SessionMeta } from '@podium/protocol'
import { useEffect, useRef } from 'react'

/** Default trailing debounce (ms) before a viewed session is marked read. Long
 *  enough that a streaming session settles first (so we mark read once, not on
 *  every frame), short enough that a glance clears the nag promptly. */
export const MARK_READ_ON_VIEW_MS = 1200

const tabIsVisible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

/**
 * Mark the session the operator is LOOKING AT (the focused, visible pane) read
 * on view (#138). The explicit switch handlers (selectPanel / tab-click / …)
 * only fire on a *change* of pane, so a session that's already the open pane —
 * e.g. the coordinator session the user keeps returning to — never gets marked
 * read and stays bold forever. This closes that gap: a trailing debounce keyed
 * on FOCUS and ACTIVITY marks the focused session read once its output settles
 * (a still-streaming session keeps resetting the timer, so we don't spam the
 * outbox; suppress-while-working keeps it un-bold meanwhile).
 *
 * The trigger is focus/activity — deliberately NOT the `unread` flag itself — so
 * manually marking the currently-open session unread is NOT immediately undone
 * (its unread sticks until fresh activity or a re-focus). `unread` + visibility
 * are re-checked at fire time (via a ref) so we only mark when it still applies.
 */
export function useMarkReadOnView({
  session,
  markSessionRead,
  delayMs = MARK_READ_ON_VIEW_MS,
  isVisible = tabIsVisible,
}: {
  /** The focused + visible session, if any. */
  session: SessionMeta | undefined
  markSessionRead: (sessionId: string) => void
  delayMs?: number
  isVisible?: () => boolean
}): void {
  const sessionId = session?.sessionId
  // Depend on activity so a session still producing output restarts the debounce
  // (trailing edge = "settled"), rather than marking read mid-stream.
  const activity = session?.lastActiveAt
  // Latest session read at fire time — so a mid-flight manual mark-unread (which
  // flips `unread` without new activity) is respected, and a session that went
  // read some other way isn't needlessly re-stamped.
  const sessionRef = useRef<SessionMeta | undefined>(session)
  sessionRef.current = session
  // biome-ignore lint/correctness/useExhaustiveDependencies: `activity` is a trigger, not a read — its change restarts the trailing debounce (settle detection); the value itself is read via sessionRef at fire time.
  useEffect(() => {
    if (!sessionId) return
    const timer = setTimeout(() => {
      const s = sessionRef.current
      if (s?.sessionId === sessionId && s.unread === true && isVisible()) {
        markSessionRead(sessionId)
      }
    }, delayMs)
    return () => clearTimeout(timer)
  }, [sessionId, activity, markSessionRead, delayMs, isVisible])
}
