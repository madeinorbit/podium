import { relativeTime } from '@podium/client-core/focus'
import { formatClock } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph/pool'
import { mapQueryResult } from '@podium/client-graph/query-result'
import { worklistGroups } from '@podium/client-graph/worklist/groups'
import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import type { MobileWorkRef, MobileWorkSection as WorkSection } from '@podium/client-graph/worklist/mobile'
import { mobileWorkView } from '@podium/client-graph/worklist/mobile'
export type MobileWorkSection = Omit<WorkSection, 'data'> & { readonly data: readonly MobileWorkRef[] }

import type { SidebarTiming } from '@podium/client-graph/worklist/sidebar-row'
import { issueLanding, issueStatusLabel } from '@podium/model'

/** Fold keys keep the existing replicated sidebar namespace. */
export const workGroupFoldKey = (sectionKey: string): string =>
  `podium:sidebar:work-group-fold:${sectionKey}`

/** The web row's `Landed · <branch> · <sha>` in the phone's lower-case grammar (POD-2151). */
function landedStatus(issue: object): string | null {
  const landing = issueLanding(issue as unknown as Parameters<typeof issueLanding>[0])
  return landing ? ['landed', landing.branch, landing.sha].filter(Boolean).join(' · ') : null
}

export function mobileRowStamp(timing: SidebarTiming, now: number): string | null {
  if (timing.phase === 'done')
    return timing.totalMs !== undefined ? `∑ ${formatClock(timing.totalMs)}` : null
  if (!Number.isFinite(timing.sinceMs) || timing.sinceMs <= 0) return null
  if (timing.phase === 'working')
    return formatClock(Math.max(0, now - timing.sinceMs) + (timing.baseMs ?? 0))
  if (timing.phase === 'waiting') return relativeTime(new Date(timing.sinceMs).toISOString(), now)
  return null
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

/** Matching is one shared title/ref id-set pass (POD-5561); unchanged
 * matches allocate no row array. A changed match copies its lane only,
 * keeping other native sections intact. No row is painted here — painting
 * happens per visible row in WorkListRow — so a keystroke costs the
 * short-string scan, never a paint per candidate across bands, snoozed and
 * closed. The kept bands
 * belong to one search over one pool: ending the search or a new pool
 * (another principal) drops them, so a screen holds one instance. */
export class MobileSearchSections {
  constructor(private readonly ordering = false) {}
  private readonly bands = new Map<string, MobileWorkSection>()
  private readonly sources = new Map<string, { source: WorkSection; native: MobileWorkSection; pinnedIds: readonly string[] }>()
  private nativeSources: readonly MobileWorkSection[] = []
  private native(pool: MobxPool, sections: readonly (WorkSection | string)[]): readonly MobileWorkSection[] {
    const active = new Set<string>()
    const next = sections.map(key => {
      // SectionList needs a descriptor object. Worklist retains only keys and
      // model fields; this UI boundary forms the native library's props.
      const source = typeof key === 'string' ? nativeSectionFields(pool, key, this.ordering) : key
      active.add(source.key)
      const old = this.sources.get(source.key)
      // Pinned attention rows also remain in Pinned and keep their distinct
      // list key. Project attention rows keep the original record key.
      const pinnedIds = source.kind === 'attention'
        ? mobileWorkView(pool).mobileSections().pinned.openIds : EMPTY_SECTION_IDS
      if (old && old.pinnedIds === pinnedIds && sameSectionFields(old.source, source)) return old.native
      const data = mapQueryResult(source.data, id => ({ id,
        listKey: source.kind === 'attention' && worklistGroups(pool).placementOf(id)?.pinned ? `needs-you:${id}` : id }))
      const native: MobileWorkSection = { ...source, data }
      this.sources.set(source.key, { source, native, pinnedIds })
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
    const active = new Set<string>(),
      next: MobileWorkSection[] = []
    for (const source of sections) {
      active.add(source.key)
      const old = this.bands.get(source.key)
      const data = filteredNative(
        source.data,
        (ref) => textIds.has(ref.id),
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
) => a.id === b.id && a.listKey === b.listKey

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

export function worklistRowStatus(sidebar: WorklistIssue): string {
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
  const landed = landedStatus(sidebar.issue)
  if (landed) return landed
  return issueStatusLabel(
    sidebar.issue as unknown as Parameters<typeof issueStatusLabel>[0],
  ).toLowerCase()
}
