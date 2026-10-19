import { issueDefaultAgentKind } from '@podium/client-core/agent-models'
import type { SessionView } from '@podium/client-core/session-values'
import {
  FLIGHT_DECK_FOLDS_KEY,
  FLIGHT_DECK_MODE_KEY,
  readMissionScreenView,
  writeMissionScreenView,
} from '@podium/client-core/ui-state'
import {
  type FlightDeckFoldMap,
  type FlightDeckFoldState,
  type FlightDeckMode,
  type IssueNavigationModel,
  issueAbandoned,
  machineViewsFromWire,
  nativeSubagentRows,
  readFlightDeckFolds,
  reposToViews,
  writeFlightDeckFolds,
} from '@podium/client-core/values'
import { companion, lazy } from '@podium/mobx-helpers'
import { isFinished } from '@podium/model/browser'
import { action, compareShallow, compareStructural, observable } from 'mobx'
import { headerView } from './header-views'
import { omitGone } from './lookup'
import { FullDeck } from './mission-full-deck'
import { type MissionDeckIssueModel, MissionViewReader, missionView, requireLoaded, settled } from './mission-view'
import type { IssueModel, SessionModel } from './models'
import type { MobxPool } from './pool'
import { SettingsRecordRequest } from './requested-records'
import { LOADING, type Loaded } from './worklist/rollup'

export interface MissionScreenOptions {
  /** Persist a device preference. The pool's preference row is the stored
   * value (the UiStore is not built), so the screen reads it back from there. */
  setPreference?: (key: string, raw: string | null) => void
  /** The desktop deck draws Full only, whatever mode the phone stored. */
  fullOnly?: boolean
  /** How a session is named where the mission search matches it. */
  sessionName?: (session: SessionView) => string
}

const NO_HOSTS: ReturnType<typeof machineViewsFromWire> = []

/** The mission's search words for one drawn row: title, reference, crew names. */
class MissionRowSearch {
  constructor(private readonly row: MissionDeckIssueModel, private readonly screen: MissionScreen) {}
  @lazy({ equals: compareShallow }) get words(): readonly string[] {
    const { row } = this
    const issue = requireLoaded(row.view.catalogIssue(row.id))!
    const name = this.screen.sessionName
    return [issue.title.toLowerCase(), row.displayRef.toLowerCase(), ...row.crewIds.map((id) => {
      const session = row.view.rawSession(id)
      return session && typeof session !== 'symbol' ? name(session).toLowerCase() : ''
    })]
  }
}

/** Per-session display facts the deck lays out before drawing a row. */
class MissionSession {
  constructor(private readonly session: SessionModel) {}
  @lazy get height(): number {
    const session = settled(() => (this.session.exists ? this.session : undefined))
    if (session === LOADING) throw LOADING
    return 46 + (session ? nativeSubagentRows(session as unknown as SessionView).length * 22 : 0)
  }
}

/**
 * One opening of a mission, drawn by the desktop flight deck and the phone
 * mission screens. The root component creates it and closes it; closing drops
 * the screen's reader, its decks and every companion with it. Search and the
 * archive disclosure are this opening's UI state; mode and folds are device
 * preferences, read from the pool's preference row and written through it.
 */
export class MissionScreen {
  readonly reader: MissionViewReader
  readonly settingsRequest: SettingsRecordRequest
  @observable accessor query = ''
  @observable accessor searchOpen = false
  @observable accessor archivedOpen = false
  private readonly search = companion((row: MissionDeckIssueModel) => new MissionRowSearch(row, this))
  private readonly seat = companion((session: SessionModel) => new MissionSession(session))
  /** The Full view (flight deck v6): its own filter, Show done and default
   * folds over this opening's full deck. */
  readonly full: FullDeck = new FullDeck(this)

  constructor(readonly pool: MobxPool, readonly rootId: string, private readonly options: MissionScreenOptions = {}) {
    this.reader = new MissionViewReader(pool)
    this.settingsRequest = new SettingsRecordRequest(pool)
  }

  get sessionName(): (session: SessionView) => string {
    return this.options.sessionName ?? ((session) => session.name?.trim() || session.title || '')
  }

  // Lifetime
  close(): void {
    this.reader.dispose()
    this.settingsRequest.close()
  }

