/** The real sidebar's section projection over resident pool indexes.
 * The small state argument is caller-owned per-user layout/selection data.
 * It is never read from worklistSlice, a selector, or browser storage here.
 */
import type { MobxPool } from '../pool'
import type { ModelHost } from '../models'
import type { SliceIssue, SliceSession, SliceWorktree } from '../shared/slice-types'
import { issueExcluded } from '../shared/schema'
import { overlayRow } from '../shared/overlay-row'
import { compareStructural, computed, type IComputedValue } from 'mobx'
import { LOADING, attentionGroup } from './rollup'
import { retains, retentionOf, type HiddenIssue } from './visible'
import { sortedSidebarSessions, type SidebarRowValues } from './sidebar-row'

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
  let pending = 0
  const candidates = [...host.rosterCandidates(path)]
  if (host.rosterColdPending(path)) {
    // Only a positive cold-lane summary reaches the old relation. No cold
    // id enters the resident roster index; pending seats queue one batch.
    for (const id of host.relations.many('worktree', path, 'sessions')) {
      if (host.hidden('session', id) !== undefined) candidates.push(id)
    }
  }
  for (const id of candidates) {
    const session = host.model('session', id)
    if (session === undefined) {
      // Reason about a historical seat from declared summaries. Only a seat
      // the summaries cannot rule out requests a batch; no cold id is indexed.
      const summary = host.hidden('session', id)
      const retention = retentionOf(summary as SliceSession | undefined)
      if (retention === null || !retention.seat) continue
      const owner = retention.issueId ? host.hidden('issue', retention.issueId) as HiddenIssue | undefined : undefined
      if (owner && (issueExcluded(owner) || (owner.flatUntil !== undefined && input.passed(owner.flatUntil)))) continue
      if (!owner && !retains(retention, undefined, undefined, input)) continue
      if (host.resident('session', id) === 'loading') pending += 1
      if (owner && retention.issueId) void host.resident('issue', retention.issueId)
      continue
    }
    const retention = session.retention
    if (retention === null || !retention.seat || retention.shell) continue
    const owner = session.issueLink === null ? undefined : input.issue(session.issueLink)
    if (owner?.standing?.excluded) continue
    const finish = retention.finish.kind === 'idleDone' && owner?.standing?.finished
      ? owner.ownFacts : undefined
    if (retains(retention, finish, owner?.standing, input)) ids.push(id)
  }
  return { ids, pending }
}

export class SidebarIndex {
  private seenSelected: string | null = null
  private readonly sectionViews = new WeakMap<SidebarState, IComputedValue<SidebarSections>>()
  constructor(private readonly pool: MobxPool) {}

  row(id: string): SidebarRowValues | typeof LOADING | undefined {
    const model = this.pool.issue(id)
    if (model !== undefined) return model.sidebar
    return this.pool.resident('issue', id) === 'loading' ? LOADING : undefined
  }

  /** Read never requests an evicted id. The caller clears selection through
   * its existing action when this answers true. A cold known row still counts. */
  selectionEvicted(): boolean {
    const id = this.pool.selection.keys().next().value ?? null
    if (id === null) return false
    const resident = this.pool.resident('issue', id)
    if (resident !== 'absent') { this.seenSelected = id; return false }
    if (this.seenSelected !== id) return false
    this.seenSelected = null
    return true
  }

  active(id: string, state: SidebarState): boolean {
    const model = this.pool.issue(id)
    if (model?.selected !== true) return false
    const row = model.sidebar
    return row !== undefined && row !== LOADING && (!row.draftAgentOnly || state.paneA === row.firstSessionId)
  }

