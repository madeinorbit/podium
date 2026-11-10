import { machinePathKey, machinePathsEqual } from '@podium/model/browser'
import { here } from '../lookup'
import { worklistGroups } from './groups'
import { projectIndex } from './projects'
/** The real sidebar's section projection over resident pool indexes.
 * The small state argument is caller-owned per-user layout/selection data.
 * It is never read from worklistSlice, a selector, or browser storage here.
 */

import { compareShallow, compareStructural } from 'mobx'
import { keyedViews } from '../cached'
import { hostOf, type IssueModel, type UserPreferencesModel } from '../models'
import type { MobxPool } from '../pool'
import { WorklistIssue } from './issue'
import { LOADING, type Loaded } from './rollup'
import type { SidebarProgress } from './sidebar-row'
import { type Worklist, worklistView } from './view-model'

export interface SidebarState {
  readonly projectOrder?: readonly string[]
  readonly projectSort?: UserPreferencesModel['sidebar']['repoSort']
  readonly pinnedRepos?: readonly string[]
  readonly pinnedWorktrees?: readonly string[]
  readonly collapsed?: Readonly<Record<string, boolean>>
}
export interface SidebarBand {
  readonly key: string
  readonly label: string
  readonly aliases: readonly string[]
  readonly repoPath: string
  /** The registered repository this band shows, when it is one (POD-2153). */
  readonly repoId?: string | null
  readonly rowIds: readonly string[]
  readonly snoozedIds: readonly string[]
  readonly closedIds: readonly string[]
  readonly collapsed: boolean
  readonly snoozedCollapsed: boolean
  readonly closedCollapsed: boolean
  readonly foldKey: string
  readonly snoozedFoldKey: string
  readonly closedFoldKey: string
}
export interface SidebarSections {
  readonly pinnedIds: readonly string[]
  readonly pinnedCollapsed: boolean
  readonly pinnedFoldKey: string
  readonly bands: readonly SidebarBand[]
}
function companionOf(model: IssueModel | WorklistIssue, pool: MobxPool): WorklistIssue {
  return model instanceof WorklistIssue ? model : worklistView(pool).row(model)
}
const EMPTY_IDS: readonly string[] = Object.freeze([])

export function sidebarBelowOf(issue: WorklistIssue, pool: MobxPool): readonly string[] {
  const ids: string[] = []
  const host = issue.worklist.host
  for (const id of pool.graph.many('issue', issue.id, 'treeChildren')) {
    const child = host.visibleInputs.issue(id)
    if (!child) continue
    if (child.present) ids.push(id)
    else ids.push(...(child as WorklistIssue).visibleChildIds)
  }
  return ids.length === 0 ? EMPTY_IDS : ids.sort()
}

/** The visible children a row nests: those whose nest parent it is. Only a
 * real `parentId` nests a task; the session that started one never does. */
export function sidebarNestedOf(issue: WorklistIssue): readonly string[] {
  if (!issue.present) return EMPTY_IDS
  const host = issue.worklist.host
  const ids: string[] = []
  for (const id of issue.visibleChildIds) {
    const child = host.visibleInputs.issue(id)
    if (child && child.nestParent === issue.id) ids.push(id)
  }
  return ids.length === 0 ? EMPTY_IDS : ids.sort()
}

export function sidebarNested(model: IssueModel | WorklistIssue, pool: MobxPool) {
  return companionOf(model, pool).visibleDescendantIds
}
export function sidebarOwnAttention(model: IssueModel | WorklistIssue, pool: MobxPool) {
  return companionOf(model, pool).ownAttention
}
export function sidebarAttention(model: IssueModel | WorklistIssue, pool: MobxPool) {
  return companionOf(model, pool).visibleAttention
}
export function sidebarSeatActivity(model: IssueModel | WorklistIssue, pool: MobxPool) {
  return companionOf(model, pool).visibleSessionActivity
}
export function sidebarActivityAt(model: IssueModel | WorklistIssue, pool: MobxPool) {
  return companionOf(model, pool).visibleActivityAt
}

/** Compatibility records borrow narrow fields, storing no answers. */
export function sidebarIssueRow(
  model: IssueModel | WorklistIssue,
  pool: MobxPool,
): Loaded<WorklistIssue> {
  const row = companionOf(model, pool)
  return row.ready === 'ready' ? row : row.ready
}
export function sidebarValues(
  model: IssueModel | WorklistIssue,
  pool: MobxPool,
): Loaded<WorklistIssue> {
  const row = companionOf(model, pool)
  return row.ready === 'ready' ? row : row.ready
}
export function sidebarIssueProgress(
  model: IssueModel | WorklistIssue,
): SidebarProgress | typeof LOADING {
  return model instanceof WorklistIssue
    ? model.progress
    : worklistView(hostOf(model) as MobxPool).row(model).progress
}

