import { omitGone } from './lookup'
import type { SessionView } from '@podium/client-core/session-values'

import { displayRefOf } from './views'
import {
  deckIssueState,
  deckSessionOrder,
  type FlightDeckFoldMap,
  type FlightDeckMode,
  type FlightDeckRow,
  type HandoffNextEntry,
  type HandoffNowEntry,
  type IssueContinuation,
  type IssueNavigationModel,
  type IssueNote,
  issueAbandoned,
  issueNeedsHuman,
  type MissionDeparture,
  type MissionProgress,
  type PresenceNote,
  panelLabel,
  selectLatestPromptSession,
} from '@podium/client-core/values'
import { companion, lazy } from '@podium/mobx-helpers'
import { machinePathsEqual } from '@podium/model'
import type { GitRepositoryWire, MachineWire } from '@podium/model/browser'
import { asIssueId, asSessionId, DRAFT_ISSUE_TITLE, HANDOFF_HARNESS_KINDS } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import type { IssueModel, ModelOf, SessionModel } from './models'
import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import { missions } from './mission'
import type { MobxPool } from './pool'
import type { SeatRelation } from './session-seats'
import { settingsHasFirstTask } from './settings-views'
import { createRowOverlay } from './shared/overlay-row'
import { LOADING, type Loaded } from './worklist/rollup'

const joinedIssueRef = (issue: { seq: number; prefix?: string | null }): string =>
  displayRefOf(issue.seq, issue.prefix)

const issueRefOverlay = createRowOverlay()
const issueNavigationOverlay = createRowOverlay()
const menuIssueOverlay = createRowOverlay()
const menuSessionOverlay = createRowOverlay()
const MENU_SESSION_OVERRIDES = Object.freeze({})
const MENU_SESSION_OMISSIONS = new Set<PropertyKey>(['machineName', 'condition', 'handoffTarget', 'displayRef'])
const MENU_OMISSIONS = new Set<PropertyKey>(['memberSessionIds', 'childIds', 'dependents'])

export interface MissionRowPresentation {
  state: ReturnType<typeof deckIssueState>
  note: IssueNote | null
  presence: PresenceNote | null
}
export interface MissionViewValues {
  root: IssueNavigationModel | undefined
  rows: FlightDeckRow[]
  members: ReadonlySet<string>
  issueIds: readonly string[]
  deck?: MissionDeckModel
  /** The mission's seated (non-archived) senders, in session order. */
  sessions: readonly SessionView[]
  /** How many archived sessions the drawn rows hold; the list itself is
   * read only while shown ({@link MissionViewReader.archive}). */
  archivedCount: number
  titles: ReadonlyMap<string, string>
  progress: MissionProgress
  departures: MissionDeparture[]
  continuation: IssueContinuation | null
  note: IssueNote | null
  presence: PresenceNote | null
  rowPresentation: ReadonlyMap<string, MissionRowPresentation>
}

const NO_PROGRESS: MissionProgress = Object.freeze({ total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 })
export const EMPTY_MISSION_VIEW: MissionViewValues = Object.freeze({
  root: undefined, rows: [], members: new Set<string>(), issueIds: [],
  sessions: [], archivedCount: 0, titles: new Map<string, string>(), progress: NO_PROGRESS,
  departures: [], continuation: null, note: null, presence: null, rowPresentation: new Map<string, MissionRowPresentation>(),
})

/** An issue's archived mission senders, cached apart from its seats: a
 * seated heartbeat never re-reads history (review finding 2). */
export interface MissionHistory {
  /** Archived senders with a row. */
  readonly count: number
  /** Of those, the ones a roster draws (neither headless nor a shell). */
  readonly roster: number
  /** `newestSession` of the archived senders, by id. */
  readonly newest: string | undefined
  /** The first archived sender, in session order, that moved elsewhere. */
  readonly moved: string | undefined
  /** `selectLatestPromptSession` of the archived senders, by id. */
  readonly latestPrompt: string | undefined
}

type SessionFacts = SessionModel
/** History reads the shared scalar fields, so a display edit stops at its session. */
const latestPromptOf = (sessions: readonly SessionModel[]) =>
  selectLatestPromptSession(sessions.map(session => ({
    sessionId: session.sessionId, lastActiveAt: session.lastActivity,
    lastInputAt: session.lastInput, transcriptAvailable: session.transcript,
    agentKind: session.historyKind,
  })) as unknown as readonly SessionView[])?.sessionId
const NO_HISTORY: MissionHistory = Object.freeze({ count: 0, roster: 0, newest: undefined, moved: undefined, latestPrompt: undefined })
interface IssueMemberFacts {
  readonly ids: ReturnType<typeof asSessionId>[]
  readonly latest: number
  readonly summary: { total: number; byPhase: Record<string, number> }
}
type MissionIssue = ModelOf['issue'] & Pick<IssueNavigationModel, 'stage' | 'coordinatorSessionId' | 'startedBySession' | 'closedReason' | 'blocked' | 'needsHuman' | 'parentId' | 'updatedAt'>

export function settled<T>(read: () => T): T | typeof LOADING {
  try { return read() } catch (error) { if (error === LOADING) return LOADING; throw error }
}
export function requireLoaded<T>(value: T | typeof LOADING): T {
  if (value === LOADING) throw LOADING
  return value
}
interface DeckTopology {
  readonly scope: ReadonlySet<string>
  readonly children: ReadonlyMap<string, readonly string[]>
  readonly parent: ReadonlyMap<string, string>
  readonly parents: ReadonlyMap<string, readonly string[]>
  readonly overlap: boolean
  readonly depths: ReadonlyMap<string, number>
}
const topology = ((deck: MissionDeckModel): DeckTopology | typeof LOADING => settled(() => {
  const { view } = deck, members = requireLoaded(deck.members)
  const scope = new Set<string>(), children = new Map<string, string[]>()
  let pending = false
  const visible = (id: string) => {
    const value = settled(() => view.facts(id).visible)
    if (value === LOADING) { pending = true; return undefined }
    return value
  }
  const stack = [...members]
  while (stack.length) {
    const id = stack.pop()!
    if (scope.has(id)) continue
    scope.add(id)
    if (visible(id) === false) continue
    const kids = [...view.pool.graph.many('issue', id, 'children')]
    stack.push(...kids)
    children.set(id, kids.filter(child => visible(child) === true))
  }
  // A pending child must not prevent its siblings from being requested in
  // this same loader batch. No topology is published until every input settles.
  if (pending) return LOADING
  for (const id of members) {
    const issue = view.facts(id)
    if (!issue.visible || id === deck.id || (issue.parentId && members.has(issue.parentId))) continue
    const owner = issue.startedBySession ? view.pool.graph.one('session', issue.startedBySession, 'missionIssue') : null
    const parent = owner && members.has(owner) && owner !== id ? owner : deck.id
    const siblings = children.get(parent) ?? []
    if (!siblings.includes(id)) siblings.push(id)
    children.set(parent, siblings)
  }
  for (const siblings of children.values()) siblings.sort((left, right) => {
    const a = view.facts(left), b = view.facts(right)
    return a.sortKey && b.sortKey && a.sortKey !== b.sortKey ? a.sortKey.localeCompare(b.sortKey) :
      a.seq - b.seq || (left < right ? -1 : left > right ? 1 : 0)
  })
  const parent = new Map<string, string>(), parents = new Map<string, string[]>(), seen = new Set<string>()
  let overlap = false
  const firstChild = (id: string) => view.node(id).earliestChild
  for (const [id, kids] of children) for (const child of kids) {
    const origins = parents.get(child) ?? []
    origins.push(id); parents.set(child, origins)
    if (seen.has(child)) overlap = true
    seen.add(child)
    const previous = parent.get(child) ?? view.facts(child).parentId
    const first = firstChild(id), prior = previous ? firstChild(previous) : undefined
    parent.set(child, !previous || (first !== undefined && (prior === undefined || first < prior)) ? id : previous)
  }
  // Malformed cycles use the same finite, unique closure as the old rows.
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) { overlap = true; return }
    if (visited.has(id)) return
    visiting.add(id)
    for (const child of children.get(id) ?? []) visit(child)
    visiting.delete(id); visited.add(id)
  }
  for (const id of scope) visit(id)
  const depths = new Map<string, number>()
  const depthOf = (id: string, depth: number) => {
    if (depths.has(id)) return
    depths.set(id, depth)
    for (const child of children.get(id) ?? []) depthOf(child, depth + 1)
  }
  depthOf(deck.id, 0)
  return { scope, children, parent, parents, overlap, depths }
}))

type Count = 'tasks' | 'done' | 'run' | 'live' | 'working' | 'needsYou' | 'waiting'
const COUNTS: readonly Count[] = ['tasks', 'done', 'run', 'live', 'working', 'needsYou', 'waiting']
const ownCount = (name: Count) => ((row: MissionDeckIssueModel) => {
  const facts = row.facts
  if (!facts.visible) return 0
  if (name === 'tasks') return 1
  if (name === 'done') return Number(facts.finished && !issueAbandoned(facts))
  if (name === 'run') return Number(!facts.finished && (underway(facts.stage) || facts.stage === 'review'))
  row.view.stats.onRollup?.(row.id)
  // Counts do not need the presentation roster's coordinator-first ordering.
  // Keep that additional computed lazy until a row actually draws its crew.
  const crew = requireLoaded(row.view.roster(row.id))
  if (name === 'live') return crew.filter(session => row.view.pool.sessionObject(session.sessionId).open).length
  if (name === 'working') return crew.filter(session => { const model = row.view.pool.sessionObject(session.sessionId); return model.open && model.workingMotion }).length
  if (name === 'waiting') return crew.filter(session => row.asks(session)).length
  return Number(issueNeedsHuman(row.rulesIssue!, crew))
})
const own = Object.fromEntries(COUNTS.map(name => [name, (row: MissionDeckIssueModel) => row.ownCount(name)])) as Record<Count, (row: MissionDeckIssueModel) => number>
const deriveSum = Object.fromEntries(COUNTS.map(name => [name, ((row: MissionDeckIssueModel) => settled(() => {
  row.view.stats.onRollup?.(row.id)
  const shape = requireLoaded(row.deck.topology)
  let total = 0, pending = false
  const add = (value: number | typeof LOADING) => {
    if (value === LOADING) pending = true
    else total += value
  }
  if (shape.overlap) {
    for (const id of [row.id, ...row.descendantIds]) add(settled(() => own[name](row.deck.model(id))))
  } else {
    add(settled(() => own[name](row)))
    for (const id of requireLoaded(row.deckChildren)) add(sum[name](row.deck.model(id)))
  }
  return pending ? LOADING : total
}))])) as Record<Count, (row: MissionDeckIssueModel) => number | typeof LOADING>
const sum = Object.fromEntries(COUNTS.map(name => [name, (row: MissionDeckIssueModel) => row.totalCount(name)])) as Record<Count, (row: MissionDeckIssueModel) => number | typeof LOADING>
const descendants = ((row: MissionDeckIssueModel) => {
  const shape = requireLoaded(row.deck.topology), seen = new Set<string>([row.id]), ids: string[] = []
  const stack = [...(shape.children.get(row.id) ?? [])].reverse()
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id); ids.push(id); stack.push(...[...(shape.children.get(id) ?? [])].reverse())
  }
  return ids
})
const childrenOf = ((row: MissionDeckIssueModel) => {
  const shape = row.deck.topology
  return shape === LOADING ? LOADING : shape.children.get(row.id) ?? []
})
const crewIds = ((row: MissionDeckIssueModel) => {
  const { view, facts } = row
  return [...view.pool.graph.many('issue', row.id, 'missionSessions')].filter(id => view.pool.sessionObject(id).onRoster).sort((a, b) =>
    Number(b === facts.coordinatorSessionId) - Number(a === facts.coordinatorSessionId) ||
    view.pool.sessionObject(a).createdAt.localeCompare(view.pool.sessionObject(b).createdAt) || a.localeCompare(b))
})
const hasPayload = ((row: MissionDeckIssueModel) => requireLoaded(row.deckChildren).length > 0 || row.crewIds.length > 0)
const presentation = ((row: MissionDeckIssueModel) => row.view.presentation(row.issue, row.sessions))
const crewOf = ((row: MissionDeckIssueModel) => deckSessionOrder(row.facts,
  requireLoaded(row.view.roster(row.id))))
