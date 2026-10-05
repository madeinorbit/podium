import { keyedComputed } from '@podium/mobx-helpers'
import type { SessionView } from '@podium/client-core/session-values'
import {
  deckSessionOrder, issueAbandoned, issueClosed, issueNeedsHuman, motionPhase,
  sessionAsksOnIssue, sessionAtWork, sessionPresentOnTask, sessionSettled,
  type FlightDeckFoldMap, type FlightDeckMode, type FlightDeckRow,
  type IssueNavigationModel, type MissionProgress,
} from '@podium/client-core/values'
import { cachedGroup } from './cached'
import type { MissionViewReader } from './mission-view'
import { missions } from './mission'
import { LOADING } from './loading'
import { isFinished } from './shared/predicates'

export function settled<T>(read: () => T): T | typeof LOADING {
  try { return read() } catch (error) { if (error === LOADING) return LOADING; throw error }
}
export function requireLoaded<T>(value: T | typeof LOADING): T {
  if (value === LOADING) throw LOADING
  return value
}
const underway = (stage: string) => ['planning', 'in_progress', 'shipping'].includes(stage)
const field = <K extends keyof IssueNavigationModel>(name: K) =>
  cachedGroup(`deck.${String(name)}`, (node: MissionIssueFacts) => node.row?.[name])
const fields = {
  stage: field('stage'), archived: field('archived'), deletedAt: field('deletedAt'),
  parentId: field('parentId'), startedBySession: field('startedBySession'),
  sortKey: field('sortKey'), seq: field('seq'), updatedAt: field('updatedAt'),
  needsHuman: field('needsHuman'), closedReason: field('closedReason'), blocked: field('blocked'),
  coordinatorSessionId: field('coordinatorSessionId'),
}

/** The issue's scalar mission facts. No rich navigation record is read here.
 * Each scalar computed is allocated only while something observes it. */
export class MissionIssueFacts {
  constructor(readonly id: string, readonly view: MissionViewReader) {}
  get row(): IssueNavigationModel | undefined { return requireLoaded(this.view.catalogIssue(this.id)) }
  get stage() { return fields.stage(this) ?? '' }
  get parentId() { return fields.parentId(this) ?? null }
  get startedBySession() { return fields.startedBySession(this) }
  get sortKey() { return fields.sortKey(this) }
  get seq() { return fields.seq(this) ?? 0 }
  get updatedAt() { return fields.updatedAt(this) ?? '' }
  get closedReason() { return fields.closedReason(this) }
  get blocked() { return fields.blocked(this) }
  get needsHuman() { return fields.needsHuman(this) }
  get coordinatorSessionId() { return fields.coordinatorSessionId(this) }
  get visible() { return !fields.archived(this) && !fields.deletedAt(this) && this.stage !== '' }
  private static readonly live = cachedGroup('deck.live', (node: MissionIssueFacts) =>
    requireLoaded(node.view.present(node.id)).some(sessionPresentOnTask))
  get live() { return MissionIssueFacts.live(this) }
}

interface DeckTopology {
  readonly scope: ReadonlySet<string>
  readonly children: ReadonlyMap<string, readonly string[]>
  readonly parent: ReadonlyMap<string, string>
  readonly overlap: boolean
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
  const parent = new Map<string, string>(), seen = new Set<string>()
  let overlap = false
  const firstChild = (id: string) => [...view.pool.graph.many('issue', id, 'children')].sort()[0]
  for (const [id, kids] of children) for (const child of kids) {
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
  return { scope, children, parent, overlap }
}))

