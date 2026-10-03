import {
  formatClock,
  deriveGitStamp,
  FLEET_KIND_LIMIT,
  rowStatusLine,
  type UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import { relativeTime } from '@podium/client-core/focus'
import type { MobileRowValues } from '@podium/client-graph/worklist/mobile-row'
import type { MobileWorkSection } from '@podium/client-graph/worklist/mobile'
import type { MobxPool } from '@podium/client-graph/pool'
import { issueStatusLabel, type IssueGitState } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'

/** Fold keys keep the existing replicated sidebar namespace. */
export const workGroupFoldKey = (sectionKey: string): string =>
  `podium:sidebar:work-group-fold:${sectionKey}`

/** Only paint facts cross the row subscription. Navigation reads the current
 * pool value on the gesture; bookkeeping and payloads cannot invalidate it. */
export function mobileRowPaint(value: MobileRowValues, now: number) {
  const sidebar = value.sidebar
  const issue = sidebar?.issue
  const git = deriveGitStamp(value.branch, value.gitState as IssueGitState | undefined)
  const ahead = value.suppressAhead ? undefined : git.ahead
  const gitShown = git.kind === 'ready' && (git.mismatch || git.merged || git.dirty !== undefined || ahead !== undefined)
  return {
    id: value.id,
    kind: value.kind,
    label: value.label,
    ref: issue ? issueDisplayRef(issue) : null,
    color: value.color,
    internal: value.internal,
    pinned: value.pinned,
    branch: value.kind === 'worktree' ? value.branch : null,
    progress: value.progress && value.progress.total >= 2 ? value.progress : null,
    originSeq: value.originSeq,
    statusLine: mobileRowStatus(value, now),
    stamp: mobileRowStamp(value.timing, now),
    snoozed: value.snoozed,
    unsnoozed: value.unsnoozed,
    tuckable: value.tuckable,
    display: {
      phase: value.timing.phase,
      working: value.working,
      waitingCount: value.waitingCount,
      decision: value.decision,
      unread: value.unread,
      draftOnly: value.draftOnly,
      fleet: value.draftOnly ? { total: 0, parkedCount: 0, nativeCount: 0, tiles: [] }
        : { ...value.fleet, tiles: value.fleet.tiles.slice(0, FLEET_KIND_LIMIT) },
      gitStamp: { kind: gitShown ? 'ready' as const : 'hidden' as const,
        mismatch: gitShown && git.mismatch, merged: gitShown && git.merged,
        dirty: gitShown ? git.dirty : undefined, ahead: gitShown ? ahead : undefined },
    },
  }
}
export type MobileRowPaint = ReturnType<typeof mobileRowPaint>

function mobileRowStatus(value: MobileRowValues, now: number): string {
  const sidebar = value.sidebar
  if (!sidebar) {
    // The existing worktree formatter is pure and sees this roster alone.
    return rowStatusLine({ kind: 'worktree', worktree: { sessions: value.sessions },
      activityAt: value.activityAt } as unknown as UnifiedWorkRow, now, 0)
  }
  if (sidebar.awaitingFirstPrompt) return 'awaiting first prompt'
  if (sidebar.statusFromChildren) {
    const { total, done, run, review, stall, block, wait } = sidebar.progress
    if (total === 0) return 'no active subtasks'
    const progress = `${done}/${total} ${total === 1 ? 'subtask' : 'subtasks'} done`
    if (done === total) return progress
    const next = block > 0 ? `${block} blocked` : review > 0 ? `${review} in review`
      : run > 0 ? `${run} underway` : stall > 0 ? `${stall} stalled` : wait > 0 ? `${wait} to go` : null
    return next ? `${progress} · ${next}` : progress
  }
  if (value.decision === 'merge') return sidebar.mergeCommits > 0 ? `ready to merge · ${sidebar.mergeCommits}` : 'ready to merge'
  if (value.decision === 'review') return 'needs review'
  if (sidebar.continuation) return `${sidebar.continuation.kind} · ${sidebar.continuation.ref}`
  if (sidebar.issue.blocked) return 'blocked'
  return issueStatusLabel(sidebar.issue as unknown as Parameters<typeof issueStatusLabel>[0]).toLowerCase()
}

export function mobileRowStamp(timing: MobileRowValues['timing'], now: number): string | null {
  if (timing.phase === 'done') return timing.totalMs !== undefined ? `∑ ${formatClock(timing.totalMs)}` : null
  if (!Number.isFinite(timing.sinceMs) || timing.sinceMs <= 0) return null
  if (timing.phase === 'working') return formatClock(Math.max(0, now - timing.sinceMs) + (timing.baseMs ?? 0))
  if (timing.phase === 'waiting') return relativeTime(new Date(timing.sinceMs).toISOString(), now)
  return null
}

/** Pair the clock's plain current value with the next coarse tick. The
 * equality-filtered reader wakes React only if its displayed stamp changed. */
export function mobilePaintNow(pool: MobxPool): number {
  const now = pool.clock.current
  pool.clock.reached(now)
  pool.clock.reached(now + 1)
  return now
}

/** Search is opt-in work. Without a query the pool's stable native arrays go
 * straight to SectionList, and row payload changes never rebuild them. */
export function searchMobileSections(pool: MobxPool, sections: readonly MobileWorkSection[], query: string,
  cache = new MobileSearchSections()): readonly MobileWorkSection[] {
  return cache.update(pool, sections, query)
}

/** Matching can scan resident refs; unchanged matches allocate no row array.
 * A changed match copies its lane only, keeping other native sections intact.
 * The kept bands belong to one search over one pool: ending the search or a
 * new pool (another principal) drops them, so a screen holds one instance. */
export class MobileSearchSections {
  private readonly bands = new Map<string, MobileWorkSection>()
  private previous: readonly MobileWorkSection[] = []
  private pool: MobxPool | null = null
  update(pool: MobxPool, sections: readonly MobileWorkSection[], query: string): readonly MobileWorkSection[] {
    const needle = query.trim().toLowerCase()
    if (!needle || pool !== this.pool) {
      this.bands.clear()
      this.previous = []
      this.pool = pool
    }
    if (!needle) return sections
    const now = mobilePaintNow(pool)
    const matches = (id: string, kind: 'issue' | 'worktree', folded = false): boolean => {
      const value = pool.mobileWork.row({ id, kind })
      if (!value || typeof value === 'symbol') return false
      const paint = mobileRowPaint(value, now)
      const text = paint.kind === 'issue' ? `${paint.ref} ${paint.label}`
        : `${paint.label.slice(0, paint.branch ? -(paint.branch.length + 3) : undefined)} ${paint.branch ?? ''}`
      return `${text}${folded ? '' : ` ${paint.statusLine}`}`.toLowerCase().includes(needle)
    }
    const active = new Set<string>(), next: MobileWorkSection[] = []
    for (const source of sections) {
      active.add(source.key)
      const old = this.bands.get(source.key)
      const data = filteredNative(source.data, ref => matches(ref.id, ref.kind), old?.data, sameMobileRef)
      const snoozedIds = filteredNative(source.snoozedIds, id => matches(id, 'issue', true), old?.snoozedIds)
      const closedIds = filteredNative(source.closedIds, id => matches(id, 'issue', true), old?.closedIds)
      const section = old && old.data === data && old.snoozedIds === snoozedIds && old.closedIds === closedIds
        && old.label === source.label && old.kind === source.kind && old.foldKey === source.foldKey
        && old.collapsed === source.collapsed ? old : { ...source, data, snoozedIds, closedIds, total: data.length }
      this.bands.set(source.key, section)
      if (data.length + snoozedIds.length + closedIds.length > 0) next.push(section)
    }
    for (const key of this.bands.keys()) if (!active.has(key)) this.bands.delete(key)
    if (next.length !== this.previous.length || next.some((section, index) => section !== this.previous[index])) this.previous = next
    return this.previous
  }
}

const sameMobileRef = (a: MobileWorkSection['data'][number], b: MobileWorkSection['data'][number]) =>
  a.id === b.id && a.kind === b.kind && a.listKey === b.listKey

function filteredNative<T>(source: readonly T[], matches: (value: T) => boolean, previous?: readonly T[],
  equal: (a: T, b: T) => boolean = (a, b) => a === b): readonly T[] {
  let next: T[] | undefined, count = 0
  for (const value of source) if (matches(value)) {
    if (!next && (!previous || count >= previous.length || !equal(previous[count]!, value))) next = previous?.slice(0, count) ?? []
    next?.push(value)
    count++
  }
  return next ?? (previous?.length === count ? previous : previous?.slice(0, count) ?? [])
}

/** Native sections carry plain immutable arrays. Folding changes one section
 * object; unchanged bands and their data keep identity across publications. */
export class MobileNativeSections {
  private readonly folded = new Map<string, { source: MobileWorkSection; section: MobileWorkSection }>()
  private previous: readonly MobileWorkSection[] = []
  update(sections: readonly MobileWorkSection[], collapsed: ReadonlySet<string>, searching: boolean): readonly MobileWorkSection[] {
    const active = new Set<string>()
    const next = sections.map(source => {
      active.add(source.key)
      if (searching || !collapsed.has(source.key)) return source
      let saved = this.folded.get(source.key)
      if (!saved || saved.source !== source) {
        saved = { source, section: { ...source, data: [], snoozedIds: [], closedIds: [], collapsed: true } }
        this.folded.set(source.key, saved)
      }
      return saved.section
    })
    for (const key of this.folded.keys()) if (!active.has(key)) this.folded.delete(key)
    if (next.length !== this.previous.length || next.some((section, index) => section !== this.previous[index])) this.previous = next
    return this.previous
  }
}