const matchedWorking = ((row: MissionDeckIssueModel) => row.sessions.some(session => row.view.pool.sessionObject(session.sessionId).atWork))
const matchedNeedsYou = ((row: MissionDeckIssueModel) => own.needsYou(row) > 0)
const collapsedCrew: (row: MissionDeckIssueModel) => SessionView[] = ((row: MissionDeckIssueModel): SessionView[] => {
  const seen = new Set<string>(), candidates: SessionView[] = []
  const rank = (session: SessionView) => {
    const facts = row.view.pool.sessionObject(session.sessionId)
    return facts.open && facts.workingMotion ? 0 : facts.settled ? 2 : 1
  }
  const shape = requireLoaded(row.deck.topology)
  const groups = shape.overlap ? [row.sessions, ...row.descendantIds.map(id => row.deck.model(id).sessions)] :
    [row.sessions, ...requireLoaded(row.deckChildren).map(id => row.deck.model(id).collapsedCrew)]
  for (const crew of groups) {
    for (const session of crew) {
      if (seen.has(session.sessionId)) continue
      seen.add(session.sessionId); candidates.push(session)
    }
    candidates.sort((a, b) => rank(a) - rank(b)); candidates.length = Math.min(12, candidates.length)
  }
  return candidates
})
const kindCodes: (row: MissionDeckIssueModel) => string = ((row: MissionDeckIssueModel): string => {
  const kinds = new Set<SessionView['agentKind']>()
  const shape = requireLoaded(row.deck.topology)
  const ownCrew = shape.overlap ? [row.id, ...row.descendantIds].flatMap(id => row.deck.model(id).sessions) : row.sessions
  for (const session of ownCrew) {
    if (row.view.pool.sessionObject(session.sessionId).open) kinds.add(session.agentKind)
    if (kinds.size === 2) return JSON.stringify([...kinds])
  }
  if (!shape.overlap) for (const id of requireLoaded(row.deckChildren)) {
    for (const kind of JSON.parse(row.deck.model(id).kindCodes) as SessionView['agentKind'][]) {
      kinds.add(kind)
      if (kinds.size === 2) return JSON.stringify([...kinds])
    }
  }
  return JSON.stringify([...kinds])
})
const kindsOf = ((row: MissionDeckIssueModel) => JSON.parse(row.kindCodes) as SessionView['agentKind'][])
const latestBelow = ((row: MissionDeckIssueModel): string => {
  const shape = requireLoaded(row.deck.topology)
  if (shape.overlap) return [row.id, ...row.descendantIds].reduce((at, id) => row.view.facts(id).updatedAt > at ? row.view.facts(id).updatedAt : at, '')
  let at = row.facts.updatedAt
  for (const id of requireLoaded(row.deckChildren)) { const next = row.deck.model(id).updatedBelow; if (next > at) at = next }
  return at
})

const rollupValue = ((row: MissionDeckIssueModel) => settled(() => ({
  tasks: requireLoaded(sum.tasks(row)), done: requireLoaded(sum.done(row)), run: requireLoaded(sum.run(row)),
  live: requireLoaded(sum.live(row)), working: requireLoaded(sum.working(row)), needsYou: requireLoaded(sum.needsYou(row)), waiting: requireLoaded(sum.waiting(row)),
})))
/** A mission-scoped handle on the pool's issue, with lazy computed getters.
 * Scope matters: a graft may have different children and paths in two roots.
 * The handle holds no row, geometry, retained computed or presentation map. */
export class MissionDeckIssueModel implements FlightDeckRow {
  constructor(readonly entity: IssueModel, readonly deck: MissionDeckModel, private readonly path?: readonly string[]) {}
  get id() { return this.entity.id }
  @lazy private get ownTasks() { return ownCount('tasks')(this) }
  @lazy private get totalTasks(): number | typeof LOADING { return deriveSum.tasks(this) }
  @lazy private get ownDone() { return ownCount('done')(this) }
  @lazy private get totalDone(): number | typeof LOADING { return deriveSum.done(this) }
  @lazy private get ownRun() { return ownCount('run')(this) }
  @lazy private get totalRun(): number | typeof LOADING { return deriveSum.run(this) }
  @lazy private get ownLive() { return ownCount('live')(this) }
  @lazy private get totalLive(): number | typeof LOADING { return deriveSum.live(this) }
  @lazy private get ownWorking() { return ownCount('working')(this) }
  @lazy private get totalWorking(): number | typeof LOADING { return deriveSum.working(this) }
  @lazy private get ownNeedsYou() { return ownCount('needsYou')(this) }
  @lazy private get totalNeedsYou(): number | typeof LOADING { return deriveSum.needsYou(this) }
  @lazy private get ownWaiting() { return ownCount('waiting')(this) }
  @lazy private get totalWaiting(): number | typeof LOADING { return deriveSum.waiting(this) }
  ownCount(name: Count): number {
    switch (name) {
      case 'tasks': return this.ownTasks
      case 'done': return this.ownDone
      case 'run': return this.ownRun
      case 'live': return this.ownLive
      case 'working': return this.ownWorking
      case 'needsYou': return this.ownNeedsYou
      case 'waiting': return this.ownWaiting
    }
  }
  totalCount(name: Count): number | typeof LOADING {
    switch (name) {
      case 'tasks': return this.totalTasks
      case 'done': return this.totalDone
      case 'run': return this.totalRun
      case 'live': return this.totalLive
      case 'working': return this.totalWorking
      case 'needsYou': return this.totalNeedsYou
      case 'waiting': return this.totalWaiting
    }
  }
  @lazy get collapsedCrew(): SessionView[] { return collapsedCrew(this) }
  @lazy get kindCodes(): string { return kindCodes(this) }
  @lazy get kinds() { return kindsOf(this) }
  /** A graft can draw the same issue under two mission paths. */
  get key() { return this.path ? JSON.stringify(this.path) : this.id }
  private get canonical(): MissionDeckIssueModel { return this.path ? this.deck.model(this.id) : this }
  get view() { return this.deck.view }
  get facts() { return this.view.facts(this.id) }
  get issue() { return requireLoaded(this.view.issue(this.id))! }
  get rulesIssue() { return this.view.rulesIssue(this.id) }
  get stage() { return this.facts.stage }
  get title() { return requireLoaded(this.view.title(requireLoaded(this.view.catalogIssue(this.id))!)) }
  @lazy private get ownDeckChildren() { return childrenOf(this) }
  get deckChildren() { return this.canonical.ownDeckChildren }
  @lazy private get ownDescendantIds() { return descendants(this) }
  get descendantIds() { return this.canonical.ownDescendantIds }
  @lazy private get ownSessions() { return crewOf(this) }
  get sessions() { return this.canonical.ownSessions }
  @lazy private get ownCrewIds() { return crewIds(this) }
  get crewIds() { return this.canonical.ownCrewIds }
  get hasLead() { return this.entity.hasLead }
  asks(session: Pick<SessionView, 'sessionId'>) { return this.view.pool.sessionObject(session.sessionId).asking && !this.entity.finished }
  @lazy get workingSessionIds() { return this.crewIds.filter(id => this.view.pool.sessionObject(id).atWork) }
  @lazy get askingSessionIds() { return this.matches('needs-you') ? this.crewIds.filter(id => this.asks(this.view.pool.sessionObject(id))) : [] }
  sessionIds(mode: FlightDeckMode): readonly string[] {
    const row = this.canonical
    return mode === 'full' ? row.crewIds : mode === 'working' ? row.workingSessionIds : row.askingSessionIds
  }
  get depth() { return this.path ? this.path.length - 1 : this.deck.depth(this.id) }
  @lazy get matched() { return this.matches(this.deck.mode) }
  @lazy get matchesWorking() { return matchedWorking(this) }
  @lazy get matchesNeedsYou() { return matchedNeedsYou(this) }
  matches(mode: FlightDeckMode) { return mode === 'full' || (mode === 'working' ? this.canonical.matchesWorking : this.canonical.matchesNeedsYou) }
  get rollup() { return rollupValue(this.canonical) }
  @lazy get tasks() { return sum.tasks(this.canonical) }
  @lazy get done() { return sum.done(this.canonical) }
  @lazy get run() { return sum.run(this.canonical) }
  @lazy get actionableCount() { return requireLoaded(sum.needsYou(this.canonical)) }
  @lazy get liveAgentCount() { return requireLoaded(sum.live(this.canonical)) }
  @lazy get workingAgentCount() { return requireLoaded(sum.working(this.canonical)) }
  @lazy get waitingAgentCount() { return requireLoaded(sum.waiting(this.canonical)) }
  get collapsedSummary() {
    const row = this.canonical
    // A searchable placeholder asks only for the task count. Reading it must
    // not observe the hidden row's crew, kinds and other presentation rollups.
    return {
      get tasks() { return requireLoaded(row.tasks) - own.tasks(row) },
      get done() { return requireLoaded(row.done) - own.done(row) },
      get run() { return requireLoaded(row.run) - own.run(row) },
      get kinds() { return row.kinds },
      get crew() { return row.collapsedCrew },
      get needsYou() { return row.actionableCount > 0 },
    }
  }
  @lazy private get ownPresentation() { return presentation(this) }
  get presentation() { return this.canonical.ownPresentation }
  @lazy private get ownUpdatedBelow() { return latestBelow(this) }
  get updatedBelow() { return this.canonical.ownUpdatedBelow }
  @lazy private get ownHasPayload() { return hasPayload(this) }
  get hasPayload() { return this.canonical.ownHasPayload }
  folded(folds: FlightDeckFoldMap) {
    const explicit = folds.get(this.id)
    return explicit === undefined ? requireLoaded(this.deckChildren).length === 0 && this.crewIds.length === 1 : explicit === 'closed'
  }
}

