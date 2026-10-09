import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import type { WorklistWorktree } from '@podium/client-graph/worklist/worktree'
import { mobileWorkView } from '@podium/client-graph/worklist/mobile'
import { relativeTime } from '@podium/client-core/focus'
import {
  deriveGitStamp,
  FLEET_KIND_LIMIT,
  formatClock,
  rowStatusLine,
  type UnifiedWorkRow,
} from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph/pool'
import type { MobileWorkSection as WorkSection, MobileWorkRef } from '@podium/client-graph/worklist/mobile'
export type MobileWorkSection = Omit<WorkSection, 'data'> & { readonly data: readonly MobileWorkRef[] }
import type { MobileRowValues } from '@podium/client-graph/worklist/mobile-row'
import { type IssueGitState, issueStatusLabel } from '@podium/model'
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
  const gitShown =
    git.kind === 'ready' &&
    (git.mismatch || git.merged || git.dirty !== undefined || ahead !== undefined)
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
      fleet: value.draftOnly
        ? { total: 0, parkedCount: 0, nativeCount: 0, tiles: [] }
        : { ...value.fleet, tiles: value.fleet.tiles.slice(0, FLEET_KIND_LIMIT) },
      gitStamp: {
        kind: gitShown ? ('ready' as const) : ('hidden' as const),
        mismatch: gitShown && git.mismatch,
        merged: gitShown && git.merged,
        dirty: gitShown ? git.dirty : undefined,
        ahead: gitShown ? ahead : undefined,
      },
    },
  }
}
export type MobileRowPaint = ReturnType<typeof mobileRowPaint>

function mobileRowStatus(value: MobileRowValues, now: number): string {
  const sidebar = value.sidebar
  if (!sidebar) {
    // The existing worktree formatter is pure and sees this roster alone.
    return rowStatusLine(
      {
        kind: 'worktree',
        worktree: { sessions: value.sessions },
        activityAt: value.activityAt,
      } as unknown as UnifiedWorkRow,
      now,
      0,
    )
  }
  if (sidebar.awaitingFirstPrompt) return 'awaiting first prompt'
  if (sidebar.statusFromChildren) {
    const { total, done, run, review, stall, block, wait } = sidebar.progress
    if (total === 0) return 'no active subtasks'
    const progress = `${done}/${total} ${total === 1 ? 'subtask' : 'subtasks'} done`
    if (done === total) return progress
    const next =
      block > 0
        ? `${block} blocked`
        : review > 0
          ? `${review} in review`
          : run > 0
            ? `${run} underway`
            : stall > 0
              ? `${stall} stalled`
              : wait > 0
                ? `${wait} to go`
                : null
    return next ? `${progress} · ${next}` : progress
  }
  if (value.decision === 'merge')
    return sidebar.mergeCommits > 0 ? `ready to merge · ${sidebar.mergeCommits}` : 'ready to merge'
  if (value.decision === 'review') return 'needs review'
  if (sidebar.continuation) return `${sidebar.continuation.kind} · ${sidebar.continuation.ref}`
  if (sidebar.issue.blocked) return 'blocked'
  return issueStatusLabel(
    sidebar.issue as unknown as Parameters<typeof issueStatusLabel>[0],
  ).toLowerCase()
}

export function mobileRowStamp(timing: MobileRowValues['timing'], now: number): string | null {
  if (timing.phase === 'done')
    return timing.totalMs !== undefined ? `∑ ${formatClock(timing.totalMs)}` : null
  if (!Number.isFinite(timing.sinceMs) || timing.sinceMs <= 0) return null
  if (timing.phase === 'working')
    return formatClock(Math.max(0, now - timing.sinceMs) + (timing.baseMs ?? 0))
  if (timing.phase === 'waiting') return relativeTime(new Date(timing.sinceMs).toISOString(), now)
  return null
}

/** The equality-filtered reader wakes React only if its displayed stamp changed. */
export function mobilePaintNow(pool: MobxPool): number {
  return pool.clock.trackedNow()
}

/** Search is opt-in work. Without a query the pool's stable native arrays go
 * straight to SectionList, and row payload changes never rebuild them. */
export function searchMobileSections(
  pool: MobxPool,
  sections: readonly string[],
  query: string,
  cache = new MobileSearchSections(),
): readonly MobileWorkSection[] {
  return cache.update(pool, sections, query)
}

