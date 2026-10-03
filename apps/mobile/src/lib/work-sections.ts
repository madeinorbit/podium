import {
  formatClock,
  deriveGitStamp,
  FLEET_KIND_LIMIT,
  rowStatusLine,
  rowWaitingCount,
  type UnifiedIssueRow,
  type UnifiedWorkGroup,
  type UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import { relativeTime } from '@podium/client-core/focus'
import type { MobileRowValues } from '@podium/client-graph/worklist/mobile-row'
import type { MobileWorkSection } from '@podium/client-graph/worklist/mobile'
import type { MobxPool } from '@podium/client-graph/pool'
import { issueStatusLabel, type IssueGitState } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'

/**
 * THE WORK TAB'S SECTION PROJECTION — pinned first, then the asks, then the
 * project bands [POD-338, POD-724].
 *
 * The rows come from the published worklist slice the desktop sidebar reads
 * (POD-331); this module only decides which BAND each row appears in and in
 * what band order. Source order inside every band is preserved, and reordering
 * still writes in the original pinned/project scope (`orderingSections`).
 *
 * PINNED LEADS. Pinning is the operator's own "this stays under my thumb", so
 * the band sits above even Needs You — and a pinned row NEVER leaves it. The
 * screen used to lift a pinned row that started asking into Needs You, which
 * made the one deliberately-placed row jump bands exactly when the operator
 * was about to look for it.
 *
 * A PINNED ASK APPEARS IN BOTH BANDS. Round 2's deliberate exception to "one
 * row per mission": Needs You is the complete answer to "where am I needed",
 * and a pinned ask missing from it made the count and the band disagree. So a
 * waiting pinned row keeps its place in Pinned AND renders again in Needs You;
 * the second copy carries a distinct {@link workRowListKey} so the flattened
 * SectionList never sees two children under one key, and both copies get the
 * full attention treatment because the tint, count and Answer/Review action all
 * key off `rowWaitingCount`, not the band.
 *
 * NEEDS YOU still lifts every OTHER asking row out of its project band: on a
 * phone the whole point of the tab is "where am I needed", and a screen of
 * project bands buries that answer below the fold.
 */

/** A worklist row as this screen's SectionList renders it. `listKey` is set
 *  only on the SECOND rendering of a row that appears in two bands (a pinned
 *  ask duplicated into Needs You); the first keeps its canonical identity. */
export type WorkListRow = UnifiedWorkRow & { listKey?: string }

/** The row's canonical identity — issue id or worktree path. Shared by the
 *  loader/press plumbing so both copies of a duplicated row light up together. */
export function workRowId(row: UnifiedWorkRow): string {
  return row.kind === 'issue' ? row.issue.id : row.worktree.path
}

/** The SectionList key: unique across the WHOLE list even when one issue
 *  renders in two bands, because the list flattens its sections. */
export function workRowListKey(row: WorkListRow): string {
  return row.listKey ?? workRowId(row)
}

export interface WorkSection {
  /** Stable band id — also the fold-key suffix (see {@link workGroupFoldKey}). */
  key: string
  label: string
  kind: 'pinned' | 'attention' | 'project'
  /** Rows the band WOULD show — the header's count, independent of the fold. */
  total: number
  data: WorkListRow[]
  snoozedRows: UnifiedIssueRow[]
  closedRows: UnifiedIssueRow[]
}

export interface WorkSectionSplit {
  /** The bands the list renders, in band order, empty bands dropped. */
  sections: WorkSection[]
  /**
   * Reorder scope per band: pinned and every project group with their FULL row
   * sets — including asks the visible list lifted out — because fractional
   * `sortKey` patches only mean anything in the row's original scope
   * [POD-168]. Needs You is a projection, not a scope, so it has no entry.
   */
  orderingSections: WorkSection[]
  issueCount: number
  pinnedCount: number
  /** Every row waiting on the human, WHEREVER it is banded — the subtitle's
   *  "N NEED YOU" must not shrink just because an ask is pinned. */
  attentionCount: number
}

function section(input: Omit<WorkSection, 'total'>): WorkSection {
  return { ...input, total: input.data.length }
}

/** Split the published worklist into the phone's bands. Pure — one derivation
 *  per snapshot, so the header counts and the list can never disagree. */
export function buildWorkSections(
  pinned: readonly UnifiedWorkRow[],
  groups: readonly UnifiedWorkGroup[],
): WorkSectionSplit {
  const sections: WorkSection[] = []
  const ordering: WorkSection[] = []
  if (pinned.length > 0) {
    const band = section({
      key: 'pinned',
      label: 'Pinned',
      kind: 'pinned',
      data: [...pinned],
      snoozedRows: [],
      closedRows: [],
    })
    sections.push(band)
    ordering.push(band)
  }
  // Pinned asks lead the band — they are the rows the operator deliberately
  // placed — as SECOND renderings under a band-scoped list key (see the module
  // note). The group asks keep their canonical identity and source order.
  const pinnedAsks: WorkListRow[] = pinned
    .filter((row) => rowWaitingCount(row) > 0)
    .map((row) => ({ ...row, listKey: `needs-you:${workRowId(row)}` }))
  const attentionRows: WorkListRow[] = [
    ...pinnedAsks,
    ...groups.flatMap((group) => group.rows).filter((row) => rowWaitingCount(row) > 0),
  ]
  if (attentionRows.length > 0) {
    sections.push(
      section({
        key: 'needs-you',
        label: 'Needs you',
        kind: 'attention',
        data: attentionRows,
        snoozedRows: [],
        closedRows: [],
      }),
    )
  }
  for (const group of groups) {
    if (group.rows.length + group.snoozedRows.length + group.closedRows.length === 0) continue
    const live = group.rows.filter((row) => rowWaitingCount(row) === 0)
    const band = section({
      key: group.key,
      label: group.label,
      kind: 'project',
      data: live,
      snoozedRows: group.snoozedRows,
      closedRows: group.closedRows,
    })
    ordering.push({ ...band, data: [...group.rows], total: group.rows.length })
    if (live.length + group.snoozedRows.length + group.closedRows.length > 0) {
      sections.push(band)
    }
  }
  const open = [...pinned, ...groups.flatMap((group) => group.rows)]
  return {
    sections,
    orderingSections: ordering,
    issueCount: open.filter((row) => row.kind === 'issue').length,
    pinnedCount: pinned.length,
    attentionCount: open.filter((row) => rowWaitingCount(row) > 0).length,
  }
}

/**
 * Fold state for one Work band, spelled into the ALREADY-CLASSIFIED
 * `podium:sidebar:` namespace — see `./fold-keys.ts` for why: the ui-state
 * classifier is default-closed and THROWS on an unregistered key, and this
 * spelling routes to the per-user replicated `sidebar.section.*` family, so a
 * band folded on the couch is folded at the desk too. The suffix is the
 * section key (`pinned`, `needs-you`, or the group's repo key), the same
 * suffix the Snoozed/Closed fold keys already use.
 */
export const workGroupFoldKey = (sectionKey: string): string =>
  `podium:sidebar:work-group-fold:${sectionKey}`

/**
 * Apply the operator's folds: a collapsed band keeps its header (and therefore
 * its count) and drops its rows AND its Snoozed/Closed disclosures —
 * compression, not concealment. An active search overrides every fold: "no
 * matching work" because the match sat in a folded band is a lie the operator
 * cannot diagnose.
 */
export function foldWorkSections(
  sections: readonly WorkSection[],
  collapsedKeys: ReadonlySet<string>,
  searching: boolean,
): WorkSection[] {
  if (searching) return [...sections]
  return sections.map((band) =>
    collapsedKeys.has(band.key) ? { ...band, data: [], snoozedRows: [], closedRows: [] } : band,
  )
}

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
 * A changed match copies its lane only, keeping other native sections intact. */
export class MobileSearchSections {
  private readonly bands = new Map<string, MobileWorkSection>()
  private previous: readonly MobileWorkSection[] = []
  update(pool: MobxPool, sections: readonly MobileWorkSection[], query: string): readonly MobileWorkSection[] {
    const needle = query.trim().toLowerCase()
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
