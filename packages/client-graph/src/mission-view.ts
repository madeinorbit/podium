import type { SessionView } from '@podium/client-core/session-values'
import {
  deckIssueState, deckSessionOrder, issueAbandoned, issueClosed, issueNeedsHuman,
  motionPhase, panelLabel, sessionAsksOnIssue, sessionAtWork, sessionPresentOnTask,
  sessionSettled, type FlightDeckMode, type FlightDeckRow, type IssueContinuation,
  type IssueNavigationModel, type IssueNote, type MissionDeparture, type MissionProgress,
  type PresenceNote, type HandoffNowEntry, type HandoffNextEntry,
} from '@podium/client-core/viewmodels'
import { asIssueId, asSessionId, DRAFT_ISSUE_TITLE } from '@podium/model/browser'
import type { GitRepositoryWire, MachineWire } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { cachedGroup } from './cached'
import { missions } from './mission'
import { MISSION_VIEW_DEPS } from './mission-view-schema'
import { knownIssueIds } from './enumerate'
import type { MobxPool } from './pool'
import { overlayRow } from './shared/overlay-row'
import { LOADING, type Loaded } from './worklist/rollup'

export interface MissionRowPresentation {
  state: ReturnType<typeof deckIssueState>
  note: IssueNote | null
  presence: PresenceNote | null
}
export interface MissionViewValues {
  root: IssueNavigationModel | undefined
  rows: FlightDeckRow[]
  members: ReadonlySet<string>
  byId: ReadonlyMap<string, IssueNavigationModel>
  sessions: readonly SessionView[]
  archived: SessionView[]
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
  root: undefined, rows: [], members: new Set<string>(), byId: new Map<string, IssueNavigationModel>(),
  sessions: [], archived: [], titles: new Map<string, string>(), progress: NO_PROGRESS,
  departures: [], continuation: null, note: null, presence: null, rowPresentation: new Map<string, MissionRowPresentation>(),
})

/** IDs only in these handles. Computed groups live only while a pane/diagnostic
 * observes them; row values are borrowed through the pool's one reader. */
class MissionNode {
  constructor(readonly id: string, readonly view: MissionViewReader) {}
}
const issueValue = cachedGroup('missionIssue', (node: MissionNode) => node.view.readIssue(node.id))
const attachedValue = cachedGroup('missionAttachments', (node: MissionNode) => node.view.readAttached(node.id))
const rowOrder = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const sessionOrder = (a: SessionView, b: SessionView) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0
const visible = (issue: { archived?: boolean; deletedAt?: string | null }) => !issue.archived && !issue.deletedAt
const openSession = sessionPresentOnTask
const underway = new Set(['planning', 'in_progress', 'shipping'])
const leftMission = (issue: IssueNavigationModel) => !['proposed', 'backlog'].includes(issue.stage) && Boolean(issue.deps.find(dep => dep.type === 'discovered-from'))
const originId = (issue: IssueNavigationModel) => issue.deps.find(dep => dep.type === 'discovered-from')?.id ?? null

/** One read service on the existing principal's pool. There is no source,
 * replica, runtime, outbox or independently maintained relation index here. */
