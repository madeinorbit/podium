import type { AttentionGroup } from '@podium/client-core/focus'
import { action, compareShallow, observable, observableRef, reaction } from 'mobx'
import { lazy } from '@podium/mobx-helpers'
import { issuePages } from './issue-page'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './loading'

type ScreeningSummary = Pick<
  IssueViewModel,
  | 'id'
  | 'stage'
  | 'parentId'
  | 'archived'
  | 'deletedAt'
  | 'isDraftVessel'
  | 'audience'
  | 'priority'
  | 'seq'
>
const isScreenableRoot = (issue: ScreeningSummary) =>
  issue.stage === 'proposed' &&
  !issue.archived &&
  !issue.deletedAt &&
  !issue.isDraftVessel &&
  issue.audience !== 'agent'
/** Order key for the queue: priority ascending, then newest first. Fixed-width
 * complements keep lexicographic order equal to the numeric sort, so the
 * keeper's tree maintains the queue order one changed key at a time. */
const screeningOrderKey = (issue: ScreeningSummary) => {
  const priority = Math.trunc(issue.priority ?? 0) + 0x80000000
  const newestFirst = 0xffffffff - Math.max(0, Math.trunc(issue.seq ?? 0))
  return `${String(priority).padStart(10, '0')}:${String(newestFirst).padStart(10, '0')}`
}
/** One proposed issue's queue membership, read through its own summary plus
 * its ancestor chain. The keeper tracks exactly those rows, so an unrelated
 * proposal change never re-reads this entry. */
function readScreeningId(pool: MobxPool, id: string): Loaded<string> {
  const row = pool.row('issue', id, 'summary') as Loaded<ScreeningSummary>
  if (row === LOADING) return LOADING
  if (!row || !isScreenableRoot(row)) return undefined
  const seen = new Set<string>([row.id])
  let parentId = row.parentId,
    pending = false
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = pool.row('issue', parentId, 'summary') as Loaded<ScreeningSummary>
    if (parent === LOADING) {
      pending = true
      break
    }
    if (!parent) break
    if (parent.stage === 'proposed') return undefined
    parentId = parent.parentId
  }
  if (pending) return LOADING
  return row.id
}

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
    return this.pool.queries.summarize(
      { kind: 'inboxSessions' },
      `mobileInbox.${group}`,
      (id) => {
        if (this.pool.queries.collapsed(id)) return undefined
        const session = this.pool.sessionObject(id)
        try {
          return session.onRoster && session.attentionGroup === group ? id : undefined
        } catch (error) {
          if (error === LOADING) return LOADING
          throw error
        }
      },
      {
        order: (id) => {
          const session = this.pool.sessionObject(id)
          return `${descending(session.recency)}:${descending(session.createdAt ?? '')}`
        },
      },
    )
  }

  @lazy get needsYou() {
    return this.group('needsYou')
  }
  @lazy get idle() {
    return this.group('idle')
  }
  @lazy get working() {
    return this.group('working')
  }
  @lazy get groups() {
    return { needsYou: this.needsYou.rows, idle: this.idle.rows, working: this.working.rows }
  }
  @lazy get booting() {
    const state = this.pool.row('mobileInboxState', 'state')
    return (
      !state ||
      state === LOADING ||
      (!state.hasCursor &&
        this.pool.queries.count('session') === 0 &&
        this.pool.queries.count('issue') === 0) ||
      this.needsYou.pending + this.idle.pending + this.working.pending > 0
    )
  }
  @lazy get outboxSize() {
    return (
      (this.pool.row('window', 'window') as { outboxSize: number } | undefined)?.outboxSize ?? 0
    )
  }
  session(id: string) {
    return this.pool.sessionObject(id)
  }
  issue(id: string) {
    return issuePages(this.pool).issue(id)
  }
}

export function screeningQueue(pool: MobxPool): Loaded<string[]> {
  return pool.queries.project(
    { kind: 'proposedIssues' },
    'mobileInbox.screeningIds',
    (id) => readScreeningId(pool, id),
    {
      order: (id) => {
        const row = pool.row('issue', id, 'summary')
        return row && row !== LOADING ? screeningOrderKey(row as never) : ''
      },
    },
  )
}

/** Explicit opening order: retain the decided prefix, remove departed cards and
 * append arrivals. This is UI state; no issue facts are stored in the deck. */
export function reconcileScreeningIds<T extends string>(
  order: readonly T[],
  index: number,
  queue: readonly T[],
) {
  const end = Math.min(Math.max(index, 0), order.length)
  const screenable = new Set(queue),
    seen = new Set(order)
  const next = order.slice(0, end)
  for (let at = end; at < order.length; at++) if (screenable.has(order[at]!)) next.push(order[at]!)
  for (const id of queue)
    if (!seen.has(id)) {
      seen.add(id)
      next.push(id)
    }
  return { order: next, index: end }
}

export class ProposalScreening {
  @observableRef accessor order: readonly string[] = EMPTY
  @observable accessor index = 0
  private readonly waits = new Set<() => void>()
  constructor(readonly pool: MobxPool) {}
  @lazy get queue() {
    return screeningQueue(this.pool)
  }
  @lazy get booting() {
    const state = this.pool.row('mobileInboxState', 'state')
    return !state || state === LOADING || this.queue === LOADING
  }
  @lazy get currentId() {
    return this.order[this.index]
  }
  @lazy get nextId() {
    return this.order[this.index + 1]
  }
  issue(id: string | undefined) {
    return id ? issuePages(this.pool).issue(id) : undefined
  }
  @lazy get current() {
    return this.issue(this.currentId)
  }
  @lazy get next() {
    return this.issue(this.nextId)
  }
  @action advance() {
    this.index = Math.min(this.index + 1, this.order.length)
  }
  @action restart(ids: readonly string[]) {
    this.order = ids
    this.index = 0
  }
  @action private reconcile(queue: readonly string[]) {
    const next = reconcileScreeningIds(this.order, this.index, queue)
    if (!compareShallow(this.order, next.order)) this.order = next.order
    this.index = next.index
  }
  /** Failed decisions are addressed only when the operator chooses Retry. */
  @action resolveIssue(id: string) {
    const issue = this.issue(id)
    if (issue !== LOADING) return issue
    return new Promise<
      Exclude<typeof issue | ReturnType<ProposalScreening['issue']>, typeof LOADING>
    >((resolve) => {
      let stop: (() => void) | undefined,
        finished = false
      const finish = (value: ReturnType<ProposalScreening['issue']>) => {
        if (value === LOADING) return
        finished = true
        stop?.()
        this.waits.delete(cancel)
        resolve(value)
      }
      const cancel = () => finish(undefined)
      this.waits.add(cancel)
      stop = reaction(() => this.issue(id), finish, { fireImmediately: true })
      if (finished) stop()
    })
  }
  open() {
    const stop = reaction(
      () => (this.booting ? undefined : this.queue),
      (queue) => {
        if (queue && queue !== LOADING) this.reconcile(queue)
      },
      { fireImmediately: true },
    )
    return () => {
      stop()
      for (const cancel of this.waits) cancel()
    }
  }
}