const progress = ((deck: MissionDeckModel): MissionProgress | typeof LOADING => settled(() => {
  const { view } = deck, members = requireLoaded(deck.members)
  const formal = new Set<string>(), stack = [...view.pool.graph.many('issue', deck.id, 'children')]
  while (stack.length) {
    const id = stack.pop()!
    if (id === deck.id || formal.has(id) || !view.facts(id).visible) continue
    formal.add(id); stack.push(...view.pool.graph.many('issue', id, 'children'))
  }
  const scope = [...members].filter(id => view.facts(id).visible)
  // Progress needs staffing throughout this formal scope. Observe every
  // required crew before propagating LOADING instead of loading one per frame.
  let pending = false
  for (const id of scope) if (settled(() => view.facts(id).live) === LOADING) pending = true
  if (pending) return LOADING
  const accepted = scope.filter(id => formal.has(id) && view.facts(id).stage !== 'proposed' && !issueAbandoned(view.facts(id)))
  const units: string[] = []
  for (const id of accepted.length ? accepted : [deck.id]) {
    const eligible = settled(() => {
      const facts = view.facts(id)
      return !issueAbandoned(facts) && (facts.live || (view.tipIds(id, true).length === 0 && !view.hasSpinOffDependent(id)))
    })
    if (eligible === LOADING) pending = true
    else if (eligible) units.push(id)
  }
  if (pending) return LOADING
  const staffed = new Set<string>()
  for (const issueId of scope) {
    if (!view.facts(issueId).live) continue
    let id: string | null = issueId
    while (id && !staffed.has(id)) { staffed.add(id); id = view.pool.graph.one('issue', id, 'parent') }
  }
  const result: MissionProgress = { total: units.length, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }
  for (const id of units) {
    const facts = view.facts(id)
    if (facts.finished) result.done++
    else if (facts.blocked) result.block++
    else if (facts.stage === 'review') result.review++
    else if (underway(facts.stage)) { if (facts.stage === 'shipping' || staffed.has(id)) result.run++; else result.stall++ }
  }
  result.wait = Math.max(0, result.total - result.done - result.block - result.review - result.run - result.stall)
  return result
}))

// The header is mounted only after its own references and scalar rollups have
// settled. Observing this boolean keeps LOADING in the data boundary; ordinary
// header value changes are read by its observer, without republishing the pane.
const headerReady = ((deck: MissionDeckModel) => settled(() => {
  const row = deck.model(deck.id)
  const reads: readonly (() => unknown)[] = [
    () => row.liveAgentCount, () => row.workingAgentCount,
    () => row.actionableCount, () => row.waitingAgentCount,
    () => deck.continuation, () => deck.note,
    () => deck.presence, () => deck.departures,
  ]
  let pending = false
  for (const read of reads) if (settled(read) === LOADING) pending = true
  return pending ? LOADING : true
}))
const rootContinuation = ((deck: MissionDeckModel) => {
  const root = deck.view.rulesIssue(deck.id)
  return root ? deck.view.continuation(root) : null
})
const rootNote = ((deck: MissionDeckModel) => {
  const root = deck.view.rulesIssue(deck.id)
  return root ? deck.view.note(root) : null
})
const rootPresence = ((deck: MissionDeckModel) => {
  const root = deck.view.rulesIssue(deck.id)
  return root ? deck.view.presence(root, deck.model(deck.id).sessions) : null
})
const rootDepartures = ((deck: MissionDeckModel) => deck.view.departures(deck))

/** Root questions contain IDs and mission-wide numbers. MobX owns every cache
 * lifetime; unobserved row/model questions keep no computed allocations. */
export class MissionDeckModel {
  readonly card = companion((issue: IssueModel) => new MissionDeckIssueModel(issue, this))
  constructor(readonly entity: IssueModel, readonly view: MissionViewReader, readonly mode: FlightDeckMode) {}
  get id() { return this.entity.id }
  /** Phone mission rosters include history; web reads the seated list and only
   * mounts history on request. Both lists contain the shared session objects. */
  @lazy get allSessions(): readonly SessionView[] {
    const crew = new Map<string, SessionView>()
    for (const id of requireLoaded(this.rowIds())) {
      for (const session of requireLoaded(this.view.attached(id))) crew.set(session.sessionId, session)
    }
    return [...crew.values()].sort(this.view.sessionOrder)
  }
  @lazy get values() { this.view.stats.values++; return this.view.deckValues(this) }
  @lazy get archivedCount() { return this.view.readArchiveCount(this) }
  @lazy get members() { return missions(this.view.pool).members(this.id) }
  @lazy get topology() { return topology(this) }
  @lazy get progress() { return progress(this) }
  @lazy get headerReady() { return headerReady(this) }
  @lazy get continuation() { return rootContinuation(this) }
  @lazy get note() { return rootNote(this) }
  @lazy get presence() { return rootPresence(this) }
  @lazy get departures() { return rootDepartures(this) }
  @lazy private get paths() { return settled(() => this.readPaths()) }
  @lazy private get placements() { return settled(() => requireLoaded(this.paths).map(path => path[path.length - 1]!)) }
  private readPaths() {
    const shape = requireLoaded(this.topology), members = requireLoaded(this.members)
    const included = new Set<string>([this.id])
    for (const id of members) {
      if (!this.view.facts(id).visible || !this.model(id).matches(this.mode)) continue
      let current: string | undefined = id
      const seen = new Set<string>()
      while (current && !seen.has(current)) {
        seen.add(current); included.add(current)
        if (current === this.id) break
        current = shape.parent.get(current)
      }
    }
    const paths: string[][] = []
    const walk = (id: string, path: readonly string[]) => {
      if (path.includes(id) || !included.has(id) || !this.view.facts(id).visible) return
      const next = [...path, id]
      paths.push(next)
      for (const child of shape.children.get(id) ?? []) walk(child, next)
    }
    walk(this.id, [])
    return paths
  }
  rowIds(mode: FlightDeckMode = this.mode, collapsed: FlightDeckFoldMap | null = null): readonly string[] | typeof LOADING {
    if (mode !== this.mode) return this.view.deck(this.id, mode).rowIds(mode, collapsed)
    if (collapsed === null) return this.placements
    return settled(() => requireLoaded(this.paths)
      .filter(path => path.slice(1, -1).every(id => !this.model(id).folded(collapsed)))
      .map(path => path[path.length - 1]!))
  }
  @lazy private get rowPlacements() {
    return requireLoaded(this.paths).map(path => new MissionDeckIssueModel(this.view.facts(path[path.length - 1]!), this, path))
  }
  rows() { return this.rowPlacements }
  model(id: string) { return this.card(this.view.facts(id)) }
  depth(id: string) {
    return requireLoaded(this.topology).depths.get(id) ?? 0
  }
  ancestorPath(id: string) {
    const shape = requireLoaded(this.topology), ids: string[] = [], seen = new Set<string>()
    let current: string | undefined = id
    while (current && !seen.has(current)) { seen.add(current); ids.push(current); if (current === this.id) break; current = shape.parent.get(current) }
    return ids.reverse()
  }
  ancestorIds(id: string) {
    const shape = requireLoaded(this.topology), ids = new Set<string>(), stack = [id]
    while (stack.length) {
      const current = stack.pop()!
      if (ids.has(current)) continue
      ids.add(current)
      if (current !== this.id) stack.push(...shape.parents.get(current) ?? [])
    }
    return ids
  }

}

/** Mission rules and rich read projections belong to this screen companion. */
class MissionIssueReader {
  constructor(readonly entity: IssueModel, readonly view: MissionViewReader) {}
  get id() { return this.entity.id }
  @lazy get earliestChild() {
    let first: string | undefined
    for (const id of this.view.pool.graph.many('issue', this.id, 'children')) if (first === undefined || id < first) first = id
    return first
  }
  @lazy get issue() { return this.view.readIssue(this.id) }
  @lazy get menuIssue() { return this.view.readMenuIssue(this.id) }
  @lazy get catalog() { return this.view.readCatalogIssue(this.id) }
  @lazy get rules() { return this.view.readRulesIssue(this.id) }
  @lazy get localTips() { return this.view.readTips(this.id, true) }
  @lazy get liveTips() { return this.view.readTips(this.id, false) }
  @lazy get attached() { return this.view.readAttached(this.id) }
  @lazy get present() { return this.view.readPresent(this.id) }
  @lazy get history() { return this.view.readHistory(this.id) }
  @lazy get historyRosterCount() { return this.view.readHistoryRosterCount(this.id) }
  @lazy get handoff() { return deriveMissionHandoff(this.view, this.id) }
  @lazy get menuHandoff(): MissionMenuHandoff | typeof LOADING {
    const count = this.view.pool.graph.size('issue', this.id, 'handoffSessions')
    if (count === 0) return { blocker: 'no-agent-session' }
    if (count > 1) return { blocker: 'multiple-sessions' }
    const sessionId = this.view.pool.graph.many('issue', this.id, 'handoffSessions')[Symbol.iterator]().next().value!
    const session = this.view.menuSession(sessionId)
    return session === LOADING ? LOADING : session ? { session } : { blocker: 'no-agent-session' }
  }
}
const rowOrder = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const underway = (stage: string) => stage === 'planning' || stage === 'in_progress' || stage === 'shipping'
const leftMission = (issue: IssueNavigationModel) => !['proposed', 'backlog'].includes(issue.stage) && Boolean(issue.deps.find(dep => dep.type === 'discovered-from'))
const originId = (issue: IssueNavigationModel) => issue.deps.find(dep => dep.type === 'discovered-from')?.id ?? null

