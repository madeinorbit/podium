import { machinePathsEqual } from '@podium/model'
import { headerView } from './header-views'
import { headerEntities } from './header-entities'
import { settingsHasFirstTask } from './settings-views'
import { keyedComputed } from '@podium/mobx-helpers'
import { isFinished } from './shared/predicates'
import type { SessionView } from '@podium/client-core/session-values'

import { issueDisplayRef as joinedIssueRef } from '@podium/client-graph/diagnostics/reference/issue-views'
import {
  deckIssueState, deckSessionOrder, issueAbandoned, issueClosed, issueNeedsHuman,
  motionPhase, panelLabel, selectLatestPromptSession, sessionAsksOnIssue, sessionAtWork, sessionPresentOnTask,
  sessionSettled, sessionNeedsHuman, type FlightDeckFoldMap, type FlightDeckMode, type FlightDeckRow, type IssueContinuation,
  type IssueNavigationModel, type IssueNote, type MissionDeparture, type MissionProgress,
  type PresenceNote, type HandoffNowEntry, type HandoffNextEntry,
} from '@podium/client-core/values'
import { asIssueId, asSessionId, DRAFT_ISSUE_TITLE, HANDOFF_HARNESS_KINDS } from '@podium/model/browser'
import type { GitRepositoryWire, MachineWire } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { cachedGroup } from './cached'
import { missions } from './mission'
import type { MobxPool } from './pool'
import type { SeatRelation } from './session-seats'
import { createRowOverlay } from './shared/overlay-row'
import { LOADING, type Loaded } from './worklist/rollup'

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

/** The fields history aggregates read of one session: a read marker or any
 * other display change leaves them, and so every aggregate, untouched. */
interface SessionFacts {
  readonly sessionId: string
  readonly lastActiveAt: string
  readonly lastInputAt?: string | null
  readonly transcriptAvailable?: boolean
  readonly agentKind: SessionView['agentKind']
  readonly moved: boolean
  readonly phase: string
  readonly archived: boolean
  /** Drawn in a roster: neither headless nor a shell. */
  readonly roster: boolean
}
const factsOf = (session: SessionView): SessionFacts => ({
  sessionId: session.sessionId, lastActiveAt: session.lastActiveAt, lastInputAt: session.lastInputAt,
  transcriptAvailable: session.transcriptAvailable, agentKind: session.agentKind,
  moved: Boolean(session.handoffTarget), phase: session.agentState?.phase ?? 'unknown',
  archived: Boolean(session.archived), roster: !session.headless && session.agentKind !== 'shell',
})
/** `selectLatestPromptSession` reads only these fields. */
const latestPromptOf = (facts: readonly SessionFacts[]) =>
  selectLatestPromptSession(facts as unknown as readonly SessionView[])?.sessionId

const NO_HISTORY: MissionHistory = Object.freeze({ count: 0, roster: 0, newest: undefined, moved: undefined, latestPrompt: undefined })

/** The member summary an issue model carries, as composable facts. */
interface MemberFacts {
  readonly count: number
  /** Phase → its member count and the smallest member id with it (legacy key order). */
  readonly phases: ReadonlyMap<string, { readonly count: number; readonly first: string }>
  /** Latest finite member activity, ms (-Infinity when none). */
  readonly latest: number
}
interface IssueMemberFacts {
  readonly ids: ReturnType<typeof pageMemberIds>
  readonly latest: number
  readonly summary: { total: number; byPhase: Record<string, number> }
}
function memberFacts(sessions: readonly Pick<SessionFacts, 'sessionId' | 'lastActiveAt' | 'phase'>[]): MemberFacts {
  const phases = new Map<string, { count: number; first: string }>()
  let latest = -Infinity
  for (const session of sessions) {
    const phase = session.phase, seen = phases.get(phase)
    if (!seen) phases.set(phase, { count: 1, first: session.sessionId })
    else { seen.count++; if (session.sessionId < seen.first) seen.first = session.sessionId }
    const at = Date.parse(session.lastActiveAt)
    if (at > latest) latest = at
  }
  return { count: sessions.length, phases, latest }
}
const NO_MEMBERS: MemberFacts = Object.freeze({ count: 0, phases: new Map(), latest: -Infinity })
function mergeMemberFacts(a: MemberFacts, b: MemberFacts): MemberFacts {
  const phases = new Map(a.phases)
  for (const [phase, value] of b.phases) {
    const seen = phases.get(phase)
    phases.set(phase, seen ? { count: seen.count + value.count, first: seen.first < value.first ? seen.first : value.first } : value)
  }
  return { count: a.count + b.count, phases, latest: Math.max(a.latest, b.latest) }
}

export function settled<T>(read: () => T): T | typeof LOADING {
  try { return read() } catch (error) { if (error === LOADING) return LOADING; throw error }
}
export function requireLoaded<T>(value: T | typeof LOADING): T {
  if (value === LOADING) throw LOADING
  return value
}
const field = <K extends keyof IssueNavigationModel>(name: K) =>
  cachedGroup(`deck.${String(name)}`, (node: MissionIssueFacts) => node.row?.[name])
const fields = {
  stage: field('stage'),
  parentId: field('parentId'), startedBySession: field('startedBySession'),
  sortKey: field('sortKey'), seq: field('seq'), updatedAt: field('updatedAt'),
  needsHuman: field('needsHuman'), closedReason: field('closedReason'), blocked: field('blocked'),
  coordinatorSessionId: field('coordinatorSessionId'),
}
const visibleFact = cachedGroup('deck.visible', (node: MissionIssueFacts) => {
  const row = node.row
  return Boolean(row && !row.archived && !row.deletedAt)
})
const earliestChild = cachedGroup('deck.earliestChild', (node: MissionIssueFacts) => {
  let first: string | undefined
  for (const id of node.view.pool.graph.many('issue', node.id, 'children')) {
    if (first === undefined || id < first) first = id
  }
  return first
})

