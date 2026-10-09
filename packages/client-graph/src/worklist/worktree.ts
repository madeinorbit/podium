import { here } from '../lookup'
import { lazy } from '@podium/mobx-helpers'
import { compareShallow, compareStructural } from 'mobx'
import { machinePathsEqual } from '@podium/model/browser'
import { createQueryResult } from '../query-result'
import type { IssueModel, ModelOf, SessionModel } from '../models'
import type { Worklist } from './view-model'
import { sidebarRosterView } from './sidebar-roster'
import { sidebarRosterOf, type SidebarState } from './sidebar'
import { LOADING } from './rollup'
import { sidebarTimingFromFacts, combineSidebarSessionField, NO_SIDEBAR_SESSIONS, type SidebarSessionFacts } from './sidebar-row'

const EMPTY_SESSIONS: readonly SessionModel[] = Object.freeze([])

/** A roster keeps shared sessions, with demand-scoped data queries owning
 * ordering. A heartbeat updates one ordering key; it never sorts the roster. */
export class WorklistWorktree {
  private readonly orderedSessions: ReturnType<WorklistWorktree['sessionQuery']>
  constructor(readonly worktree: ModelOf['worktree'], readonly worklist: Worklist) {
    // Query contents and subscriptions live only while a reader watches get().
    this.orderedSessions = this.sessionQuery()
  }
  get id() { return this.worktree.id }
  @lazy({ equals: compareShallow }) get representedIssues(): readonly IssueModel[] {
    const pool = this.worklist.pool
    return [...pool.graph.many('worktree', this.id, 'issues')].map(id => pool.issueObject(id))
      .filter(issue => this.worklist.row(issue).rosterOwner.represented)
  }
  @lazy({ equals: compareShallow }) get candidateIds(): readonly string[] {
    return [...sidebarRosterView(this.worklist.pool).residentCandidates(this.id)]
      .filter(id => this.worklist.session(this.worklist.pool.sessionObject(id)).rosterCandidate)
  }
  @lazy get hasCandidates(): boolean {
    for (const id of sidebarRosterView(this.worklist.pool).residentCandidates(this.id))
      if (this.worklist.session(this.worklist.pool.sessionObject(id)).rosterCandidate) return true
    return false
  }
  @lazy({ equals: compareShallow }) get rosterIds(): readonly string[] {
    return sidebarRosterOf(this.worklist.host, this.id).ids
  }
  get roster() { return { ids: this.rosterIds, pending: 0 } }