/** One read service on the existing principal's pool. There is no source,
 * replica, runtime, outbox or independently maintained relation index here. */
export class MissionViewReader {
  private card = companion((issue: IssueModel) => new MissionIssueReader(issue, this))
  private fullDeck = companion((issue: IssueModel) => new MissionDeckModel(issue, this, 'full'))
  private workingDeck = companion((issue: IssueModel) => new MissionDeckModel(issue, this, 'working'))
  private askingDeck = companion((issue: IssueModel) => new MissionDeckModel(issue, this, 'needs-you'))
  readonly stats: { values: number; issueReads: number; sessionReads: number; attachmentEdges: number; onRollup?: (id: string) => void } = { values: 0, issueReads: 0, sessionReads: 0, attachmentEdges: 0 }
  facts(id: string): MissionIssue { return this.pool.issueObject(id) as MissionIssue }
  deck(id: string, mode: FlightDeckMode = 'full') {
    const issue = this.facts(id)
    return mode === 'full' ? this.fullDeck(issue) : mode === 'working' ? this.workingDeck(issue) : this.askingDeck(issue)
  }
  node(id: string) { return this.card(this.facts(id)) }
  constructor(readonly pool: MobxPool) {}
  /** The pane is cached per mission ROOT and mode. The selection only picks
   * the root through {@link selectedRoot} (cached reads; a screen may override
   * which roots it shows), so another row of the same mission reuses the
   * derived pane instead of rebuilding it (review finding 2). */
  values(id: string | null, mode: FlightDeckMode): MissionViewValues | typeof LOADING {
    if (!id) return EMPTY_MISSION_VIEW
    // The root goes through selectedRoot so a screen's override (the phone
    // opens archived roots and waits on known cold rows) still applies.
    const root = this.selectedRoot(id)
    if (root === undefined) return EMPTY_MISSION_VIEW
    const rootId = root === LOADING ? this.rootFor(id) : root.id
    if (typeof rootId !== 'string') return LOADING
    const deck = this.deck(rootId, mode)
    // These independent questions are needed by the same pane. Observe each
    // before propagating LOADING, so their requests share the 50 ms window.
    const shape = deck.topology, numbers = deck.progress, archived = this.archiveCount(deck), ready = deck.headerReady
    if (root === LOADING || shape === LOADING || numbers === LOADING || archived === LOADING || ready === LOADING) return LOADING
    return deck.values
  }
  handoff(id: string): MissionHandoffValues | typeof LOADING { return this.node(id).handoff }
  issue(id: string): Loaded<IssueNavigationModel> { return this.node(id).issue }
  /** An open menu shows authored issue fields, unread and cascade counts;
   * it does not show the history roster or its phase summary. */
  menuIssue(id: string): Loaded<IssueNavigationModel> { return this.node(id).menuIssue }
  readMenuIssue(id: string): Loaded<IssueNavigationModel> {
    const row = this.menuCatalogIssue(id)
    if (!row || row === LOADING) return row
    const readAt = this.pool.readCursor(id) ?? null, readTime = Date.parse(readAt ?? '')
    return menuIssueOverlay(row, {
      readAt,
      unread: !row.deletedAt && (!Number.isFinite(readTime) || Date.parse(row.updatedAt) > readTime || (this.pool.visibleInputs.seatSummary?.(id).activity ?? 0) > readTime),
      ...this.pool.queries.issueChildCounts(id),
      sessionSummary: { total: this.pool.graph.size('issue', id, 'pageSessions'), byPhase: {} },
    }, MENU_OMISSIONS) as IssueNavigationModel
  }
  /** Count the declared capability set, and load a sender only when it is
   * the unique handoff subject. MobX retains this answer only while observed. */
  menuHandoff(id: string) { return this.node(id).menuHandoff }
  /** Menu metadata is already declared in the cold summary. Reading it does
   * not promote a closed issue and initialize its full display roster. */
  menuCatalogIssue(id: string): Loaded<IssueNavigationModel> {
    const row = omitGone(this.pool.row('issue', id, 'summary-fields')) as Loaded<IssueNavigationModel>
    if (!row || row === LOADING) return row
    const repoId = this.pool.graph.one('issue', id, 'repo')
    const repo = repoId ? omitGone(this.pool.row('repo', repoId)) as { prefix?: string } | undefined : undefined
    return issueRefOverlay(row, { prefix: repo?.prefix, displayRef: joinedIssueRef({ seq: row.seq, prefix: repo?.prefix }) }) as IssueNavigationModel
  }
  /** Shared raw-member facts: read cursors and machine display changes do not
   * rebuild the archived contribution or the ordered membership IDs. */
  issueMembers(id: string): IssueMemberFacts | typeof LOADING { return this.readIssueMembers(id) }
  /** Menu catalogs use authored labels and references, not other tasks' crew. */
  catalogIssue(id: string): Loaded<IssueNavigationModel> {
    return this.node(id).catalog
  }
  readCatalogIssue(id: string): Loaded<IssueNavigationModel> {
    const raw = omitGone(this.pool.row('issue', id))
    if (!raw || raw === LOADING) return raw
    const row = raw as IssueNavigationModel
    const repoId = this.pool.graph.one('issue', id, 'repo')
    const repo = repoId ? omitGone(this.pool.row('repo', repoId)) as { prefix?: string } | undefined : undefined
    return issueRefOverlay(row, { prefix: repo?.prefix, displayRef: joinedIssueRef({ seq: row.seq, prefix: repo?.prefix }) }) as IssueNavigationModel
  }
  /** Every explicit mission sender, archived history included, in session
   * order. Explicit whole-roster readers ask for it; mission derivations
   * compose {@link present} and {@link history} so a seated heartbeat never
   * re-reads history. */
  attached(id: string): readonly SessionView[] | typeof LOADING { return this.node(id).attached }
  /** Non-archived mission senders, in session order. */
  present(id: string): readonly SessionView[] | typeof LOADING { return this.node(id).present }
  /** What derivations need from the archived mission senders. */
  history(id: string): MissionHistory | typeof LOADING {
    // Most issues have no archived sender: answer without building a cache.
    return this.hasHistory('missionSessions', id) === false ? NO_HISTORY : this.node(id).history
  }
  /** A closed archive observes only roster eligibility, without allocating
   * the activity, prompt and handoff winner questions for every hidden seat. */
  historyRosterCount(id: string): number | typeof LOADING {
    return this.hasHistory('missionSessions', id) === false ? 0 : this.node(id).historyRosterCount
  }
  /** Whether the relation holds archived or unsettled senders (LOADING while seats load). */
  private hasHistory(relation: SeatRelation, id: string): boolean | typeof LOADING {
    const ids = this.seatIds(relation, id, true)
    return ids === LOADING ? LOADING : ids.length > 0
  }
  /** The archived list under a mission root's drawn rows, in row order. */
  archive(rootId: string, mode: FlightDeckMode): SessionView[] | typeof LOADING { return deriveMissionArchive(this, this.deck(rootId, mode).rowIds(mode)) }
  /** An archived session's facts: its shared seat when the whole row is in
   * hand (one cached value per session, shared with navigation and the
   * partitions), else its row, which this read loads. */
  private sessionFacts(sessionId: string): SessionFacts | typeof LOADING | undefined {
    const session = this.pool.sessionObject(sessionId)
    return settled(() => session.exists ? session : undefined)
  }
  private idOrder = (a: string, b: string): number => {
    const left = this.pool.graph.orderKey('session', a), right = this.pool.graph.orderKey('session', b)
    return (left < right ? -1 : left > right ? 1 : 0) || (a < b ? -1 : a > b ? 1 : 0)
  }
  /** Facts of the given sessions in session order; LOADING while any row loads. */
  private factsOfIds(ids: readonly string[]): SessionFacts[] | typeof LOADING {
    const found: SessionFacts[] = []
    let pending = false
    for (const sessionId of ids) {
      const facts = this.sessionFacts(sessionId)
      if (facts === LOADING) pending = true
      else if (facts) found.push(facts)
    }
    return pending ? LOADING : found.sort((a, b) => this.idOrder(a.sessionId, b.sessionId))
  }
  sessionOrder = (a: Pick<SessionView, 'sessionId'>, b: Pick<SessionView, 'sessionId'>): number => this.idOrder(a.sessionId, b.sessionId)
  rawSession(id: string): Loaded<SessionModel & SessionView> {
    const model = this.pool.sessionObject(id)
    return settled(() => model.exists ? model as SessionModel & SessionView : undefined)
  }
  session(id: string): Loaded<SessionView> {
    this.stats.sessionReads++
    const row = this.rawSession(id)
    return row as Loaded<SessionView>
  }
  /** Menu labels and guards use the addressed session's own fields. The
   * machine/login/reference joins belong to its drawn row, not this menu. */
  menuSession(id: string): Loaded<SessionView> {
    // Menus borrow a row projection so omissions and serialization keep their
    // wire shape; session facts everywhere else come from the shared model.
    const row = omitGone(this.pool.row('session', id)) as Loaded<SessionView>
    return !row || row === LOADING ? row : menuSessionOverlay(row, MENU_SESSION_OVERRIDES, MENU_SESSION_OMISSIONS)
  }
  private seatIds(relation: SeatRelation, id: string, archived: boolean): readonly string[] | typeof LOADING {
    return this.pool.sessionSeatIds(relation, id, archived)
  }
  private seatRows(relation: SeatRelation, id: string, archived: boolean): SessionView[] | typeof LOADING {
    const ids = this.seatIds(relation, id, archived)
    if (ids === LOADING) return LOADING
    const found: SessionView[] = []
    let pending = false
    for (const sessionId of ids) {
      this.stats.attachmentEdges++
      const session = this.pool.sessionObject(sessionId)
      const foundSession = settled(() => session.exists && session.archived === archived)
      if (foundSession === LOADING) pending = true
      else if (foundSession) found.push(session as SessionView)
    }
    return pending ? LOADING : found
  }
  readPresent(id: string): readonly SessionView[] | typeof LOADING {
    const found = this.seatRows('missionSessions', id, false)
    return found === LOADING ? LOADING : found.sort(this.sessionOrder)
  }
  readHistory(id: string): MissionHistory | typeof LOADING {
    const ids = this.seatIds('missionSessions', id, true)
    if (ids === LOADING) return LOADING
    const all = this.factsOfIds(ids)
    if (all === LOADING) return LOADING
    const facts: SessionFacts[] = []
    let pending = false
    for (const session of all) {
      // A declared display summary can satisfy exists while these history
      // fields still throw LOADING. Settle at the reader boundary and visit
      // every archived sender so their payloads share one load window.
      const archived = settled(() => {
        if (!session.archived) return false
        void session.rosterEligible
        void session.lastActivity
        void session.moved
        void session.lastInput
        void session.transcript
        void session.historyKind
        return true
      })
      if (archived === LOADING) pending = true
      else if (archived) facts.push(session)
    }
    if (pending) return LOADING
    let newest: SessionFacts | undefined
    for (const session of facts) if (!newest || session.lastActivity > newest.lastActivity) newest = session
    return { count: facts.length, roster: facts.filter(session => session.rosterEligible).length, newest: newest?.sessionId,
      moved: facts.find(session => session.moved)?.sessionId, latestPrompt: latestPromptOf(facts) }
  }
  readHistoryRosterCount(id: string): number | typeof LOADING {
    const ids = this.seatIds('missionSessions', id, true)
    if (ids === LOADING) return LOADING
    let count = 0, pending = false
    for (const sessionId of ids) {
      const roster = settled(() => this.pool.sessionObject(sessionId).rosterEligible)
      if (roster === LOADING) pending = true
      else if (roster) count++
    }
    return pending ? LOADING : count
  }
  readAttached(id: string): readonly SessionView[] | typeof LOADING {
    const present = this.present(id), archived = this.seatRows('missionSessions', id, true)
    if (present === LOADING || archived === LOADING) return LOADING
    return [...present, ...archived].sort(this.sessionOrder)
  }
  readIssueMembers(id: string): IssueMemberFacts | typeof LOADING {
    const issue = this.facts(id)
    return settled(() => ({ ids: issue.memberSessionIds, latest: issue.memberLatestActivity, summary: issue.memberSummary }))
  }
  /** The present and archived seats are both settled (history rows loaded). */
  settled(id: string): boolean {
    return this.present(id) !== LOADING && this.history(id) !== LOADING
  }
  /** First session in session order among the present and archived candidates. */
  earlier(present: SessionView | undefined, archived: SessionView | undefined): SessionView | undefined {
    return !present ? archived : !archived ? present : this.sessionOrder(present, archived) <= 0 ? present : archived
  }
  /** `newestSession` over the whole roster: the latest activity, earlier session order on a tie. */
  newest(id: string): SessionView | undefined {
    const present = this.present(id), history = this.history(id)
    if (present === LOADING || history === LOADING) throw LOADING
    const left = newestSession(present), right = this.resolve(history.newest)
    if (!left || !right || left.lastActiveAt === right.lastActiveAt) return this.earlier(left, right)
    return left.lastActiveAt > right.lastActiveAt ? left : right
  }
  /** The first session, present or archived, that moved to another issue. */
  moved(id: string): SessionView | undefined {
    const present = this.present(id), history = this.history(id)
    if (present === LOADING || history === LOADING) throw LOADING
    return this.earlier(present.find(session => session.handoffTarget), this.resolve(history.moved))
  }
  /** One session's row by id, for an aggregate's chosen member. */
  resolve(sessionId: string | undefined): SessionView | undefined {
    if (sessionId === undefined) return undefined
    const session = this.session(sessionId)
    if (session === LOADING) throw LOADING
    return session
  }
  /** The latest prompt among the given archived senders' winners. */
  latestPrompt(ids: Iterable<string>): string | undefined {
    const winners: SessionFacts[] = []
    for (const id of ids) {
      const facts = this.sessionFacts(id)
      if (facts === LOADING) throw LOADING
      if (facts) winners.push(facts)
    }
    return latestPromptOf(winners)
  }
  /** An explicit mission sender of this issue, by id, without reading its roster. */
  member(id: string, sessionId: string): SessionView | undefined {
    if (this.pool.graph.one('session', sessionId, 'missionIssue') !== id) return undefined
    const session = this.session(sessionId)
    if (session === LOADING) throw LOADING
    return session
  }
  readIssue(id: string): Loaded<IssueNavigationModel> {
    this.stats.issueReads++
    const raw = omitGone(this.pool.row('issue', id))
    if (raw === LOADING || !raw) return raw
    const row = raw as Omit<IssueNavigationModel, 'description' | 'notes'> & { description: string | { value: string }; notes?: string | { value: string } }
    if (!this.settled(id)) return LOADING
    // Replica-derived member IDs exclude shells, but include archived/headless
    // attachments. The drawn roster applies its additional headless filter.
    // Archived members contribute through their own cached facts.
    // Without archived members a heartbeat walks only seated ones.
    const members = this.issueMembers(id)
    let pending = members === LOADING
    const childIds = [...this.pool.graph.many('issue', id, 'treeChildren')]
    const { childDoneCount } = this.pool.queries.issueChildCounts(id)
    // One declared inverse yields source IDs. Reading each source's declared
    // edge list preserves custom types, duplicate edges and per-source order.
    const dependents: IssueNavigationModel['dependents'] = []
    for (const sourceId of [...this.pool.graph.many('issue', id, 'pageDependents')].sort()) {
      const source = omitGone(this.pool.row('issue', sourceId)) as Loaded<IssueNavigationModel>
      if (source === LOADING) pending = true
      else if (source) for (const dep of source.deps ?? []) {
        if (dep.id === id) dependents.push({ id: asIssueId(sourceId), type: dep.type })
      }
    }
    if (pending || members === LOADING) return LOADING
    const repoId = this.pool.graph.one('issue', id, 'repo')
    const repo = repoId ? omitGone(this.pool.row('repo', repoId)) as { prefix?: string } | undefined : undefined
    const readAt = this.pool.readCursor(id) ?? null
    let unread = !readAt || !Number.isFinite(Date.parse(readAt)) || Date.parse(row.updatedAt) > Date.parse(readAt)
    unread ||= members.latest > Date.parse(readAt ?? '')
    const deferAt = row.deferUntil ? Date.parse(row.deferUntil) : NaN
    const deferred = Number.isFinite(deferAt) && !this.pool.clock.reached(deferAt)
    return issueNavigationOverlay(row, {
      description: typeof row.description === 'string' ? row.description : row.description?.value ?? '',
      notes: typeof row.notes === 'string' ? row.notes : row.notes?.value,
      worktreePath: row.worktreePath ?? null, branch: row.branch ?? null,
      prefix: repo?.prefix, displayRef: joinedIssueRef({ seq: row.seq, prefix: repo?.prefix }),
      readAt, memberSessionIds: members.ids,
      childIds: [...childIds].sort().map(asIssueId), childCount: childIds.length, childDoneCount,
      deferred, ready: !row.blocked && !deferred && !this.facts(id).finished, dependents,
      unread: row.deletedAt ? false : unread, sessionSummary: members.summary,
    }) as IssueNavigationModel
  }
  roster(id: string, archived = false): readonly SessionView[] | typeof LOADING {
    const seats = archived ? this.seatRows('missionSessions', id, true) : this.present(id)
    if (seats === LOADING) return LOADING
    return (archived ? [...seats].sort(this.sessionOrder) : seats)
      .filter(session => { const model = this.pool.sessionObject(session.sessionId); return archived ? model.archived && model.rosterEligible : model.onRoster })
  }
  rootFor(selectedId: string | null): Loaded<string> {
    const root = missions(this.pool).rootFor(selectedId)
    if (root !== LOADING || !selectedId) return root
    // The shared root reader supplies the answer. Request its cold ancestry
    // together so a long retained parent chain does not load one row per frame.
    const seen = new Set<string>()
    let id: string | null = selectedId
    while (id && !seen.has(id)) {
      seen.add(id)
      const currentId = id
      const facts = omitGone(this.pool.row('issue', id, 'summary')) as Loaded<{ archived?: boolean; deletedAt?: string }>
      const visible = settled(() => this.facts(currentId).visible)
      if (facts === undefined || visible === false) break
      void omitGone(this.pool.row('issue', id))
      id = this.pool.graph.one('issue', id, 'parent')
    }
    return LOADING
  }
  selectedRoot(selectedId: string | null): Loaded<IssueNavigationModel> {
    const rootId = this.rootFor(selectedId)
    if (rootId === LOADING || !rootId) return rootId === LOADING ? LOADING : undefined
    return this.rootValue(rootId)
  }
  private rootValue(rootId: string): Loaded<IssueNavigationModel> {
    const root = this.issue(rootId)
    if (root === LOADING || !root || !this.facts(rootId).visible) return root === LOADING ? LOADING : undefined
    if (root.isDraftVessel && !root.worktreePath) {
      const sessions = this.present(rootId)
      if (sessions === LOADING || this.history(rootId) === LOADING) return LOADING
      if (sessions.length === 0) return undefined
    }
    return root
  }
  title(issue: IssueNavigationModel): string | typeof LOADING {
    if (!issue.isDraftVessel || !['', DRAFT_ISSUE_TITLE].includes(issue.title.trim())) return issue.title
    const crew = this.roster(issue.id)
    if (crew === LOADING) return LOADING
    return crew[0]?.name?.trim() || (crew[0] ? `New ${panelLabel(crew[0].agentKind)} session` : 'New agent')
  }
  /** Request the addressed neighbourhood together before presentation reads
   * can stop at the first cold child and split one batch into N batches. */
  prepareHandoff(members: ReadonlySet<string>): boolean {
    const drawn = new Set<string>(), tips = new Set<string>(), addressed = new Set<string>()
    let pending = false
    const visibleId = (id: string) => {
      const row = omitGone(this.pool.row('issue', id, 'summary')) as Loaded<{ archived?: boolean; deletedAt?: string | null }>
      if (row === LOADING) { pending = true; return false }
      return Boolean(row && this.facts(id).visible)
    }
    const formal = [...members]
    while (formal.length) {
      const id = formal.pop()!
      if (drawn.has(id) || !visibleId(id)) continue
      drawn.add(id); formal.push(...this.pool.graph.many('issue', id, 'children'))
    }
    const departed = [...drawn]
    while (departed.length) {
      const id = departed.pop()!
      if (tips.has(id) || !visibleId(id)) continue
      tips.add(id); departed.push(...this.pool.graph.many('issue', id, 'spinOffs'))
    }
    for (const id of tips) {
      addressed.add(id)
      for (const target of this.pool.graph.many('issue', id, 'pageDependencies')) addressed.add(target)
      for (const relation of ['treeParent', 'supersedingIssue', 'canonicalIssue']) {
        const target = this.pool.graph.one('issue', id, relation)
        if (target) addressed.add(target)
      }
    }
    for (const id of addressed) {
      const issue = this.issue(id)
      if (issue === LOADING) pending = true
      else if (issue && tips.has(id)) for (const dep of issue.deps) {
        if (this.issue(dep.id) === LOADING) pending = true
        if (!this.settled(dep.id)) pending = true
      }
      if (!this.settled(id)) pending = true
    }
    return !pending
  }
  archiveCount(deck: MissionDeckModel): number | typeof LOADING { return deck.archivedCount }
  readArchiveCount(deck: MissionDeckModel): number | typeof LOADING {
    return settled(() => {
      let count = 0, pending = false
      for (const id of requireLoaded(deck.rowIds())) {
        const roster = this.historyRosterCount(id)
        if (roster === LOADING) pending = true
        else count += roster
      }
      return pending ? LOADING : count
    })
  }
  addressedIds(deck: MissionDeckModel): string[] {
    const ids = new Set(requireLoaded(deck.topology).scope)
    const stack = [...ids]
    let pending = false
    while (stack.length) {
      const id = stack.pop()!
      for (const child of this.pool.graph.many('issue', id, 'spinOffs')) {
        if (ids.has(child)) continue
        const visible = settled(() => this.facts(child).visible)
        if (visible === LOADING) pending = true
        else if (visible) { ids.add(child); stack.push(child) }
      }
    }
    for (const id of [...ids]) {
      for (const target of this.pool.graph.many('issue', id, 'pageDependencies')) ids.add(target)
      const issue = this.catalogIssue(id)
      if (issue === LOADING) { pending = true; continue }
      for (const target of [issue?.supersededBy, issue?.duplicateOf, issue?.stage === 'proposed' ? issue.parentId : null]) if (target) ids.add(target)
    }
    const present: string[] = []
    // These are independent inputs for one phone crew. Keep visiting the
    // cohort so cold siblings and references share the same load window.
    for (const id of ids) {
      const issue = this.catalogIssue(id)
      if (issue === LOADING) pending = true
      else if (issue) present.push(id)
    }
    if (pending) throw LOADING
    return present
  }
  deckValues(deck: MissionDeckModel): MissionViewValues {
    const view = this
    return {
      deck,
      get root() { return requireLoaded(view.issue(deck.id)) },
      get members() { return requireLoaded(deck.members) },
      get rows() { return deck.rows() },
      get issueIds() { return view.addressedIds(deck) },
      get sessions() {
        const sessions = new Map<string, SessionView>()
        for (const id of view.addressedIds(deck)) for (const session of requireLoaded(view.present(id))) sessions.set(session.sessionId, session)
        return [...sessions.values()].sort(view.sessionOrder)
      },
      get archivedCount() { return requireLoaded(view.archiveCount(deck)) },
      get titles() { return new Map(requireLoaded(deck.rowIds()).map(id => [id, deck.model(id).title])) },
      get rowPresentation() { return new Map(requireLoaded(deck.rowIds()).map(id => [id, deck.model(id).presentation])) },
      get progress() { return requireLoaded(deck.progress) },
      get continuation() { return deck.continuation },
      get note() { return deck.note },
      get presence() { return deck.presence },
      get departures() { return deck.departures },
    }
  }
  departures(deck: MissionDeckModel): MissionDeparture[] {
    const members = requireLoaded(deck.members), found: MissionDeparture[] = [], seen = new Set<string>()
    let pending = false
    for (const id of [...members].sort()) {
      if (!this.facts(id).visible) continue
      if (this.pool.graph.size('issue', id, 'spinOffs') === 0) continue
      const result = settled(() => {
        const empty = !requireLoaded(this.roster(id)).some(session => this.pool.sessionObject(session.sessionId).open)
        for (const tip of this.tips(id)) {
          if (members.has(tip.id) || seen.has(tip.id) || (!empty && this.facts(tip.id).finished)) continue
          const value = settled(() => {
            const issue = requireLoaded(this.issue(tip.id))!
            const crew = requireLoaded(this.roster(tip.id))
            return { issue, originId: id, state: this.presentation(issue, crew).state }
          })
          if (value === LOADING) pending = true
          else { seen.add(tip.id); found.push(value) }
        }
      })
      if (result === LOADING) pending = true
    }
    if (pending) throw LOADING
    return found.sort((a, b) => a.issue.seq - b.issue.seq)
  }
  private presentStrict(id: string) { return requireLoaded(this.present(id)) }
  private rosterStrict(id: string, archived = false) { return [...requireLoaded(this.roster(id, archived))] }
  rulesIssue(id: string): IssueNavigationModel | undefined {
    return this.node(id).rules
  }
  readRulesIssue(id: string): IssueNavigationModel | undefined {
    const raw = this.catalogIssue(id)
    if (!raw) return undefined
    let pending = raw === LOADING
    const dependents: IssueNavigationModel['dependents'] = []
    for (const sourceId of [...this.pool.graph.many('issue', id, 'pageDependents')].sort()) {
      const source = this.catalogIssue(sourceId)
      if (source === LOADING) pending = true
      else if (source) for (const dep of source.deps ?? []) if (dep.id === id) dependents.push({ id: asIssueId(sourceId), type: dep.type })
    }
    if (pending || raw === LOADING) throw LOADING
    return issueNavigationOverlay(raw, { dependents }) as IssueNavigationModel
  }
  hasSpinOffDependent(id: string) { return this.rulesIssue(id)?.dependents.some(dep => dep.type === 'discovered-from') ?? false }
  tipIds(id: string, local = false) { return this.tips(id, local).map(issue => issue.id as string) }
  presentation(issue: IssueNavigationModel, sessions: readonly SessionView[]): MissionRowPresentation {
    let state = deckIssueState(issue, sessions)
    if (['retired', 'proposed', 'next', 'idle'].includes(state.state) && this.waiting(issue).length)
      state = { ...state, state: 'waiting', label: 'Waiting' }
    return { state, note: this.note(issue, true), presence: this.presence(issue, sessions, true) }
  }
  live(id: string) { return this.facts(id).live }
  lastActive(issue: IssueNavigationModel, local: boolean) {
    return local ? issue.updatedAt : this.presentStrict(issue.id).reduce((latest, session) =>
      !session.archived && session.lastActiveAt > latest ? session.lastActiveAt : latest, issue.updatedAt)
  }
  preferred(candidates: readonly IssueNavigationModel[], local = false): IssueNavigationModel | undefined {
    const staffed = local ? [] : candidates.filter(issue => this.facts(issue.id).live)
    const unfinished = candidates.filter(issue => !this.facts(issue.id).finished)
    return [...(staffed.length ? staffed : unfinished.length ? unfinished : candidates)]
      .sort((a, b) => this.lastActive(b, local).localeCompare(this.lastActive(a, local)))[0]
  }
  tips(origin: string, local = false): IssueNavigationModel[] {
    if (this.pool.graph.size('issue', origin, 'spinOffs') === 0) return []
    return (local ? this.node(origin).localTips : this.node(origin).liveTips)
  }
  readTips(origin: string, local: boolean): IssueNavigationModel[] {
    const seen = new Set<string>(), descendants: IssueNavigationModel[] = []
    let pending = false
    const stack = [origin]
    while (stack.length) {
      const parentId = stack.pop()!
      const children = [...this.pool.graph.many('issue', parentId, 'spinOffs')].sort()
      for (const id of children) {
        if (seen.has(id)) continue
        seen.add(id)
        // The relation preserves the legacy first discovered-from edge.
        // Parenting is an ID question; it need not wait for rich issue rows.
        if (this.pool.graph.one('issue', id, 'discoveredFrom') !== parentId) continue
        const visible = settled(() => this.facts(id).visible)
        if (visible === false) continue
        // Metadata, dependent-source fields and staffing are independent
        // inputs for this same candidate. Request them in the same window.
        const issue = settled(() => this.rulesIssue(id))
        const live = local ? false : settled(() => this.live(id))
        if (visible === LOADING || issue === LOADING || live === LOADING) { pending = true; stack.push(id); continue }
        if (!issue) continue
        descendants.push(issue); stack.push(id)
      }
    }
    if (!local) for (const issue of descendants) if (settled(() => this.facts(issue.id).live) === LOADING) pending = true
    if (pending) throw LOADING
    const branches = new Map<string, IssueNavigationModel[]>()
    for (const issue of descendants) {
      if (!leftMission(issue) && (local || !this.facts(issue.id).live)) continue
      let branchId: string = issue.id, parentId = this.pool.graph.one('issue', issue.id, 'discoveredFrom')
      const path = new Set<string>([issue.id])
      while (parentId && parentId !== origin) {
        if (path.has(parentId)) { parentId = null; break }
        path.add(parentId)
        branchId = parentId
        parentId = this.pool.graph.one('issue', parentId, 'discoveredFrom')
      }
      if (parentId !== origin) continue
      const candidates = branches.get(branchId) ?? []
      candidates.push(issue); branches.set(branchId, candidates)
    }
    return [...branches.values()].flatMap(candidates => {
      const tip = this.preferred(candidates, local)
      return tip ? [tip] : []
    })
  }
  continuation(issue: IssueNavigationModel, local = false): IssueContinuation | null {
    const targetId = issue.supersededBy
      ? this.pool.graph.one('issue', issue.id, 'supersedingIssue') ?? issue.supersededBy
      : this.pool.graph.one('issue', issue.id, 'canonicalIssue') ?? issue.duplicateOf
    if (targetId) {
      const target = requireLoaded(this.catalogIssue(targetId)), ref = target ? issueDisplayRef(target) : 'another task'
      return issue.supersededBy ? { kind: 'superseded', ...(target ? { target } : {}), short: ref,
        full: `Work continued in ${ref}`, line: `continued · ${ref}` } :
        { kind: 'duplicate', ...(target ? { target } : {}), short: ref,
          full: `The same work is tracked in ${ref}`, line: `duplicate · ${ref}` }
    }
    if ((local ? this.rosterStrict(issue.id) : this.presentStrict(issue.id)).some(session => this.pool.sessionObject(session.sessionId).open)) return null
    const tip = this.preferred(this.tips(issue.id, local), local)
    if (!tip) return null
    const ref = issueDisplayRef(tip)
    return { kind: 'spinoff', target: tip, short: ref, full: `Work continued in ${ref}`, line: `continued · ${ref}` }
  }
  waiting(issue: IssueNavigationModel): string[] {
    return issue.deps.filter(dep => dep.type === 'blocks').flatMap(dep => {
      const target = requireLoaded(this.catalogIssue(dep.id))
      return target && !this.facts(target.id).finished ? [issueDisplayRef(target)] : []
    })
  }
  blockLabel(issue: IssueNavigationModel) {
    const refs = this.waiting(issue)
    return refs.length === 1 ? `Blocked by ${refs[0]}` : refs.length > 1 ? `Blocked by ${refs.length} tasks` :
      issue.blockedByNotes?.map(line => line.trim()).find(Boolean) ?? 'Waiting on dependency'
  }
  waitingLabel(issue: IssueNavigationModel) {
    const refs = this.waiting(issue)
    return refs.length === 1 ? `Waiting for ${refs[0]} to complete` : refs.length ? `Waiting for ${refs.length} tasks to complete` : null
  }
  note(issue: IssueNavigationModel, local = false): IssueNote | null {
    const continuation = this.continuation(issue, local)
    if (continuation) return { kind: 'continued', label: 'continued in', short: continuation.short, full: continuation.full }
    const refs = this.waiting(issue), short = refs.length === 1 ? refs[0]! : `${refs.length} tasks`
    if (issue.blocked) {
      const full = this.blockLabel(issue)
      return { kind: 'blocked', label: refs.length ? 'blocked by' : null, short: refs.length ? short : full, full }
    }
    if (refs.length) return { kind: 'waiting', label: 'waiting for', short, full: this.waitingLabel(issue)! }
    if (issue.stage === 'proposed') {
      const spin = originId(issue), sourceId = spin ?? issue.parentId
      if (sourceId) {
        const source = requireLoaded(this.catalogIssue(sourceId)), ref = source ? issueDisplayRef(source) : null
        return spin ? { kind: 'shape-own', label: 'starts', short: 'on its own',
          full: ref ? `Starts on its own — ${ref} can close without it` : 'Starts on its own — the task that found it can close without it' } :
          { kind: 'shape-mission', label: 'starts', short: 'in this mission',
            full: ref ? `Part of ${ref} — that task is not done until this is` : 'Part of the task that found it — that task is not done until this is' }
      }
    }
    const verbs: Record<string, string> = { 'discovered-from': 'Discovered from', related: 'Related to', tracks: 'Tracks', supersedes: 'Supersedes', 'caused-by': 'Caused by', validates: 'Validates' }
    for (const dep of issue.deps) {
      if (dep.type === 'blocks' || dep.type === 'parent-child') continue
      const target = requireLoaded(this.catalogIssue(dep.id))
      if (!target) continue
      const label = verbs[dep.type] ?? dep.type, ref = issueDisplayRef(target)
      return { kind: 'relation', label, short: ref, full: `${label} ${ref}` }
    }
    return null
  }
  /** `sessions` is a drawn roster; `roster` names the issue whose whole
   * roster (archived included) answers which session moved. */
  presence(issue: IssueNavigationModel, sessions: readonly SessionView[], local = false, roster?: string): PresenceNote | null {
    if (sessions.some(session => this.pool.sessionObject(session.sessionId).open)) return null
    const moved = roster === undefined ? sessions.find(session => session.handoffTarget) : this.moved(roster)
    if (moved) return { kind: 'moved', text: `Session moved to ${moved.handoffTarget}`, attention: false }
    const continuation = this.continuation(issue, local)
    if (continuation) return { kind: 'moved', text: continuation.full, attention: false }
    if (issue.blocked) return { kind: 'blocked', text: this.blockLabel(issue), attention: false }
    const waiting = this.waitingLabel(issue)
    if (waiting) return { kind: 'waiting', text: waiting, attention: false }
    if (this.facts(issue.id).finished) return { kind: 'done', text: issueAbandoned(issue) ? 'Cancelled · session retired' : 'Completed · session retired', attention: false }
    if (issue.stage === 'review') return { kind: 'review', text: 'Review ready · session ended', attention: false }
    if (issue.stage === 'shipping') return { kind: 'shipping', text: 'Shipping service has custody', attention: false }
    if (issue.stage === 'planning' || issue.stage === 'backlog') return { kind: 'ready', text: 'Ready to start', attention: false }
    if (issue.stage === 'in_progress') return { kind: 'attention', text: 'Agent left · choose a handoff', attention: true }
    return { kind: 'ready', text: 'Proposed · not started', attention: false }
  }
  dispose = () => {
    this.card = companion(issue => new MissionIssueReader(issue, this))
    this.fullDeck = companion(issue => new MissionDeckModel(issue, this, 'full'))
    this.workingDeck = companion(issue => new MissionDeckModel(issue, this, 'working'))
    this.askingDeck = companion(issue => new MissionDeckModel(issue, this, 'needs-you'))
  }
}