/** The issue's scalar mission facts. No rich navigation record is read here.
 * Each scalar computed is allocated only while something observes it. */
export class MissionIssueFacts {
  constructor(readonly id: string, readonly view: MissionViewReader) {}
  // Scalar facts borrow the pool row directly. Joining a display reference for
  // every field would repeat catalog work throughout the root rollups.
  get row(): IssueNavigationModel | undefined { return requireLoaded(this.view.pool.row('issue', this.id)) as IssueNavigationModel | undefined }
  get stage() { return fields.stage(this) ?? 'backlog' }
  get parentId() { return fields.parentId(this) ?? null }
  get startedBySession() { return fields.startedBySession(this) }
  get sortKey() { return fields.sortKey(this) }
  get seq() { return fields.seq(this) ?? 0 }
  get updatedAt() { return fields.updatedAt(this) ?? '' }
  get closedReason() { return fields.closedReason(this) }
  get blocked() { return fields.blocked(this) }
  get needsHuman() { return fields.needsHuman(this) }
  get coordinatorSessionId() { return fields.coordinatorSessionId(this) }
  get visible() { return visibleFact(this) }
  get earliestChild() { return earliestChild(this) }
  private static readonly live = cachedGroup('deck.live', (node: MissionIssueFacts) =>
    requireLoaded(node.view.present(node.id)).some(sessionPresentOnTask))
  get live() { return MissionIssueFacts.live(this) }
}

