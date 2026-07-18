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
 * - `pendingFor` / status='queued' → not yet in context → COUNT
 * - status='delivered' (transcript echo) → already in context → EXCLUDE
 * - status='read' / terminal → consumed or gone → EXCLUDE
 * - legacy unread with a substrate twin → trust substrate (already covered or excluded)
 * - legacy unread with NO twin (pre-substrate) → COUNT
 */
export function countContextAwarePendingMail(
  store: Pick<SessionStore, 'messages' | 'issues'>,
  issueId: string,
  formatFromIssue: (fromIssue: string) => string = (id) => id,
): { unread: number; senders: string[] } {
  // Substrate: only queued rows — never echoed into the transcript, never pulled.
  const queued = store.messages.pendingFor({ kind: 'issue', id: issueId })
  // Legacy fallback covers pre-substrate writers only. Shared ids: if a twin
  // exists on the substrate, trust that ledger (even when status is still
  // queued — those are already in `queued` above).
  const pureLegacy = store.issues
    .listIssueMessages(issueId, { status: 'unread' })
    .filter((m) => !store.messages.getMessage(m.id))
  const senders = [
    ...new Set(
      queued.map((m) => {
        if (m.fromKind !== 'agent') return m.fromKind
        if (m.fromIssue) return formatFromIssue(m.fromIssue)
        return m.fromSession ? `session:${m.fromSession}` : 'agent'
      }),
    ),
  ]
  return { unread: queued.length + pureLegacy.length, senders }
}
