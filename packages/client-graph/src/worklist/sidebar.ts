/** The real sidebar's section projection over resident pool indexes.
 * The small state argument is caller-owned per-user layout/selection data.
 * It is never read from worklistSlice, a selector, or browser storage here.
 */

import { compareStructural, observable, reaction } from 'mobx'
import { keyedViews } from '../cached'
import type { ModelHost } from '../models'
import type { MobxPool } from '../pool'
import { createRowOverlay } from '../shared/overlay-row'
import type { SliceIssue, SliceSession, SliceWorktree } from '../shared/slice-types'
import { attentionGroup, LOADING } from './rollup'
import { type SidebarRowValues, sortedSidebarSessions } from './sidebar-row'
import { retains } from './visible'

const overlayRow = createRowOverlay()

export interface SidebarState {
  readonly projectOrder?: readonly string[]
  readonly pinnedRepos?: readonly string[]
  readonly pinnedWorktrees?: readonly string[]
  readonly collapsed?: Readonly<Record<string, boolean>>
  readonly paneA?: string | null
  readonly selectedWorktree?: string | null
}
export interface SidebarBand {
  readonly key: string
  readonly label: string
  readonly aliases: readonly string[]
  readonly repoPath: string
  readonly rowIds: readonly string[]
  readonly worktreeIds: readonly string[]
  readonly snoozedIds: readonly string[]
  readonly closedIds: readonly string[]
  readonly collapsed: boolean
  readonly snoozedCollapsed: boolean
  readonly closedCollapsed: boolean
  readonly foldKey: string
  readonly snoozedFoldKey: string
  readonly closedFoldKey: string
  readonly startFirstTask: boolean
}
export interface SidebarSections {
  readonly pinnedIds: readonly string[]
  readonly pinnedCollapsed: boolean
  readonly pinnedFoldKey: string
  readonly bands: readonly SidebarBand[]
}
export interface SidebarWorktree {
  readonly worktree: SliceWorktree
  readonly sessions: readonly SliceSession[]
  readonly visible: readonly SliceSession[]
  readonly stale: readonly SliceSession[]
  /** The existing row's provenance/ref lookup needs only these owners,
   * never a copy of the issue world. Missing owners use session.displayRef. */
  readonly issues: readonly (SliceIssue & { readonly displayRef: string })[]
  readonly activityAt: number
  readonly active: boolean
  readonly pending: number
}

export interface SidebarRoster {
  readonly ids: readonly string[]
  readonly pending: number
}

/** One worktree's retained, unrepresented seats. Its existing model caches
 * this index from narrow session/owner facts; payload changes do not wake bands. */
export function sidebarRosterOf(host: ModelHost, path: string): SidebarRoster {
  const input = host.visibleInputs
  const ids: string[] = []
  const pending = 0
  // POD-5407: the candidates are resident seats only (`SidebarRosterIndex`):
  // a session the rule keeps cold can no longer be a retained seat.
  for (const id of host.rosterCandidates(path)) {
    const session = host.model('session', id)
    if (session === undefined) continue
    const retention = session.retention
    if (retention === null || !retention.seat || retention.shell) continue
    const owner = session.issueLink === null ? undefined : input.issue(session.issueLink)
    if (owner?.standing?.excluded) continue
    const finish =
      retention.finish.kind === 'idleDone' && owner?.standing?.finished ? owner.ownFacts : undefined
    if (retains(retention, finish, owner?.standing, input)) ids.push(id)
  }
  return { ids, pending }
}

