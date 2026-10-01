/** The real sidebar's section projection over resident pool indexes.
 * The small state argument is caller-owned per-user layout/selection data.
 * It is never read from worklistSlice, a selector, or browser storage here.
 */
import type { MobxPool } from '../pool'
import type { SliceIssue, SliceSession, SliceWorktree } from '../shared/slice-types'
import { LOADING, attentionGroup } from './rollup'
import { retains } from './visible'
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

export class SidebarIndex {
  private seenSelected: string | null = null
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
    let activityAt = 0, pending = 0, retained = false
    for (const id of this.pool.relations.many('worktree', path, 'sessions')) {
      const sessionModel = this.pool.model('session', id)
      const row = this.pool.row('session', id)
      if (row === LOADING) { pending += 1; continue }
      if (row === undefined || sessionModel === undefined) continue
      const session = row as SliceSession
      const retention = sessionModel.retention
      if (retention === null || !retention.seat || retention.shell) continue
      const owner = sessionModel.issueLink === null ? undefined : this.pool.knownIssue(sessionModel.issueLink)
      if (owner?.standing?.excluded) continue
      // A present mission already accounts for its retained seats, even when
      // the member exited and therefore no longer draws in the roster.
      if (owner?.placed && owner.retainedSeatIds.includes(id)) continue
      if (session.issueId == null && [...this.pool.relations.many('worktree', path, 'issues')].some(issueId => {
        const issue = this.pool.knownIssue(issueId)
        return issue?.placed && issue.retainedSeatIds.includes(id)
      })) continue
      const issue = owner?.ownFacts.issue
      if (!retains(retention, issue, owner?.standing, this.pool.visibleInputs)) continue
      retained = true
      if (session.issueId && owner) {
        const raw = this.pool.row('issue', session.issueId)
        if (raw === LOADING) pending += 1
        else if (raw !== undefined) issues.set(session.issueId, { ...(raw as SliceIssue), displayRef: this.pool.issue(session.issueId)!.displayRef })
      }
      activityAt = Math.max(activityAt, Date.parse(session.lastActiveAt) || 0)
      if (session.status !== 'exited') sessions.push(session)
    }
    if (!retained && pending === 0) return undefined
    const sorted = sortedSidebarSessions(sessions, this.pool.inputs.reached)
    const candidates = sorted.filter(s => attentionGroup(s) !== 'working' && this.pool.inputs.passed((Date.parse(s.lastActiveAt) || 0) + 16 * 60 * 60 * 1000))
    const staleIds = new Set(sorted.length > 5 && candidates.length > 3 ? [...candidates].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)).slice(3).map(s => s.sessionId) : [])
    return { worktree: lane as SliceWorktree, sessions: sorted,
      visible: sorted.filter(s => !staleIds.has(s.sessionId)), stale: sorted.filter(s => staleIds.has(s.sessionId)),
      issues: [...issues.values()], activityAt, pending, active: this.pool.selection.size === 0 && state.selectedWorktree === path }
  }

  sections(state: SidebarState = {}): SidebarSections {
    const pinnedIds = this.pool.groups.pinnedIds.filter(id => this.pool.issue(id)?.nestParent === null)
    const bands = new Map<string, SidebarBand>()
    const lanes = [...this.pool.tables.worktree.keys()].map(id => this.pool.row('worktree', id)).filter((row): row is SliceWorktree => row !== undefined && row !== LOADING) as SliceWorktree[]
    const repos = lanes.filter(lane => lane.path === lane.repoPath && lane.projectRoot !== false &&
      (state.pinnedRepos?.includes(lane.path) || lanes.some(member => member.projectIndex === lane.projectIndex && !state.pinnedWorktrees?.includes(member.path)))).sort((a, b) => {
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
      const root = (id: string) => this.pool.issue(id)?.nestParent === null
      const ids = group.rowIds.filter(root), closedIds = group.closedIds.filter(root)
      if (!ids.length && !closedIds.length) continue
      const example = this.pool.issue(ids[0] ?? closedIds[0] ?? '')
      const band = add(key, group.label, example?.ownFacts.issue?.repoPath ?? key)
      const snoozedIds = ids.filter(id => this.pool.issue(id)?.band === 2)
      bands.set(key, { ...band, label: group.label, rowIds: ids.filter(id => this.pool.issue(id)?.band !== 2), snoozedIds, closedIds, startFirstTask: false })
    }
    for (const lane of lanes) {
      if (this.worktree(lane.path, state) === undefined) continue
      const key = lane.repoId ?? lane.repoPath
      const band = add(key, lane.repoName, lane.repoPath)
      bands.set(key, { ...band, worktreeIds: [...band.worktreeIds, lane.path].sort(), startFirstTask: false })
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
