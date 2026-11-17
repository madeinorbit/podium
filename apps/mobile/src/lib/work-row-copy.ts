import type { PhoneWorkLane } from '@podium/client-graph/worklist/phone'
import { WORK_LANE_LABELS } from '../screens/WorkSurface.types'
import type { WorkMenuActionId } from './work-menu'

/** SF Symbol names the menu uses; kept as a literal union so a typo fails typecheck. */
export type WorkMenuSymbol =
  | 'pencil'
  | 'envelope.open'
  | 'envelope.badge'
  | 'sun.max'
  | 'arrow.down.to.line'
  | 'arrow.uturn.backward'
  | 'arrow.up.left.square'
  | 'arrow.down.right.square'
  | 'trash'

/** "Open 18" in the segmented control; an empty lane shows its bare name. */
export function workLaneTitle(lane: PhoneWorkLane, count: number): string {
  return count > 0 ? `${WORK_LANE_LABELS[lane]} ${count}` : WORK_LANE_LABELS[lane]
}

/** Long-press menu wording (Mail-style title case) for the existing work-menu ids. */
export function workMenuItem(
  action: Exclude<WorkMenuActionId, 'status'>,
  state: { unread: boolean; inMission: boolean },
): { label: string; symbol: WorkMenuSymbol } {
  switch (action) {
    case 'rename':
      return { label: 'Rename', symbol: 'pencil' }
    case 'read':
      return state.unread
        ? { label: 'Mark as Read', symbol: 'envelope.open' }
        : { label: 'Mark as Unread', symbol: 'envelope.badge' }
    case 'undefer':
      return { label: 'Unsnooze', symbol: 'sun.max' }
    case 'tuck':
      return { label: 'Tuck', symbol: 'arrow.down.to.line' }
    case 'bringBack':
      return { label: 'Bring Back from Closed', symbol: 'arrow.uturn.backward' }
    case 'placement':
      return state.inMission
        ? { label: 'Move Out of Mission', symbol: 'arrow.up.left.square' }
        : { label: 'Move into Parent Task', symbol: 'arrow.down.right.square' }
    case 'delete':
      return { label: 'Delete…', symbol: 'trash' }
  }
}

/** W3: "3 need you · 6 working"; a zero part drops, and nothing at all is no subtitle. */
export function workSubtitle(needYou: number, working: number): string | undefined {
  const parts = [needYou > 0 ? `${needYou} need you` : '', working > 0 ? `${working} working` : '']
  return parts.filter(Boolean).join(' · ') || undefined
}

/** W4: the folded row for projects with nothing open. */
export function quietProjectsLabel(count: number): string {
  return `${count} ${count === 1 ? 'project' : 'projects'} with nothing open`
}
