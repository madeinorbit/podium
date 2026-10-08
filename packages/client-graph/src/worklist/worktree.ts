import { lazy } from '@podium/mobx-helpers'
import { compareShallow, reaction } from 'mobx'
import { machinePathsEqual } from '@podium/model/browser'
import { createQueryResult } from '../query-result'
import type { IssueModel, ModelOf, SessionModel } from '../models'
import type { Worklist } from './view-model'
import { sidebarRosterOf, type SidebarState } from './sidebar'
import { LOADING } from './rollup'
import { mobileWorktreeValues } from './mobile-row'

/** A roster keeps shared sessions, with demand-scoped data queries owning
 * ordering. A heartbeat updates one ordering key; it never sorts the roster. */
export class WorklistWorktree {
  constructor(readonly worktree: ModelOf['worktree'], readonly worklist: Worklist) {}
  get id() { return this.worktree.id }
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
        return stale ? descending(session.lastActivity) : this.worklist.session(session).sortKey
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
    return this.sessions.length > 5 && this.staleCandidates.length > 3
      ? this.sessions.filter(session => this.staleCandidates.slice(3).includes(session)) : []
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
  @lazy get mobile() {
    if (!this.rosterIds.length) return undefined
    if (this.pending > 0) return LOADING
    return mobileWorktreeValues(this.id, this.worktree.repoName, this.worktree.branch,
      this.sessions as never, this.activityAt,
      session => this.worklist.pool.sessionObject(session.sessionId).executing,
      session => this.worklist.pool.sessionObject(session.sessionId).open,
      session => this.worklist.pool.sessionObject(session.sessionId).stateSinceMs)
  }
}

/** ISO date keys retain lexical ordering while newest is first. */
export function descending(value: string): string {
  return Array.from(value, char => String.fromCharCode(0xffff - char.charCodeAt(0))).join('')
}
