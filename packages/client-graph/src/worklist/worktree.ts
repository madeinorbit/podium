import { lazy, companion } from '@podium/mobx-helpers'
import { createIdentityQuery } from '../query-result'
import type { ModelOf } from '../models'
import type { Worklist } from './view-model'
import { sidebarRosterOf, type SidebarRoster } from './sidebar'
import { LOADING } from './rollup'
import { mobileWorktreeValues } from './mobile-row'

const roster = companion((row: WorklistWorktree) => createIdentityQuery({ name: `worklist@${row.id}.roster`,
  ids: () => sidebarRosterOf(row.worklist.host, row.id).ids }))

export class WorklistWorktree {
  constructor(readonly worktree: ModelOf['worktree'], readonly worklist: Worklist) {}
  get id() { return this.worktree.id }
  get rosterIds(): readonly string[] { return roster(this).get() }
  get roster(): SidebarRoster { return { ids: this.rosterIds, pending: 0 } }
  @lazy get mobile() {
    const value = this.worklist.desktop.worktree(this.id)
    if (!value) return undefined
    return value.pending > 0 ? LOADING : mobileWorktreeValues(this.id, value.worktree.repoName,
      value.worktree.branch, value.sessions, value.activityAt,
      session => this.worklist.pool.sessionObject(session.sessionId).executing,
      session => this.worklist.pool.sessionObject(session.sessionId).open,
      session => this.worklist.pool.sessionObject(session.sessionId).stateSinceMs)
  }
}
