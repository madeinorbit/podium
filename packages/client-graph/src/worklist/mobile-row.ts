/** Mobile presentation facts. Copy, clock formatting, colours and local
 * navigation feedback remain in the existing native components. */
import type { SliceSession } from '../shared/slice-types'
import { fleetOf, sidebarTiming, type SidebarRowValues, type SidebarTiming } from './sidebar-row'
import { isSessionWorking, motionPhase, type Aggregate } from './rollup'

export interface MobileRowValues {
  readonly id: string
  readonly kind: 'issue' | 'worktree'
  readonly label: string
  readonly progress: SidebarRowValues['progress'] | null
  readonly originSeq: number | null
  readonly timing: SidebarTiming
  readonly working: boolean
  readonly waitingCount: number
  readonly decision: SidebarRowValues['decision']
  readonly unread: boolean
  readonly draftOnly: boolean
  readonly draftQuiet: boolean
  readonly color: string | null
  readonly internal: boolean
  readonly pinned: boolean
  readonly snoozed: boolean
  readonly unsnoozed: boolean
  readonly tuckable: boolean
  readonly fleet: SidebarRowValues['fleet']
  readonly branch: string | null
  readonly gitState: SidebarRowValues['gitState']
  readonly suppressAhead: boolean
  readonly attentionAction: 'Review' | 'Answer' | null
  readonly navigation: { readonly kind: 'issue' | 'session'; readonly id: string } | null
  /** Existing row/status formatter inputs, borrowed from the shared caches. */
  readonly sidebar: SidebarRowValues | null
  readonly sessions: readonly SliceSession[]
  readonly activityAt: number
}

export const MOBILE_ROW_FIELDS = [
  'id', 'kind', 'label', 'progress', 'originSeq', 'timing', 'working', 'waitingCount',
  'decision', 'unread', 'draftOnly', 'draftQuiet', 'color', 'internal', 'pinned',
  'snoozed', 'unsnoozed', 'tuckable', 'fleet', 'branch', 'gitState', 'suppressAhead',
  'attentionAction', 'navigation', 'sidebar', 'sessions', 'activityAt',
] as const satisfies readonly (keyof MobileRowValues)[]
const exhaustive: Exclude<keyof MobileRowValues, typeof MOBILE_ROW_FIELDS[number]> extends never ? true : never = true
void exhaustive

/** Exact branch-wide badge, including offer-only decision deduplication.
 * The attention cache already composes these counters over nested rows. */
export function mobileWaitingCount(aggregate: Aggregate, finished: boolean): number {
  const counts = aggregate.railWaiting
  return counts === undefined ? 0 : counts.decisions + (finished ? counts.finished : counts.open)
}

export function mobileIssueValues(sidebar: SidebarRowValues, waitingCount: number, activityAt: number): MobileRowValues {
  const first = sidebar.sessions[0]
  const draftQuiet = sidebar.draftAgentOnly && !first?.busy && (first?.agentState?.phase ?? 'unknown') === 'unknown'
  return {
    id: sidebar.issue.id, kind: 'issue', label: sidebar.title, progress: sidebar.progress,
    originSeq: sidebar.originTick?.seq ?? null, timing: sidebar.timing, working: sidebar.working,
    waitingCount, decision: sidebar.decision, unread: sidebar.unread && !draftQuiet,
    draftOnly: sidebar.draftAgentOnly, draftQuiet, color: sidebar.color, internal: sidebar.internal,
    pinned: sidebar.issue.pinned === true, snoozed: sidebar.deferred, unsnoozed: sidebar.unsnoozed,
    tuckable: sidebar.awaitsTuck, fleet: sidebar.fleet, branch: sidebar.issue.branch ?? null,
    gitState: sidebar.gitState, suppressAhead: sidebar.decision === 'merge',
    attentionAction: waitingCount > 0 ? sidebar.decision ? 'Review' : 'Answer' : null,
    navigation: sidebar.draftAgentOnly && first ? { kind: 'session', id: first.sessionId } : { kind: 'issue', id: sidebar.issue.id },
    sidebar, sessions: sidebar.sessions, activityAt,
  }
}

export function mobileWorktreeValues(id: string, repoName: string, branch: string | null | undefined, sessions: readonly SliceSession[], activityAt: number): MobileRowValues {
  const phases = sessions.map(session => motionPhase(session, false))
  const phase = phases.includes('waiting') ? 'waiting' : phases.includes('working') ? 'working'
    : phases.length > 0 && phases.every(value => value === 'done') ? 'done' : 'queued'
  const working = sessions.some(isSessionWorking)
  return {
    id, kind: 'worktree', label: `${repoName}${branch ? ` · ${branch}` : ''}`,
    progress: null, originSeq: null, timing: sidebarTiming(sessions, phase, false, activityAt),
    working, waitingCount: phases.filter(value => value === 'waiting').length, decision: null,
    unread: !working && sessions.some(session => session.unread), draftOnly: false, draftQuiet: false,
    color: null, internal: false, pinned: false, snoozed: false, unsnoozed: false, tuckable: false,
    fleet: fleetOf(sessions), branch: branch ?? null, gitState: undefined, suppressAhead: false,
    attentionAction: null, navigation: sessions[0] ? { kind: 'session', id: sessions[0].sessionId } : null,
    sidebar: null, sessions, activityAt,
  }
}