  // Preferences: stored once, in the pool's preference rows
  private preference(key: string): string | null {
    const row = requireLoaded(omitGone(this.pool.row('preference', key)))
    return typeof row === 'object' && row !== null ? row.value : null
  }
  @lazy get mode(): FlightDeckMode {
    return this.options.fullOnly ? 'full' : readMissionScreenView(this.preference(FLIGHT_DECK_MODE_KEY))
  }
  @lazy({ equals: compareStructural }) get folds(): FlightDeckFoldMap {
    return readFlightDeckFolds(this.preference(FLIGHT_DECK_FOLDS_KEY))
  }
  @action setMode(mode: FlightDeckMode): void {
    this.options.setPreference?.(FLIGHT_DECK_MODE_KEY, writeMissionScreenView(mode))
  }
  @action setFolds(folds: FlightDeckFoldMap): void {
    this.options.setPreference?.(FLIGHT_DECK_FOLDS_KEY, writeFlightDeckFolds(folds))
  }
  /** A fold the operator performed is written explicitly, whichever way it went. */
  @action fold(id: string, closed: boolean): void {
    const next = new Map(this.folds)
    next.set(id, closed ? 'closed' : 'open')
    this.setFolds(next)
  }
  @action toggleFold(row: MissionDeckIssueModel): void { this.fold(row.id, !row.folded(this.folds)) }
  /** Both directions write explicit values for every foldable branch. */
  @action foldAll(): void {
    const closed = !this.allFolded
    this.setFolds(new Map(this.foldable.map((row): [string, FlightDeckFoldState] => [row.id, closed ? 'closed' : 'open'])))
  }

  // Search
  @action setQuery(query: string): void { this.query = query }
  @action toggleSearch(): void {
    if (this.searchOpen) this.query = ''
    this.searchOpen = !this.searchOpen
  }
  @action closeSearch(): void { this.query = ''; this.searchOpen = false }
  @action setArchivedOpen(open: boolean): void { this.archivedOpen = open }