  worktree(path: string, state: SidebarState = {}): SidebarWorktree | undefined {
    const lane = this.pool.row('worktree', path)
    if (lane === undefined || lane === LOADING) return undefined
    const sessions: SliceSession[] = []
    const issues = new Map<string, SliceIssue & { readonly displayRef: string }>()
    const roster = this.pool.model('worktree', path)?.roster
    if (roster === undefined || (!roster.ids.length && roster.pending === 0)) return undefined
    let activityAt = 0, pending = roster.pending
    for (const id of roster.ids) {
      const sessionModel = this.pool.model('session', id)
      const row = this.pool.row('session', id)
      if (row === LOADING) { pending += 1; continue }
      if (row === undefined || sessionModel === undefined) continue
      const session = row as SliceSession
      const owner = sessionModel.issueLink === null ? undefined : this.pool.knownIssue(sessionModel.issueLink)
      if (session.issueId && owner) {
        const raw = this.pool.row('issue', session.issueId)
        if (raw === LOADING) pending += 1
        else if (raw !== undefined) issues.set(session.issueId, overlayRow(raw as SliceIssue, { displayRef: this.pool.issue(session.issueId)!.displayRef }))
      }
      activityAt = Math.max(activityAt, Date.parse(session.lastActiveAt) || 0)
      if (session.status !== 'exited') sessions.push(session)
    }
    const sorted = sortedSidebarSessions(sessions, this.pool.inputs.reached)
    const candidates = sorted.filter(s => attentionGroup(s) !== 'working' && this.pool.inputs.passed((Date.parse(s.lastActiveAt) || 0) + 16 * 60 * 60 * 1000))
    const staleIds = new Set(sorted.length > 5 && candidates.length > 3 ? [...candidates].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)).slice(3).map(s => s.sessionId) : [])
    return { worktree: lane as SliceWorktree, sessions: sorted,
      visible: sorted.filter(s => !staleIds.has(s.sessionId)), stale: sorted.filter(s => staleIds.has(s.sessionId)),
      issues: [...issues.values()], activityAt, pending, active: this.pool.selection.size === 0 && state.selectedWorktree === path }
  }

  sections(state: SidebarState = EMPTY_STATE): SidebarSections {
    let view = this.sectionViews.get(state)
    if (!view) {
      view = computed(() => this.sectionValues(state), { name: 'pool.sidebar.sections', equals: compareStructural })
      this.sectionViews.set(state, view)
    }
    return view.get()
  }

  private sectionValues(state: SidebarState): SidebarSections {
    const pinnedIds = this.pool.groups.pinnedRootIds
    const bands = new Map<string, SidebarBand>()
    const index = this.pool.sidebarRosters
    const repos = [...index.projects].map(path => this.pool.row('worktree', path))
      .filter((row): row is SliceWorktree => row !== undefined && row !== LOADING)
      .filter(lane => state.pinnedRepos?.includes(lane.path) || index.unpinnedProjectLanes(lane.projectIndex, state.pinnedWorktrees ?? []) > 0).sort((a, b) => {
      const ap = state.pinnedRepos?.indexOf(a.path) ?? -1, bp = state.pinnedRepos?.indexOf(b.path) ?? -1
      if (ap >= 0 || bp >= 0) return ap >= 0 && bp >= 0 ? ap - bp : ap >= 0 ? -1 : 1
      return (a.projectIndex ?? 0) - (b.projectIndex ?? 0)
    })
    const add = (key: string, label: string, path: string, aliases: readonly string[] = [key]): SidebarBand => {
      const previous = bands.get(key)
      if (previous) return previous
      const foldKey = `podium:sidebar:project-fold:${key}`
      const snoozedFoldKey = `podium:sidebar:snoozed-fold:${key}`
      const closedFoldKey = `podium:sidebar:closed-fold:${key}`
      const band: SidebarBand = { key, label, aliases, repoPath: path, rowIds: [], worktreeIds: [], snoozedIds: [], closedIds: [],
        foldKey, snoozedFoldKey, closedFoldKey, collapsed: state.collapsed?.[foldKey] === true,
        snoozedCollapsed: state.collapsed?.[snoozedFoldKey] !== false,
        closedCollapsed: state.collapsed?.[closedFoldKey] !== false, startFirstTask: true }
      bands.set(key, band)
      return band
    }
    for (const repo of repos) add(repo.repoId ?? repo.repoPath, repo.repoName, repo.repoPath, repo.projectAliases ?? [repo.repoId ?? repo.repoPath, repo.path])
    for (const key of this.pool.groups.keys) {
      const group = this.pool.groups.group(key)
      const { rowIds, snoozedIds, closedIds } = group.sidebarRows
      if (!rowIds.length && !snoozedIds.length && !closedIds.length) continue
      const label = group.sidebarMetadata.label
      // A registered root was seeded above. Otherwise legacy uses the first
      // open issue's path, then the key; folded rows never supply this path.
      const firstOpen = rowIds[0]
      const path = firstOpen === undefined ? key : this.pool.groups.placementOf(firstOpen)?.repoPath ?? key
      const band = add(key, label, path)
      bands.set(key, { ...band, label, rowIds, snoozedIds, closedIds, startFirstTask: false })
    }
    for (const key of index.keys()) {
      const roster = index.band(key)
      if (!roster.ids.length) continue
      const band = add(key, roster.label, roster.repoPath)
      bands.set(key, { ...band, worktreeIds: roster.ids, startFirstTask: false })
    }
    const base = [...bands.values()]
    const registered = new Set(repos.map(repo => repo.repoId ?? repo.repoPath))
    base.sort((a, b) => registered.has(a.key) && registered.has(b.key) ? 0 : registered.has(a.key) ? -1 : registered.has(b.key) ? 1 : a.key.localeCompare(b.key))
    const remaining = new Set(base)
    const ordered: SidebarBand[] = []
    for (const saved of state.projectOrder ?? []) {
      const band = base.find(item => remaining.has(item) && item.aliases.includes(saved))
      if (band) { ordered.push(band); remaining.delete(band) }
    }
    for (const band of base) if (remaining.has(band)) ordered.push(band)
    return { pinnedIds, bands: ordered, pinnedFoldKey: 'podium:sidebar:pinned-fold', pinnedCollapsed: state.collapsed?.['podium:sidebar:pinned-fold'] === true }
  }
}

const EMPTY_STATE: SidebarState = Object.freeze({})