/** Compatibility adapter; the worklist owns the shared section queries. */
export function sidebarView(pool: MobxPool): SidebarIndex {
  return worklistView(pool).desktop
}

export class SidebarIndex {
  /** Views by layout value (`layoutKey`), each released when unobserved. */
  private readonly sectionViews = keyedViews<SidebarSections>(
    'pool.sidebar',
    'sections',
    sameSections,
  )
  // These projections assemble new arrays and records from the same lane facts.
  private readonly specViews = keyedViews<BandSpecs>('pool.sidebar', 'bandSpecs', compareStructural)
  private readonly bandViews = keyedViews<SidebarBand>('pool.sidebar', 'band', sameBand)
  private readonly activityViews = keyedViews<number>('pool.sidebar', 'projectActivity', Object.is)
  private readonly groupViews = keyedViews<GroupFacts>('pool.sidebar', 'group', compareStructural)
  private get pool() {
    return this.view.pool
  }
  constructor(private readonly view: Worklist) {}

  row(id: string): WorklistIssue | typeof LOADING | undefined {
    const model = here(this.pool.issue(id))
    if (model !== undefined) return sidebarIssueRow(model, this.pool)
    return this.pool.resident('issue', id) === 'loading' ? LOADING : undefined
  }

  /** Read never requests an evicted id. The caller clears selection through
   * its existing action when this answers true. A cold known row still counts. */
  selectionGone(): boolean {
    return this.view.selectionGone
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
      pinnedIds: worklistGroups(this.pool).pinnedRootIds,
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
      const group = worklistGroups(this.pool).group(key)
      const rowIds = group.sidebarRowIds,
        snoozedIds = group.sidebarSnoozedIds,
        closedIds = group.sidebarClosedIds
      const firstOpen = rowIds[0]
      // The group's logical repo, from its issues: two repos can share a path,
      // and only one of them seeds a root lane there (POD-2153).
      const member = firstOpen ?? snoozedIds[0] ?? closedIds[0]
      const issue = member === undefined ? undefined : here(this.pool.model('issue', member))
      return {
        repoId: issue?.repoId ?? null,
        shown: rowIds.length > 0 || snoozedIds.length > 0 || closedIds.length > 0,
        label: group.sidebarMetadata.label,
        // Legacy uses the first open issue's path, then the key; folded rows
        // never supply this path.
        path:
          firstOpen === undefined
            ? key
            : (worklistGroups(this.pool).placementOf(firstOpen)?.repoPath ?? key),
      }
    })
  }

  /** One shared activity answer per project; unrelated projects keep their cache. */
  private projectActivity(key: string): number {
    return this.activityViews(key, () => {
      let latest = 0
      for (const id of worklistGroups(this.pool).members.lane(key)) {
        const row = this.row(id)
        if (row !== undefined && row !== LOADING) latest = Math.max(latest, row.visibleActivityAt)
      }
      return latest
    })
  }

  private specValues(state: SidebarState): BandSpecs {
    const repos = projectIndex(this.pool).registered(state)
    const specs = new Map<string, BandSpec>()
    const add = (
      key: string,
      label: string,
      path: string,
      aliases: readonly string[] = [key],
      repoId: string | null = null,
    ): BandSpec => {
      const previous = specs.get(key)
      if (previous) return previous
      const spec: BandSpec = { key, label, aliases, repoPath: path, repoId, group: false }
      specs.set(key, spec)
      return spec
    }
    for (const repo of repos)
      add(
        repo.repoId ?? machinePathKey(repo.repoPath),
        // The lane model's name: the server's `repo.name` when known (POD-6246).
        here(this.pool.model('worktree', repo.path))?.repoName || repo.repoName,
        repo.repoPath,
        repo.projectAliases ?? [repo.repoId ?? repo.repoPath, repo.path],
        repo.repoId ?? null,
      )
    for (const key of worklistGroups(this.pool).keys) {
      const facts = this.groupFacts(key)
      if (!facts.shown) continue
      // A registered root was seeded above; its path stays.
      const spec = add(key, facts.label, facts.path, [key], facts.repoId)
      specs.set(key, {
        ...spec,
        label: facts.label,
        repoId: spec.repoId ?? facts.repoId,
        group: true,
      })
    }
    const base = [...specs.values()]
    const registered = new Set(repos.map((repo) => repo.repoId ?? machinePathKey(repo.repoPath)))
    base.sort((a, b) =>
      registered.has(a.key) && registered.has(b.key)
        ? 0
        : registered.has(a.key)
          ? -1
          : registered.has(b.key)
            ? 1
            : a.key.localeCompare(b.key),
    )
    let ordered: BandSpec[]
    if (state.projectSort === 'alphabetical' || state.projectSort === 'lastUsed') {
      const activity =
        state.projectSort === 'lastUsed'
          ? new Map(base.map((band) => [band.key, this.projectActivity(band.key)]))
          : undefined
      const pinAt = (band: BandSpec) =>
        state.pinnedRepos?.findIndex((pin) =>
          band.aliases.some((alias) => machinePathsEqual(alias, pin)),
        ) ?? -1
      ordered = base.sort((a, b) => {
        const ap = pinAt(a),
          bp = pinAt(b)
        if (ap >= 0 || bp >= 0) return ap >= 0 && bp >= 0 ? ap - bp : ap >= 0 ? -1 : 1
        return (
          (activity?.get(b.key) ?? 0) - (activity?.get(a.key) ?? 0) ||
          a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) ||
          a.key.localeCompare(b.key)
        )
      })
    } else {
      const remaining = new Set(base)
      ordered = []
      for (const saved of state.projectOrder ?? []) {
        const band = base.find(
          (item) =>
            remaining.has(item) && item.aliases.some((alias) => machinePathsEqual(alias, saved)),
        )
        if (band) {
          ordered.push(band)
          remaining.delete(band)
        }
      }
      for (const band of base) if (remaining.has(band)) ordered.push(band)
    }
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
    const rows = spec.group ? worklistGroups(this.pool).group(band) : undefined
    return {
      key: band,
      label: spec.label,
      aliases: spec.aliases,
      repoPath: spec.repoPath,
      repoId: spec.repoId,
      rowIds: rows?.sidebarRowIds ?? NO_IDS,
      snoozedIds: rows?.sidebarSnoozedIds ?? NO_IDS,
      closedIds: rows?.sidebarClosedIds ?? NO_IDS,
      foldKey,
      snoozedFoldKey,
      closedFoldKey,
      collapsed: state.collapsed?.[foldKey] === true,
      snoozedCollapsed: state.collapsed?.[snoozedFoldKey] !== false,
      closedCollapsed: state.collapsed?.[closedFoldKey] !== false,
    }
  }
}

