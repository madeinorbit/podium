/**
 * Phase machine for the issue peek drawer (POD-95). The store holds only the
 * intent (`peekIssueId`); the drawer needs one extra phase to play its EXIT
 * slide — `closing` keeps the last issue mounted until the transition ends.
 * One peek at a time: a new id while open (or mid-close) snaps to `open`.
 */
export type PeekPhase =
  | { kind: 'closed' }
  | { kind: 'open'; issueId: string }
  | { kind: 'closing'; issueId: string }

export const PEEK_CLOSED: PeekPhase = { kind: 'closed' }

/** Fold the store's peekIssueId into the current phase. */
export function nextPeekPhase(prev: PeekPhase, peekIssueId: string | null): PeekPhase {
  if (peekIssueId) {
    return prev.kind === 'open' && prev.issueId === peekIssueId
      ? prev
      : { kind: 'open', issueId: peekIssueId }
  }
  return prev.kind === 'open' ? { kind: 'closing', issueId: prev.issueId } : prev
}

/** The exit transition finished (or its reduced-motion fallback timer fired). */
export function finishPeekClose(prev: PeekPhase): PeekPhase {
  return prev.kind === 'closing' ? PEEK_CLOSED : prev
}
