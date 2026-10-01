/** Sidebar facts, carried by the existing issue object and cached groups.
 * No colour tokens, timer formatting, status copy, or glyphs live here.
 * The compatibility payload lets the current row keep its presentation.
 */
import { resolveDescriptors } from '@podium/harness/browser'
import type { SliceIssue, SliceSession, SlicePhase } from '../shared/slice-types'
import { DEFER_NEXT_MESSAGE, FINISHED_GRACE_MS, isClosedTopLevel, issueAbandoned } from '../views'
import { awaitingMergeOf } from '../shared/schema'
import { attentionGroup, isSessionWorking, motionPhase, type UnitState } from './rollup'

export interface SidebarProgress extends Readonly<Record<UnitState, number>> { readonly total: number }
export interface SidebarTiming {
  readonly phase: SlicePhase
  readonly sinceMs: number
  readonly baseMs?: number
  readonly totalMs?: number
}
export interface SidebarRowValues {
  readonly idNumber: number
  readonly color: string | null
  readonly title: string
  readonly timing: SidebarTiming
  readonly decision: 'merge' | 'review' | null
  readonly mergeCommits: number
  readonly progress: SidebarProgress
  readonly fromChildren: boolean
  /** Legacy enriches root status with progress; a nested row keeps leaf copy. */
  readonly statusFromChildren: boolean
  readonly gitState: SliceIssue['gitState']
  readonly unread: boolean
  readonly errorClass: string | null
  readonly internal: boolean
  readonly unsnoozed: boolean
  readonly deferred: boolean
  readonly awaitsTuck: boolean
  readonly canBringBack: boolean
  readonly draftAgentOnly: boolean
  readonly firstSessionId: string | null
  readonly continuation: { readonly kind: 'continued' | 'duplicate'; readonly ref: string } | null
  readonly fleet: {
    readonly total: number
    readonly parkedCount: number
    readonly nativeCount: number
    readonly tiles: readonly { readonly kind: string | null; readonly parked: boolean }[]
  }
  /** Own immutable row facts, owned by the feed; never a model or store handle. */
  readonly issue: SliceIssue
  readonly sessions: readonly SliceSession[]
  readonly aggregateSessions: readonly SliceSession[]
  readonly awaitingFirstPrompt: boolean
}

/** Exhaustive comparison surface for the round-three sidebar oracle. */
export const SIDEBAR_ROW_FIELDS = [
  'idNumber', 'color', 'title', 'timing', 'decision', 'mergeCommits', 'progress',
  'fromChildren', 'statusFromChildren', 'gitState', 'unread', 'errorClass', 'internal', 'unsnoozed',
  'deferred', 'awaitsTuck', 'canBringBack', 'draftAgentOnly', 'firstSessionId',
  'continuation', 'fleet', 'issue', 'sessions', 'aggregateSessions', 'awaitingFirstPrompt',
] as const satisfies readonly (keyof SidebarRowValues)[]
const exhaustive: Exclude<keyof SidebarRowValues, typeof SIDEBAR_ROW_FIELDS[number]> extends never ? true : never = true
void exhaustive

