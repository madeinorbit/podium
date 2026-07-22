import { attentionGroup } from '@podium/client-core'
import type { IssueWire, SessionMeta, SessionOffer } from '@podium/protocol'

/**
 * The Tray's whole contract (.design/specs/engraved-column.md §2.3-v3 + §5):
 * the ONLY things it ever shows are items that need a HUMAN's ATTENTION — an
 * agent's question (`needsHuman`), an agent's action offer (SessionOffer
 * [spec:SP-c7f1], which is how review-ready work announces itself richly), or
 * a deterministic review backstop for stage=review issues with no live offer
 * [POD-118]. Finished/done issues never appear [POD-198]: archive cleanup is
 * not attention (archiving lives on the board/sidebar). Working/status rows
 * never appear either; when nothing waits, the tray collapses to the quiet
 * empty line whose live counter comes from {@link workingSessionCount}.
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
    // Finished/done issues deliberately get NO card [POD-198]: an Archive
    // nudge is cleanup, not attention — on an agent-throughput day a finished
    // card per closed issue floods the column. Archiving lives on the
    // board/sidebar.
  }
  // Stable global sort (§2.3-v3): newest-first, identical whatever is
  // selected. Selection never re-sorts.
  return items.sort((a, b) => b.since.localeCompare(a.since))
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
export function trayCount(issues: IssueWire[], dismissedOffers?: ReadonlySet<string>): number {
  return deriveTrayItems(issues, dismissedOffers).length
}