  // The deck
  get root(): IssueModel { return this.reader.facts(this.rootId) }
  @lazy get deck() { return this.reader.deck(this.rootId, this.mode) }
  /** The deck has settled: its shape, numbers, archive count, header and rows. */
  @lazy get ready(): boolean {
    return settled(() => {
      // A loading device preference must not briefly draw the default folds.
      // Keep display demand inside this opening until its mode and folds arrive.
      const deck = this.deck
      const reads = [deck.topology, deck.progress, deck.archivedCount, deck.headerReady, this.reader.issue(this.rootId), settled(() => deck.rowIds()), this.folds]
      return !reads.includes(LOADING)
    }) === true
  }
  /** The row spine needs its shape and folds, independently of header totals.
   * Waterfall geometry must not subscribe to whole-mission activity rollups. */
  @lazy get rowsReady(): boolean {
    return settled(() => {
      const reads = [this.deck.topology, this.reader.issue(this.rootId), settled(() => this.deck.rowIds()), this.folds]
      return !reads.includes(LOADING)
    }) === true
  }
  @lazy({ equals: compareShallow }) get rows(): readonly MissionDeckIssueModel[] {
    return this.rowsReady ? this.deck.rows() : []
  }
  /** The mission's own row: the header, which the spine does not print again. */
  @lazy get rootRow(): MissionDeckIssueModel | undefined { return this.rows[0] }
  @lazy get needle(): string { return this.query.trim().toLowerCase() }
  matches(row: MissionDeckIssueModel, needle = this.needle): boolean {
    return this.search(row).words.some((word) => word.includes(needle))
  }
  /** Proposals leave the tree for their own tail, unless they carry sub-tasks. */
  @lazy({ equals: compareShallow }) private get proposalIds(): readonly string[] {
    return this.rows.filter((row) =>
      row.depth > 0 && row.stage === 'proposed' && requireLoaded(row.deckChildren).length === 0).map((row) => row.id)
  }
  @lazy({ equals: compareShallow }) private get proposals(): readonly MissionDeckIssueModel[] {
    const ids = new Set(this.proposalIds)
    return this.rows.filter((row) => ids.has(row.id))
  }
  @lazy({ equals: compareShallow }) private get tree(): readonly MissionDeckIssueModel[] {
    const ids = new Set(this.proposalIds)
    return this.rows.filter((row) => !ids.has(row.id))
  }
  @lazy({ equals: compareShallow }) private get unfoldedIds(): readonly string[] {
    return this.rowsReady ? requireLoaded(this.deck.rowIds(this.mode, this.folds)) : []
  }
  @lazy({ equals: compareShallow }) private get unfolded(): readonly MissionDeckIssueModel[] {
    const ids = new Set(this.unfoldedIds)
    return this.tree.filter((row) => row.depth > 0 && ids.has(row.id))
  }
  /** The drawn spine: unfolded rows, narrowed by the search to matches and their path. */
  @lazy({ equals: compareShallow }) get visibleRows(): readonly MissionDeckIssueModel[] {
    const needle = this.needle
    if (!needle) return this.unfolded
    const keep = new Set<string>(), trail: MissionDeckIssueModel[] = []
    for (const row of this.unfolded) {
      trail.length = row.depth
      trail[row.depth] = row
      if (this.matches(row, needle)) for (const ancestor of trail) if (ancestor) keep.add(ancestor.id)
    }
    return this.unfolded.filter((row) => keep.has(row.id))
  }
  @lazy({ equals: compareShallow }) get proposedRows(): readonly MissionDeckIssueModel[] {
    const needle = this.needle
    return needle ? this.proposals.filter((row) => this.matches(row, needle)) : this.proposals
  }
  /** Branches "fold every branch" acts on: never the root, never a proposal. */
  @lazy({ equals: compareShallow }) get foldable(): readonly MissionDeckIssueModel[] {
    const ids = new Set(this.proposalIds)
    return this.rows.filter((row) => row.depth > 0 && !ids.has(row.id) && row.hasPayload)
  }
  @lazy get anyFoldable(): boolean { return this.foldable.length > 0 }
  @lazy get allFolded(): boolean { return this.anyFoldable && this.foldable.every((row) => row.folded(this.folds)) }
  /** Every crew member drawn on a row of this mission, in row order. */
  /** The mission's members, unfiltered by the view. */
  @lazy({ equals: compareStructural }) get members(): ReadonlySet<string> { return requireLoaded(this.deck.members) }
  @lazy({ equals: compareShallow }) get crewIds(): readonly string[] { return this.rows.flatMap((row) => row.crewIds) }
  @lazy({ equals: compareStructural }) get inMission(): ReadonlySet<string> { return new Set(this.crewIds) }
  /** Every seated sender across the mission's members, in session order:
   * the crew the phone's mission screen picks its conversation from. */
  @lazy({ equals: compareShallow }) get crew(): readonly SessionModel[] {
    const seats = new Map<string, SessionModel>()
    for (const member of this.members) {
      for (const seat of requireLoaded(this.reader.present(member))) seats.set(seat.sessionId, this.pool.sessionObject(seat.sessionId))
    }
    return [...seats.values()].sort(this.reader.sessionOrder)
  }
  @lazy({ equals: compareShallow }) get rootSessionIds(): readonly string[] { return this.rootRow?.sessionIds(this.mode) ?? [] }
  sessionHeight(id: string): number { return this.seat(this.pool.sessionObject(id)).height }
  /** The phone's proposal author: the filing session's reference, never a
   * collapsed resume twin's. */
  proposalAuthor(row: MissionDeckIssueModel): string | null {
    const authorId = row.facts.startedBySession
    return authorId && this.pool.graph.isCollapsed('session', authorId) ? null : row.authorRef
  }