interface DeckTopology {
  readonly scope: ReadonlySet<string>
  readonly children: ReadonlyMap<string, readonly string[]>
  readonly parent: ReadonlyMap<string, string>
  readonly parents: ReadonlyMap<string, readonly string[]>
  readonly overlap: boolean
  readonly depths: ReadonlyMap<string, number>
}
const topology = cachedGroup('deck.topology', (deck: MissionDeckModel): DeckTopology | typeof LOADING => settled(() => {
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
  const firstChild = (id: string) => view.facts(id).earliestChild
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
const ownCount = (name: Count) => cachedGroup(`deck.own.${name}`, (row: MissionDeckIssueModel) => {
  const facts = row.facts
  if (!facts.visible) return 0
  if (name === 'tasks') return 1
  if (name === 'done') return Number(issueClosed(facts) && !issueAbandoned(facts))
  if (name === 'run') return Number(!isFinished(facts) && (underway(facts.stage) || facts.stage === 'review'))
  row.view.stats.onRollup?.(row.id)
  // Counts do not need the presentation roster's coordinator-first ordering.
  // Keep that additional computed lazy until a row actually draws its crew.
  const crew = requireLoaded(row.view.roster(row.id))
  if (name === 'live') return crew.filter(sessionPresentOnTask).length
  if (name === 'working') return crew.filter(session => sessionPresentOnTask(session) && motionPhase(session) === 'working').length
  if (name === 'waiting') return crew.filter(session => sessionAsksOnIssue(facts, session)).length
  return Number(issueNeedsHuman(row.rulesIssue!, crew))
})
const own = Object.fromEntries(COUNTS.map(name => [name, ownCount(name)])) as Record<Count, (row: MissionDeckIssueModel) => number>
const sum = Object.fromEntries(COUNTS.map(name => [name, cachedGroup(`deck.rollup.${name}`, (row: MissionDeckIssueModel) => settled(() => {
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
const descendants = cachedGroup('deck.descendants', (row: MissionDeckIssueModel) => {
  const shape = requireLoaded(row.deck.topology), seen = new Set<string>([row.id]), ids: string[] = []
  const stack = [...(shape.children.get(row.id) ?? [])].reverse()
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id); ids.push(id); stack.push(...[...(shape.children.get(id) ?? [])].reverse())
  }
  return ids
})
const childrenOf = cachedGroup('deck.children', (row: MissionDeckIssueModel) => {
  const shape = row.deck.topology
  return shape === LOADING ? LOADING : shape.children.get(row.id) ?? []
})
const crewIds = cachedGroup('deck.crewIds', (row: MissionDeckIssueModel) => {
  const { view, facts } = row
  return [...view.pool.graph.many('issue', row.id, 'missionSessions')].filter(id => view.sessionRoster(id)).sort((a, b) =>
    Number(b === facts.coordinatorSessionId) - Number(a === facts.coordinatorSessionId) ||
    view.sessionCreatedAt(a).localeCompare(view.sessionCreatedAt(b)) || a.localeCompare(b))
})
const hasPayload = cachedGroup('deck.hasPayload', (row: MissionDeckIssueModel) => requireLoaded(row.deckChildren).length > 0 || row.crewIds.length > 0)
const hasLead = cachedGroup('deck.hasLead', (row: MissionDeckIssueModel) => Boolean(row.facts.coordinatorSessionId &&
  row.crewIds.includes(row.facts.coordinatorSessionId) && row.view.sessionOpen(row.facts.coordinatorSessionId)))
const presentation = cachedGroup('deck.presentation', (row: MissionDeckIssueModel) => row.view.presentation(row.issue, row.sessions))
const crewOf = cachedGroup('deck.crew', (row: MissionDeckIssueModel) => deckSessionOrder(row.facts,
  requireLoaded(row.view.roster(row.id))))
const matchedWorking = cachedGroup('deck.matches.working', (row: MissionDeckIssueModel) => row.sessions.some(sessionAtWork))
const matchedNeedsYou = cachedGroup('deck.matches.needsYou', (row: MissionDeckIssueModel) => own.needsYou(row) > 0)
const collapsedCrew: (row: MissionDeckIssueModel) => SessionView[] = cachedGroup('deck.collapsedCrew', (row: MissionDeckIssueModel): SessionView[] => {
  const seen = new Set<string>(), candidates: SessionView[] = []
  const rank = (session: SessionView) => sessionPresentOnTask(session) && motionPhase(session) === 'working' ? 0 : sessionSettled(session) ? 2 : 1
  const shape = requireLoaded(row.deck.topology)
  const groups = shape.overlap ? [row.sessions, ...row.descendantIds.map(id => row.deck.model(id).sessions)] :
    [row.sessions, ...requireLoaded(row.deckChildren).map(id => collapsedCrew(row.deck.model(id)))]
  for (const crew of groups) {
    for (const session of crew) {
      if (seen.has(session.sessionId)) continue
      seen.add(session.sessionId); candidates.push(session)
    }
    candidates.sort((a, b) => rank(a) - rank(b)); candidates.length = Math.min(12, candidates.length)
  }
  return candidates
})
const kindCodes: (row: MissionDeckIssueModel) => string = cachedGroup('deck.kindCodes', (row: MissionDeckIssueModel): string => {
  const kinds = new Set<SessionView['agentKind']>()
  const shape = requireLoaded(row.deck.topology)
  const ownCrew = shape.overlap ? [row.id, ...row.descendantIds].flatMap(id => row.deck.model(id).sessions) : row.sessions
  for (const session of ownCrew) {
    if (sessionPresentOnTask(session)) kinds.add(session.agentKind)
    if (kinds.size === 2) return JSON.stringify([...kinds])
  }
  if (!shape.overlap) for (const id of requireLoaded(row.deckChildren)) {
    for (const kind of JSON.parse(kindCodes(row.deck.model(id))) as SessionView['agentKind'][]) {
      kinds.add(kind)
      if (kinds.size === 2) return JSON.stringify([...kinds])
    }
  }
  return JSON.stringify([...kinds])
})
const kindsOf = cachedGroup('deck.kinds', (row: MissionDeckIssueModel) => JSON.parse(kindCodes(row)) as SessionView['agentKind'][])
const latestBelow = cachedGroup('deck.updatedBelow', (row: MissionDeckIssueModel): string => {
  const shape = requireLoaded(row.deck.topology)
  if (shape.overlap) return [row.id, ...row.descendantIds].reduce((at, id) => row.view.facts(id).updatedAt > at ? row.view.facts(id).updatedAt : at, '')
  let at = row.facts.updatedAt
  for (const id of requireLoaded(row.deckChildren)) { const next = latestBelow(row.deck.model(id)); if (next > at) at = next }
  return at
})

const rollupValue = cachedGroup('deck.rollup', (row: MissionDeckIssueModel) => settled(() => ({
  tasks: requireLoaded(sum.tasks(row)), done: requireLoaded(sum.done(row)), run: requireLoaded(sum.run(row)),
  live: requireLoaded(sum.live(row)), working: requireLoaded(sum.working(row)), needsYou: requireLoaded(sum.needsYou(row)), waiting: requireLoaded(sum.waiting(row)),
})))
/** A mission-scoped handle on the pool's issue, with lazy computed getters.
 * Scope matters: a graft may have different children and paths in two roots.
 * The handle holds no row, geometry, retained computed or presentation map. */
export class MissionDeckIssueModel implements FlightDeckRow {
  constructor(readonly id: string, readonly deck: MissionDeckModel, private readonly path?: readonly string[]) {}
  /** A graft can draw the same issue under two mission paths. */
  get key() { return this.path ? JSON.stringify(this.path) : this.id }
  private get canonical(): MissionDeckIssueModel { return this.path ? this.deck.model(this.id) : this }
  get view() { return this.deck.view }
  get facts() { return this.view.facts(this.id) }
  get issue() { return requireLoaded(this.view.issue(this.id))! }
  get rulesIssue() { return this.view.rulesIssue(this.id) }
  get stage() { return this.facts.stage }
  get title() { return requireLoaded(this.view.title(requireLoaded(this.view.catalogIssue(this.id))!)) }
  get deckChildren() { return childrenOf(this.canonical) }
  get descendantIds() { return descendants(this.canonical) }
  get sessions() { return crewOf(this.canonical) }
  get crewIds() { return crewIds(this.canonical) }
  get hasLead() { return hasLead(this.canonical) }
  private readonly shownIds = keyedComputed('MissionIssue.sessionIds', (mode: FlightDeckMode) => {
    if (mode === 'full') return this.crewIds
    if (!this.matches(mode)) return []
    return this.crewIds.filter(id => mode === 'working' ? this.view.sessionAtWork(id) : !issueClosed(this.facts) && this.view.sessionAsking(id))
  })
  sessionIds(mode: FlightDeckMode): readonly string[] { return this.path ? this.canonical.sessionIds(mode) : this.shownIds(mode) }
  get depth() { return this.path ? this.path.length - 1 : this.deck.depth(this.id) }
  get matched() { return this.matches(this.deck.mode) }
  matches(mode: FlightDeckMode) { return mode === 'full' || (mode === 'working' ? matchedWorking(this.canonical) : matchedNeedsYou(this.canonical)) }
  get rollup() { return rollupValue(this.canonical) }
  get tasks() { return sum.tasks(this.canonical) }
  get done() { return sum.done(this.canonical) }
  get run() { return sum.run(this.canonical) }
  get actionableCount() { return requireLoaded(sum.needsYou(this.canonical)) }
  get liveAgentCount() { return requireLoaded(sum.live(this.canonical)) }
  get workingAgentCount() { return requireLoaded(sum.working(this.canonical)) }
  get waitingAgentCount() { return requireLoaded(sum.waiting(this.canonical)) }
  get collapsedSummary() {
    const row = this.canonical
    // A searchable placeholder asks only for the task count. Reading it must
    // not observe the hidden row's crew, kinds and other presentation rollups.
    return {
      get tasks() { return requireLoaded(row.tasks) - own.tasks(row) },
      get done() { return requireLoaded(row.done) - own.done(row) },
      get run() { return requireLoaded(row.run) - own.run(row) },
      get kinds() { return kindsOf(row) },
      get crew() { return collapsedCrew(row) },
      get needsYou() { return row.actionableCount > 0 },
    }
  }
  get presentation() { return presentation(this.canonical) }
  get updatedBelow() { return latestBelow(this.canonical) }
  get hasPayload() { return hasPayload(this.canonical) }
  folded(folds: FlightDeckFoldMap) {
    const explicit = folds.get(this.id)
    return explicit === undefined ? requireLoaded(this.deckChildren).length === 0 && this.crewIds.length === 1 : explicit === 'closed'
  }
}

const progress = cachedGroup('deck.progress', (deck: MissionDeckModel): MissionProgress | typeof LOADING => settled(() => {
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
    if (issueClosed(facts)) result.done++
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
const headerReady = cachedGroup('deck.headerReady', (deck: MissionDeckModel) => settled(() => {
  const row = deck.model(deck.id)
  const reads: readonly (() => unknown)[] = [
    () => row.liveAgentCount, () => row.workingAgentCount,
    () => deck.continuation, () => deck.note,
    () => deck.presence, () => deck.departures,
  ]
  let pending = false
  for (const read of reads) if (settled(read) === LOADING) pending = true
  return pending ? LOADING : true
}))
const rootContinuation = cachedGroup('deck.continuation', (deck: MissionDeckModel) => {
  const root = deck.view.rulesIssue(deck.id)
  return root ? deck.view.continuation(root) : null
})
const rootNote = cachedGroup('deck.note', (deck: MissionDeckModel) => {
  const root = deck.view.rulesIssue(deck.id)
  return root ? deck.view.note(root) : null
})
const rootPresence = cachedGroup('deck.presence', (deck: MissionDeckModel) => {
  const root = deck.view.rulesIssue(deck.id)
  return root ? deck.view.presence(root, deck.model(deck.id).sessions) : null
})
const rootDepartures = cachedGroup('deck.departures', (deck: MissionDeckModel) => deck.view.departures(deck))

/** Root questions contain IDs and mission-wide numbers. MobX owns every cache
 * lifetime; unobserved row/model questions keep no computed allocations. */
export class MissionDeckModel {
  private readonly modelsById = new Map<string, MissionDeckIssueModel>()
  private readonly occurrences = new Map<string, MissionDeckIssueModel>()
  private readonly paths = keyedComputed('MissionDeck.paths', (key: string) => settled(() => {
    const [mode, entries] = JSON.parse(key) as [FlightDeckMode, [string, string][] | null]
    const folds = entries === null ? null : new Map(entries) as FlightDeckFoldMap
    const shape = requireLoaded(this.topology), members = requireLoaded(this.members)
    const included = new Set<string>([this.id])
    for (const id of members) {
      if (!this.view.facts(id).visible || !this.model(id).matches(mode)) continue
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
      if (folds && id !== this.id && this.model(id).folded(folds)) return
      for (const child of shape.children.get(id) ?? []) walk(child, next)
    }
    walk(this.id, [])
    return paths
  }))
  private readonly placements = keyedComputed('MissionDeck.rowIds', (key: string) => settled(() =>
    requireLoaded(this.paths(key)).map(path => path[path.length - 1]!)))
  constructor(readonly id: string, readonly view: MissionViewReader, readonly mode: FlightDeckMode) {}
  get members() { return missions(this.view.pool).members(this.id) }
  get topology() { return topology(this) }
  get progress() { return progress(this) }
  get headerReady() { return headerReady(this) }
  get continuation() { return rootContinuation(this) }
  get note() { return rootNote(this) }
  get presence() { return rootPresence(this) }
  get departures() { return rootDepartures(this) }
  rowIds(mode: FlightDeckMode = this.mode, collapsed: FlightDeckFoldMap | null = null) {
    return this.placements(JSON.stringify([mode, collapsed === null ? null : [...collapsed]]))
  }
  rows() {
    return requireLoaded(this.paths(JSON.stringify([this.mode, null]))).map(path => {
      const key = JSON.stringify(path)
      let row = this.occurrences.get(key)
      if (!row) { row = new MissionDeckIssueModel(path[path.length - 1]!, this, path); this.occurrences.set(key, row) }
      return row
    })
  }
  model(id: string) {
    let model = this.modelsById.get(id)
    if (!model) { model = new MissionDeckIssueModel(id, this); this.modelsById.set(id, model) }
    return model
  }
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
  dispose() { this.paths.clear(); this.placements.clear(); this.modelsById.clear(); this.occurrences.clear() }
}

/** IDs only in these handles. Computed groups live only while a pane/diagnostic
 * observes them; row values are borrowed through the pool's one reader. */
class MissionNode {
  constructor(readonly id: string, readonly view: MissionViewReader) {}
}
const issueValue = cachedGroup('missionIssue', (node: MissionNode) => node.view.readIssue(node.id))
const menuIssueValue = cachedGroup('missionMenuIssue', (node: MissionNode) => node.view.readMenuIssue(node.id))
const catalogValue = cachedGroup('missionCatalog', (node: MissionNode) => node.view.readCatalogIssue(node.id))
const rulesValue = cachedGroup('missionRules', (node: MissionNode) => node.view.readRulesIssue(node.id))
const localTipsValue = cachedGroup('missionTips.local', (node: MissionNode) => node.view.readTips(node.id, true))
const liveTipsValue = cachedGroup('missionTips.live', (node: MissionNode) => node.view.readTips(node.id, false))
const attachedValue = cachedGroup('missionAttachments', (node: MissionNode) => node.view.readAttached(node.id))
const presentValue = cachedGroup('missionPresent', (node: MissionNode) => node.view.readPresent(node.id))
const historyValue = cachedGroup('missionHistory', (node: MissionNode) => node.view.readHistory(node.id))
const historyRosterCountValue = cachedGroup('missionHistoryRosterCount', (node: MissionNode) => node.view.readHistoryRosterCount(node.id))
const pageMemberIds = (pool: MobxPool, id: string) =>
  [...pool.graph.many('issue', id, 'pageSessions')].sort().map(asSessionId)
const memberIdsValue = cachedGroup('missionMemberIds', (node: MissionNode) => pageMemberIds(node.view.pool, node.id))
const memberHistoryValue = cachedGroup('missionMemberHistory', (node: MissionNode) => node.view.readMemberHistory(node.id))
const MODES = ['full', 'working', 'needs-you'] as const
type PaneGroups<V> = Record<FlightDeckMode, (node: MissionNode) => V>
const paneValues = Object.fromEntries(MODES.map(mode => [mode,
  cachedGroup(`missionPane.${mode}`, (node: MissionNode) => {
    const deck = node.view.deck(node.id, mode)
    requireLoaded(deck.rowIds(mode))
    node.view.stats.values++
    return node.view.deckValues(deck)
  }),
])) as PaneGroups<MissionViewValues>
const archiveCountValue = cachedGroup('missionArchiveCount', (deck: MissionDeckModel) => deck.view.readArchiveCount(deck))
const handoffValue = cachedGroup('missionHandoff', (node: MissionNode) => deriveMissionHandoff(node.view, node.id))
const rowOrder = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const visible = (issue: { archived?: boolean; deletedAt?: string | null }) => !issue.archived && !issue.deletedAt
const openSession = sessionPresentOnTask
const underway = (stage: string) => stage === 'planning' || stage === 'in_progress' || stage === 'shipping'
const leftMission = (issue: IssueNavigationModel) => !['proposed', 'backlog'].includes(issue.stage) && Boolean(issue.deps.find(dep => dep.type === 'discovered-from'))
const originId = (issue: IssueNavigationModel) => issue.deps.find(dep => dep.type === 'discovered-from')?.id ?? null

/** One read service on the existing principal's pool. There is no source,
 * replica, runtime, outbox or independently maintained relation index here. */
export class MissionViewReader {
  private readonly nodes = new Map<string, MissionNode>()
  private readonly factsById = new Map<string, MissionIssueFacts>()
  private readonly decks = new Map<string, MissionDeckModel>()
  readonly stats: { values: number; issueReads: number; sessionReads: number; attachmentEdges: number; onRollup?: (id: string) => void } = { values: 0, issueReads: 0, sessionReads: 0, attachmentEdges: 0 }
  facts(id: string) {
    let facts = this.factsById.get(id)
    if (!facts) { facts = new MissionIssueFacts(id, this); this.factsById.set(id, facts) }
    return facts
  }
  deck(id: string, mode: FlightDeckMode = 'full') {
    const key = JSON.stringify([id, mode])
    let deck = this.decks.get(key)
    if (!deck) { deck = new MissionDeckModel(id, this, mode); this.decks.set(key, deck) }
    return deck
  }
  private node(id: string) {
    let node = this.nodes.get(id)
    if (!node) { node = new MissionNode(id, this); this.nodes.set(id, node) }
    return node
  }
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
    return paneValues[mode](this.node(rootId))
  }
  handoff(id: string): MissionHandoffValues | typeof LOADING { return handoffValue(this.node(id)) }
  issue(id: string): Loaded<IssueNavigationModel> { return issueValue(this.node(id)) }
  /** An open menu shows authored issue fields, unread and cascade counts;
   * it does not show the history roster or its phase summary. */
  menuIssue(id: string): Loaded<IssueNavigationModel> { return menuIssueValue(this.node(id)) }
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
  readonly menuHandoff = keyedComputed('MissionMenu.handoff', (id: string): MissionMenuHandoff | typeof LOADING => {
    const count = this.pool.graph.size('issue', id, 'handoffSessions')
    if (count === 0) return { blocker: 'no-agent-session' }
    if (count > 1) return { blocker: 'multiple-sessions' }
    const sessionId = this.pool.graph.many('issue', id, 'handoffSessions')[Symbol.iterator]().next().value!
    const session = this.menuSession(sessionId)
    return session === LOADING ? LOADING : session ? { session } : { blocker: 'no-agent-session' }
  })
  /** Menu metadata is already declared in the cold summary. Reading it does
   * not promote a closed issue and initialize its full display roster. */
  menuCatalogIssue(id: string): Loaded<IssueNavigationModel> {
    const row = this.pool.row('issue', id, 'summary-fields') as Loaded<IssueNavigationModel>
    if (!row || row === LOADING) return row
    const repoId = this.pool.graph.one('issue', id, 'repo')
    const repo = repoId ? this.pool.row('repo', repoId) as { prefix?: string } | undefined : undefined
    return issueRefOverlay(row, { prefix: repo?.prefix, displayRef: joinedIssueRef({ seq: row.seq, prefix: repo?.prefix }) }) as IssueNavigationModel
  }
  /** Shared raw-member facts: read cursors and machine display changes do not
   * rebuild the archived contribution or the ordered membership IDs. */
  issueMembers(id: string): IssueMemberFacts | typeof LOADING { return this.readIssueMembers(id) }
  /** Menu catalogs use authored labels and references, not other tasks' crew. */
  catalogIssue(id: string): Loaded<IssueNavigationModel> {
    return catalogValue(this.node(id))
  }
  readCatalogIssue(id: string): Loaded<IssueNavigationModel> {
    const raw = this.pool.row('issue', id)
    if (!raw || raw === LOADING) return raw
    const row = raw as IssueNavigationModel
    const repoId = this.pool.graph.one('issue', id, 'repo')
    const repo = repoId ? this.pool.row('repo', repoId) as { prefix?: string } | undefined : undefined
    return issueRefOverlay(row, { prefix: repo?.prefix, displayRef: joinedIssueRef({ seq: row.seq, prefix: repo?.prefix }) }) as IssueNavigationModel
  }
  /** Every explicit mission sender, archived history included, in session
   * order. Explicit whole-roster readers ask for it; mission derivations
   * compose {@link present} and {@link history} so a seated heartbeat never
   * re-reads history. */
  attached(id: string): readonly SessionView[] | typeof LOADING { return attachedValue(this.node(id)) }
  /** Non-archived mission senders, in session order. */
  present(id: string): readonly SessionView[] | typeof LOADING { return presentValue(this.node(id)) }
  /** What derivations need from the archived mission senders. */
  history(id: string): MissionHistory | typeof LOADING {
    // Most issues have no archived sender: answer without building a cache.
    return this.hasHistory('missionSessions', id) === false ? NO_HISTORY : historyValue(this.node(id))
  }
  /** A closed archive observes only roster eligibility, without allocating
   * the activity, prompt and handoff winner questions for every hidden seat. */
  historyRosterCount(id: string): number | typeof LOADING {
    return this.hasHistory('missionSessions', id) === false ? 0 : historyRosterCountValue(this.node(id))
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
    return this.historySession(sessionId)
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
  sessionOrder = (a: SessionView, b: SessionView): number => this.idOrder(a.sessionId, b.sessionId)
  rawSession(id: string): Loaded<SessionView> {
    const resident = this.pool.row('session', id, 'mark')
    if (resident !== LOADING) return resident as Loaded<SessionView>
    const summary = this.pool.row('session', id, 'summary')
    if (summary && summary !== LOADING && ['sessionId', 'cwd', 'status', 'lastActiveAt', 'title'].every(key => Object.hasOwn(summary, key))) return summary as SessionView
    return this.pool.row('session', id) as Loaded<SessionView>
  }
  readonly sessionRoster = keyedComputed('MissionSession.roster', (id: string) => {
    const session = requireLoaded(this.rawSession(id))
    return Boolean(session && !session.archived && !session.headless && session.agentKind !== 'shell')
  })
  readonly sessionCreatedAt = keyedComputed('MissionSession.createdAt', (id: string) => requireLoaded(this.rawSession(id))?.createdAt ?? '')
  readonly sessionAtWork = keyedComputed('MissionSession.atWork', (id: string) => {
    const session = requireLoaded(this.rawSession(id)); return Boolean(session && sessionAtWork(session))
  })
  readonly sessionAsking = keyedComputed('MissionSession.asking', (id: string) => {
    const session = requireLoaded(this.rawSession(id)); return Boolean(session && !session.archived && sessionNeedsHuman(session))
  })
  readonly sessionOpen = keyedComputed('MissionSession.open', (id: string) => {
    const session = requireLoaded(this.rawSession(id)); return Boolean(session && !session.archived && session.status !== 'exited')
  })
  session(id: string): Loaded<SessionView> {
    this.stats.sessionReads++
    const row = this.rawSession(id)
    return row as Loaded<SessionView>
  }
  /** Menu labels and guards use the addressed session's own fields. The
   * machine/login/reference joins belong to its drawn row, not this menu. */
  menuSession(id: string): Loaded<SessionView> {
    const row = this.session(id)
    return !row || row === LOADING ? row : menuSessionOverlay(row, MENU_SESSION_OVERRIDES, MENU_SESSION_OMISSIONS)
  }
  private sessionScalar<T>(name: string, read: (session: SessionView) => T) {
    return keyedComputed(`MissionSession.${name}`, (id: string): Loaded<T> => {
      const session = this.rawSession(id)
      return session === LOADING || session === undefined ? session : read(session)
    })
  }
  private readonly historyFields = {
    activity: this.sessionScalar('historyActivity', session => session.lastActiveAt),
    input: this.sessionScalar('historyInput', session => session.lastInputAt),
    transcript: this.sessionScalar('historyTranscript', session => session.transcriptAvailable),
    kind: this.sessionScalar('historyKind', session => session.agentKind),
    moved: this.sessionScalar('historyMoved', session => Boolean(session.handoffTarget)),
    phase: this.sessionScalar('historyPhase', session => session.agentState?.phase ?? 'unknown'),
    roster: this.sessionScalar('historyRoster', session => !session.headless && session.agentKind !== 'shell'),
  }
  /** A display-only change stops at these scalar getters; it never wakes the
   * archived roster aggregates that observe this record. */
  private readonly historySession = keyedComputed('MissionSession.history', (id: string): Loaded<SessionFacts> => settled(() => {
    const archived = requireLoaded(this.archivedSession(id))
    if (archived === undefined) return undefined
    const field = this.historyFields
    return {
      sessionId: id, archived,
      lastActiveAt: requireLoaded(field.activity(id))!,
      lastInputAt: requireLoaded(field.input(id)),
      transcriptAvailable: requireLoaded(field.transcript(id)),
      agentKind: requireLoaded(field.kind(id))!,
      moved: requireLoaded(field.moved(id))!,
      phase: requireLoaded(field.phase(id))!,
      roster: requireLoaded(field.roster(id))!,
    }
  }))
  /** Membership and archived flags alone determine each side. A heartbeat
   * keeps these ID arrays observed without walking the history again. */
  private readonly seatIdValues = keyedComputed('MissionSeats.ids', (key: string): readonly string[] | typeof LOADING => {
    const [relation, id, archived] = JSON.parse(key) as [SeatRelation, string, boolean]
    const ids: string[] = []
    let pending = false
    for (const sessionId of this.pool.graph.many('issue', id, relation)) {
      const flag = this.archivedSession(sessionId)
      if (flag === LOADING) pending = true
      else if (flag === archived) ids.push(sessionId)
    }
    return pending ? LOADING : ids
  })
  /** The seated or archived side's ids, and the cold ones whose summary
   * does not say which: those settle from their rows (read here anyway). */
  private seatIds(relation: SeatRelation, id: string, archived: boolean): readonly string[] | typeof LOADING {
    return this.seatIdValues(JSON.stringify([relation, id, archived]))
  }
  private readonly archivedSession = keyedComputed('MissionSession.archived', (id: string) => {
    const row = this.rawSession(id)
    return row === LOADING || row === undefined ? row : Boolean(row.archived)
  })
  private seatRows(relation: SeatRelation, id: string, archived: boolean): SessionView[] | typeof LOADING {
    const ids = this.seatIds(relation, id, archived)
    if (ids === LOADING) return LOADING
    const found: SessionView[] = []
    let pending = false
    for (const sessionId of ids) {
      this.stats.attachmentEdges++
      const session = this.rawSession(sessionId)
      if (session === LOADING) pending = true
      else if (session && Boolean(session.archived) === archived) found.push(session)
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
    const facts = all.filter(session => session.archived)
    let newest: SessionFacts | undefined
    for (const session of facts) if (!newest || session.lastActiveAt > newest.lastActiveAt) newest = session
    return { count: facts.length, roster: facts.filter(session => session.roster).length, newest: newest?.sessionId,
      moved: facts.find(session => session.moved)?.sessionId, latestPrompt: latestPromptOf(facts) }
  }
  readHistoryRosterCount(id: string): number | typeof LOADING {
    const ids = this.seatIds('missionSessions', id, true)
    if (ids === LOADING) return LOADING
    let count = 0, pending = false
    for (const sessionId of ids) {
      const roster = this.historyFields.roster(sessionId)
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
  /** Archived raw members' contribution to an issue's member summary. */
  readMemberHistory(id: string): MemberFacts | typeof LOADING {
    const ids = this.seatIds('pageSessions', id, true)
    if (ids === LOADING) return LOADING
    const facts = this.factsOfIds(ids)
    return facts === LOADING ? LOADING : memberFacts(facts.filter(session => session.archived))
  }
  readIssueMembers(id: string): IssueMemberFacts | typeof LOADING {
    const plain = this.hasHistory('pageSessions', id) === false
    const ids = plain ? pageMemberIds(this.pool, id) : memberIdsValue(this.node(id))
    const present = this.seatRows('pageSessions', id, false)
    const archived = plain ? NO_MEMBERS : memberHistoryValue(this.node(id))
    if (present === LOADING || archived === LOADING) return LOADING
    const facts = mergeMemberFacts(memberFacts(present.map(factsOf)), archived)
    const byPhase: Record<string, number> = {}
    for (const [phase, { count }] of [...facts.phases].sort((a, b) => a[1].first < b[1].first ? -1 : 1)) byPhase[phase] = count
    return { ids, latest: facts.latest, summary: { total: facts.count, byPhase } }
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
    const raw = this.pool.row('issue', id)
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
      const source = this.pool.row('issue', sourceId) as Loaded<IssueNavigationModel>
      if (source === LOADING) pending = true
      else if (source) for (const dep of source.deps ?? []) {
        if (dep.id === id) dependents.push({ id: asIssueId(sourceId), type: dep.type })
      }
    }
    if (pending || members === LOADING) return LOADING
    const repoId = this.pool.graph.one('issue', id, 'repo')
    const repo = repoId ? this.pool.row('repo', repoId) as { prefix?: string } | undefined : undefined
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
      deferred, ready: !row.blocked && !deferred && !isFinished(row), dependents,
      unread: row.deletedAt ? false : unread, sessionSummary: members.summary,
    }) as IssueNavigationModel
  }
  roster(id: string, archived = false): readonly SessionView[] | typeof LOADING {
    const seats = archived ? this.seatRows('missionSessions', id, true) : this.present(id)
    if (seats === LOADING) return LOADING
    return (archived ? [...seats].sort(this.sessionOrder) : seats)
      .filter(session => !session.headless && session.agentKind !== 'shell' && Boolean(session.archived) === archived)
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
      const facts = this.pool.row('issue', id, 'summary') as Loaded<{ archived?: boolean; deletedAt?: string }>
      if (facts === undefined || (facts !== LOADING && !visible(facts))) break
      void this.pool.row('issue', id)
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
    if (root === LOADING || !root || !visible(root)) return root === LOADING ? LOADING : undefined
    if (root.isDraftVessel && !root.worktreePath) {
      const sessions = this.present(rootId)
      if (sessions === LOADING || this.history(rootId) === LOADING) return LOADING
      if (!sessions.some(session => !session.archived)) return undefined
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
      const row = this.pool.row('issue', id, 'summary') as Loaded<{ archived?: boolean; deletedAt?: string | null }>
      if (row === LOADING) { pending = true; return false }
      return Boolean(row && visible(row))
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
  archiveCount(deck: MissionDeckModel): number | typeof LOADING { return archiveCountValue(deck) }
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
    while (stack.length) {
      const id = stack.pop()!
      for (const child of this.pool.graph.many('issue', id, 'spinOffs')) if (!ids.has(child) && this.facts(child).visible) { ids.add(child); stack.push(child) }
    }
    for (const id of [...ids]) {
      for (const target of this.pool.graph.many('issue', id, 'pageDependencies')) ids.add(target)
      const issue = requireLoaded(this.catalogIssue(id))
      for (const target of [issue?.supersededBy, issue?.duplicateOf, issue?.stage === 'proposed' ? issue.parentId : null]) if (target) ids.add(target)
    }
    return [...ids].filter(id => Boolean(requireLoaded(this.catalogIssue(id))))
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
        const empty = !requireLoaded(this.roster(id)).some(openSession)
        for (const tip of this.tips(id)) {
          if (members.has(tip.id) || seen.has(tip.id) || (!empty && issueClosed(tip))) continue
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
    return rulesValue(this.node(id))
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
  live(id: string) { return this.presentStrict(id).some(openSession) }
  lastActive(issue: IssueNavigationModel, local: boolean) {
    return local ? issue.updatedAt : this.presentStrict(issue.id).reduce((latest, session) =>
      !session.archived && session.lastActiveAt > latest ? session.lastActiveAt : latest, issue.updatedAt)
  }
  preferred(candidates: readonly IssueNavigationModel[], local = false): IssueNavigationModel | undefined {
    const staffed = local ? [] : candidates.filter(issue => this.live(issue.id))
    const unfinished = candidates.filter(issue => !isFinished(issue))
    return [...(staffed.length ? staffed : unfinished.length ? unfinished : candidates)]
      .sort((a, b) => this.lastActive(b, local).localeCompare(this.lastActive(a, local)))[0]
  }
  tips(origin: string, local = false): IssueNavigationModel[] {
    if (this.pool.graph.size('issue', origin, 'spinOffs') === 0) return []
    return (local ? localTipsValue : liveTipsValue)(this.node(origin))
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
    if (!local) for (const issue of descendants) if (settled(() => this.live(issue.id)) === LOADING) pending = true
    if (pending) throw LOADING
    const branches = new Map<string, IssueNavigationModel[]>()
    for (const issue of descendants) {
      if (!leftMission(issue) && (local || !this.live(issue.id))) continue
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
    if ((local ? this.rosterStrict(issue.id) : this.presentStrict(issue.id)).some(openSession)) return null
    const tip = this.preferred(this.tips(issue.id, local), local)
    if (!tip) return null
    const ref = issueDisplayRef(tip)
    return { kind: 'spinoff', target: tip, short: ref, full: `Work continued in ${ref}`, line: `continued · ${ref}` }
  }
  waiting(issue: IssueNavigationModel): string[] {
    return issue.deps.filter(dep => dep.type === 'blocks').flatMap(dep => {
      const target = requireLoaded(this.catalogIssue(dep.id))
      return target && !issueClosed(target) ? [issueDisplayRef(target)] : []
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
    if (sessions.some(openSession)) return null
    const moved = roster === undefined ? sessions.find(session => session.handoffTarget) : this.moved(roster)
    if (moved) return { kind: 'moved', text: `Session moved to ${moved.handoffTarget}`, attention: false }
    const continuation = this.continuation(issue, local)
    if (continuation) return { kind: 'moved', text: continuation.full, attention: false }
    if (issue.blocked) return { kind: 'blocked', text: this.blockLabel(issue), attention: false }
    const waiting = this.waitingLabel(issue)
    if (waiting) return { kind: 'waiting', text: waiting, attention: false }
    if (issueClosed(issue)) return { kind: 'done', text: issueAbandoned(issue) ? 'Cancelled · session retired' : 'Completed · session retired', attention: false }
    if (issue.stage === 'review') return { kind: 'review', text: 'Review ready · session ended', attention: false }
    if (issue.stage === 'shipping') return { kind: 'shipping', text: 'Shipping service has custody', attention: false }
    if (issue.stage === 'planning' || issue.stage === 'backlog') return { kind: 'ready', text: 'Ready to start', attention: false }
    if (issue.stage === 'in_progress') return { kind: 'attention', text: 'Agent left · choose a handoff', attention: true }
    return { kind: 'ready', text: 'Proposed · not started', attention: false }
  }
  dispose = () => {
    for (const deck of this.decks.values()) deck.dispose()
    this.historySession.clear(); this.seatIdValues.clear()
    for (const field of Object.values(this.historyFields)) field.clear()
    this.nodes.clear(); this.factsById.clear(); this.decks.clear(); this.archivedSession.clear(); this.sessionRoster.clear(); this.sessionCreatedAt.clear(); this.sessionAtWork.clear(); this.sessionAsking.clear(); this.sessionOpen.clear()
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
    if (!memberIds.has(issue.id) || issue.stage === 'proposed' || issue.archived || issue.deletedAt)
      continue
    const crew = requireLoaded(ctx.present(issue.id))
    const present = crew.filter(sessionPresentOnTask)
    const asking = present.find(
      (session) => sessionAsksOnIssue(issue, session) || motionPhase(session) === 'waiting',
    )
    const askedBy = issue.asked?.by ? ctx.member(issue.id, issue.asked.by) : undefined
    const explicitNeed = issue.needsHuman === true || asking !== undefined
    let entry: HandoffNowEntry | null = null

    if (explicitNeed && !issueClosed(issue)) {
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
      const working = present.find(sessionAtWork)
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
        Boolean(candidate && !issueClosed(candidate)),
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
      issue.archived ||
      issue.deletedAt ||
      issueClosed(issue)
    )
      continue
    const openBlockers = (issue.deps ?? [])
      .filter((dep) => dep.type === 'blocks')
      .map((dep) => requireLoaded(ctx.issue(dep.id)))
      .filter((candidate): candidate is IssueNavigationModel =>
        Boolean(candidate && !issueClosed(candidate)),
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
    return issue && issue.stage !== 'proposed' && visible(issue) && !issueClosed(issue) ? [issue] : []
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
  const rootId = selected && visible(selected) ? view.rootFor(selected.id) : undefined
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
