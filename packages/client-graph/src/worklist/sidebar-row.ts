/** Sidebar facts, carried by the existing issue object and cached groups.
 * No colour tokens, timer formatting, status copy, or glyphs live here.
 * The compatibility payload lets the current row keep its presentation.
 */
import { resolveDescriptors } from '@podium/harness/browser'
import type { SliceIssue, SliceSession, SlicePhase } from '../shared/slice-types'
import type { RowOriginTick } from '../shared/row-view'
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
  readonly working: boolean
  readonly asking: boolean
  readonly originTick: RowOriginTick | null
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
  readonly issue: SliceIssue & { readonly displayRef: string }
  readonly sessions: readonly SliceSession[]
  readonly aggregateSessions: readonly SliceSession[]
  readonly awaitingFirstPrompt: boolean
}

/** Exhaustive comparison surface for the round-three sidebar oracle. */
export const SIDEBAR_ROW_FIELDS = [
  'idNumber', 'color', 'title', 'timing', 'working', 'asking', 'originTick', 'decision', 'mergeCommits', 'progress',
  'fromChildren', 'statusFromChildren', 'gitState', 'unread', 'errorClass', 'internal', 'unsnoozed',
  'deferred', 'awaitsTuck', 'canBringBack', 'draftAgentOnly', 'firstSessionId',
  'continuation', 'fleet', 'issue', 'sessions', 'aggregateSessions', 'awaitingFirstPrompt',
] as const satisfies readonly (keyof SidebarRowValues)[]
const exhaustive: Exclude<keyof SidebarRowValues, typeof SIDEBAR_ROW_FIELDS[number]> extends never ? true : never = true
void exhaustive

interface SidebarSessionOrder {
  readonly id: string
  readonly working: boolean
  readonly snoozedUntil: SliceSession['snoozedUntil']
  readonly recency: string
  readonly createdAt: string
  readonly offerOnly: boolean
}

/** Feed records are immutable. Issue title/cursor changes may rebuild their
 * roster, but do not change these ordering and rail facts. A replacement seat
 * gets new facts; weak keys release them when the borrowed record is released.
 * Clock thresholds are still read by the sorting caller on every run. */
const sessionOrders = new WeakMap<SliceSession, SidebarSessionOrder>()
export function sidebarSessionOrder(session: SliceSession): SidebarSessionOrder {
  let order = sessionOrders.get(session)
  if (order === undefined) {
    const activeAt = session.lastActiveAt
    const draftAt = session.draftUpdatedAt
    order = {
      id: session.sessionId,
      working: attentionGroup(session) === 'working',
      snoozedUntil: session.snoozedUntil,
      recency: draftAt && draftAt > activeAt ? draftAt : activeAt,
      createdAt: session.createdAt ?? '',
      offerOnly: Boolean(session.offer) && attentionGroup(session, false) !== 'needsYou',
    }
    sessionOrders.set(session, order)
  }
  return order
}