type Count = 'tasks' | 'done' | 'run' | 'live' | 'working' | 'needsYou' | 'waiting'
const COUNTS: readonly Count[] = ['tasks', 'done', 'run', 'live', 'working', 'needsYou', 'waiting']
const ownCount = (name: Count) => cachedGroup(`deck.own.${name}`, (row: MissionDeckIssueModel) => {
  const facts = row.facts
  if (!facts.visible) return 0
  if (name === 'tasks') return 1
  if (name === 'done') return Number(issueClosed(facts) && !issueAbandoned(facts))
  if (name === 'run') return Number(!isFinished(facts) && (underway(facts.stage) || facts.stage === 'review'))
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
const crewOf = cachedGroup('deck.crew', (row: MissionDeckIssueModel) => deckSessionOrder(row.facts,
  requireLoaded(row.view.roster(row.id))))
const matchedWorking = cachedGroup('deck.matches.working', (row: MissionDeckIssueModel) => row.sessions.some(sessionAtWork))
const matchedNeedsYou = cachedGroup('deck.matches.needsYou', (row: MissionDeckIssueModel) => own.needsYou(row) > 0)
const collapsedCrew = cachedGroup('deck.collapsedCrew', (row: MissionDeckIssueModel) => {
  const seen = new Set<string>(), candidates: SessionView[] = []
  const rank = (session: SessionView) => sessionPresentOnTask(session) && motionPhase(session) === 'working' ? 0 : sessionSettled(session) ? 2 : 1
  for (const id of [row.id, ...row.descendantIds]) {
    for (const session of row.deck.model(id).sessions) {
      if (seen.has(session.sessionId)) continue
      seen.add(session.sessionId); candidates.push(session)
    }
    // Every child's candidates occur later on ties. Retaining the best twelve
    // after each child preserves the original stable rank ordering.
    candidates.sort((a, b) => rank(a) - rank(b))
    candidates.length = Math.min(12, candidates.length)
  }
  return candidates
})
const kindsOf = cachedGroup('deck.kinds', (row: MissionDeckIssueModel) => {
  const kinds = new Set<SessionView['agentKind']>()
  for (const id of [row.id, ...row.descendantIds]) for (const session of row.deck.model(id).sessions) {
    if (sessionPresentOnTask(session)) kinds.add(session.agentKind)
    if (kinds.size === 2) return [...kinds]
  }
  return [...kinds]
})
const latestBelow = cachedGroup('deck.updatedBelow', (row: MissionDeckIssueModel): string => {
  const shape = requireLoaded(row.deck.topology)
  if (shape.overlap) return [row.id, ...row.descendantIds].reduce((at, id) => row.view.facts(id).updatedAt > at ? row.view.facts(id).updatedAt : at, '')
  let at = row.facts.updatedAt
  for (const id of requireLoaded(row.deckChildren)) { const next = latestBelow(row.deck.model(id)); if (next > at) at = next }
  return at
})

/** A mission-scoped handle on the pool's issue, with lazy computed getters.
 * Scope matters: a graft may have different children and paths in two roots.
 * The handle holds no row, geometry, retained computed or presentation map. */
export class MissionDeckIssueModel implements FlightDeckRow {
  constructor(readonly id: string, readonly deck: MissionDeckModel) {}
  get view() { return this.deck.view }
  get facts() { return this.view.facts(this.id) }
  get issue() { return requireLoaded(this.view.issue(this.id))! }
  get rulesIssue() { return this.view.rulesIssue(this.id) }
  get stage() { return this.facts.stage }
  get title() { return requireLoaded(this.view.title(this.issue)) }
  get deckChildren() { return childrenOf(this) }
  get descendantIds() { return descendants(this) }
  get sessions() { return crewOf(this) }
  get depth() { return this.deck.depth(this.id) }
  get matched() { return this.matches(this.deck.mode) }
  matches(mode: FlightDeckMode) { return mode === 'full' || (mode === 'working' ? matchedWorking(this) : matchedNeedsYou(this)) }
  get rollup() { return this }
  get tasks() { return sum.tasks(this) }
  get done() { return sum.done(this) }
  get run() { return sum.run(this) }
  get actionableCount() { return requireLoaded(sum.needsYou(this)) }
  get liveAgentCount() { return requireLoaded(sum.live(this)) }
  get workingAgentCount() { return requireLoaded(sum.working(this)) }
  get waitingAgentCount() { return requireLoaded(sum.waiting(this)) }
  get collapsedSummary() { return {
    tasks: requireLoaded(this.tasks) - own.tasks(this), done: requireLoaded(this.done) - own.done(this),
    run: requireLoaded(this.run) - own.run(this), kinds: kindsOf(this), crew: collapsedCrew(this), needsYou: this.actionableCount > 0,
  } }
  get presentation() { return this.view.presentation(this.issue, this.sessions) }
  get updatedBelow() { return latestBelow(this) }
  get hasPayload() { return requireLoaded(this.deckChildren).length > 0 || this.sessions.length > 0 }
  folded(folds: FlightDeckFoldMap) {
    const explicit = folds.get(this.id)
    return explicit === undefined ? requireLoaded(this.deckChildren).length === 0 && this.sessions.length === 1 : explicit === 'closed'
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
  private readonly placements = keyedComputed('MissionDeck.rowIds', (key: string) => settled(() => {
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
    const ids: string[] = []
    const walk = (id: string, path: ReadonlySet<string>) => {
      if (path.has(id) || !included.has(id) || !this.view.facts(id).visible) return
      ids.push(id)
      if (folds && id !== this.id && this.model(id).folded(folds)) return
      const next = new Set(path).add(id)
      for (const child of shape.children.get(id) ?? []) walk(child, next)
    }
    walk(this.id, new Set())
    return ids
  }))
  constructor(readonly id: string, readonly view: MissionViewReader, readonly mode: FlightDeckMode) {}
  get members() { return missions(this.view.pool).members(this.id) }
  get topology() { return topology(this) }
  get progress() { return progress(this) }
  rowIds(mode: FlightDeckMode = this.mode, collapsed: FlightDeckFoldMap | null = null) {
    return this.placements(JSON.stringify([mode, collapsed === null ? null : [...collapsed]]))
  }
  model(id: string) {
    let model = this.modelsById.get(id)
    if (!model) { model = new MissionDeckIssueModel(id, this); this.modelsById.set(id, model) }
    return model
  }
  depth(id: string) {
    const shape = requireLoaded(this.topology), path = new Set<string>()
    const walk = (current: string, depth: number): number | undefined => {
      if (path.has(current)) return undefined
      if (current === id) return depth
      path.add(current)
      for (const child of shape.children.get(current) ?? []) { const found = walk(child, depth + 1); if (found !== undefined) return found }
      path.delete(current)
      return undefined
    }
    return walk(this.id, 0) ?? 0
  }
  ancestorPath(id: string) {
    const shape = requireLoaded(this.topology), ids: string[] = [], seen = new Set<string>()
    let current: string | undefined = id
    while (current && !seen.has(current)) { seen.add(current); ids.push(current); if (current === this.id) break; current = shape.parent.get(current) }
    return ids.reverse()
  }
  dispose() { this.placements.clear(); this.modelsById.clear() }
}
