import type { IssueNavigationModel } from '@podium/client-core/values'
import type { PhoneWorkLane, PhoneWorklist } from '@podium/client-graph/worklist/phone'
import type { SessionId } from '@podium/model'
import type { MutableRefObject, ReactNode } from 'react'
import type { useRefreshableTab } from '../hooks/useRefreshableTab'
import type { WorkMenuActionId } from '../lib/work-menu'

export const WORK_LANES: readonly PhoneWorkLane[] = ['open', 'snoozed', 'closed']
export const WORK_LANE_LABELS = { open: 'Open', snoozed: 'Snoozed', closed: 'Closed' } as const

export interface WorkSurfaceProps {
  scrollOffset: MutableRefObject<number>
  returnOffset: number
  returnFocus?: string
  phone: PhoneWorklist
  collapsed: ReadonlySet<string>
  onToggle: (key: string) => void
  pendingNav: string | null
  onOpenIssue: (issue: IssueNavigationModel) => void
  onOpenSession: (sessionId: SessionId, rowKey: string) => void
  onMenu: (issue: IssueNavigationModel, lane?: 'live' | 'snoozed' | 'closed') => void
  onAction: (id: string, action: WorkMenuActionId) => void
  onStatus: (id: string, value: string) => void
  onTuck: (id: string) => void
  refresh: ReturnType<typeof useRefreshableTab>
  bottomInset: number
  notices: ReactNode
  loading: boolean
}