export function sortedSidebarSessions(
  sessions: readonly SliceSession[],
  reached: (at: number) => boolean,
  coordinator?: string | null,
): SliceSession[] {
  const snoozed = (s: SidebarSessionOrder): boolean => s.snoozedUntil === null ||
    (typeof s.snoozedUntil === 'string' && !reached(Date.parse(s.snoozedUntil)))
  const rank = (s: SidebarSessionOrder): number => s.working ? 2 : snoozed(s) ? 1 : 0
  const recency = (s: SidebarSessionOrder): string => {
    let at = s.recency
    if (typeof s.snoozedUntil === 'string' && reached(Date.parse(s.snoozedUntil)) && s.snoozedUntil > at) at = s.snoozedUntil
    return at
  }
  const sorted = [...sessions].sort((left, right) => {
    const a = sidebarSessionOrder(left), b = sidebarSessionOrder(right)
    return rank(a) - rank(b) || recency(b).localeCompare(recency(a)) ||
      b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
  })
  const index = sorted.findIndex(s => sidebarSessionOrder(s).id === coordinator)
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

/** The session facts a clock-only row redraw needs, composed in the existing
 * attention cache. No redraw walks the borrowed subtree records again. */
interface TimerAnchor {
  readonly stateSince: number
  readonly sinceMs: number
  readonly baseMs?: number
}
export interface SidebarSessionFacts {
  readonly fleet: SidebarRowValues['fleet']
  readonly working?: TimerAnchor
  readonly waitingOpen?: TimerAnchor
  readonly waitingFinished?: TimerAnchor
  readonly doneSince: number
  readonly totalMs?: number
  readonly lastActiveMs: number
  readonly errorClass: string | null
  readonly allUnstarted: boolean
}
export const NO_SIDEBAR_SESSIONS: SidebarSessionFacts = {
  fleet: { total: 0, parkedCount: 0, nativeCount: 0, tiles: [] },
  doneSince: 0, lastActiveMs: 0, errorClass: null, allUnstarted: true,
}

export function sidebarSessionFacts(session: SliceSession): SidebarSessionFacts {
  const stateSince = Date.parse(session.agentState?.since ?? session.lastActiveAt)
  const working = isSessionWorking(session)
  const waiting: TimerAnchor = { stateSince,
    sinceMs: Date.parse(session.offer?.createdAt ?? '') || stateSince }
  return {
    fleet: fleetOf([session]),
    ...(working ? { working: { stateSince, sinceMs: stateSince,
      ...(session.agentState?.workingMsTotal !== undefined ? { baseMs: session.agentState.workingMsTotal } : {}) } } : {}),
    ...(motionPhase(session, false) === 'waiting' ? { waitingOpen: waiting } : {}),
    ...(motionPhase(session, true) === 'waiting' ? { waitingFinished: waiting } : {}),
    doneSince: stateSince || 0,
    ...(session.agentState?.workingMsTotal !== undefined ? { totalMs: session.agentState.workingMsTotal } : {}),
    lastActiveMs: Date.parse(session.lastActiveAt) || 0,
    errorClass: !session.archived && session.status !== 'exited' && session.agentState?.phase === 'errored'
      ? session.agentState.error?.class ?? 'unknown' : null,
    allUnstarted: unstarted(session),
  }
}

/** Ordered and associative: ties keep the first roster member, as the row's
 * earliest-session choice and fleet glyph order do. */
export function combineSidebarSessions(a: SidebarSessionFacts, b: SidebarSessionFacts): SidebarSessionFacts {
  // Sessionless branches are the composition's identity. Borrow the already
  // composed facts instead of copying fleet tiles through every empty branch.
  if (a === NO_SIDEBAR_SESSIONS) return b
  if (b === NO_SIDEBAR_SESSIONS) return a
  const earliest = (left: TimerAnchor | undefined, right: TimerAnchor | undefined) =>
    left === undefined ? right : right !== undefined && right.stateSince < left.stateSince ? right : left
  return {
    fleet: combineFleet(a.fleet, b.fleet),
    working: earliest(a.working, b.working), waitingOpen: earliest(a.waitingOpen, b.waitingOpen),
    waitingFinished: earliest(a.waitingFinished, b.waitingFinished),
    doneSince: Math.max(a.doneSince, b.doneSince),
    ...(a.totalMs !== undefined || b.totalMs !== undefined ? { totalMs: (a.totalMs ?? 0) + (b.totalMs ?? 0) } : {}),
    lastActiveMs: Math.max(a.lastActiveMs, b.lastActiveMs),
    errorClass: a.errorClass ?? b.errorClass, allUnstarted: a.allUnstarted && b.allUnstarted,
  }
}

function combineFleet(a: SidebarRowValues['fleet'], b: SidebarRowValues['fleet']): SidebarRowValues['fleet'] {
  // An exited-only branch can still contribute timing, but contributes no
  // fleet glyphs. Keep the other branch's immutable fleet in that case.
  if (a.total === 0) return b
  if (b.total === 0) return a
  const tiles = a.tiles.map(tile => ({ ...tile }))
  for (const tile of b.tiles) {
    const previous = tiles.find(candidate => candidate.kind === tile.kind)
    if (previous) previous.parked &&= tile.parked
    else tiles.push({ ...tile })
  }
  return { total: a.total + b.total, parkedCount: a.parkedCount + b.parkedCount,
    nativeCount: a.nativeCount + b.nativeCount, tiles }
}

export function sidebarTimingFromFacts(
  facts: SidebarSessionFacts, phase: SlicePhase, finished: boolean, activityAt: number, decidingAt?: number,
): SidebarTiming {
  if (phase === 'working' && facts.working) return { phase, sinceMs: facts.working.sinceMs,
    ...(facts.working.baseMs !== undefined ? { baseMs: facts.working.baseMs } : {}) }
  if (phase === 'waiting') {
    const anchor = finished ? facts.waitingFinished : facts.waitingOpen
    if (anchor) return { phase, sinceMs: anchor.sinceMs }
    if (decidingAt !== undefined) return { phase, sinceMs: decidingAt }
  }
  if (phase === 'done') return { phase, sinceMs: facts.doneSince,
    ...(facts.totalMs !== undefined ? { totalMs: facts.totalMs } : {}) }
  return { phase, sinceMs: activityAt }
}

const labels: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(resolveDescriptors([]).map(d => [d.kind, d.shortLabel])))
export function unstarted(s: SliceSession): boolean {
  if (s.name?.trim()) return false
  const title = (s.title ?? '').replace(/^[\p{So}\p{Sk}·•\s]+/u, '').trim().toLowerCase()
  const kind = s.agentKind ?? ''
  const label = Object.hasOwn(labels, kind) ? labels[kind] : undefined
  return !title || [label?.toLowerCase(), s.agentKind, 'claude code', s.cwd.split('/').filter(Boolean).at(-1)?.toLowerCase()].includes(title)
}

export function sidebarLifecycle(issue: SliceIssue, asking: boolean, passed: (at: number) => boolean, reached: (at: number) => boolean) {
  const settled = isClosedTopLevel(issue) && !issue.needsHuman && !awaitingMergeOf(issue) && !asking
  const eligible = settled && !issueAbandoned(issue) &&
    !passed((Date.parse(issue.closedAt ?? issue.updatedAt) || 0) + FINISHED_GRACE_MS)
  const deadline = Date.parse(issue.deferUntil ?? '')
  const timed = issue.deferUntil !== DEFER_NEXT_MESSAGE && Number.isFinite(deadline)
  return { awaitsTuck: eligible && issue.tuckedAt == null, canBringBack: eligible && issue.tuckedAt != null,
    unsnoozed: timed && reached(deadline), deferred: issue.deferUntil === DEFER_NEXT_MESSAGE || (timed && !reached(deadline)) }
}
