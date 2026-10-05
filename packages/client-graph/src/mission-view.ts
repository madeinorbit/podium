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
import { asIssueId, asSessionId, DRAFT_ISSUE_TITLE } from '@podium/model/browser'
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
  stage: field('stage'), archived: field('archived'), deletedAt: field('deletedAt'),
  parentId: field('parentId'), startedBySession: field('startedBySession'),
  sortKey: field('sortKey'), seq: field('seq'), updatedAt: field('updatedAt'),
  needsHuman: field('needsHuman'), closedReason: field('closedReason'), blocked: field('blocked'),
  coordinatorSessionId: field('coordinatorSessionId'),
}
const exists = cachedGroup('deck.exists', (node: MissionIssueFacts) => Boolean(node.row))

/** The issue's scalar mission facts. No rich navigation record is read here.
 * Each scalar computed is allocated only while something observes it. */
export class MissionIssueFacts {
  constructor(readonly id: string, readonly view: MissionViewReader) {}
  get row(): IssueNavigationModel | undefined { return requireLoaded(this.view.catalogIssue(this.id)) }
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
  get visible() { return exists(this) && !fields.archived(this) && !fields.deletedAt(this) }
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
  const stack = [...members]
  while (stack.length) {
    const id = stack.pop()!
    if (scope.has(id)) continue
    scope.add(id)
    if (!view.facts(id).visible) continue
    const kids = [...view.pool.graph.many('issue', id, 'children')]
    stack.push(...kids)
    children.set(id, kids.filter(child => view.facts(child).visible))
  }
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
  const firstChild = (id: string) => [...view.pool.graph.many('issue', id, 'children')].sort()[0]
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
  const crew = row.sessions
  if (name === 'live') return crew.filter(sessionPresentOnTask).length
  if (name === 'working') return crew.filter(session => sessionPresentOnTask(session) && motionPhase(session) === 'working').length
  if (name === 'waiting') return crew.filter(session => sessionAsksOnIssue(facts, session)).length
  return Number(issueNeedsHuman(row.rulesIssue!, crew))
})
const own = Object.fromEntries(COUNTS.map(name => [name, ownCount(name)])) as Record<Count, (row: MissionDeckIssueModel) => number>
const sum = Object.fromEntries(COUNTS.map(name => [name, cachedGroup(`deck.rollup.${name}`, (row: MissionDeckIssueModel) => settled(() => {
  row.view.stats.onRollup?.(row.id)
  const shape = requireLoaded(row.deck.topology)
  if (shape.overlap) return [row.id, ...row.descendantIds].reduce((total, id) => total + own[name](row.deck.model(id)), 0)
  let total = own[name](row)
  for (const id of requireLoaded(row.deckChildren)) total += requireLoaded(sum[name](row.deck.model(id)))
  return total
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
  get collapsedSummary() { return {
    tasks: requireLoaded(this.tasks) - own.tasks(this.canonical), done: requireLoaded(this.done) - own.done(this.canonical),
    run: requireLoaded(this.run) - own.run(this.canonical), kinds: kindsOf(this.canonical), crew: collapsedCrew(this.canonical), needsYou: this.actionableCount > 0,
  } }
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
  const accepted = scope.filter(id => formal.has(id) && view.facts(id).stage !== 'proposed' && !issueAbandoned(view.facts(id)))
  const units = (accepted.length ? accepted : [deck.id]).filter(id => {
    const facts = view.facts(id)
    return !issueAbandoned(facts) && (facts.live || (view.tipIds(id, true).length === 0 && !view.hasSpinOffDependent(id)))
  })
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
const attachedValue = cachedGroup('missionAttachments', (node: MissionNode) => node.view.readAttached(node.id))
const presentValue = cachedGroup('missionPresent', (node: MissionNode) => node.view.readPresent(node.id))
const historyValue = cachedGroup('missionHistory', (node: MissionNode) => node.view.readHistory(node.id))
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
    const root = this.selectedRoot(id)
    if (root === LOADING) return LOADING
    if (!root) return EMPTY_MISSION_VIEW
    const deck = this.deck(root.id, mode)
    if (deck.topology === LOADING || deck.progress === LOADING || this.archiveCount(deck) === LOADING) return LOADING
    return paneValues[mode](this.node(root.id))
  }
  handoff(id: string): MissionHandoffValues | typeof LOADING { return handoffValue(this.node(id)) }
  issue(id: string): Loaded<IssueNavigationModel> { return issueValue(this.node(id)) }
  /** Shared raw-member facts: read cursors and machine display changes do not
   * rebuild the archived contribution or the ordered membership IDs. */
  issueMembers(id: string): IssueMemberFacts | typeof LOADING { return this.readIssueMembers(id) }
  /** Menu catalogs use authored labels and references, not other tasks' crew. */
  catalogIssue(id: string): Loaded<IssueNavigationModel> {
    const raw = this.pool.row('issue', id)
    if (!raw || raw === LOADING) return raw
    const row = raw as IssueNavigationModel
    const repoId = this.pool.graph.one('issue', id, 'repo')
    const repo = repoId ? this.pool.row('repo', repoId) as { prefix?: string } | undefined : undefined
    return issueRefOverlay(row, { prefix: repo?.prefix, displayRef: joinedIssueRef({ seq: row.seq, prefix: repo?.prefix }) }) as IssueNavigationModel
  }
  /** Every explicit mission sender, archived history included, in session
   * order. Only whole-list readers (menus) ask for it; mission derivations
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
    const session = this.session(sessionId)
    return session === LOADING || !session ? session : factsOf(session)
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
  /** The seated or archived side's ids, and the cold ones whose summary
   * does not say which: those settle from their rows (read here anyway). */
  private seatIds(relation: SeatRelation, id: string, archived: boolean): readonly string[] | typeof LOADING {
    const ids: string[] = []
    let pending = false
    for (const sessionId of this.pool.graph.many('issue', id, relation)) {
      const flag = this.archivedSession(sessionId)
      if (flag === LOADING) pending = true
      else if (flag === archived) ids.push(sessionId)
    }
    return pending ? LOADING : ids
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
      let count = 0
      for (const id of requireLoaded(deck.rowIds())) count += requireLoaded(this.history(id)).roster
      return count
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
      get continuation() { return view.continuation(requireLoaded(view.issue(deck.id))!) },
      get note() { return view.note(requireLoaded(view.issue(deck.id))!) },
      get presence() { return view.presence(requireLoaded(view.issue(deck.id))!, deck.model(deck.id).sessions) },
      get departures() { return view.departures(deck) },
    }
  }
  departures(deck: MissionDeckModel): MissionDeparture[] {
    const members = requireLoaded(deck.members), found: MissionDeparture[] = [], seen = new Set<string>()
    for (const id of [...members].sort()) {
      if (!this.facts(id).visible) continue
      if (this.pool.graph.size('issue', id, 'spinOffs') === 0) continue
      const empty = !requireLoaded(this.roster(id)).some(openSession)
      for (const tip of this.tips(id)) {
        if (members.has(tip.id) || seen.has(tip.id) || (!empty && issueClosed(tip))) continue
        seen.add(tip.id)
        const issue = requireLoaded(this.issue(tip.id))!
        found.push({ issue, originId: id, state: this.presentation(issue, requireLoaded(this.roster(tip.id))).state })
      }
    }
    return found.sort((a, b) => a.issue.seq - b.issue.seq)
  }
  private presentStrict(id: string) { return requireLoaded(this.present(id)) }
  private rosterStrict(id: string, archived = false) { return [...requireLoaded(this.roster(id, archived))] }
  rulesIssue(id: string): IssueNavigationModel | undefined {
    const raw = requireLoaded(this.catalogIssue(id))
    if (!raw) return undefined
    const dependents: IssueNavigationModel['dependents'] = []
    for (const sourceId of [...this.pool.graph.many('issue', id, 'pageDependents')].sort()) {
      const source = requireLoaded(this.catalogIssue(sourceId))
      if (source) for (const dep of source.deps ?? []) if (dep.id === id) dependents.push({ id: asIssueId(sourceId), type: dep.type })
    }
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
    const seen = new Set<string>(), descendants: IssueNavigationModel[] = []
    const stack = [origin]
    while (stack.length) {
      const parentId = stack.pop()!
      const children = [...this.pool.graph.many('issue', parentId, 'spinOffs')].sort()
      for (const id of children) {
        if (seen.has(id)) continue
        seen.add(id)
        if (!this.facts(id).visible) continue
        const issue = this.rulesIssue(id)
        // Legacy's first discovered-from edge is the origin, not every edge.
        if (!issue || originId(issue) !== parentId) continue
        descendants.push(issue); stack.push(id)
      }
    }
    const branches = new Map<string, IssueNavigationModel[]>()
    for (const issue of descendants) {
      if (!leftMission(issue) && (local || !this.live(issue.id))) continue
      let branch = issue, parentId = originId(branch)
      const path = new Set<string>([issue.id])
      while (parentId && parentId !== origin) {
        if (path.has(parentId)) { parentId = null; break }
        path.add(parentId)
        const parent = this.rulesIssue(parentId)
        if (!parent) break
        branch = parent; parentId = originId(branch)
      }
      if (parentId !== origin) continue
      const candidates = branches.get(branch.id) ?? []
      candidates.push(issue); branches.set(branch.id, candidates)
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
      const target = this.rulesIssue(targetId), ref = target ? issueDisplayRef(target) : 'another task'
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
      const target = this.rulesIssue(dep.id)
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
        const source = this.rulesIssue(sourceId), ref = source ? issueDisplayRef(source) : null
        return spin ? { kind: 'shape-own', label: 'starts', short: 'on its own',
          full: ref ? `Starts on its own — ${ref} can close without it` : 'Starts on its own — the task that found it can close without it' } :
          { kind: 'shape-mission', label: 'starts', short: 'in this mission',
            full: ref ? `Part of ${ref} — that task is not done until this is` : 'Part of the task that found it — that task is not done until this is' }
      }
    }
    const verbs: Record<string, string> = { 'discovered-from': 'Discovered from', related: 'Related to', tracks: 'Tracks', supersedes: 'Supersedes', 'caused-by': 'Caused by', validates: 'Validates' }
    for (const dep of issue.deps) {
      if (dep.type === 'blocks' || dep.type === 'parent-child') continue
      const target = this.rulesIssue(dep.id)
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
  const hasAnyTask = view.pool.hasFirstTask
  if (hasAnyTask === LOADING) return LOADING
  return { missionRoot, missionIds, missionIssues, issue: focused ?? missionRoot, missionOnScreen, hasAnyTask: Boolean(hasAnyTask), loading: false as boolean }
}

export interface MissionActionInputs {
  issues: IssueNavigationModel[]
  allIssues: IssueNavigationModel[]
  sessions: SessionView[]
  repos: GitRepositoryWire[]
  machines: MachineWire[]
  session?: SessionView
  issue?: IssueNavigationModel
}
/** The issue menu's label/duplicate catalogs are global UI values. Read them
 * once when that menu is mounted, through the one row reader; never build a
 * persistent catalog or a global session ownership index for mission rows. */
export function readMissionActionInputs(view: MissionViewReader, issueIds: readonly string[], sessionId?: string): MissionActionInputs | typeof LOADING {
  const selected: IssueNavigationModel[] = [], allIssues: IssueNavigationModel[] = []
  const session = sessionId ? view.session(sessionId) : undefined
  if (session === LOADING) return LOADING
  const requested = sessionId ? (session?.issueId ? [session.issueId] : []) : issueIds
  for (const id of requested) {
    const issue = view.issue(id)
    if (issue === LOADING) return LOADING
    if (issue) selected.push(issue)
  }
  let pending = false
  if (!sessionId) for (const id of view.pool.queries.ids({ kind: 'missionIssues' }).sort()) {
    const issue = view.catalogIssue(id)
    if (issue === LOADING) pending = true
    else if (issue) allIssues.push(issue)
  }
  if (pending) return LOADING
  const seats = new Map<string, SessionView>()
  for (const issue of selected) {
    const attached = view.attached(issue.id)
    if (attached === LOADING) return LOADING
    for (const seat of attached) seats.set(seat.sessionId, seat)
  }
  const repos = view.pool.headerViews.ids('repository').flatMap(id => {
    const repo = view.pool.headerViews.row('repository', id)
    return repo ? [repo] : []
  })
  return { issues: selected, allIssues, sessions: [...seats.values()].sort(view.sessionOrder), repos,
    machines: view.pool.headerViews.machines(), session, issue: selected[0] }
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