export function missionView(pool: MobxPool): MissionViewReader {
  return pool.sources.view('missionView', () => new MissionViewReader(pool))
}

export function readMissionView(view: MissionViewReader, selectedId: string | null, mode: FlightDeckMode = 'full'): MissionViewValues | typeof LOADING {
  return view.values(selectedId, mode)
}
function deriveMissionArchive(view: MissionViewReader, rowIds: readonly string[] | typeof LOADING): SessionView[] | typeof LOADING {
  if (rowIds === LOADING) return LOADING
  const seen = new Set<string>(), archived: SessionView[] = []
  for (const id of rowIds) {
    const roster = view.roster(id, true)
    if (roster === LOADING) return LOADING
    for (const session of roster) if (!seen.has(session.sessionId)) { seen.add(session.sessionId); archived.push(session) }
  }
  return archived
}

function newestSession(sessions: readonly SessionView[]): SessionView | undefined {
  let newest: SessionView | undefined
  for (const session of sessions) {
    if (!newest || session.lastActiveAt > newest.lastActiveAt) newest = session
  }
  return newest
}

const NOW_RANK: Record<HandoffNowEntry['kind'], number> = {
  working: 0,
  review: 1,
  blocked: 2,
  stalled: 2,
  'needs-you': 3,
}

/** Current mission exceptions, one truthful row per issue. */
function poolHandoffNow(ctx: MissionViewReader, issues: readonly IssueNavigationModel[], memberIds: ReadonlySet<string>): HandoffNowEntry[] {
  const entries: Array<{ entry: HandoffNowEntry; seq: number }> = []

  for (const issue of issues) {
    if (!memberIds.has(issue.id) || issue.stage === 'proposed' || !ctx.facts(issue.id).visible)
      continue
    const crew = requireLoaded(ctx.present(issue.id))
    const present = crew.filter(session => ctx.pool.sessionObject(session.sessionId).open)
    const asking = present.find(
      (session) => ctx.pool.sessionObject(session.sessionId).asking && !ctx.facts(issue.id).finished || ctx.pool.sessionObject(session.sessionId).motion === 'waiting',
    )
    const askedBy = issue.asked?.by ? ctx.member(issue.id, issue.asked.by) : undefined
    const explicitNeed = issue.needsHuman === true || asking !== undefined
    let entry: HandoffNowEntry | null = null

    if (explicitNeed && !ctx.facts(issue.id).finished) {
      const session = asking ?? askedBy
      entry = {
        kind: 'needs-you',
        issueId: issue.id,
        ...(session ? { sessionId: session.sessionId } : {}),
        text:
          session?.agentState?.need?.summary?.trim() ||
          issue.asked?.question?.trim() ||
          'Waiting on you.',
      }
    } else {
      const working = present.find(session => ctx.pool.sessionObject(session.sessionId).atWork)
      if (working) {
        entry = {
          kind: 'working',
          issueId: issue.id,
          sessionId: working.sessionId,
          text:
            (issue.blocked ? ctx.blockLabel(issue) : null) ??
            ctx.presence(issue, crew, false, issue.id)?.text ??
            'Agent computing now.',
        }
      } else if (issue.stage === 'review' && !issue.blocked) {
        const session = ctx.newest(issue.id)
        entry = {
          kind: 'review',
          issueId: issue.id,
          ...(session ? { sessionId: session.sessionId } : {}),
          text: 'Ready for review.',
        }
      } else if (issue.blocked) {
        const session = newestSession(present)
        entry = {
          kind: 'blocked',
          issueId: issue.id,
          ...(session ? { sessionId: session.sessionId } : {}),
          text:
            (issue.blocked ? ctx.blockLabel(issue) : null) ??
            ctx.presence(issue, crew, false, issue.id)?.text ??
            'Waiting on dependency.',
        }
      } else if (
        (issue.stage === 'planning' || issue.stage === 'in_progress') &&
        present.length === 0
      ) {
        entry = {
          kind: 'stalled',
          issueId: issue.id,
          text:
            ctx.presence(issue, crew, false, issue.id)?.text ??
            'Started with no present session.',
        }
      }
    }

    if (entry) entries.push({ entry, seq: issue.seq })
  }

  entries.sort(
    (left, right) => NOW_RANK[left.entry.kind] - NOW_RANK[right.entry.kind] || left.seq - right.seq,
  )
  return entries.map(({ entry }) => entry)
}


