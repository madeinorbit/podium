import type { AttentionGroup } from '@podium/client-core/focus'
import { action, compareShallow, observable, reaction } from 'mobx'
import { lazy } from '@podium/mobx-helpers'
import { issuePages } from './issue-page'
import { readScreeningEntry, screeningOrderKey } from './mobile-inbox-views'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './loading'

const EMPTY: string[] = []
/** Complement timestamp code units so the query tree maintains newest-first order. */
function descending(value: string) {
  let key = ''
  for (let at = 0; at < value.length; at++)
    key += String.fromCharCode(0xffff - value.charCodeAt(at))
  return key
}

/** Membership only. Card fields and issue joins belong to mounted row observers. */
export class MobileInbox {
  constructor(readonly pool: MobxPool) {}

  private group(group: AttentionGroup) {
    return this.pool.queries.summarize({ kind: 'inboxSessions' }, `mobileInbox.${group}`, id => {
      if (this.pool.queries.collapsed(id)) return undefined
      const session = this.pool.sessionObject(id)
      try { return session.onRoster && session.attentionGroup === group ? id : undefined }
      catch (error) { if (error === LOADING) return LOADING; throw error }
    }, { order: id => {
      const session = this.pool.sessionObject(id)
      return `${descending(session.recency)}:${descending(session.createdAt ?? '')}`
    } })
  }

  @lazy get needsYou() { return this.group('needsYou') }
  @lazy get idle() { return this.group('idle') }
  @lazy get working() { return this.group('working') }
  @lazy get groups() {
    return { needsYou: this.needsYou.rows, idle: this.idle.rows, working: this.working.rows }
  }
  @lazy get booting() {
    const state = this.pool.row('mobileInboxState', 'state')
    return !state || state === LOADING ||
      (!state.hasCursor && this.pool.queries.count('session') === 0 && this.pool.queries.count('issue') === 0) ||
      this.needsYou.pending + this.idle.pending + this.working.pending > 0
  }
  @lazy get outboxSize() {
    return (this.pool.row('window', 'window') as { outboxSize: number } | undefined)?.outboxSize ?? 0
  }
  session(id: string) { return this.pool.sessionObject(id) }
  issue(id: string) { return issuePages(this.pool).issue(id) }
}

export function screeningQueue(pool: MobxPool): Loaded<string[]> {
  return pool.queries.project({ kind: 'proposedIssues' }, 'mobileInbox.screeningIds',
    id => {
      const entry = readScreeningEntry(pool, id)
      return entry === LOADING ? LOADING : entry?.id
    }, { order: id => {
      const row = pool.row('issue', id, 'summary')
      return row && row !== LOADING ? screeningOrderKey(row as never) : ''
    } })
}

/** Explicit opening order: retain the decided prefix, remove departed cards and
 * append arrivals. This is UI state; no issue facts are stored in the deck. */
export function reconcileScreeningIds(order: readonly string[], index: number, queue: readonly string[]) {
  const end = Math.min(Math.max(index, 0), order.length)
  const screenable = new Set(queue), seen = new Set(order)
  const next = order.slice(0, end)
  for (let at = end; at < order.length; at++) if (screenable.has(order[at]!)) next.push(order[at]!)
  for (const id of queue) if (!seen.has(id)) { seen.add(id); next.push(id) }
  return { order: next, index: end }
}

export class ProposalScreening {
  @observable.ref accessor order: readonly string[] = EMPTY
  @observable accessor index = 0
  constructor(readonly pool: MobxPool) {}
  @lazy get queue() { return screeningQueue(this.pool) }
  @lazy get booting() {
    const state = this.pool.row('mobileInboxState', 'state')
    return !state || state === LOADING || this.queue === LOADING
  }
  @lazy get currentId() { return this.order[this.index] }
  @lazy get nextId() { return this.order[this.index + 1] }
  issue(id: string | undefined) { return id ? issuePages(this.pool).issue(id) : undefined }
  @lazy get current() { return this.issue(this.currentId) }
  @lazy get next() { return this.issue(this.nextId) }
  @action advance() { this.index = Math.min(this.index + 1, this.order.length) }
  @action restart(ids: readonly string[]) { this.order = ids; this.index = 0 }
  @action private reconcile(queue: readonly string[]) {
    const next = reconcileScreeningIds(this.order, this.index, queue)
    if (!compareShallow(this.order, next.order)) this.order = next.order
    this.index = next.index
  }
  open() {
    return reaction(() => this.booting ? undefined : this.queue,
      queue => { if (queue && queue !== LOADING) this.reconcile(queue) }, { fireImmediately: true })
  }
}