export class SidebarIndex {
  private seenSelected: string | null = null
  private readonly evicted = observable.box(false)
  private readonly stopSelection: () => void
  /** Views by layout value (`layoutKey`), each released when unobserved. */
  private readonly sectionViews = keyedViews<SidebarSections>(
    'pool.sidebar',
    'sections',
    sameSections,
  )
  // These projections assemble new arrays and records from the same lane facts.
  private readonly specViews = keyedViews<BandSpecs>('pool.sidebar', 'bandSpecs', compareStructural)
  private readonly bandViews = keyedViews<SidebarBand>('pool.sidebar', 'band', compareStructural)
  private readonly groupViews = keyedViews<GroupFacts>('pool.sidebar', 'group', compareStructural)
  constructor(private readonly pool: MobxPool) {
    // Reaction effects run as actions. Selection history never changes during a render read.
    this.stopSelection = reaction(
      () => {
        const id = pool.selection.keys().next().value ?? null
        return { id, resident: id === null ? null : pool.resident('issue', id) }
      },
      ({ id, resident }) => {
        if (id !== this.seenSelected) this.seenSelected = null
        if (id !== null && resident !== 'absent') this.seenSelected = id
        this.evicted.set(id !== null && resident === 'absent' && this.seenSelected === id)
      },
      { fireImmediately: true, equals: compareStructural },
    )
  }

  dispose(): void {
    this.stopSelection()
  }

  row(id: string): SidebarRowValues | typeof LOADING | undefined {
    const model = this.pool.issue(id)
    if (model !== undefined) return model.sidebar
    return this.pool.resident('issue', id) === 'loading' ? LOADING : undefined
  }

  /** Read never requests an evicted id. The caller clears selection through
   * its existing action when this answers true. A cold known row still counts. */
  selectionEvicted(): boolean {
    return this.evicted.get()
  }

  active(id: string, state: SidebarState): boolean {
    const model = this.pool.issue(id)
    if (model?.selected !== true) return false
    const row = model.sidebar
    return (
      row !== undefined &&
      row !== LOADING &&
      (!row.draftAgentOnly || state.paneA === row.firstSessionId)
    )
  }

  worktree(path: string, state: SidebarState = {}): SidebarWorktree | undefined {
    const lane = this.pool.row('worktree', path)
    if (lane === undefined || lane === LOADING) return undefined
    const sessions: SliceSession[] = []
    const issues = new Map<string, SliceIssue & { readonly displayRef: string }>()
    const roster = this.pool.model('worktree', path)?.roster
    if (roster === undefined || (!roster.ids.length && roster.pending === 0)) return undefined
    let activityAt = 0,
      pending = roster.pending
    for (const id of roster.ids) {
      const sessionModel = this.pool.model('session', id)
      const row = this.pool.row('session', id)
      if (row === LOADING) {
        pending += 1
        continue
      }
      if (row === undefined || sessionModel === undefined) continue
      const session = row as SliceSession
      const owner =
        sessionModel.issueLink === null ? undefined : this.pool.knownIssue(sessionModel.issueLink)
      if (session.issueId && owner) {
        const raw = this.pool.row('issue', session.issueId)
        if (raw === LOADING) pending += 1
        else if (raw !== undefined)
          issues.set(
            session.issueId,
            overlayRow(raw as SliceIssue, {
              displayRef: this.pool.issue(session.issueId)!.displayRef,
            }),
          )
      }
      activityAt = Math.max(activityAt, Date.parse(session.lastActiveAt) || 0)
      if (session.status !== 'exited') sessions.push(session)
    }
    const sorted = sortedSidebarSessions(sessions, this.pool.inputs.reached)
    const candidates = sorted.filter(
      (s) =>
        attentionGroup(s) !== 'working' &&
        this.pool.inputs.passed((Date.parse(s.lastActiveAt) || 0) + 16 * 60 * 60 * 1000),
    )
    const staleIds = new Set(
      sorted.length > 5 && candidates.length > 3
        ? [...candidates]
            .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
            .slice(3)
            .map((s) => s.sessionId)
        : [],
    )
    return {
      worktree: lane as SliceWorktree,
      sessions: sorted,
      visible: sorted.filter((s) => !staleIds.has(s.sessionId)),
      stale: sorted.filter((s) => staleIds.has(s.sessionId)),
      issues: [...issues.values()],
      activityAt,
      pending,
      // The selection is read only for the selected worktree: a click
      // elsewhere wakes no other worktree row (POD-5423).
      active: state.selectedWorktree === path && this.pool.selection.size === 0,
    }
  }

