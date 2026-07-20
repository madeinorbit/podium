import { attentionGroup } from '@podium/client-core'
import type { IssueWire, SessionMeta, SessionOffer } from '@podium/protocol'

/** How long a finished task's Archive card stays in the tray. Deliberately
 *  TIGHTER than the sidebar's unread visibility (7d): the sidebar row may wait
 *  for acknowledgment, but the tray is "act now" — a day later the archive
 *  nudge is noise (the historical never-read population would flood it). */
const FINISHED_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The Tray's whole contract (.design/specs/engraved-column.md §2.3–§2.4): the
 * ONLY things it ever shows are items that need a HUMAN — an agent's question
 * (`needsHuman`), an agent's action offer (SessionOffer [spec:SP-c7f1],
 * which is also how review-ready work announces itself), or a deterministic
 * finished-task card awaiting Archive. Working/status rows never
 * appear; when nothing waits, the tray collapses to the quiet empty line whose
 * live counter comes from {@link workingSessionCount}.
 *
 * Scope (spec §5): the selected issue AND its descendants — the handoff shows
 * children of the selected issue in the tray. With no issue selected the tray
 * widens to all live issues: a question waiting on the human must not vanish
 * just because nothing is selected.
 */
export type TrayItem = {
  issue: IssueWire
  /** Best available "waiting since" — the issue's last update. The event log
   *  would be exacter, but updatedAt is on the wire and moves when needsHuman
   *  or the stage flips, which is the moment the card appears. */
  since: string
} & (
  | { kind: 'question'; text: string }
  | { kind: 'offer'; session: SessionMeta; offer: SessionOffer }
  // Deterministic completion card: recognized from issue state, not
  // agent-offered — a finished task waits for the human to archive it.
  | { kind: 'finished' }
)

/** Identity of one offer instance — a NEW offer on the same session is a new
 *  card (and a fresh flash), so the key carries createdAt, not just the session. */
export const offerKey = (sessionId: string, createdAt: string): string =>
  `${sessionId}@${createdAt}`

const live = (issue: IssueWire): boolean => !issue.archived && !issue.deletedAt

/** The selected issue + its descendants (live issues only). Unknown/absent
 *  root ⇒ every live issue (global scope). */
export function trayScopeIssues(issues: IssueWire[], selectedIssueId: string | null): IssueWire[] {
  const alive = issues.filter(live)
  if (!selectedIssueId || !alive.some((issue) => issue.id === selectedIssueId)) return alive
  const byParent = new Map<string, IssueWire[]>()
  for (const issue of alive) {
    if (!issue.parentId) continue
    const siblings = byParent.get(issue.parentId) ?? []
    siblings.push(issue)
    byParent.set(issue.parentId, siblings)
  }
  const scope: IssueWire[] = []
  const queue = alive.filter((issue) => issue.id === selectedIssueId)
  while (queue.length > 0) {
    const issue = queue.shift() as IssueWire
    scope.push(issue)
    queue.push(...(byParent.get(issue.id) ?? []))
  }
  return scope
}

export function deriveTrayItems(
  issues: IssueWire[],
  selectedIssueId: string | null,
  /** Offers optimistically consumed by a button click, keyed by
   *  {@link offerKey} — hidden until the server's cleared meta arrives
   *  (the same pattern as ChatView's dismissedOfferAt). */
  dismissedOffers?: ReadonlySet<string>,
  /** Clock for the finished-card decay window (defaults to the real clock;
   *  injectable for tests and the Tray's slow tick). */
  now: number = Date.now(),
): TrayItem[] {
  const items: TrayItem[] = []
  for (const issue of trayScopeIssues(issues, selectedIssueId)) {
    if (issue.needsHuman) {
      items.push({
        kind: 'question',
        issue,
        text: issue.humanQuestion?.trim() || 'Needs your input.',
        since: issue.updatedAt,
      })
    }
    // Agent action offers [spec:SP-c7f1]: a live session's suggested next
    // actions are exactly "an item that needs a human" — the same dynamic
    // offer channel the chat composer bar and native PTY bar render, surfaced
    // here so the tray is action-complete. This replaced the old hardcoded
    // review cards: review-ready work announces itself through an offer.
    // Same session filter as everywhere else: shells can't offer, headless
    // (superagent-embedded) threads keep theirs in the super chat.
    for (const session of issue.sessions ?? []) {
      if (session.archived || session.headless === true || session.agentKind === 'shell') continue
      const offer = session.offer
      if (!offer) continue
      if (dismissedOffers?.has(offerKey(session.sessionId, offer.createdAt))) continue
      items.push({ kind: 'offer', issue, session, offer, since: offer.createdAt })
    }
    // Deterministic finished card: a recently-done human issue gets an Archive
    // action — archiving is the acknowledgment that removes card and sidebar
    // row immediately.
    const finished = issue.stage === 'done' || issue.closedReason != null
    const finishedAt = Date.parse(issue.closedAt ?? issue.updatedAt) || 0
    if (finished && issue.audience === 'human' && now - finishedAt <= FINISHED_WINDOW_MS) {
      items.push({ kind: 'finished', issue, since: issue.closedAt ?? issue.updatedAt })
    }
  }
  // Newest first — the handoff's cards read top-down by recency.
  return items.sort((a, b) => b.since.localeCompare(a.since))
}

/**
 * The empty state's "N agents working" counter: live agent sessions attached to
 * the tray's scope. Shells and headless (superagent-embedded) sessions are not
 * "agents working on this task" any more than they are on the board.
 */
export function workingSessionCount(issues: IssueWire[], selectedIssueId: string | null): number {
  const seen = new Set<string>()
  for (const issue of trayScopeIssues(issues, selectedIssueId)) {
    for (const session of issue.sessions ?? []) {
      if (session.archived || session.headless === true || session.agentKind === 'shell') continue
      if (attentionGroup(session) === 'working') seen.add(session.sessionId)
    }
  }
  return seen.size
}

/** Re-exported shape guard for the bar badge: the pill shows the CARD count
 *  (spec §6.11 working assumption), not the waiting-session count. */
export function trayCount(
  issues: IssueWire[],
  selectedIssueId: string | null,
  dismissedOffers?: ReadonlySet<string>,
  now?: number,
): number {
  return deriveTrayItems(issues, selectedIssueId, dismissedOffers, now).length
}
