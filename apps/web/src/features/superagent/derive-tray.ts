import { attentionGroup } from '@podium/client-core'
import type { SessionMeta } from '@podium/protocol'
import type { IssueViewModel } from '@/app/store'

/**
 * The Tray's whole contract (.design/specs/engraved-column.md §2.3–§2.4): the
 * ONLY things it ever shows are items that need a HUMAN — an agent's question
 * (`needsHuman`) or an issue sitting in review. Working/status rows never
 * appear; when nothing waits, the tray collapses to the quiet empty line whose
 * live counter comes from {@link workingSessionCount}.
 *
 * Scope (spec §5): the selected issue AND its descendants — the handoff shows
 * children of the selected issue in the tray. With no issue selected the tray
 * widens to all live issues: a question waiting on the human must not vanish
 * just because nothing is selected.
 */
export type TrayItem = {
  issue: IssueViewModel
  /** Best available "waiting since" — the issue's last update. The event log
   *  would be exacter, but updatedAt is on the wire and moves when needsHuman
   *  or the stage flips, which is the moment the card appears. */
  since: string
} & ({ kind: 'question'; text: string } | { kind: 'review'; body: string })

const live = (issue: IssueViewModel): boolean => !issue.archived && !issue.deletedAt

/** The selected issue + its descendants (live issues only). Unknown/absent
 *  root ⇒ every live issue (global scope). */
export function trayScopeIssues(
  issues: IssueViewModel[],
  selectedIssueId: string | null,
): IssueViewModel[] {
  const alive = issues.filter(live)
  if (!selectedIssueId || !alive.some((issue) => issue.id === selectedIssueId)) return alive
  const byParent = new Map<string, IssueViewModel[]>()
  for (const issue of alive) {
    if (!issue.parentId) continue
    const siblings = byParent.get(issue.parentId) ?? []
    siblings.push(issue)
    byParent.set(issue.parentId, siblings)
  }
  const scope: IssueViewModel[] = []
  const queue = alive.filter((issue) => issue.id === selectedIssueId)
  while (queue.length > 0) {
    const issue = queue.shift() as IssueViewModel
    scope.push(issue)
    queue.push(...(byParent.get(issue.id) ?? []))
  }
  return scope
}

export function deriveTrayItems(
  issues: IssueViewModel[],
  selectedIssueId: string | null,
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
    // Review cards only for issues the human tracks: an INTERNAL (agent-audience)
    // issue's review stage is agent working detail, not a human review request.
    if (issue.stage === 'review' && issue.audience === 'human') {
      items.push({
        kind: 'review',
        issue,
        body:
          issue.suggestedReason?.trim() ||
          (issue.prUrl ? `Ready for review — ${issue.prUrl}` : 'Ready for review.'),
        since: issue.updatedAt,
      })
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
export function workingSessionCount(
  issues: IssueViewModel[],
  selectedIssueId: string | null,
  sessions: readonly SessionMeta[],
): number {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]))
  const seen = new Set<string>()
  for (const issue of trayScopeIssues(issues, selectedIssueId)) {
    for (const id of issue.memberSessionIds ?? []) {
      const session = byId.get(id)
      if (!session) continue
      if (session.archived || session.headless === true || session.agentKind === 'shell') continue
      if (attentionGroup(session) === 'working') seen.add(session.sessionId)
    }
  }
  return seen.size
}

/** Re-exported shape guard for the bar badge: the pill shows the CARD count
 *  (spec §6.11 working assumption), not the waiting-session count. */
export function trayCount(issues: IssueViewModel[], selectedIssueId: string | null): number {
  return deriveTrayItems(issues, selectedIssueId).length
}
