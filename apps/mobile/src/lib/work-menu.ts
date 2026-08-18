import type { IssueNavigationModel } from '@podium/client-core/viewmodels'
import type { IssueWire } from '@podium/model'

/** The part of Work the long-pressed row occupies. Folded rows deliberately
 * have a much smaller vocabulary than live rows. */
export type WorkMenuLane = 'live' | 'snoozed' | 'closed'

export type WorkMenuActionId =
  | 'open'
  | 'peek'
  | 'rename'
  | 'read'
  | 'status'
  | 'priority'
  | 'agent'
  | 'labels'
  | 'color'
  | 'placement'
  | 'defer'
  | 'pin'
  | 'moveTop'
  | 'moveUp'
  | 'moveDown'
  | 'bringBack'
  | 'undefer'
  | 'archive'
  | 'delete'

export interface WorkMenuCapabilities {
  placement: boolean
  moveTop: boolean
  moveUp: boolean
  moveDown: boolean
}

/**
 * The mobile projection of the desktop sidebar menu.
 *
 * Phone-only affordances stay explicit: Peek replaces a second pane, and the
 * three Move actions replace the desktop's drag grip. Everything else follows
 * the desktop menu's order and lifecycle gates. Closed and Snoozed rows do not
 * inherit this list: once folded, their only useful choices are the inverse of
 * the fold and Archive.
 */
export function workMenuActionIds(
  issue: IssueNavigationModel,
  lane: WorkMenuLane,
  capabilities: WorkMenuCapabilities,
): WorkMenuActionId[] {
  if (lane === 'closed') return ['bringBack', 'archive']
  if (lane === 'snoozed') return ['undefer', 'archive']

  const live = !issue.deletedAt
  const open = live && issue.closedReason == null
  const ids: WorkMenuActionId[] = ['open', 'peek']
  if (!live) return ids

  ids.push('rename', 'read', 'status', 'priority')
  if (open) ids.push('agent')
  ids.push('labels')
  if (issue.parentId == null) ids.push('color')
  if (capabilities.placement) ids.push('placement')
  if (open || issue.deferUntil != null) ids.push('defer')
  ids.push('pin')
  if (capabilities.moveTop) ids.push('moveTop')
  if (capabilities.moveUp) ids.push('moveUp')
  if (capabilities.moveDown) ids.push('moveDown')
  ids.push('archive', 'delete')
  return ids
}

/** Same gate as the desktop's Run now / Assign agent choice. */
export function workIssueStartable(issue: IssueWire): boolean {
  return (
    !issue.worktreePath &&
    issue.closedReason == null &&
    !issue.archived &&
    !issue.deletedAt &&
    issue.stage !== 'shipping'
  )
}

/** Local YYYY-MM-DD for the desktop menu's tomorrow/week defer presets. */
export function workDeferDateFromNow(now: number, days: number): string {
  const date = new Date(now)
  date.setDate(date.getDate() + days)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
