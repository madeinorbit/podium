import type { IssueNavigationModel } from '@podium/client-core/viewmodels'

/** The part of Work the long-pressed row occupies. Folded rows deliberately
 * have a much smaller vocabulary than live rows. */
export type WorkMenuLane = 'live' | 'snoozed' | 'closed'

export type WorkMenuActionId =
  | 'rename'
  | 'read'
  | 'status'
  | 'color'
  | 'placement'
  | 'bringBack'
  | 'undefer'
  | 'delete'

export interface WorkMenuCapabilities {
  placement: boolean
}

/**
 * The mobile long-press menu, TRIMMED by the 2026-08-27 device review.
 *
 * This began as the full desktop sidebar vocabulary projected onto a sheet, and
 * on a real phone most of it was noise: Open/Peek duplicated the row tap,
 * priority/labels/agent-launch/snooze/pin/archive all have better homes (the
 * task page and the chat's own menus), and Move down never earned its row.
 * What is LEFT is what a long-press is actually for — naming, read state,
 * status, colour, placement, and delete — the Move to top/up reorder pair went
 * in the 2026-08-28 follow-up review, the day it was discovered ("remove the
 * move entries"): ordering belongs to drag on the desktop, not a phone menu.
 * Closed and Snoozed rows keep only the inverse of their fold.
 */
export function workMenuActionIds(
  issue: IssueNavigationModel,
  lane: WorkMenuLane,
  capabilities: WorkMenuCapabilities,
): WorkMenuActionId[] {
  if (lane === 'closed') return ['bringBack']
  if (lane === 'snoozed') return ['undefer']

  if (issue.deletedAt) return []

  const ids: WorkMenuActionId[] = ['rename', 'read', 'status']
  if (issue.parentId == null) ids.push('color')
  if (capabilities.placement) ids.push('placement')
  ids.push('delete')
  return ids
}