function poolHandoffNext(ctx: MissionViewReader, issues: readonly IssueNavigationModel[], memberIds: ReadonlySet<string>): HandoffNextEntry[] {
  const entries: Array<{ entry: HandoffNextEntry; seq: number; depth: number }> = []
  const depthMemo = new Map<string, number>()

  const prerequisites = (issue: IssueNavigationModel): IssueNavigationModel[] => {
    const blockers = (issue.deps ?? [])
      .filter((dep) => dep.type === 'blocks')
      .map((dep) => requireLoaded(ctx.issue(dep.id)))
      .filter((candidate): candidate is IssueNavigationModel =>
        Boolean(candidate && !ctx.facts(candidate.id).finished),
      )
    return [...blockers, ...poolOpenChildren(ctx, memberIds, issue.id)]
  }
  const depthOf = (issue: IssueNavigationModel, visiting = new Set<string>()): number => {
    const memo = depthMemo.get(issue.id)
    if (memo !== undefined) return memo
    if (visiting.has(issue.id)) return 0
    const nextVisiting = new Set(visiting).add(issue.id)
    const deps = prerequisites(issue)
    const depth =
      deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep, nextVisiting)))
    depthMemo.set(issue.id, depth)
    return depth
  }

  for (const issue of issues) {
    if (
      !memberIds.has(issue.id) ||
      issue.stage === 'proposed' ||
      !ctx.facts(issue.id).visible ||
      ctx.facts(issue.id).finished
    )
      continue
    const openBlockers = (issue.deps ?? [])
      .filter((dep) => dep.type === 'blocks')
      .map((dep) => requireLoaded(ctx.issue(dep.id)))
      .filter((candidate): candidate is IssueNavigationModel =>
        Boolean(candidate && !ctx.facts(candidate.id).finished),
      )
    const children = poolOpenChildren(ctx, memberIds, issue.id)
    const session = ctx.newest(issue.id)
    let entry: HandoffNextEntry | null = null

    if (issue.stage === 'review' && openBlockers.length === 0) {
      entry = {
        issueId: issue.id,
        ...(session ? { sessionId: session.sessionId } : {}),
        text: `Review and land ${issueDisplayRef(issue)}.`,
      }
    } else if (openBlockers.length === 1) {
      const blocker = openBlockers[0] as IssueNavigationModel
      entry = {
        issueId: issue.id,
        afterIssueId: blocker.id,
        ...(session ? { sessionId: session.sessionId } : {}),
        text: `After ${issueDisplayRef(blocker)} closes, resume ${issueDisplayRef(issue)}.`,
      }
    } else if (openBlockers.length === 0 && children.length === 1) {
      const child = children[0] as IssueNavigationModel
      entry = {
        issueId: issue.id,
        afterIssueId: child.id,
        ...(session ? { sessionId: session.sessionId } : {}),
        text: `After ${issueDisplayRef(child)} closes, resume ${issueDisplayRef(issue)}.`,
      }
    } else if (issue.stage === 'backlog' && issue.ready && openBlockers.length === 0) {
      entry = { issueId: issue.id, text: `${issueDisplayRef(issue)} is ready to start.` }
    }

    if (entry) entries.push({ entry, seq: issue.seq, depth: depthOf(issue) })
  }

  entries.sort((left, right) => left.depth - right.depth || left.seq - right.seq)
  return entries.map(({ entry }) => entry)
}