export class MissionViewReader {
  private readonly nodes = new Map<string, MissionNode>()
  readonly stats = { values: 0, issueReads: 0, sessionReads: 0, attachmentEdges: 0 }
  private node(id: string) {
    let node = this.nodes.get(id)
    if (!node) { node = new MissionNode(id, this); this.nodes.set(id, node) }
    return node
  }
  constructor(readonly pool: MobxPool) {}
  issue(id: string): Loaded<IssueNavigationModel> { return issueValue(this.node(id)) }
  attached(id: string): readonly SessionView[] | typeof LOADING { return attachedValue(this.node(id)) }
  session(id: string): Loaded<SessionView> {
    this.stats.sessionReads++
    let row = this.pool.row('session', id, 'summary')
    if (row && row !== LOADING && !['sessionId', 'cwd', 'status', 'lastActiveAt', 'title'].every(key => Object.hasOwn(row, key))) row = this.pool.row('session', id)
    return row as Loaded<SessionView>
  }
  readAttached(id: string): readonly SessionView[] | typeof LOADING {
    const found: SessionView[] = []
    let pending = false
    for (const sessionId of this.pool.graph.many('issue', id, 'missionSessions')) {
      this.stats.attachmentEdges++
      const session = this.session(sessionId)
      if (session === LOADING) pending = true
      else if (session) found.push(session)
    }
    return pending ? LOADING : found.sort(sessionOrder)
  }
  readIssue(id: string): Loaded<IssueNavigationModel> {
    this.stats.issueReads++
    const raw = this.pool.row('issue', id)
    if (raw === LOADING || !raw) return raw
    const row = raw as Omit<IssueNavigationModel, 'description' | 'notes'> & { description: string | { value: string }; notes?: string | { value: string } }
    const attached = this.attached(id)
    if (attached === LOADING) return LOADING
    // Replica-derived member IDs exclude shells, but include archived/headless
    // attachments. The drawn roster applies its additional headless filter.
    const members = attached.filter(session => session.agentKind !== 'shell')
    const childIds = [...this.pool.graph.many('issue', id, 'treeChildren')]
    let childDoneCount = 0, pending = false
    for (const childId of childIds) {
      const child = this.pool.row('issue', childId, 'summary') as Loaded<{ stage: string }>
      if (child === LOADING) pending = true
      else if (child?.stage === 'done') childDoneCount++
    }
    if (pending) return LOADING
    const repoId = this.pool.graph.one('issue', id, 'repo')
    const repo = repoId ? this.pool.row('repo', repoId) as { prefix?: string } | undefined : undefined
    const byPhase: Record<string, number> = {}
    let unread = !row.readAt || !Number.isFinite(Date.parse(row.readAt)) || Date.parse(row.updatedAt) > Date.parse(row.readAt)
    for (const session of members) {
      const phase = session.agentState?.phase ?? 'unknown'
      byPhase[phase] = (byPhase[phase] ?? 0) + 1
      unread ||= Date.parse(session.lastActiveAt) > Date.parse(row.readAt ?? '')
    }
    const dependents = [
      ...[...this.pool.graph.many('issue', id, 'spinOffs')].map(id => ({ id: asIssueId(id), type: 'discovered-from' })),
      ...MISSION_VIEW_DEPS.flatMap(([type, , inverse]) => [...this.pool.graph.many('issue', id, inverse)].map(id => ({ id: asIssueId(id), type }))),
    ].sort(rowOrder)
    const deferAt = row.deferUntil ? Date.parse(row.deferUntil) : NaN
    const deferred = Number.isFinite(deferAt) && !this.pool.clock.reached(deferAt)
    return overlayRow(row, {
      description: typeof row.description === 'string' ? row.description : row.description?.value ?? '',
      notes: typeof row.notes === 'string' ? row.notes : row.notes?.value,
      worktreePath: row.worktreePath ?? null, branch: row.branch ?? null,
      prefix: repo?.prefix, displayRef: issueDisplayRef({ seq: row.seq, prefix: repo?.prefix }),
      memberSessionIds: members.map(session => asSessionId(session.sessionId)),
      childIds: [...childIds].sort().map(asIssueId), childCount: childIds.length, childDoneCount,
      deferred, ready: !row.blocked && !deferred && row.stage !== 'done', dependents,
      unread: row.deletedAt ? false : unread, sessionSummary: { total: members.length, byPhase },
    }) as IssueNavigationModel
  }
  roster(id: string, archived = false): readonly SessionView[] | typeof LOADING {
    const attached = this.attached(id)
    return attached === LOADING ? LOADING : attached.filter(session => !session.headless && session.agentKind !== 'shell' && Boolean(session.archived) === archived)
  }
  selectedRoot(selectedId: string | null): Loaded<IssueNavigationModel> {
    const rootId = missions(this.pool).rootFor(selectedId)
    if (rootId === LOADING || !rootId) return rootId === LOADING ? LOADING : undefined
    const root = this.issue(rootId)
    if (root === LOADING || !root || !visible(root)) return root === LOADING ? LOADING : undefined
    if (root.isDraftVessel && !root.worktreePath) {
      const sessions = this.attached(rootId)
      if (sessions === LOADING) return LOADING
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
  dispose = () => { this.nodes.clear() }
}

export function missionView(pool: MobxPool): MissionViewReader {
  return pool.sources.view('missionView', () => new MissionViewReader(pool))
}

/** A single derivation's addressed neighbourhood. These maps are presentation
 * values, not maintained indexes: their inputs are declared graph queries. */
class MissionContext {
  readonly byId = new Map<string, IssueNavigationModel>()
  constructor(readonly view: MissionViewReader) {}
  issue(id: string): IssueNavigationModel | undefined {
    if (this.byId.has(id)) return this.byId.get(id)
    const value = this.view.issue(id)
    if (value === LOADING) throw LOADING
    if (value) this.byId.set(id, value)
    return value
  }
  attached(id: string): readonly SessionView[] {
    const value = this.view.attached(id)
    if (value === LOADING) throw LOADING
    return value
  }
  roster(id: string, archived = false): SessionView[] {
    const value = this.view.roster(id, archived)
    if (value === LOADING) throw LOADING
    return [...value]
  }
  live(id: string) { return this.attached(id).some(openSession) }
  lastActive(issue: IssueNavigationModel, local: boolean) {
    return local ? issue.updatedAt : this.attached(issue.id).reduce((latest, session) =>
      !session.archived && session.lastActiveAt > latest ? session.lastActiveAt : latest, issue.updatedAt)
  }
  preferred(candidates: readonly IssueNavigationModel[], local = false): IssueNavigationModel | undefined {
    const staffed = local ? [] : candidates.filter(issue => this.live(issue.id))
    const unfinished = candidates.filter(issue => !issue.closedReason && issue.stage !== 'done')
    return [...(staffed.length ? staffed : unfinished.length ? unfinished : candidates)]
      .sort((a, b) => this.lastActive(b, local).localeCompare(this.lastActive(a, local)))[0]
  }
  tips(origin: string, local = false): IssueNavigationModel[] {
    const seen = new Set<string>(), descendants: IssueNavigationModel[] = []
    const stack = [origin]
    while (stack.length) {
      const parentId = stack.pop()!
      const children = [...this.view.pool.graph.many('issue', parentId, 'spinOffs')].sort()
      for (const id of children) {
        if (seen.has(id)) continue
        seen.add(id)
        const facts = this.view.pool.row('issue', id, 'summary') as Loaded<{ archived?: boolean; deletedAt?: string }>
        if (facts === LOADING) throw LOADING
        if (!facts || !visible(facts)) continue
        const issue = this.issue(id)
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
        const parent = this.issue(parentId)
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
    const targetId = this.view.pool.graph.one('issue', issue.id, 'viewSupersededBy') ??
      this.view.pool.graph.one('issue', issue.id, 'viewDuplicateOf')
    if (targetId) {
      const target = this.issue(targetId), ref = target ? issueDisplayRef(target) : 'another task'
      return issue.supersededBy ? { kind: 'superseded', ...(target ? { target } : {}), short: ref,
        full: `Work continued in ${ref}`, line: `continued · ${ref}` } :
        { kind: 'duplicate', ...(target ? { target } : {}), short: ref,
          full: `The same work is tracked in ${ref}`, line: `duplicate · ${ref}` }
    }
    if ((local ? this.roster(issue.id) : this.attached(issue.id)).some(openSession)) return null
    const tip = this.preferred(this.tips(issue.id, local), local)
    if (!tip) return null
    const ref = issueDisplayRef(tip)
    return { kind: 'spinoff', target: tip, short: ref, full: `Work continued in ${ref}`, line: `continued · ${ref}` }
  }
  waiting(issue: IssueNavigationModel): string[] {
    return issue.deps.filter(dep => dep.type === 'blocks').flatMap(dep => {
      const target = this.issue(dep.id)
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
        const source = this.issue(sourceId), ref = source ? issueDisplayRef(source) : null
        return spin ? { kind: 'shape-own', label: 'starts', short: 'on its own',
          full: ref ? `Starts on its own — ${ref} can close without it` : 'Starts on its own — the task that found it can close without it' } :
          { kind: 'shape-mission', label: 'starts', short: 'in this mission',
            full: ref ? `Part of ${ref} — that task is not done until this is` : 'Part of the task that found it — that task is not done until this is' }
      }
    }
    const verbs: Record<string, string> = { 'discovered-from': 'Discovered from', related: 'Related to', tracks: 'Tracks', supersedes: 'Supersedes', 'caused-by': 'Caused by', validates: 'Validates' }
    for (const dep of issue.deps) {
      if (dep.type === 'blocks' || dep.type === 'parent-child') continue
      const target = this.issue(dep.id)
      if (!target) continue
      const label = verbs[dep.type] ?? dep.type, ref = issueDisplayRef(target)
      return { kind: 'relation', label, short: ref, full: `${label} ${ref}` }
    }
    return null
  }
  presence(issue: IssueNavigationModel, sessions: readonly SessionView[], local = false): PresenceNote | null {
    if (sessions.some(openSession)) return null
    const moved = sessions.find(session => session.handoffTarget)
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
}

function buildRows(ctx: MissionContext, root: IssueNavigationModel, members: ReadonlySet<string>, mode: FlightDeckMode): FlightDeckRow[] {
  const children = new Map<string, IssueNavigationModel[]>(), scope = new Set<string>()
  const stack = [...members]
  while (stack.length) {
    const id = stack.pop()!
    if (scope.has(id)) continue
    scope.add(id)
    const facts = ctx.view.pool.row('issue', id, 'summary') as Loaded<{ archived?: boolean; deletedAt?: string }>
    if (facts === LOADING) throw LOADING
    if (!facts || !visible(facts)) continue
    const issue = ctx.issue(id)
    if (!issue) continue
    const kids = [...ctx.view.pool.graph.many('issue', id, 'children')]
    stack.push(...kids)
    const found = kids.flatMap(childId => {
      const childFacts = ctx.view.pool.row('issue', childId, 'summary') as Loaded<{ archived?: boolean; deletedAt?: string }>
      if (childFacts === LOADING) throw LOADING
      if (!childFacts || !visible(childFacts)) return []
      const child = ctx.issue(childId)
      return child ? [child] : []
    })
    children.set(id, found)
  }
  for (const id of members) {
    const issue = ctx.byId.get(id)
    if (!issue || !visible(issue) || id === root.id || (issue.parentId && members.has(issue.parentId))) continue
    const owner = issue.startedBySession ? ctx.view.pool.graph.one('session', issue.startedBySession, 'missionIssue') : null
    const parentId = owner && members.has(owner) && owner !== id ? owner : root.id
    const siblings = children.get(parentId) ?? []
    if (!siblings.some(child => child.id === id)) siblings.push(issue)
    children.set(parentId, siblings)
  }
  for (const siblings of children.values()) siblings.sort((a, b) =>
    a.sortKey && b.sortKey && a.sortKey !== b.sortKey ? a.sortKey.localeCompare(b.sortKey) : a.seq - b.seq || rowOrder(a, b))
  const parentOf = new Map<string, string>()
  for (const [id, kids] of children) for (const child of kids) if (!parentOf.has(child.id)) parentOf.set(child.id, id)
  const rosters = new Map<string, SessionView[]>()
  for (const id of scope) {
    const issue = ctx.byId.get(id)
    if (issue && visible(issue)) rosters.set(id, deckSessionOrder(issue, ctx.roster(id)))
  }
  const matches = (issue: IssueNavigationModel) => mode === 'needs-you' ? issueNeedsHuman(issue, rosters.get(issue.id) ?? []) :
    mode === 'working' ? (rosters.get(issue.id) ?? []).some(sessionAtWork) : true
  const included = new Set<string>([root.id])
  for (const id of members) {
    const issue = ctx.byId.get(id)
    if (!issue || !visible(issue) || !matches(issue)) continue
    let current: string | undefined = id
    const seen = new Set<string>()
    while (current && !seen.has(current)) {
      seen.add(current); included.add(current)
      if (current === root.id) break
      current = parentOf.get(current)
    }
  }
  const descendants = (id: string) => {
    const seen = new Set<string>([id]), out: string[] = [], stack = [...(children.get(id) ?? [])].reverse()
    while (stack.length) {
      const child = stack.pop()!
      if (seen.has(child.id)) continue
      seen.add(child.id); out.push(child.id)
      stack.push(...[...(children.get(child.id) ?? [])].reverse())
    }
    return out
  }
  const rows: FlightDeckRow[] = []
  const walk = (id: string, depth: number, path: ReadonlySet<string>) => {
    const issue = ctx.byId.get(id)
    if (path.has(id) || !included.has(id) || !issue || !visible(issue)) return
    const descendantIds = descendants(id), ids = [id, ...descendantIds]
    const allSessions = ids.flatMap(id => rosters.get(id) ?? [])
    const actionableCount = ids.filter(id => { const candidate = ctx.byId.get(id); return candidate && issueNeedsHuman(candidate, rosters.get(id) ?? []) }).length
    const waitingAgentCount = ids.reduce((count, id) => {
      const candidate = ctx.byId.get(id)
      return count + (candidate ? (rosters.get(id) ?? []).filter(session => sessionAsksOnIssue(candidate, session)).length : 0)
    }, 0)
    const hidden = descendantIds.flatMap(id => { const child = ctx.byId.get(id); return child ? [child] : [] })
    const working = (session: SessionView) => openSession(session) && motionPhase(session) === 'working'
    const rank = (session: SessionView) => working(session) ? 0 : sessionSettled(session) ? 2 : 1
    const seenCrew = new Set<string>()
    const unique = allSessions.filter(session => { if (seenCrew.has(session.sessionId)) return false; seenCrew.add(session.sessionId); return true })
    rows.push({ issue, depth, sessions: rosters.get(id) ?? [], descendantIds, actionableCount,
      liveAgentCount: allSessions.filter(openSession).length, workingAgentCount: allSessions.filter(working).length,
      waitingAgentCount, matched: matches(issue), collapsedSummary: {
        tasks: hidden.length, done: hidden.filter(child => issueClosed(child) && !issueAbandoned(child)).length,
        run: hidden.filter(child => !child.closedReason && (underway.has(child.stage) || child.stage === 'review')).length,
        kinds: [...new Set(allSessions.filter(openSession).map(session => session.agentKind))].slice(0, 2),
        crew: unique.sort((a, b) => rank(a) - rank(b)).slice(0, 12), needsYou: actionableCount > 0,
      } })
    const nextPath = new Set(path).add(id)
    for (const child of children.get(id) ?? []) walk(child.id, depth + 1, nextPath)
  }
  walk(root.id, 0, new Set())
  return rows
}

function progressFor(ctx: MissionContext, root: IssueNavigationModel, members: ReadonlySet<string>): MissionProgress {
  const formal = new Set<string>(), stack = [...ctx.view.pool.graph.many('issue', root.id, 'children')]
  while (stack.length) {
    const id = stack.pop()!
    if (id === root.id || formal.has(id)) continue
    const issue = ctx.issue(id)
    if (!issue || !visible(issue)) continue
    formal.add(id); stack.push(...ctx.view.pool.graph.many('issue', id, 'children'))
  }
  const scope = [...members].flatMap(id => { const issue = ctx.byId.get(id); return issue && visible(issue) ? [issue] : [] })
  const accepted = scope.filter(issue => formal.has(issue.id) && issue.stage !== 'proposed' && !issueAbandoned(issue))
  const units = (accepted.length ? accepted : [root]).filter(issue => !issueAbandoned(issue) &&
    (ctx.live(issue.id) || (ctx.tips(issue.id, true).length === 0 && ctx.view.pool.graph.size('issue', issue.id, 'spinOffs') === 0)))
  const staffed = new Set<string>()
  for (const issue of scope) {
    if (!ctx.live(issue.id)) continue
    let id: string | null = issue.id
    while (id && !staffed.has(id)) { staffed.add(id); id = ctx.view.pool.graph.one('issue', id, 'parent') }
  }
  const result = { ...NO_PROGRESS, total: units.length }
  for (const issue of units) {
    if (issueClosed(issue)) result.done++
    else if (issue.blocked) result.block++
    else if (issue.stage === 'review') result.review++
    else if (underway.has(issue.stage)) {
      if (issue.stage === 'shipping' || staffed.has(issue.id)) result.run++
      else result.stall++
    }
  }
  result.wait = Math.max(0, result.total - result.done - result.block - result.review - result.run - result.stall)
  return result
}

export function readMissionView(view: MissionViewReader, selectedId: string | null, mode: FlightDeckMode = 'full'): MissionViewValues | typeof LOADING {
  view.stats.values++
  try {
    const root = view.selectedRoot(selectedId)
    if (root === LOADING) return LOADING
    if (!root) return EMPTY_MISSION_VIEW
    const members = missions(view.pool).members(root.id)
    if (members === LOADING) return LOADING
    const ctx = new MissionContext(view)
    ctx.byId.set(root.id, root)
    const rows = buildRows(ctx, root, members, mode)
    const seenArchived = new Set<string>(), archived: SessionView[] = [], titles = new Map<string, string>()
    const rowPresentation = new Map<string, MissionRowPresentation>()
    for (const row of rows) {
      for (const session of ctx.roster(row.issue.id, true)) {
        if (!seenArchived.has(session.sessionId)) { seenArchived.add(session.sessionId); archived.push(session) }
      }
      const title = view.title(row.issue)
      if (title === LOADING) return LOADING
      titles.set(row.issue.id, title)
      // The row's old local note sees only its own crew; the root header sees
      // staffing on continuation targets as well. Preserve both readings.
      const note = ctx.note(row.issue, true), presence = ctx.presence(row.issue, row.sessions, true)
      rowPresentation.set(row.issue.id, { state: deckIssueState(row.issue, row.sessions, ctx.byId), note, presence })
    }
    const continuation = ctx.continuation(root), note = ctx.note(root), presence = ctx.presence(root, rows[0]?.sessions ?? [])
    const departures: MissionDeparture[] = [], seenDepartures = new Set<string>()
    // Legacy origin order is the replica's id order, not the rendered seq order.
    const origins = [...members].sort().flatMap(id => { const issue = ctx.issue(id); return issue && visible(issue) ? [issue] : [] })
    for (const origin of origins) {
      const empty = !ctx.roster(origin.id).some(openSession)
      for (const tip of ctx.tips(origin.id)) {
        if (members.has(tip.id) || seenDepartures.has(tip.id) || (!empty && issueClosed(tip))) continue
        seenDepartures.add(tip.id)
        ctx.waiting(tip)
        departures.push({ issue: tip, originId: origin.id, state: deckIssueState(tip, ctx.roster(tip.id), ctx.byId) })
      }
    }
    const progress = progressFor(ctx, root, members)
    // API/handoff/gesture consumers need explicit members, archived included.
    // Never reconstruct ownership by scanning a global session array.
    const sessions = [...new Map([...ctx.byId.keys()].flatMap(id => ctx.attached(id)).map(session => [session.sessionId, session])).values()].sort(sessionOrder)
    return { root, rows, members, byId: ctx.byId, sessions, archived, titles, progress,
      departures: departures.sort((a, b) => a.issue.seq - b.issue.seq), continuation, note, presence, rowPresentation }
  } catch (error) { if (error === LOADING) return LOADING; throw error }
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
function poolHandoffNow(ctx: MissionContext, issues: readonly IssueNavigationModel[], memberIds: ReadonlySet<string>): HandoffNowEntry[] {
  const entries: Array<{ entry: HandoffNowEntry; seq: number }> = []

  for (const issue of issues) {
    if (!memberIds.has(issue.id) || issue.stage === 'proposed' || issue.archived || issue.deletedAt)
      continue
    const crew = ctx.attached(issue.id)
    const present = crew.filter(sessionPresentOnTask)
    const asking = present.find(
      (session) => sessionAsksOnIssue(issue, session) || motionPhase(session) === 'waiting',
    )
    const askedBy = issue.asked?.by
      ? crew.find((session) => session.sessionId === issue.asked?.by)
      : undefined
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
            ctx.presence(issue, crew)?.text ??
            'Agent computing now.',
        }
      } else if (issue.stage === 'review' && !issue.blocked) {
        const session = newestSession(crew)
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
            ctx.presence(issue, crew)?.text ??
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
            ctx.presence(issue, crew)?.text ??
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


function poolHandoffNext(ctx: MissionContext, issues: readonly IssueNavigationModel[], memberIds: ReadonlySet<string>): HandoffNextEntry[] {
  const entries: Array<{ entry: HandoffNextEntry; seq: number; depth: number }> = []
  const depthMemo = new Map<string, number>()

  const prerequisites = (issue: IssueNavigationModel): IssueNavigationModel[] => {
    const blockers = (issue.deps ?? [])
      .filter((dep) => dep.type === 'blocks')
      .map((dep) => ctx.issue(dep.id))
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
      .map((dep) => ctx.issue(dep.id))
      .filter((candidate): candidate is IssueNavigationModel =>
        Boolean(candidate && !issueClosed(candidate)),
      )
    const children = poolOpenChildren(ctx, memberIds, issue.id)
    const session = newestSession(ctx.attached(issue.id))
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

function poolOpenChildren(ctx: MissionContext, members: ReadonlySet<string>, parentId: string): IssueNavigationModel[] {
  return [...ctx.view.pool.graph.many('issue', parentId, 'treeChildren')].flatMap(id => {
    if (!members.has(id)) return []
    const issue = ctx.issue(id)
    return issue && issue.stage !== 'proposed' && visible(issue) && !issueClosed(issue) ? [issue] : []
  }).sort(rowOrder)
}
export interface MissionHandoffValues {
  crew: readonly SessionView[]
  current: readonly HandoffNowEntry[]
  next: readonly HandoffNextEntry[]
}

export function readWorkspaceMission(view: MissionViewReader, selectedId: string | null, focusedId: string | null) {
  const selected = selectedId ? view.issue(selectedId) : undefined
  if (selected === LOADING) return LOADING
  const rootId = selected && visible(selected) ? missions(view.pool).rootFor(selected.id) : undefined
  if (rootId === LOADING) return LOADING
  const missionRoot = rootId ? view.issue(rootId) : undefined
  if (missionRoot === LOADING) return LOADING
  const missionIds = missionRoot ? missions(view.pool).members(missionRoot.id) : new Set<string>()
  if (missionIds === LOADING) return LOADING
  const missionIssues: IssueNavigationModel[] = []
  for (const id of [...missionIds].sort()) {
    const issue = view.issue(id)
    if (issue === LOADING) return LOADING
    if (issue) missionIssues.push(issue)
  }
  const focused = focusedId && missionIds.has(focusedId) ? view.issue(focusedId) : undefined
  if (focused === LOADING) return LOADING
  const missionOnScreen = view.selectedRoot(selectedId)
  if (missionOnScreen === LOADING) return LOADING
  const hasAnyTask = view.pool.hasFirstTask
  if (hasAnyTask === LOADING) return LOADING
  return { missionRoot, missionIds, missionIssues, issue: focused ?? missionRoot, missionOnScreen, hasAnyTask, loading: false as boolean }
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
  if (!sessionId) for (const id of knownIssueIds(view.pool).sort()) {
    const issue = view.issue(id)
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
  return { issues: selected, allIssues, sessions: [...seats.values()].sort(sessionOrder), repos,
    machines: view.pool.headerViews.machines(), session, issue: selected[0] }
}
export function readMissionHandoff(view: MissionViewReader, rootId: string): MissionHandoffValues | typeof LOADING {
  try {
    const members = missions(view.pool).members(rootId)
    if (members === LOADING) return LOADING
    const ctx = new MissionContext(view)
    const issues = [...members].sort().flatMap(id => { const issue = ctx.issue(id); return issue ? [issue] : [] })
    const crew = [...new Map([...members].flatMap(id => ctx.attached(id)).map(session => [session.sessionId, session])).values()].sort(sessionOrder)
    return { crew, current: poolHandoffNow(ctx, issues, members), next: poolHandoffNext(ctx, issues, members) }
  } catch (error) { if (error === LOADING) return LOADING; throw error }
}
