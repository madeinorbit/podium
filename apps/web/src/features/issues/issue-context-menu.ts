import { handoffTargets, type HandoffMachine, type HandoffRepo } from '@podium/domain'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import type { IssuesKeyState } from './issues-keys'

/**
 * Pure helpers for the issue right-click context menu (IssueContextMenu.tsx) —
 * eligibility gating, right-click selection semantics, and defer-date presets.
 * Kept React-free so the rules can be unit-tested like sessionMenuEligibility.
 */

/**
 * Resolve the single handoff-eligible session for an issue-row context menu
 * ([spec:SP-3f7a]). Looks up each `issue.sessions[].sessionId` in the live
 * store sessions, reuses `handoffTargets` for eligibility, and returns a result
 * only when exactly one attached session has at least one target machine.
 * Callers must also require a single selected issue (`issues.length === 1`).
 */
export function resolveIssueHandoffSession<M extends HandoffMachine>(
  issue: { sessions: readonly { sessionId: string }[] },
  sessions: readonly SessionMeta[],
  repos: HandoffRepo[],
  machines: M[],
): { session: SessionMeta; targets: M[] } | null {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]))
  const eligible: { session: SessionMeta; targets: M[] }[] = []
  for (const ref of issue.sessions) {
    const session = byId.get(ref.sessionId)
    if (!session) continue
    const targets = handoffTargets(session, repos, machines)
    if (targets.length > 0) eligible.push({ session, targets })
  }
  return eligible.length === 1 ? (eligible[0] ?? null) : null
}

/** Closed = a close reason is recorded (server: isClosed ⇔ closedReason != null). */
export function isIssueClosed(issue: IssueWire): boolean {
  return issue.closedReason != null
}

/**
 * Which menu items apply to the current right-click target set. Single-target
 * actions (open, assign agent, close, defer, duplicate, pin) disappear on a
 * multi-selection; bulk-capable ones (stage / priority / labels / delete) match
 * the bulk action bar and stay for any non-empty selection.
 */
export function issueMenuEligibility(issues: readonly IssueWire[]): {
  canOpen: boolean
  canRename: boolean
  canSetStage: boolean
  canSetPriority: boolean
  canAssignAgent: boolean
  canSetLabels: boolean
  canClose: boolean
  canDefer: boolean
  canUndefer: boolean
  canDuplicate: boolean
  canPin: boolean
  canDelete: boolean
  canArchive: boolean
  canRestore: boolean
  canUnarchive: boolean
  canMarkRead: boolean
  canMarkUnread: boolean
} {
  const any = issues.length > 0
  const single = issues.length === 1
  const first = issues[0]
  const openSingle = single && first !== undefined && !isIssueClosed(first)
  const hasDeleted = issues.some((i) => !!i.deletedAt)
  const activeAny = any && !hasDeleted
  return {
    canOpen: single,
    // Rename is single-target and applies to any issue, open or closed (#170).
    canRename: single && !hasDeleted,
    canSetStage: activeAny,
    canSetPriority: activeAny,
    canAssignAgent: openSingle && !hasDeleted,
    canSetLabels: activeAny,
    canClose: openSingle && !hasDeleted,
    canDefer: openSingle && !hasDeleted,
    canUndefer: single && !hasDeleted && first?.deferUntil != null,
    // "Duplicate" marks the issue a duplicate of a canonical sibling — pointless
    // once it already points at one.
    canDuplicate: single && !hasDeleted && first?.duplicateOf == null,
    canPin: single && !hasDeleted,
    canDelete: activeAny,
    canRestore: any && issues.every((i) => !!i.deletedAt),
    // Archive removes an issue from the board/sidebar without deleting it; the
    // pair is single-target and mutually exclusive on the issue's `archived`.
    canArchive: single && !hasDeleted && first?.archived === false,
    canUnarchive: single && !hasDeleted && first?.archived === true,
    // Email-style read toggle (#138): single-target, mutually exclusive on the
    // derived `unread`. A currently-read row offers "mark unread"; an unread one
    // offers "mark read". (`unread` is always a boolean on the wire.)
    canMarkRead: single && !hasDeleted && first?.unread === true,
    canMarkUnread: single && !hasDeleted && !first?.unread,
  }
}

/**
 * Right-click selection semantics (matches the bulk action bar): a click inside
 * the current multi-selection keeps it (menu acts on all selected, focus moves
 * to the clicked issue); a click on an unselected issue re-focuses it and drops
 * the old selection, exactly like a plain left click would target that one issue.
 */
export function contextMenuTargets(
  state: IssuesKeyState,
  clickedId: string,
): { keyState: IssuesKeyState; targetIds: string[] } {
  if (state.selected.includes(clickedId)) {
    return { keyState: { ...state, focusId: clickedId }, targetIds: state.selected }
  }
  return { keyState: { focusId: clickedId, selected: [] }, targetIds: [clickedId] }
}

/** Local YYYY-MM-DD for `now + days` — the shape `trpc.issues.defer` expects. */
export function deferDateFromNow(now: number, days: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * Toggle `label` across the target set: if every target already has it the
 * toggle removes it everywhere; otherwise it is added to the targets missing
 * it. Returns only the issues whose label set actually changes.
 */
export function toggleLabelAcross(
  issues: readonly IssueWire[],
  label: string,
): { id: string; labels: string[] }[] {
  const allHave = issues.every((i) => i.labels.includes(label))
  return issues.flatMap((i) => {
    if (allHave) return [{ id: i.id, labels: i.labels.filter((l) => l !== label) }]
    if (i.labels.includes(label)) return []
    return [{ id: i.id, labels: [...i.labels, label] }]
  })
}
