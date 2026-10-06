import { worklistGroups } from './groups'
import { keyedComputed } from '@podium/mobx-helpers'
import { debugName } from '../debug-name'
import { sidebarRosterView } from './sidebar-roster'
/** The real sidebar's section projection over resident pool indexes.
 * The small state argument is caller-owned per-user layout/selection data.
 * It is never read from worklistSlice, a selector, or browser storage here.
 */

import { compareStructural, observable, reaction } from 'mobx'
import { cachedGroup, keyedViews } from '../cached'
import { hostOf, type IssueModel, type ModelHost, type ModelOf, type SessionModel } from '../models'
import type { MobxPool } from '../pool'
import { createRowOverlay } from '../shared/overlay-row'
import type { SliceIssue, SliceSession, SliceWorktree } from '../shared/slice-types'
import { aggregate, attentionGroup, askingOf, phaseOf, LOADING, ownAttentionPartOf, ownFactsOf, seatVerdictOf, type Aggregate, type Loaded } from './rollup'
import { NO_SIDEBAR_SESSIONS, type SidebarProgress, type SidebarRowValues, sidebarLifecycle, sidebarTimingFromFacts, sortedSidebarSessions } from './sidebar-row'
import { nestParentPartOf, retains } from './visible'

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

/** Feed summaries stay inside derivation; the legacy navigation record never
 * carried them. The compatibility view borrows all other issue properties. */
const SIDEBAR_ISSUE_OMISSIONS = Object.freeze({ has: (key: PropertyKey) => key === 'sessionFacts' })

/** Sidebar demand has its own computations: asking for a drawn row must not
 * first fill the entity's history-wide attention and nesting payloads. */
function memo<V>(name: string, read: (issue: IssueModel, pool: MobxPool) => V) {
  return keyedComputed<IssueModel, V, [MobxPool]>(
    issue => debugName(() => `IssueModel@${issue.id}.sidebar.${name}`), read,
    { context: issue => issue },
  )
}

const EMPTY_IDS: readonly string[] = Object.freeze([])

const nestParent = cachedGroup('sidebar.parent', (issue: IssueModel) =>
  nestParentPartOf(hostOf(issue).visibleInputs, issue.id, issue.nestCandidate))
const lanePath = cachedGroup('sidebar.lanePath', (issue: IssueModel) => {
  const row = hostOf(issue).rollupInputs.loadedIssue(issue.id)
  return row === undefined || row === LOADING ? null : row.worktreePath ?? null
})
const below: (issue: IssueModel, pool: MobxPool) => readonly string[] = memo('below', (issue, pool): readonly string[] => {
  const ids: string[] = []
  const host = hostOf(issue)
  for (const id of pool.graph.many('issue', issue.id, 'treeChildren')) {
    const child = host.visibleInputs.issue(id)
    if (!child) continue
    if (child.present) ids.push(id)
    else ids.push(...below(child as IssueModel, pool))
  }
  return ids.length === 0 ? EMPTY_IDS : ids.sort()
})

/** The candidate set excludes archived senders before any iteration. The
 * nesting rule's ownerOf rejects them, including archived non-exited seats.
 * Unarchived exited senders and issueless lane members still contribute. */
export const sidebarNested = memo('nested', (issue, pool): readonly string[] => {
  if (!issue.present) return EMPTY_IDS
  const host = hostOf(issue)
  const ids = new Set<string>()
  for (const id of below(issue, pool)) {
    const child = host.visibleInputs.issue(id)
    if (child && nestParent(child as IssueModel) === issue.id) ids.add(id)
  }
  const startedBy = (sessionId: string) => {
    for (const id of pool.graph.many('session', sessionId, 'startedIssues')) {
      const child = host.visibleInputs.issue(id)
      if (child && nestParent(child as IssueModel) === issue.id) ids.add(id)
    }
  }
  for (const sessionId of pool.queries.ids({ kind: 'commandIssueSessions', issueId: issue.id,
    archived: false, includeShells: true })) {
    // Each child's canonical parent checks R2 ownership, headless exclusion
    // and resume collapse. Empty started relations need no ownership probe.
    startedBy(sessionId)
  }
  if (lanePath(issue)) {
    for (const sessionId of issue.laneMemberIds) {
      const session = host.visibleInputs.session(sessionId)
      if (session.retention !== null && !session.retention.archived) startedBy(sessionId)
    }
  }
  return ids.size === 0 ? EMPTY_IDS : [...ids].sort()
})

