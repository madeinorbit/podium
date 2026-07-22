import { attentionGroup } from '@podium/client-core'
import type { IssueWire, SessionMeta, SessionOffer } from '@podium/protocol'

/** How long a finished task's Archive card stays in the tray. Deliberately
 *  TIGHTER than the sidebar's unread visibility (7d): the sidebar row may wait
 *  for acknowledgment, but the tray is "act now" — a day later the archive
 *  nudge is noise (the historical never-read population would flood it). */
const FINISHED_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The Tray's whole contract (.design/specs/engraved-column.md §2.3-v3 + §5):
 * the ONLY things it ever shows are items that need a HUMAN — an agent's
 * question (`needsHuman`), an agent's action offer (SessionOffer
 * [spec:SP-c7f1], which is how review-ready work announces itself richly), a
 * deterministic review backstop for stage=review issues with no live offer
 * [POD-118], or a deterministic finished-task card awaiting Archive. Working/
 * status rows never appear; when nothing waits, the tray collapses to the
 * quiet empty line whose live counter comes from {@link workingSessionCount}.
 *
 * Scope (spec §5, POD-113): the tray is GLOBAL — every live item across all
 * tasks, always. The selected issue influences rendering only via the colour
 * ring on its cards; it never narrows or re-sorts the list.
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
  // Deterministic review backstop [POD-118]: an issue sitting in stage=review
  // whose sessions carry NO live offer still gets a minimal card, so review
  // visibility never depends on the offer surviving (a stop-hook or mail wake
  // can force an agent turn that eats it).
  | { kind: 'review' }
)

/** Identity of one offer instance — a NEW offer on the same session is a new
 *  card (and a fresh flash), so the key carries createdAt, not just the session. */
export const offerKey = (sessionId: string, createdAt: string): string =>
  `${sessionId}@${createdAt}`

const live = (issue: IssueWire): boolean => !issue.archived && !issue.deletedAt

export function deriveTrayItems(
  issues: IssueWire[],
  /** Offers optimistically consumed by a button click, keyed by
   *  {@link offerKey} — hidden until the server's cleared meta arrives
   *  (the same pattern as ChatView's dismissedOfferAt). */
  dismissedOffers?: ReadonlySet<string>,
  /** Clock for the finished-card decay window (defaults to the real clock;
   *  injectable for tests and the Tray's slow tick). */
  now: number = Date.now(),
): TrayItem[] {
  const items: TrayItem[] = []
  for (const issue of issues.filter(live)) {
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
    // Whether ANY eligible session carries an offer — dismissed ones count:
    // an optimistically-hidden offer means the user just acted on it, and the
    // review backstop below must not pop in for that beat.
    let hasOffer = false
    for (const session of issue.sessions ?? []) {
      if (session.archived || session.headless === true || session.agentKind === 'shell') continue
      const offer = session.offer
      if (!offer) continue
      hasOffer = true
      if (dismissedOffers?.has(offerKey(session.sessionId, offer.createdAt))) continue
      items.push({ kind: 'offer', issue, session, offer, since: offer.createdAt })
    }
    // Review backstop [POD-118]: stage=review with no live offer renders a
    // minimal deterministic card. The offer is the richer announcement (its
    // own buttons), but its lifecycle must not be load-bearing for review
    // visibility — a hook-forced agent turn or a restart can consume it.
    // A needsHuman question already gives the issue a card; don't double up.
    if (issue.stage === 'review' && !hasOffer && !issue.needsHuman) {
      items.push({ kind: 'review', issue, since: issue.updatedAt })
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
  // Stable global sort (§2.3-v3): decisions first (offers, questions, review
  // backstops), finished last, newest-first within each — identical whatever
  // is selected. Selection never re-sorts.
  const rank = (item: TrayItem): number => (item.kind === 'finished' ? 1 : 0)
  return items.sort((a, b) => rank(a) - rank(b) || b.since.localeCompare(a.since))
}

/**
 * The empty state's "N agents working" counter (§2.4, global): live agent
 * sessions across ALL live issues, machine-wide. Shells and headless
 * (superagent-embedded) sessions are not "agents working on this task" any
 * more than they are on the board.
 */
export function workingSessionCount(issues: IssueWire[]): number {
  const seen = new Set<string>()
  for (const issue of issues.filter(live)) {
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
  dismissedOffers?: ReadonlySet<string>,
  now?: number,
): number {
  return deriveTrayItems(issues, dismissedOffers, now).length
}