function poolOpenChildren(ctx: MissionViewReader, members: ReadonlySet<string>, parentId: string): IssueNavigationModel[] {
  return [...ctx.pool.graph.many('issue', parentId, 'treeChildren')].flatMap(id => {
    if (!members.has(id)) return []
    const issue = requireLoaded(ctx.issue(id))
    return issue && issue.stage !== 'proposed' && ctx.facts(issue.id).visible && !ctx.facts(issue.id).finished ? [issue] : []
  }).sort(rowOrder)
}
export interface MissionHandoffValues {
  /** The mission's seated (non-archived) senders, in session order. */
  crew: readonly SessionView[]
  /** Archived senders, summarized: how many, and the latest prompt among them. */
  retired: { readonly count: number; readonly latestPrompt: SessionView | null }
  current: readonly HandoffNowEntry[]
  next: readonly HandoffNextEntry[]
}
export const EMPTY_MISSION_HANDOFF: MissionHandoffValues = Object.freeze({
  crew: [], retired: Object.freeze({ count: 0, latestPrompt: null }), current: [], next: [],
})

export function readWorkspaceMission(view: MissionViewReader, selectedId: string | null, focusedId: string | null) {
  const selected = selectedId ? view.issue(selectedId) : undefined
  if (selected === LOADING) return LOADING
  const rootId = selected && view.facts(selected.id).visible ? view.rootFor(selected.id) : undefined
  if (rootId === LOADING) return LOADING
  const missionRoot = rootId ? view.issue(rootId) : undefined
  if (missionRoot === LOADING) return LOADING
  const missionIds = missionRoot ? missions(view.pool).members(missionRoot.id) : new Set<string>()
  if (missionIds === LOADING) return LOADING
  const missionIssues: IssueNavigationModel[] = []
  let pending = false
  for (const id of [...missionIds].sort()) {
    const issue = view.issue(id)
    if (issue === LOADING) pending = true
    else if (issue) missionIssues.push(issue)
    if (!view.settled(id)) pending = true
  }
  if (pending) return LOADING
  const focused = focusedId && missionIds.has(focusedId) ? view.issue(focusedId) : undefined
  if (focused === LOADING) return LOADING
  const missionOnScreen = view.selectedRoot(selectedId)
  if (missionOnScreen === LOADING) return LOADING
  const hasAnyTask = settingsHasFirstTask(view.pool)
  if (hasAnyTask === LOADING) return LOADING
  return { missionRoot, missionIds, missionIssues, issue: focused ?? missionRoot, missionOnScreen, hasAnyTask: Boolean(hasAnyTask), loading: false as boolean }
}