const seat = cachedGroup('sidebar.seat', (session: SessionModel) => {
  const raw = hostOf(session).row('session', session.id)
  return raw === LOADING || raw === undefined ? raw : seatVerdictOf(raw as SliceSession)
})
const facts = memo('facts', issue => ownFactsOf(hostOf(issue).rollupInputs.loadedIssue(issue.id)))

export const sidebarOwnAttention = memo('own', (issue, pool) => {
  const host = hostOf(issue)
  return ownAttentionPartOf({ ...host.rollupInputs,
    seat: id => seat(host.visibleInputs.session(id) as SessionModel),
  }, {
    get present() { return issue.present },
    get ownFacts() { return facts(issue, pool) },
    get rosterIds() { return issue.rosterIds },
    get openOwn() { return issue.openOwn },
    get tip() { return issue.tip },
  })
})

export const sidebarAttention: (issue: IssueModel, pool: MobxPool) => Aggregate = memo('attention', (issue, pool): Aggregate => {
  const own = sidebarOwnAttention(issue, pool)
  const children: Aggregate[] = []
  if (!own.cold) for (const id of sidebarNested(issue, pool)) {
    const child = hostOf(issue).visibleInputs.issue(id)
    if (child) children.push(sidebarAttention(child as IssueModel, pool))
  }
  // Preserve roll-up order for the first error, timer ties and fleet glyphs.
  children.sort((a, b) => {
    const x = a.order, y = b.order
    if (!x || !y) return 0
    const keyed = Number(!x.sortKey) - Number(!y.sortKey)
    if (keyed) return keyed
    if (x.sortKey && y.sortKey && x.sortKey !== y.sortKey) return x.sortKey < y.sortKey ? -1 : 1
    return (Date.parse(y.createdAt) || 0) - (Date.parse(x.createdAt) || 0) || y.seq - x.seq || x.id.localeCompare(y.id)
  })
  return { ...aggregate({ own, children }), order: own.order }
})

/** A heartbeat changes a scalar, independent of the attention composition. */
export const sidebarSeatActivity: (issue: IssueModel, pool: MobxPool) => number | null = memo('activity', (issue, pool): number | null => {
  if (!issue.present || facts(issue, pool).state === 'cold') return null
  const host = hostOf(issue)
  let latest: number | null = null
  for (const id of issue.rosterIds) {
    const at = host.visibleInputs.session(id).activityMs
    if (at !== null && (latest === null || at > latest)) latest = at
  }
  for (const id of sidebarNested(issue, pool)) {
    const child = host.visibleInputs.issue(id)
    const at = child ? sidebarSeatActivity(child as IssueModel, pool) : null
    if (at !== null && (latest === null || at > latest)) latest = at
  }
  return latest
})

export const sidebarActivityAt = memo('activityAt', (issue, pool) => {
  const own = issue.ownActivityAt, seat = sidebarSeatActivity(issue, pool)
  return seat !== null && seat > own ? seat : own
})

/** One drawn issue payload, shared only while a screen observes it. */
export const sidebarIssueRow = keyedComputed<IssueModel, Loaded<SidebarRowValues>, [MobxPool]>(
  model => debugName(() => `IssueModel@${model.id}.sidebar`), sidebarValues,
  { context: model => model, equals: sameSidebar },
)

/** Borrowed own seats compare by identity; the composed screen facts compare
 * by value, so an unchanged ancestor payload stops propagation. */
function sameSidebar(a: Loaded<SidebarRowValues>, b: Loaded<SidebarRowValues>): boolean {
  if (a === b) return true
  if (a === LOADING || b === LOADING || a === undefined || b === undefined) return false
  const { sessions: seatsA, ...factsA } = a
  const { sessions: seatsB, ...factsB } = b
  return seatsA.length === seatsB.length &&
    seatsA.every((seat, index) => seat === seatsB[index]) && compareStructural(factsA, factsB)
}