  // Header: the root's displayed fields, each its own answer
  @lazy get rootTitle(): string { return this.rootRow?.title ?? '' }
  @lazy get rootRef(): string { return this.deck.model(this.rootId).displayRef }
  @lazy get rootStage(): IssueNavigationModel['stage'] { return this.rootIssue.stage }
  @lazy({ equals: compareShallow }) get rootStatus() { return this.deck.model(this.rootId).status }
  private get rootIssue(): IssueNavigationModel { return requireLoaded(this.reader.issue(this.rootId))! }
  @lazy get rootDraftVessel(): boolean { return Boolean(this.rootIssue.isDraftVessel) }
  @lazy get rootLeadSessionId(): string | undefined { return this.rootRow?.crewIds[0] }
  @lazy get rootAuthoredBrief(): string {
    const root = this.rootIssue
    return root.description?.trim() || root.activityNotes?.trim() || ''
  }
  @lazy get rootFinished(): boolean { return isFinished(this.rootIssue) }
  @lazy get rootAbandoned(): boolean { return issueAbandoned(this.rootIssue) }
  @lazy get rootClosable(): boolean { return !this.rootFinished && !this.rootIssue.deletedAt }
  @lazy({ equals: compareShallow }) get rootAgentTarget() {
    const { defaultAgent, repoPath, machineId } = this.rootIssue
    return { defaultAgent: issueDefaultAgentKind(defaultAgent, this.settingsRequest.model?.codingHarness), repoPath, machineId }
  }
  @lazy({ equals: compareStructural }) get progress() {
    const progress = requireLoaded(this.deck.progress)
    if (settled(() => this.root.visible) !== false) return progress
    // A phone can open a hidden root by id. The visible-root meter's fallback
    // must not count it as a unit; accepted formal children still count.
    const stack = [...this.pool.graph.many('issue', this.rootId, 'children')]
    const seen = new Set<string>([this.rootId])
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const child = requireLoaded(omitGone(this.pool.row('issueBoardRow', id))) as IssueNavigationModel | undefined
      if (!child || !this.reader.facts(child.id).visible) continue
      if (child.stage !== 'proposed' && !issueAbandoned(child)) return progress
      stack.push(...this.pool.graph.many('issue', id, 'children'))
    }
    return { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }
  }
  @lazy get liveCount(): number { return this.rootRow?.liveAgentCount ?? 0 }
  @lazy get workingCount(): number { return this.rootRow?.workingAgentCount ?? 0 }
  @lazy get needsCount(): number { return this.rootRow?.actionableCount ?? 0 }
  @lazy get waitingCount(): number { return this.rootRow?.waitingAgentCount ?? 0 }
  @lazy get archivedCount(): number { return requireLoaded(this.deck.archivedCount) }
  @lazy({ equals: compareStructural }) get note() { return this.deck.note }
  /** The root's seat note; drawn only while the root has a row. */
  @lazy({ equals: compareStructural }) get presence() {
    return this.rows.some((row) => row.id === this.rootId) ? this.deck.presence : null
  }
  @lazy({ equals: compareStructural }) get continuation() { return this.deck.continuation }
  @lazy({ equals: compareStructural }) get departures() { return this.deck.departures }
  /** The continuation is a departure with an action: listed once, as the card. */
  @lazy({ equals: compareShallow }) get otherDepartures() {
    const target = this.continuation?.target?.id
    return this.departures.filter((departure) => departure.issue.id !== target)
  }
  @lazy({ equals: compareStructural }) get continuationState() {
    const target = this.continuation?.target?.id
    return this.departures.find((departure) => departure.issue.id === target)?.state ?? null
  }

  // Hosts a mission root can run on
  @lazy private get repoViews() {
    const scans = headerView(this.pool).ids('repository').flatMap((id) => {
      const scan = headerView(this.pool).row('repository', id)
      return scan ? [scan] : []
    })
    // The first view at a path, as the whole-list find answered.
    const byPath = new Map<string, ReturnType<typeof reposToViews>[number]>()
    for (const repo of reposToViews(scans)) if (!byPath.has(repo.path)) byPath.set(repo.path, repo)
    return byPath
  }
  @lazy private get machineViews() { return machineViewsFromWire(headerView(this.pool).machines()) }
  @lazy({ equals: compareShallow }) get agentHosts(): ReturnType<typeof machineViewsFromWire> {
    const machines = this.machineViews
    if (machines.length === 0) return NO_HOSTS
    const { machineId, repoPath } = this.rootAgentTarget
    if (machineId) return machines.filter((view) => view.machine.id === machineId)
    const repo = repoPath == null ? undefined : this.repoViews.get(repoPath)
    return machines.filter((view) => repo?.machines.some((machine) => machine.machineId === view.machine.id))
  }

}

/** The mission root a selection opens, by id. The phone (`structural`) opens
 * archived roots and an addressed cold row explicitly; the desktop opens the
 * visible root only, and not an empty draft vessel. */
export function missionRootId(pool: MobxPool, selectedId: string | null, structural = false): Loaded<string> {
  const reader = missionView(pool)
  if (!structural) {
    const root = reader.selectedRoot(selectedId)
    return root === LOADING ? LOADING : root?.id
  }
  const rootId = reader.rootFor(selectedId)
  if (rootId === LOADING) return LOADING
  if (rootId) {
    const root = reader.issue(rootId)
    return root === LOADING ? LOADING : root?.id
  }
  // Cold and unknown selections spend the shared load window; gone selections
  // are omitted after the lookup settles and never restart that load.
  if (selectedId && omitGone(pool.row('issue', selectedId)) === LOADING) return LOADING
  return undefined
}