  /**
   * The sections for a layout. POD-5423 (review finding 10): one view per
   * pool and layout VALUE (callers holding equal layouts share it, whatever
   * their objects), built from one cached band per key: a row changing lanes
   * re-runs its own band and this list of band references, never the other
   * bands, and the bands keep their identity when equal.
   */
  sections(state: SidebarState = EMPTY_STATE): SidebarSections {
    const key = layoutKey(state)
    return this.sectionViews(key, () => ({
      pinnedIds: this.pool.groups.pinnedRootIds,
      bands: this.specs(key, state).order.map((band) => this.bandOf(key, state, band)),
      pinnedFoldKey: 'podium:sidebar:pinned-fold',
      pinnedCollapsed: state.collapsed?.['podium:sidebar:pinned-fold'] === true,
    }))
  }

  /** TRACKED: the ordered band keys of a layout (re-run when a band appears, goes or is renamed). */
  bandKeys(state: SidebarState = EMPTY_STATE): readonly string[] {
    return this.specs(layoutKey(state), state).order
  }

  /** TRACKED: one band of a layout, or undefined when the layout shows no such band. */
  band(state: SidebarState, band: string): SidebarBand | undefined {
    const key = layoutKey(state)
    return this.specs(key, state).byKey[band] === undefined
      ? undefined
      : this.bandOf(key, state, band)
  }

  private bandOf(key: string, state: SidebarState, band: string): SidebarBand {
    return this.bandViews(`${key}\u0000${band}`, () => this.bandValue(key, state, band))
  }

  /** Which bands a layout shows, their order and their names: no lane contents. */
  private specs(key: string, state: SidebarState): BandSpecs {
    return this.specViews(key, () => this.specValues(state))
  }

  /** One group's facts the band list reads: never its rows (a lane move changes none of these). */
  private groupFacts(key: string): GroupFacts {
    return this.groupViews(key, () => {
      const group = this.pool.groups.group(key)
      const { rowIds, snoozedIds, closedIds } = group.sidebarRows
      const firstOpen = rowIds[0]
      return {
        shown: rowIds.length > 0 || snoozedIds.length > 0 || closedIds.length > 0,
        label: group.sidebarMetadata.label,
        // Legacy uses the first open issue's path, then the key; folded rows
        // never supply this path.
        path:
          firstOpen === undefined
            ? key
            : (this.pool.groups.placementOf(firstOpen)?.repoPath ?? key),
        folded: snoozedIds.length > 0 || closedIds.length > 0,
        headBand2: group.sidebarMetadata.headBand === 2,
      }
    })
  }

  private specValues(state: SidebarState): BandSpecs {
    const index = this.pool.sidebarRosters
    const repos = [...index.projects]
      .map((path) => this.pool.row('worktree', path))
      .filter((row): row is SliceWorktree => row !== undefined && row !== LOADING)
      .filter(
        (lane) =>
          state.pinnedRepos?.includes(lane.path) ||
          index.unpinnedProjectLanes(lane.projectIndex, state.pinnedWorktrees ?? []) > 0,
      )
      .sort((a, b) => {
        const ap = state.pinnedRepos?.indexOf(a.path) ?? -1,
          bp = state.pinnedRepos?.indexOf(b.path) ?? -1
        if (ap >= 0 || bp >= 0) return ap >= 0 && bp >= 0 ? ap - bp : ap >= 0 ? -1 : 1
        return (a.projectIndex ?? 0) - (b.projectIndex ?? 0)
      })
    const specs = new Map<string, BandSpec>()
    const add = (
      key: string,
      label: string,
      path: string,
      aliases: readonly string[] = [key],
    ): BandSpec => {
      const previous = specs.get(key)
      if (previous) return previous
      const spec: BandSpec = { key, label, aliases, repoPath: path, group: false, roster: false }
      specs.set(key, spec)
      return spec
    }
    for (const repo of repos)
      add(
        repo.repoId ?? repo.repoPath,
        repo.repoName,
        repo.repoPath,
        repo.projectAliases ?? [repo.repoId ?? repo.repoPath, repo.path],
      )
    for (const key of this.pool.groups.keys) {
      const facts = this.groupFacts(key)
      if (!facts.shown) continue
      // A registered root was seeded above; its path stays.
      const spec = add(key, facts.label, facts.path)
      specs.set(key, { ...spec, label: facts.label, group: true })
    }
    for (const key of index.keys()) {
      const roster = index.band(key)
      if (!roster.ids.length) continue
      const spec = add(key, roster.label, roster.repoPath)
      // The unified head names the section before folds: worktrees (band 1)
      // precede snoozed roots (band 2), even when a root is in the closed fold.
      const facts = spec.group ? this.groupFacts(key) : undefined
      const label = facts?.folded === true && facts.headBand2 ? roster.label : spec.label
      specs.set(key, { ...spec, label, roster: true })
    }
    const base = [...specs.values()]
    const registered = new Set(repos.map((repo) => repo.repoId ?? repo.repoPath))
    base.sort((a, b) =>
      registered.has(a.key) && registered.has(b.key)
        ? 0
        : registered.has(a.key)
          ? -1
          : registered.has(b.key)
            ? 1
            : a.key.localeCompare(b.key),
    )
    const remaining = new Set(base)
    const ordered: BandSpec[] = []
    for (const saved of state.projectOrder ?? []) {
      const band = base.find((item) => remaining.has(item) && item.aliases.includes(saved))
      if (band) {
        ordered.push(band)
        remaining.delete(band)
      }
    }
    for (const band of base) if (remaining.has(band)) ordered.push(band)
    return {
      order: ordered.map((spec) => spec.key),
      byKey: Object.fromEntries(ordered.map((spec) => [spec.key, spec])),
    }
  }

