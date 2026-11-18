import { omitGone } from './lookup'
import { action, compareShallow, observable, observableRef, reaction } from 'mobx'
import { lazy } from '@podium/mobx-helpers'
import { type IssueStub, stagePage } from './collections'
import { readPageIssue, type PageIssue } from './issue-page'
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
  const row = omitGone(pool.row('issue', id, 'summary')) as Loaded<ScreeningSummary>
  if (row === LOADING) return LOADING
  if (!row || !isScreenableRoot(row)) return undefined
  const seen = new Set<string>([row.id])
  let parentId = row.parentId,
    pending = false
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = omitGone(pool.row('issue', parentId, 'summary')) as Loaded<ScreeningSummary>
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

/** The proposal deck's page: the proposed stage, newest first, a page at a time. */
const PROPOSED_PAGE = stagePage('proposed')

/** A screenable root by its stub: proposed, live, not a draft or agent task, no proposed ancestor. */
function screenableStub(stub: IssueStub, stubOf: (id: string) => IssueStub | undefined): boolean {
  if (!isScreenableRoot(stub as unknown as ScreeningSummary)) return false
  const seen = new Set<string>([stub.id])
  let parentId = stub.parentId
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = stubOf(parentId)
    if (!parent) break
    if (parent.stage === 'proposed') return false
    parentId = parent.parentId
  }
  return true
}

/** How many proposals there are to screen, over all history: from the stubs (POD-7088). */
export function screeningTotal(pool: MobxPool): number | typeof LOADING {
  return pool.collections.countStubs('screenable-proposals', screenableStub)
}

/** The cards the device holds, in screening order. The deck holds the page while open. */
export function screeningQueue(pool: MobxPool): Loaded<string[]> {
  return pool.queries.project(
    { kind: 'proposedIssues' },
    'mobileInbox.screeningIds',
    (id) => readScreeningId(pool, id),
    {
      order: (id) => {
        const row = omitGone(pool.row('issue', id, 'summary'))
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
  /** All proposals to screen, from the stubs; LOADING until they answer. */
  @lazy get total() {
    return screeningTotal(this.pool)
  }
  @lazy get booting() {
    const state = omitGone(this.pool.row('mobileInboxState', 'state'))
    return (
      !state ||
      state === LOADING ||
      (!state.hasCursor &&
        this.pool.queries.heldCount('session') === 0 &&
        this.pool.queries.heldCount('issue') === 0) ||
      this.queue === LOADING
    )
  }
  @lazy get currentId() {
    return this.order[this.index]
  }
  @lazy get nextId() {
    return this.order[this.index + 1]
  }
  issue(id: string | undefined) {
    return id ? readPageIssue(this.pool, id) : undefined
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
    return new Promise<PageIssue | undefined>((resolve) => {
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
    // The deck holds its page while open; nearing the end of the cards the
    // device holds asks for the next page (design "Proposal screening").
    const release = this.pool.collections.show(PROPOSED_PAGE)
    const stop = reaction(
      () => (this.booting ? undefined : this.queue),
      (queue) => {
        if (queue && queue !== LOADING) this.reconcile(queue)
      },
      { fireImmediately: true },
    )
    const stopPaging = reaction(
      () => this.order.length - this.index <= 5,
      (near) => {
        if (near) this.pool.collections.nextPage(PROPOSED_PAGE)
      },
      { fireImmediately: true },
    )
    return () => {
      release()
      stopPaging()
      stop()
      for (const cancel of this.waits) cancel()
    }
  }
}