function nativeSectionFields(pool: MobxPool, key: string, ordering: boolean): WorkSection {
  const row = mobileWorkView(pool).mobileSections().section(key)
  const collapsed = !ordering && row.collapsed
  return {
    key, label: row.label, kind: row.kind, total: ordering ? row.allIds.length : row.total,
    data: ordering ? row.allIds : row.data,
    snoozedIds: collapsed ? EMPTY_SECTION_IDS : row.snoozedIds,
    closedIds: collapsed ? EMPTY_SECTION_IDS : row.closedIds,
    foldKey: row.foldKey, collapsed,
  }
}
const EMPTY_SECTION_IDS: readonly string[] = Object.freeze([])
const sameSectionFields = (a: WorkSection, b: WorkSection) =>
  a.key === b.key && a.label === b.label && a.kind === b.kind && a.total === b.total &&
  a.data === b.data && a.snoozedIds === b.snoozedIds && a.closedIds === b.closedIds &&
  a.foldKey === b.foldKey && a.collapsed === b.collapsed

/** Matching is one shared title/ref id-set pass (POD-5561) plus one label
 * read per worktree; unchanged matches allocate no row array. A changed
 * match copies its lane only, keeping other native sections intact. No row
 * is painted here — painting happens per visible row in WorkListRow — so a
 * keystroke costs the short-string scan plus worktree label reads, never a
 * paint per candidate across bands, snoozed and closed. The kept bands
 * belong to one search over one pool: ending the search or a new pool
 * (another principal) drops them, so a screen holds one instance. */
export class MobileSearchSections {
  constructor(private readonly ordering = false) {}
  private readonly bands = new Map<string, MobileWorkSection>()
  private readonly sources = new Map<string, { source: WorkSection; native: MobileWorkSection }>()
  private nativeSources: readonly MobileWorkSection[] = []
  private native(pool: MobxPool, sections: readonly (WorkSection | string)[]): readonly MobileWorkSection[] {
    const active = new Set<string>()
    const next = sections.map(key => {
      // SectionList needs a descriptor object. Worklist retains only keys and
      // model fields; this UI boundary forms the native library's props.
      const source = typeof key === 'string' ? nativeSectionFields(pool, key, this.ordering) : key
      active.add(source.key)
      const old = this.sources.get(source.key)
      if (old && sameSectionFields(old.source, source)) return old.native
      const data = old && old.native.data.length === source.data.length && old.native.data.every((ref, index) => ref.id === source.data[index])
        ? old.native.data : source.data.map(id => ({ id,
        kind: pool.tables.worktree.has(id) ? 'worktree' as const : 'issue' as const,
        listKey: source.kind === 'attention' ? `needs-you:${id}` : id }))
      const native: MobileWorkSection = { ...source, data }
      this.sources.set(source.key, { source, native })
      return native
    })
    for (const key of this.sources.keys()) if (!active.has(key)) this.sources.delete(key)
    if (next.length !== this.nativeSources.length || next.some((section, index) => section !== this.nativeSources[index])) this.nativeSources = next
    return this.nativeSources
  }
  private previous: readonly MobileWorkSection[] = []
  private pool: MobxPool | null = null
  update(
    pool: MobxPool,
    sources: readonly (WorkSection | string)[],
    query: string,
  ): readonly MobileWorkSection[] {
    const sections = this.native(pool, sources)
    const needle = query.trim().toLowerCase()
    if (!needle || pool !== this.pool) {
      this.bands.clear()
      this.previous = []
      this.pool = pool
    }
    if (!needle) return sections
    // POD-5561: one shared title/ref pass over the feed-maintained short
    // lowercase strings, returning an id set. Tracked by the text revision,
    // so the keystroke projection re-runs on title/seq edits only — never
    // per row and never on the clock. The pass builds no fact objects and
    // reads no descriptions; status text is not searched locally.
    const textIds = pool.queries.localTextIds(needle)
    // Worktrees are not issues, so the shared set cannot cover them. Their
    // labels (`repo · branch`) are already short strings: one row read per
    // worktree, no paint, bounded by the worktree count rather than issues.
    const worktreeMatches = (ref: MobileWorkSection['data'][number]): boolean => {
      const value = mobileWorkView(pool).mobileRow({ id: ref.id, kind: 'worktree' })
      if (!value || typeof value === 'symbol') return false
      return value.title.toLowerCase().includes(needle)
    }
    const active = new Set<string>(),
      next: MobileWorkSection[] = []
    for (const source of sections) {
      active.add(source.key)
      const old = this.bands.get(source.key)
      const data = filteredNative(
        source.data,
        (ref) => (ref.kind === 'issue' ? textIds.has(ref.id) : worktreeMatches(ref)),
        old?.data,
        sameMobileRef,
      )
      const snoozedIds = filteredNative(source.snoozedIds, (id) => textIds.has(id), old?.snoozedIds)
      const closedIds = filteredNative(source.closedIds, (id) => textIds.has(id), old?.closedIds)
      const section =
        old &&
        old.data === data &&
        old.snoozedIds === snoozedIds &&
        old.closedIds === closedIds &&
        old.label === source.label &&
        old.kind === source.kind &&
        old.foldKey === source.foldKey &&
        old.collapsed === source.collapsed
          ? old
          : { ...source, data, snoozedIds, closedIds, total: data.length }
      this.bands.set(source.key, section)
      if (data.length + snoozedIds.length + closedIds.length > 0) next.push(section)
    }
    for (const key of this.bands.keys()) if (!active.has(key)) this.bands.delete(key)
    if (
      next.length !== this.previous.length ||
      next.some((section, index) => section !== this.previous[index])
    )
      this.previous = next
    return this.previous
  }
}