export type MissionMenuHandoff = { blocker: 'no-agent-session' | 'multiple-sessions' } | { session: SessionView }
export interface MissionActionInputs {
  issues: IssueNavigationModel[]
  allIssues: IssueNavigationModel[]
  sessions: SessionView[]
  repos: GitRepositoryWire[]
  machines: MachineWire[]
  session?: SessionView
  issue?: IssueNavigationModel
  handoff?: MissionMenuHandoff
}
/** Called by mounted menus. Global choices belong to the label/duplicate
 * flyout; a session menu never asks for its issue's other senders. */
export function readMissionActionInputs(view: MissionViewReader, issueIds: readonly string[], sessionId?: string, handoffEnabled = true, targetsOpen = false): MissionActionInputs | typeof LOADING {
  const selected: IssueNavigationModel[] = []
  const session = sessionId ? view.menuSession(sessionId) : undefined
  if (session === LOADING) return LOADING
  const requested = sessionId ? (handoffEnabled && session?.issueId ? [session.issueId] : []) : issueIds
  for (const id of requested) {
    const issue = sessionId ? view.menuCatalogIssue(id) : view.menuIssue(id)
    if (issue === LOADING) return LOADING
    if (issue) selected.push(issue)
  }
  const handoff = handoffEnabled && !sessionId && selected.length === 1 ? view.menuHandoff(selected[0]!.id) : undefined
  if (handoff === LOADING) return LOADING
  const subject = handoffEnabled ? session ?? (handoff && 'session' in handoff ? handoff.session : undefined) : undefined
  // Handoff needs its containing lane and the issue's drift fallback. Other
  // worktrees in the same repository are hidden and remain unread.
  const source = subject ? headerEntities(view.pool).shippingScope(subject.cwd, subject.machineId)?.handoff : undefined
  const anchorPath = source && machinePathsEqual(source.worktreePath, source.repoPath) && selected[0]?.worktreePath
  const anchorScope = anchorPath ? headerEntities(view.pool).shippingScope(anchorPath, subject?.machineId)?.handoff : undefined
  const anchor = anchorScope && anchorPath && machinePathsEqual(anchorScope.worktreePath, anchorPath) && (!source || !machinePathsEqual(anchorScope.worktreePath, source.worktreePath)) ? anchorScope : undefined
  // The parent menu displays only source eligibility. Clone checkouts and
  // destination capabilities belong to the opened target submenu.
  const group = source && targetsOpen ? headerEntities(view.pool).repositoryGroup(source.repoPath) : []
  // A non-primary clone has its own source address, while group(path) names
  // the primary checkout. The opened picker can consult the existing root
  // catalog in that case; standalone history worktrees remain excluded.
  const repositoryIds = source ? targetsOpen ? group.length ? group : headerEntities(view.pool).repositoryRootIds() : [source.repositoryId] : []
  const repos = repositoryIds.flatMap(id => {
    const repo = headerView(view.pool).row('repository', id)
    if (!repo) return []
    const worktrees = [source, anchor].flatMap(tree => tree && machinePathsEqual(tree.repoPath, repo.path) && !machinePathsEqual(tree.worktreePath, repo.path) &&
      (subject?.machineId === undefined || repo.machineId === subject.machineId) ? [{ path: tree.worktreePath }] : [])
    return [{ ...repo, worktrees }]
  })
  // The full target picker stays inside the deferred menu component. Here
  // only source eligibility decides whether any machine choices are shown.
  const needsTargets = subject && (HANDOFF_HARNESS_KINDS as readonly string[]).includes(subject.agentKind) &&
    repos.some(repo => repo.repoId) && repos.some(repo => repo.worktrees.length > 0)
  // The sender is never a target. Exclude its address before observing any
  // payload so its login/capability changes cannot wake this menu.
  const machines = targetsOpen && needsTargets ? headerView(view.pool).ids('machine').flatMap(id => {
    if (id === subject?.machineId) return []
    const machine = headerView(view.pool).row('machine', id)
    return machine ? [machine] : []
  }) : []
  return { issues: selected, allIssues: selected, sessions: handoff && 'session' in handoff ? [handoff.session] : [], repos,
    machines, session, issue: selected[0], handoff }
}
/** Called only by a mounted Handoff target submenu. */
export function readMissionHandoffTargets(view: MissionViewReader, sessionId: string): Pick<MissionActionInputs, 'repos' | 'machines'> | typeof LOADING {
  const inputs = readMissionActionInputs(view, [], sessionId, true, true)
  return inputs === LOADING ? LOADING : { repos: inputs.repos, machines: inputs.machines }
}
export function readMissionHandoff(view: MissionViewReader, rootId: string): MissionHandoffValues | typeof LOADING {
  return view.handoff(rootId)
}
function deriveMissionHandoff(view: MissionViewReader, rootId: string): MissionHandoffValues | typeof LOADING {
  try {
    const members = missions(view.pool).members(rootId)
    if (members === LOADING) return LOADING
    if (!view.prepareHandoff(members)) return LOADING
    const ctx = view
    const issues = [...members].sort().flatMap(id => { const issue = requireLoaded(ctx.issue(id)); return issue ? [issue] : [] })
    const crew = [...new Map([...members].flatMap(id => requireLoaded(ctx.present(id))).map(session => [session.sessionId, session])).values()].sort(view.sessionOrder)
    // A session has one issue, so member histories never overlap.
    let count = 0
    const winners: string[] = []
    for (const id of members) {
      const history = view.history(id)
      if (history === LOADING) return LOADING
      count += history.count
      if (history.latestPrompt !== undefined) winners.push(history.latestPrompt)
    }
    const latestPrompt = view.resolve(view.latestPrompt(winners)) ?? null
    return { crew, retired: { count, latestPrompt }, current: poolHandoffNow(ctx, issues, members), next: poolHandoffNext(ctx, issues, members) }
  } catch (error) { if (error === LOADING) return LOADING; throw error }
}
