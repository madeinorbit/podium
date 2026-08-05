import type { SessionStore } from '../../../store'

/**
 * Context-aware pending-mail count for the "run mail inbox" nag [POD-909]
 * (design §10). Shared by mailPending (stop-hook) and prime so both surfaces
 * use the same predicate:
 *   unread = |substrate status=queued| + |legacy unread with no messages twin|
 * A dual-written row already delivered-as-transcript-turn (or read/terminal)
 * never resurrects the nag via a lagging issue_messages unread mirror.
 *
 * Predicate NOTE:
 * - status='queued' → not yet in context → COUNT
 * - status='delivered' (transcript echo) → already in context → EXCLUDE
 * - status='read' / terminal → consumed or gone → EXCLUDE
 * - legacy unread with a substrate twin → trust substrate (already covered or excluded)
 * - legacy unread with NO twin (pre-substrate) → COUNT
 */
export function countContextAwarePendingMail(
  store: Pick<SessionStore, 'messages' | 'issues'>,
  issueId: string,
  formatFromIssue: (fromIssue: string) => string = (id) => id,
  /** The READING session [POD-1379]. Given one, the count is per-reader: it
   *  never includes that session's own sends, never counts what it has already
   *  seen, and — the data-loss half — a peer's read cannot clear it. Absent
   *  (operator / UI peek), the issue-wide queued predicate stands. */
  sessionId?: string,
): { unread: number; senders: string[] } {
  const target = { kind: 'issue' as const, id: issueId }
  const queued = sessionId
    ? store.messages.pendingSummaryForSession(issueId, sessionId)
    : store.messages.pendingSummary(target)
  // Legacy fallback covers pre-substrate writers only. Shared ids: if a twin
  // exists on the substrate, trust that ledger (even when status is still
  // queued — those are already in `queued.count` above).
  const legacyUnread = store.issues
    .listIssueMessages(issueId, { status: 'unread' })
    .filter((m) => !store.messages.getMessage(m.id))
  // A pre-substrate row carries no sender session, so self-nag cannot be
  // decided for it; the reader's own receipt still retires it.
  const seen = sessionId
    ? store.messages.readReceipts(
        sessionId,
        legacyUnread.map((m) => m.id),
      )
    : new Set<string>()
  const pureLegacy = legacyUnread.filter((m) => !seen.has(m.id))
  const senders = [
    ...new Set(
      queued.senders.map((m) => {
        if (m.fromKind !== 'agent') return m.fromKind
        if (m.fromIssue) return formatFromIssue(m.fromIssue)
        return m.fromSession ? `session:${m.fromSession}` : 'agent'
      }),
    ),
  ]
  return { unread: queued.count + pureLegacy.length, senders }
}