  private sessionQuery() {
    const pool = this.worklist.pool
    const index = sidebarRosterView(pool)
    return createQueryResult<SessionModel>({
      name: `worklist.worktree@${this.id}.sessions`,
      ids: () => index.residentCandidates(this.id),
      has: id => index.hasResidentCandidate(this.id, id),
      read: id => {
        const state = pool.resident('session', id)
        if (state === 'loading') return LOADING
        if (state === 'absent') return undefined
        const session = pool.sessionObject(id)
        if (session.status === 'exited' || !this.worklist.session(session).rosterCandidate) return undefined
        return session
      },
      order: id => this.worklist.session(pool.sessionObject(id)).sortKey,
      compareOrder: compareSessionKeys,
      matches: [session => this.worklist.session(session).phase === 'waiting', session => session.executing],
      partition: {
        order: session => this.worklist.session(session).stale ? JSON.stringify([session.lastActivity, this.worklist.session(session).sortKey]) : undefined,
        compareOrder: (a, b) => {
          const left = JSON.parse(a) as [string, string], right = JSON.parse(b) as [string, string]
          return right[0].localeCompare(left[0]) || compareSessionKeys(left[1], right[1])
        },
        keepFirst: 3, minimumSize: 5,
      },
      subscribe: changed => index.subscribeCandidates(this.id, changed),
    })
  }
  /** Forward the query's persistent answers; order changes edit their paths. */
  get sessions(): readonly SessionModel[] { return this.sessionRows(this.orderedSessions.get()) }
  get stale(): readonly SessionModel[] { return this.sessionRows(this.orderedSessions.partition(true)) }
  get visible(): readonly SessionModel[] { return this.sessionRows(this.orderedSessions.partition(false)) }
  private sessionRows(rows: readonly SessionModel[] | typeof LOADING | undefined): readonly SessionModel[] {
    return rows === LOADING || rows === undefined ? EMPTY_SESSIONS : rows
  }
  @lazy({ equals: compareShallow }) get issues(): readonly IssueModel[] {
    const issues = new Set<IssueModel>()
    for (const id of this.rosterIds) {
      const session = this.worklist.pool.sessionObject(id)
      if (session.issueLink !== null) {
        const issue = here(this.worklist.pool.model('issue', session.issueLink))
        if (issue) issues.add(issue)
      }
    }
    return [...issues]
  }
  @lazy get activityAt(): number {
    let latest = 0
    for (const id of this.rosterIds) latest = Math.max(latest, this.worklist.pool.sessionObject(id).activityMs ?? 0)
    return latest
  }
  @lazy get pending(): number {
    let pending = 0
    for (const id of this.rosterIds) {
      if (this.worklist.pool.resident('session', id) === 'loading') pending++
      const owner = this.worklist.pool.sessionObject(id).issueLink
      if (owner !== null && this.worklist.pool.knownIssue(owner) && this.worklist.pool.resident('issue', owner) === 'loading') pending++
    }
    return pending
  }
  @lazy get sectionAsking() { return this.ready === 'ready' && this.waitingCount > 0 }
  active(state: SidebarState): boolean {
    return state.selectedWorktree != null && machinePathsEqual(state.selectedWorktree, this.id) && this.worklist.selectedId === null
  }
  @lazy get ready(): 'ready' | typeof LOADING | undefined {
    return !this.rosterIds.length ? undefined : this.pending > 0 ? LOADING : 'ready'
  }
  @lazy get title() { return `${this.worktree.repoName}${this.worktree.branch ? ` · ${this.worktree.branch}` : ''}` }
  @lazy get visiblePhase() {
    let working = false, done = this.sessions.length > 0
    for (const session of this.sessions) {
      const phase = this.worklist.session(session).phase
      if (phase === 'waiting') return 'waiting'
      working ||= phase === 'working'
      done &&= phase === 'done'
    }
    return working ? 'working' : done ? 'done' : 'queued'
  }
  @lazy get visibleWorking() { return this.sessions.some(session => session.executing) }
  @lazy get sessionCount() { return this.number(this.orderedSessions.count()) }
  @lazy get workingCount() { return this.number(this.orderedSessions.countMatch(1)) }
  @lazy get waitingCount() { return this.number(this.orderedSessions.countMatch(0)) }
  private number(value: number | typeof LOADING | undefined): number { return value === LOADING || value === undefined ? 0 : value }
  @lazy get visibleUnread() { return !this.visibleWorking && this.sessions.some(session => session.unread) }
  @lazy({ equals: compareStructural }) get visibleFleet() {
    let fleet = NO_SIDEBAR_SESSIONS.fleet
    for (const session of this.sessions) fleet = combineSidebarSessionField('fleet', fleet, session.fleet)
    return fleet
  }
  @lazy({ equals: compareStructural }) private get workingTimer() {
    let timer: SidebarSessionFacts['working']
    for (const session of this.sessions) timer = combineSidebarSessionField('working', timer, session.workingTimer)
    return timer
  }
  @lazy({ equals: compareStructural }) private get waitingTimer() {
    let timer: SidebarSessionFacts['waitingOpen']
    for (const session of this.sessions) if (session.motion === 'waiting')
      timer = combineSidebarSessionField('waitingOpen', timer, session.waitingTimer)
    return timer
  }
  @lazy private get doneSinceMs() {
    let latest = 0
    for (const session of this.sessions) latest = Math.max(latest, session.doneSinceMs)
    return latest
  }
  @lazy private get workingMsTotal() {
    let total: number | undefined
    for (const session of this.sessions) total = combineSidebarSessionField('totalMs', total, session.workingMsTotal)
    return total
  }
  @lazy({ equals: compareStructural }) get timing() {
    const tree = this
    return sidebarTimingFromFacts({
      get working() { return tree.workingTimer },
      get waitingOpen() { return tree.waitingTimer },
      get doneSince() { return tree.doneSinceMs },
      get totalMs() { return tree.workingMsTotal },
      fleet: NO_SIDEBAR_SESSIONS.fleet, errorClass: null, allUnstarted: true,
    }, this.visiblePhase, false, this.activityAt)
  }
  @lazy get navigation() { return this.sessions[0] ? { kind: 'session' as const, id: this.sessions[0].sessionId } : null }
}

function compareSessionKeys(a: string, b: string): number {
  const left = JSON.parse(a) as [number, string, string], right = JSON.parse(b) as [number, string, string]
  return left[0] - right[0] || right[1].localeCompare(left[1]) || right[2].localeCompare(left[2])
}