/** Formal unit counts, without the sidebar's labels, seats or attention payload. */
export const sidebarIssueProgress = cachedGroup('sidebarProgress', (model: IssueModel): SidebarProgress | typeof LOADING => {
  const below = model.unitsBelow, own = model.unitOwn
  if (below.pending > 0 || own.cold) return LOADING
  return below.members > 0
    ? { done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0, ...below.progress, total: below.units }
    : { done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0, total: own.solo ? 1 : 0,
        ...(own.solo ? { [own.state ?? 'wait']: 1 } : {}) }
}, (a, b) => a === b || (a !== LOADING && b !== LOADING &&
  a.total === b.total && a.done === b.done && a.run === b.run && a.review === b.review &&
  a.stall === b.stall && a.block === b.block && a.wait === b.wait))

function sidebarValues(model: IssueModel, pool: MobxPool): Loaded<SidebarRowValues> {
  const host = hostOf(model)
  const own = host.rollupInputs.loadedIssue(model.id)
  if (own === LOADING) return LOADING
  if (own === undefined) return undefined
  const facts = model.loaded.facts
  const repo = (model as ModelOf['issue']).repo
  const issue = overlayRow(
    own,
    {
      displayRef: model.displayRef,
      // Follow the declared live repo relation; the issue projection can lag a rename.
      repoPath: repo?.path ?? own.repoPath,
      readAt: host.visibleInputs.issueRead(model.id),
      unread: model.unread,
    },
    SIDEBAR_ISSUE_OMISSIONS,
  )
  const ownAttention = sidebarOwnAttention(model, pool)
  const agg = sidebarAttention(model, pool)
  const phase = phaseOf(agg, facts.finished)
  const asking = askingOf(agg, facts.finished)
  const activityAt = sidebarActivityAt(model, pool)
  const sessionFacts = agg.sidebarFacts ?? NO_SIDEBAR_SESSIONS
  // The own seats' rows, by id: a heartbeat redraws this row only when the
  // seat is its own (an ancestor's payload carries ids, POD-5423).
  const sessions: SliceSession[] = []
  for (const id of ownAttention.sessionIds ?? []) {
    const seat = host.row('session', id)
    if (seat !== undefined && seat !== LOADING) sessions.push(seat as SliceSession)
  }
  const aggregateSessionIds = agg.sessionIds ?? []
  const targetId = own.supersededBy ?? own.duplicateOf
  const origin =
    model.originRef === null ? undefined : host.rollupInputs.loadedIssue(model.originRef)
  if (origin === LOADING) return LOADING
  const originTick =
    origin === undefined
      ? null
      : {
          id: origin.id,
          seq: origin.seq,
          title: origin.title,
          ref: host.inputs.parts(origin.id)?.label.displayRef ?? `#${origin.seq}`,
        }
  const tip = !targetId && !model.openOwn ? model.tip : undefined
  if (
    agg.pending > 0 ||
    model.unitsBelow.pending > 0 ||
    model.unitOwn.cold ||
    (tip?.pending ?? 0) > 0
  )
    return LOADING
  const fromChildren = model.unitsBelow.members > 0
  const progress = sidebarIssueProgress(model)
  if (progress === LOADING) return LOADING
  const decision = ownAttention.deciding ? facts.decision : null
  let continuation: SidebarRowValues['continuation'] = null
  if (targetId) {
    if (host.rollupInputs.loadedIssue(targetId) === LOADING) return LOADING
    const target = host.inputs.parts(targetId)?.label
    continuation = {
      kind: own.supersededBy ? 'continued' : 'duplicate',
      ref: target?.displayRef ?? 'another task',
    }
  } else if (!model.openOwn) {
    const destination = tip?.target
    if (destination)
      continuation = {
        kind: 'continued',
        ref: host.inputs.parts(destination.id)?.label.displayRef ?? `#${destination.seq}`,
      }
  }
  const readMs = Date.parse(issue.readAt ?? '')
  const descendantUnread =
    issue.readAt &&
    Number.isFinite(readMs) &&
    ((Date.parse(agg.updatedAt ?? '') || 0) > readMs || (sidebarSeatActivity(model, pool) ?? 0) > readMs) &&
    sidebarNested(model, pool).length > 0
  return {
    idNumber: model.seq,
    color: own.color ?? null,
    title: model.title,
    timing: sidebarTimingFromFacts(
      sessionFacts,
      phase,
      facts.finished,
      activityAt,
      agg.decidingAt,
    ),
    working: agg.working,
    asking,
    originTick,
    decision,
    mergeCommits: decision === 'merge' ? (own.gitState?.ahead ?? 0) : 0,
    progress,
    fromChildren,
    statusFromChildren: model.nestParent === null && fromChildren,
    gitState: own.gitState,
    unread: !agg.working && (model.unread || Boolean(descendantUnread)),
    errorClass: facts.finished ? null : sessionFacts.errorClass,
    internal: own.audience === 'agent',
    ...sidebarLifecycle(issue, asking, host.inputs.passed, host.inputs.reached),
    draftAgentOnly: own.isDraftVessel === true && !own.worktreePath && sessions.length > 0,
    firstSessionId: ownAttention.firstSessionId ?? null,
    continuation,
    fleet: sessionFacts.fleet,
    issue,
    sessions,
    aggregateSessionIds,
    awaitingFirstPrompt:
      own.isDraftVessel === true &&
      phase === 'queued' &&
      aggregateSessionIds.length > 0 &&
      sessionFacts.allUnstarted,
  }
}