export function sortedSidebarSessions(
  sessions: readonly SliceSession[],
  reached: (at: number) => boolean,
  coordinator?: string | null,
): SliceSession[] {
  const snoozed = (s: SliceSession): boolean => s.snoozedUntil === null ||
    (typeof s.snoozedUntil === 'string' && !reached(Date.parse(s.snoozedUntil)))
  const rank = (s: SliceSession): number => attentionGroup(s) === 'working' ? 2 : snoozed(s) ? 1 : 0
  const recency = (s: SliceSession): string => {
    let at = s.lastActiveAt
    if (s.draftUpdatedAt && s.draftUpdatedAt > at) at = s.draftUpdatedAt
    if (typeof s.snoozedUntil === 'string' && reached(Date.parse(s.snoozedUntil)) && s.snoozedUntil > at) at = s.snoozedUntil
    return at
  }
  const sorted = [...sessions].sort((a, b) => rank(a) - rank(b) || recency(b).localeCompare(recency(a)) ||
    (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.sessionId.localeCompare(b.sessionId))
  const index = sorted.findIndex(s => s.sessionId === coordinator)
  if (index > 0) sorted.unshift(...sorted.splice(index, 1))
  return sorted
}

export function sidebarTiming(
  sessions: readonly SliceSession[], phase: SlicePhase, finished: boolean,
  activityAt: number, decidingAt?: number,
): SidebarTiming {
  const since = (s: SliceSession): number => Date.parse(s.agentState?.since ?? s.lastActiveAt)
  const earliest = (list: readonly SliceSession[]): SliceSession | undefined => list.reduce<SliceSession | undefined>(
    (best, s) => best === undefined || since(s) < since(best) ? s : best, undefined)
  if (phase === 'working') {
    const anchor = earliest(sessions.filter(isSessionWorking))
    if (anchor) return { phase, sinceMs: since(anchor), ...(anchor.agentState?.workingMsTotal !== undefined ? { baseMs: anchor.agentState.workingMsTotal } : {}) }
  }
  if (phase === 'waiting') {
    const anchor = earliest(sessions.filter(s => motionPhase(s, finished) === 'waiting'))
    if (anchor) return { phase, sinceMs: Date.parse(anchor.offer?.createdAt ?? '') || since(anchor) }
    if (decidingAt !== undefined) return { phase, sinceMs: decidingAt }
  }
  if (phase === 'done') {
    const totals = sessions.flatMap(s => s.agentState?.workingMsTotal === undefined ? [] : [s.agentState.workingMsTotal])
    return { phase, sinceMs: sessions.reduce((at, s) => Math.max(at, since(s) || 0), 0),
      ...(totals.length ? { totalMs: totals.reduce((a, b) => a + b, 0) } : {}) }
  }
  return { phase, sinceMs: activityAt }
}

export function fleetOf(sessions: readonly SliceSession[]): SidebarRowValues['fleet'] {
  const present = sessions.filter(s => !s.archived && s.status !== 'exited')
  const tiles: { kind: string | null; parked: boolean }[] = []
  for (const session of present) {
    const kind = session.agentKind ?? null
    const existing = tiles.find(t => t.kind === kind)
    if (existing === undefined) tiles.push({ kind, parked: session.status === 'hibernated' })
    else if (session.status !== 'hibernated') existing.parked = false
  }
  return { total: present.length, tiles,
    parkedCount: present.filter(s => s.status === 'hibernated').length,
    nativeCount: present.reduce((count, s) => count + (s.status === 'hibernated' ? 0 : s.agentState?.nativeSubagentCount ?? 0), 0) }
}

const labels = new Map(resolveDescriptors([]).map(d => [d.kind, d.shortLabel]))
export function unstarted(s: SliceSession): boolean {
  if (s.name?.trim()) return false
  const title = (s.title ?? '').replace(/^[\p{So}\p{Sk}·•\s]+/u, '').trim().toLowerCase()
  return !title || [labels.get(s.agentKind ?? '')?.toLowerCase(), s.agentKind, 'claude code', s.cwd.split('/').filter(Boolean).at(-1)?.toLowerCase()].includes(title)
}

export function sidebarLifecycle(issue: SliceIssue, asking: boolean, passed: (at: number) => boolean, reached: (at: number) => boolean) {
  const settled = isClosedTopLevel(issue) && !issue.needsHuman && !awaitingMergeOf(issue) && !asking
  const withinGrace = !passed((Date.parse(issue.closedAt ?? issue.updatedAt) || 0) + FINISHED_GRACE_MS)
  const eligible = settled && !issueAbandoned(issue) && withinGrace
  const deadline = Date.parse(issue.deferUntil ?? '')
  const timed = issue.deferUntil !== DEFER_NEXT_MESSAGE && Number.isFinite(deadline)
  return { awaitsTuck: eligible && issue.tuckedAt == null, canBringBack: eligible && issue.tuckedAt != null,
    unsnoozed: timed && reached(deadline), deferred: issue.deferUntil === DEFER_NEXT_MESSAGE || (timed && !reached(deadline)) }
}
