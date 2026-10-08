import { LOCK_POLL_MS } from '@podium/client-core/react'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import type { MobxPool } from '@podium/client-graph'
import type { IssueModel } from '@podium/client-graph/models'
import { lazy } from '@podium/mobx-helpers'
import { action, compareShallow, observable, observableRef, runInAction } from 'mobx'
import type { LockWire } from '@podium/protocol'
import type { Trpc } from '@/app/trpc'
import { queueGroups, type MergeQueueRepoScope, type QueueLock, type QueuePanelState } from './merge-queue-model'

/** Whole-repository lock readings live only for this open dock. */
export class MergeQueueView extends RequestAnswer<readonly LockWire[]> {
  @observableRef accessor issueIds: readonly string[] = []
  @observable accessor refreshedAt: number | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private active = false
  private generation = 0
  constructor(readonly pool: MobxPool, readonly scope: MergeQueueRepoScope, private readonly trpc: Pick<Trpc, 'lock'>) { super() }
  @action setIssues(ids: readonly string[]): void { this.issueIds = ids }
  @lazy({ equals: compareShallow }) get issues(): IssueModel[] { return this.issueIds.map(id => this.pool.issueObject(id)) }
  @lazy get locks(): QueueLock[] { return (this.answer ?? []).map(lock => ({ name: lock.name, holder: { ...lock.holder, acquiredAt: lock.acquiredAt, expiresAt: lock.expiresAt, secondsLeft: lock.secondsLeft, note: lock.note }, queue: lock.queue })) }
  @lazy get state(): QueuePanelState {
    if (!this.answer && !this.error) return { status: 'loading' }
    if (!this.answer && this.error) return { status: 'error', message: this.error }
    return { status: 'ready', locks: this.locks, refreshing: this.loading, ...(this.error ? { warning: this.error } : {}) }
  }
  @lazy({ equals: compareShallow }) get candidates(): IssueModel[] {
    const lock = queueGroups(this.locks).merge.lock
    const occupied = new Set([lock?.holder.issueId, ...(lock?.queue.map(waiter => waiter.issueId) ?? [])])
    return this.issues.filter(issue => issue.pendingDecision === 'merge' && !issue.archived && !issue.deletedAt && issue.audience !== 'agent' && (this.scope.repoId && issue.repoId ? issue.repoId === this.scope.repoId : issue.repoPath === this.scope.repoPath) && !occupied.has(issue.id)).sort((a, b) => {
      if (a.sortKey && b.sortKey && a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1
      if (a.sortKey && !b.sortKey) return -1
      if (!a.sortKey && b.sortKey) return 1
      return a.priority - b.priority || a.seq - b.seq
    })
  }
  private visible(): boolean { return typeof document === 'undefined' || document.visibilityState === 'visible' }
  private clearTimer(): void { clearTimeout(this.timer); this.timer = undefined }
  @action open(): void {
    this.active = true
    document.addEventListener('visibilitychange', this.visibilityChanged)
    this.refresh()
  }
  private visibilityChanged = (): void => { if (this.visible()) this.refresh(); else this.clearTimer() }
  @action refresh = (): void => {
    this.clearTimer()
    if (!this.active || this.loading || !this.visible()) return
    const generation = this.generation
    void this.load(() => this.trpc.lock.status.query({ repoPath: this.scope.repoPath })).then(() => {
      if (generation !== this.generation || !this.active) return
      runInAction(() => { if (!this.error) this.refreshedAt = Date.now() })
      if (this.visible()) this.timer = setTimeout(this.refresh, LOCK_POLL_MS)
    })
  }
  @action override close(): void {
    ++this.generation
    this.active = false
    this.clearTimer()
    document.removeEventListener('visibilitychange', this.visibilityChanged)
    super.close()
    this.issueIds = []
    this.refreshedAt = null
  }
}
