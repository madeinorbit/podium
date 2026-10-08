import { lazy } from '@podium/mobx-helpers'
import { compareShallow, reaction } from 'mobx'
import { machinePathsEqual } from '@podium/model/browser'
import { createQueryResult } from '../query-result'
import type { IssueModel, ModelOf, SessionModel } from '../models'
import type { Worklist } from './view-model'
import { sidebarRosterView } from './sidebar-roster'
import { sidebarRosterOf, type SidebarState } from './sidebar'
import { LOADING } from './rollup'
import { fleetOf, sidebarTiming } from './sidebar-row'
import { motionPhase } from './rollup'
import type { SliceSession } from '../shared/slice-types'

/** A roster keeps shared sessions, with demand-scoped data queries owning
 * ordering. A heartbeat updates one ordering key; it never sorts the roster. */
export class WorklistWorktree {
  constructor(readonly worktree: ModelOf['worktree'], readonly worklist: Worklist) {}
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

  @lazy private get orderedSessions() {
    return this.sessionQuery(false)
  }
  @lazy private get oldestSessions() {
    return this.sessionQuery(true)
  }
  private sessionQuery(stale: boolean) {
    const pool = this.worklist.pool
    return createQueryResult<SessionModel>({
      name: `worklist.worktree@${this.id}.${stale ? 'stale' : 'sessions'}`,
      ids: () => this.rosterIds,
      has: id => this.rosterIds.includes(id),
      read: id => {
        const state = pool.resident('session', id)
        if (state === 'loading') return LOADING
        if (state === 'absent') return undefined
        const session = pool.sessionObject(id)
        if (session.status === 'exited') return undefined
        return !stale || this.worklist.session(session).stale ? session : undefined
      },
      order: id => {
        const session = pool.sessionObject(id)
        return stale ? session.lastActivity : this.worklist.session(session).sortKey
      },
      compareOrder: stale ? (a, b) => b.localeCompare(a) : (a, b) => {
        const left = JSON.parse(a) as [number, string, string], right = JSON.parse(b) as [number, string, string]
        return left[0] - right[0] || right[1].localeCompare(left[1]) || right[2].localeCompare(left[2])
      },
      subscribe: changed => reaction(() => this.rosterIds, () => changed(undefined)),
    })
  }
  @lazy({ equals: compareShallow }) get sessions(): readonly SessionModel[] {
    const sessions = this.orderedSessions.get()
    return sessions === LOADING || sessions === undefined ? [] : sessions
  }
  @lazy({ equals: compareShallow }) private get staleCandidates(): readonly SessionModel[] {
    const sessions = this.oldestSessions.get()
    return sessions === LOADING || sessions === undefined ? [] : sessions
  }
  @lazy({ equals: compareShallow }) get stale(): readonly SessionModel[] {
    if (this.sessions.length <= 5 || this.staleCandidates.length <= 3) return []
    const stale = new Set(this.staleCandidates.slice(3))
    return this.sessions.filter(session => stale.has(session))
  }
  @lazy({ equals: compareShallow }) get visible(): readonly SessionModel[] {
    return this.sessions.filter(session => !this.stale.includes(session))
  }
  @lazy({ equals: compareShallow }) get issues(): readonly IssueModel[] {
    const issues = new Set<IssueModel>()
    for (const id of this.rosterIds) {
      const session = this.worklist.pool.sessionObject(id)
      if (session.issueLink !== null) {
        const issue = this.worklist.pool.model('issue', session.issueLink)
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
  @lazy get waitingCount() { return this.sessions.reduce((count, session) => count + Number(this.worklist.session(session).phase === 'waiting'), 0) }
  @lazy get visibleUnread() { return !this.visibleWorking && this.sessions.some(session => session.unread) }
  @lazy get timing() {
    return sidebarTiming(this.sessions as unknown as SliceSession[], this.visiblePhase, false, this.activityAt,
      undefined, session => this.worklist.pool.sessionObject(session.sessionId).executing,
      session => this.worklist.pool.sessionObject(session.sessionId).stateSinceMs)
  }
  @lazy get visibleFleet() {
    return fleetOf(this.sessions as unknown as SliceSession[], session => this.worklist.pool.sessionObject(session.sessionId).open)
  }
  @lazy get navigation() { return this.sessions[0] ? { kind: 'session' as const, id: this.sessions[0].sessionId } : null }
}
