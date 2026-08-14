import { useCallback, useSyncExternalStore } from 'react'

/**
 * WHICH SESSION THE POINTER IS OVER, said once for the whole shell.
 *
 * A tab in the workspace strip and a row in the Flight Deck are the same
 * session drawn twice, in two subtrees that never meet except at `AppShell`.
 * Pointing at one should say which row it is — the deck can be twenty rows
 * deep and "which of these is the tab I am on?" is otherwise a name-matching
 * exercise.
 *
 * A module-level external store rather than a context (the `ref-activation`
 * idiom) for one reason: hover changes on every pointer crossing, and a
 * context value would re-render every consumer under the provider — the whole
 * deck — on each one. Here each row subscribes with a BOOLEAN snapshot of its
 * own id, so a crossing commits exactly the two rows whose answer changed.
 *
 * Deliberately transient and un-persisted. This is a pointer, not a selection:
 * nothing here survives the pointer leaving, and nothing reads it except the
 * highlight.
 */

let hoveredSessionId: string | null = null
const listeners = new Set<() => void>()

export function subscribeHoveredSession(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getHoveredSession(): string | null {
  return hoveredSessionId
}

export function setHoveredSession(sessionId: string | null): void {
  if (hoveredSessionId === sessionId) return
  hoveredSessionId = sessionId
  for (const listener of listeners) listener()
}

/**
 * Clear, but only if this session is still the one being pointed at.
 *
 * Leaving one tab for its neighbour fires the new tab's enter before the old
 * tab's leave in some pointer sequences, and an unguarded clear would then
 * blank the highlight that just arrived. Clearing by id makes a late leave a
 * no-op instead.
 */
export function clearHoveredSession(sessionId: string): void {
  if (hoveredSessionId === sessionId) setHoveredSession(null)
}

/** Is the pointer on this session's OTHER representation right now? */
export function useSessionHovered(sessionId: string): boolean {
  const snapshot = useCallback(() => hoveredSessionId === sessionId, [sessionId])
  return useSyncExternalStore(subscribeHoveredSession, snapshot, snapshot)
}