/** The screen owns this view in the existing pool registry. */
export function sidebarView(pool: MobxPool): SidebarIndex {
  return pool.sources.view('sidebar', () => new SidebarIndex(pool))
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
  private readonly rosterViews = keyedViews<RosterFacts>('pool.sidebar', 'rosterFacts', compareStructural)
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
    if (model !== undefined) return sidebarIssueRow(model, this.pool)
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
    const row = sidebarIssueRow(model, this.pool)
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
            : (worklistGroups(this.pool).placementOf(firstOpen)?.repoPath ?? key),
        folded: snoozedIds.length > 0 || closedIds.length > 0,
        headBand2: group.sidebarMetadata.headBand === 2,
      }
    })
  }

  /** Band ordering reads presence and head metadata, never roster contents. */
  private rosterFacts(key: string): RosterFacts {
    return this.rosterViews(key, () => {
      const roster = sidebarRosterView(this.pool).band(key)
      return { shown: roster.ids.length > 0, label: roster.label, repoPath: roster.repoPath }
    })
  }

  private specValues(state: SidebarState): BandSpecs {
    const index = sidebarRosterView(this.pool)
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
      const spec: BandSpec = { key, label, aliases, repoPath: path, group: false }
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
    for (const key of worklistGroups(this.pool).keys) {
      const facts = this.groupFacts(key)
      if (!facts.shown) continue
      // A registered root was seeded above; its path stays.
      const spec = add(key, facts.label, facts.path)
      specs.set(key, { ...spec, label: facts.label, group: true })
    }
    for (const key of index.keys()) {
      const existing = specs.get(key)
      const facts = existing?.group ? this.groupFacts(key) : undefined
      // An existing project/issue band needs no roster presence to keep its
      // place. Only the snoozed-head rule borrows the roster's label.
      if (existing && !(facts?.folded === true && facts.headBand2)) continue
      const roster = this.rosterFacts(key)
      if (!roster.shown) continue
      const spec = add(key, roster.label, roster.repoPath)
      // The unified head names the section before folds: worktrees (band 1)
      // precede snoozed roots (band 2), even when a root is in the closed fold.
      const label = facts?.folded === true && facts.headBand2 ? roster.label : spec.label
      specs.set(key, { ...spec, label })
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
    const rows = spec.group ? worklistGroups(this.pool).group(band).sidebarRows : undefined
    const worktreeIds = sidebarRosterView(this.pool).band(band).ids
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
      startFirstTask: !spec.group && worktreeIds.length === 0,
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
interface RosterFacts {
  readonly shown: boolean
  readonly label: string
  readonly repoPath: string
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