interface BandSpec {
  readonly key: string
  readonly label: string
  readonly aliases: readonly string[]
  readonly repoPath: string
  readonly repoId: string | null
  /** It holds the group's root rows. */
  readonly group: boolean
}
interface BandSpecs {
  readonly order: readonly string[]
  readonly byKey: Readonly<Record<string, BandSpec>>
}
interface GroupFacts {
  readonly shown: boolean
  readonly repoId: string | null
  readonly label: string
  readonly path: string
}

const NO_IDS: readonly string[] = Object.freeze([])

/** The layout fields the sections read, as one value: equal layouts, one key. */
function layoutKey(state: SidebarState): string {
  return JSON.stringify([
    state.projectOrder ?? null,
    state.projectSort ?? null,
    state.pinnedRepos ?? null,
    state.pinnedWorktrees ?? null,
    state.collapsed ?? null,
  ])
}

/** Specs rebuild aliases when another band changes. Compare that small layout
 * list by value; persistent membership lists still compare by identity. */
function sameBand(previous: SidebarBand, next: SidebarBand): boolean {
  for (const field of Object.keys(previous) as (keyof SidebarBand)[]) {
    if (field === 'aliases') {
      if (!compareShallow(previous.aliases, next.aliases)) return false
    } else if (previous[field] !== next[field]) return false
  }
  return true
}

/** The bands by identity (each band keeps its object while equal), the rest by value. */
function sameSections(a: SidebarSections, b: SidebarSections): boolean {
  return (
    a.pinnedCollapsed === b.pinnedCollapsed &&
    a.pinnedFoldKey === b.pinnedFoldKey &&
    a.pinnedIds === b.pinnedIds &&
    a.bands.length === b.bands.length &&
    a.bands.every((band, at) => band === b.bands[at])
  )
}

const EMPTY_STATE: SidebarState = Object.freeze({})