  /** One band's lanes and folds: re-run by its own group's or roster's change. */
  private bandValue(key: string, state: SidebarState, band: string): SidebarBand {
    const spec = this.specs(key, state).byKey[band] as BandSpec
    const foldKey = `podium:sidebar:project-fold:${band}`
    const snoozedFoldKey = `podium:sidebar:snoozed-fold:${band}`
    const closedFoldKey = `podium:sidebar:closed-fold:${band}`
    const rows = spec.group ? this.pool.groups.group(band).sidebarRows : undefined
    const worktreeIds = spec.roster ? this.pool.sidebarRosters.band(band).ids : NO_IDS
    return {
      key: band,
      label: spec.label,
      aliases: spec.aliases,
      repoPath: spec.repoPath,
      rowIds: rows?.rowIds ?? NO_IDS,
      worktreeIds,
      snoozedIds: rows?.snoozedIds ?? NO_IDS,
      closedIds: rows?.closedIds ?? NO_IDS,
      foldKey,
      snoozedFoldKey,
      closedFoldKey,
      collapsed: state.collapsed?.[foldKey] === true,
      snoozedCollapsed: state.collapsed?.[snoozedFoldKey] !== false,
      closedCollapsed: state.collapsed?.[closedFoldKey] !== false,
      startFirstTask: !spec.group && !spec.roster,
    }
  }
}

interface BandSpec {
  readonly key: string
  readonly label: string
  readonly aliases: readonly string[]
  readonly repoPath: string
  /** It holds the group's root rows. */
  readonly group: boolean
  /** It holds the roster's worktrees. */
  readonly roster: boolean
}
interface BandSpecs {
  readonly order: readonly string[]
  readonly byKey: Readonly<Record<string, BandSpec>>
}
interface GroupFacts {
  readonly shown: boolean
  readonly label: string
  readonly path: string
  readonly folded: boolean
  readonly headBand2: boolean
}

const NO_IDS: readonly string[] = Object.freeze([])

/** The layout fields the sections read, as one value: equal layouts, one key. */
function layoutKey(state: SidebarState): string {
  return JSON.stringify([
    state.projectOrder ?? null,
    state.pinnedRepos ?? null,
    state.pinnedWorktrees ?? null,
    state.collapsed ?? null,
  ])
}

/** The bands by identity (each band keeps its object while equal), the rest by value. */
function sameSections(a: SidebarSections, b: SidebarSections): boolean {
  return (
    a.pinnedCollapsed === b.pinnedCollapsed &&
    a.pinnedFoldKey === b.pinnedFoldKey &&
    compareStructural(a.pinnedIds, b.pinnedIds) &&
    a.bands.length === b.bands.length &&
    a.bands.every((band, at) => band === b.bands[at])
  )
}

const EMPTY_STATE: SidebarState = Object.freeze({})