const sameMobileRef = (
  a: MobileWorkSection['data'][number],
  b: MobileWorkSection['data'][number],
) => a.id === b.id && a.kind === b.kind && a.listKey === b.listKey

function filteredNative<T>(
  source: readonly T[],
  matches: (value: T) => boolean,
  previous?: readonly T[],
  equal: (a: T, b: T) => boolean = (a, b) => a === b,
): readonly T[] {
  let next: T[] | undefined,
    count = 0
  for (const value of source)
    if (matches(value)) {
      if (!next && (!previous || count >= previous.length || !equal(previous[count]!, value)))
        next = previous?.slice(0, count) ?? []
      next?.push(value)
      count++
    }
  return next ?? (previous?.length === count ? previous : (previous?.slice(0, count) ?? []))
}

/** Native sections carry plain immutable arrays. Folding changes one section
 * object; unchanged bands and their data keep identity across publications. */
export class MobileNativeSections {
  private readonly folded = new Map<
    string,
    { source: MobileWorkSection; section: MobileWorkSection }
  >()
  private previous: readonly MobileWorkSection[] = []
  update(
    sections: readonly MobileWorkSection[],
    collapsed: ReadonlySet<string>,
    searching: boolean,
  ): readonly MobileWorkSection[] {
    const active = new Set<string>()
    const next = sections.map((source) => {
      active.add(source.key)
      if (searching || !collapsed.has(source.key)) return source
      let saved = this.folded.get(source.key)
      if (!saved || saved.source !== source) {
        saved = {
          source,
          section: { ...source, data: [], snoozedIds: [], closedIds: [], collapsed: true },
        }
        this.folded.set(source.key, saved)
      }
      return saved.section
    })
    for (const key of this.folded.keys()) if (!active.has(key)) this.folded.delete(key)
    if (
      next.length !== this.previous.length ||
      next.some((section, index) => section !== this.previous[index])
    )
      this.previous = next
    return this.previous
  }
}

export function worklistRowStatus(value: WorklistIssue | WorklistWorktree, now: number): string {
  const sidebar = 'issue' in value ? value : undefined
  if (!sidebar) {
    const tree = value as WorklistWorktree
    if (tree.visiblePhase === 'working')
      return `${tree.workingCount > 1 ? `${tree.workingCount} agents · ` : ''}working`
    if (tree.visiblePhase !== 'waiting')
      return `${tree.sessionCount > 1 ? `${tree.sessionCount} agents · ` : ''}${tree.visiblePhase === 'done' ? 'done' : 'idle'}`
    // The existing worktree formatter is pure and sees this roster alone.
    return rowStatusLine(
      {
        kind: 'worktree',
        worktree: { sessions: value.sessions },
        activityAt: value.activityAt,
      } as unknown as UnifiedWorkRow,
      now,
      0,
    )
  }
  if (sidebar.awaitingFirstPrompt) return 'awaiting first prompt'
  if (sidebar.showsChildProgress) {
    const parts = sidebar.progress
    if (typeof parts === 'symbol') return 'no active subtasks'
    const { total, done, run, review, stall, block, wait } = parts
    if (total === 0) return 'no active subtasks'
    const progress = `${done}/${total} ${total === 1 ? 'subtask' : 'subtasks'} done`
    if (done === total) return progress
    const next =
      block > 0
        ? `${block} blocked`
        : review > 0
          ? `${review} in review`
          : run > 0
            ? `${run} underway`
            : stall > 0
              ? `${stall} stalled`
              : wait > 0
                ? `${wait} to go`
                : null
    return next ? `${progress} · ${next}` : progress
  }
  if (sidebar.decision === 'merge')
    return sidebar.mergeCommits > 0 ? `ready to merge · ${sidebar.mergeCommits}` : 'ready to merge'
  if (sidebar.decision === 'review') return 'needs review'
  if (sidebar.continuation) return `${sidebar.continuation.kind} · ${sidebar.continuation.ref}`
  if (sidebar.issue.blocked) return 'blocked'
  return issueStatusLabel(
    sidebar.issue as unknown as Parameters<typeof issueStatusLabel>[0],
  ).toLowerCase()
}
