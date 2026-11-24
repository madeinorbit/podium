import type { IssueViewModel } from '@podium/client-core/replica'
import { lazy } from '@podium/mobx-helpers'
import { SideSet } from '@podium/sync/side-state'
import { action, compareShallow, observable, observableRef, reaction } from 'mobx'
import { type IssueStub, stagePage } from './collections'
import type { BoardQuery } from './issue-board-schema'
import { type PageIssue, readPageIssue } from './issue-page'
import { LOADING, type Loaded } from './loading'
import { omitGone } from './lookup'
import type {} from './mobile-inbox-schema'
import type { MobxPool } from './pool'
import { createQueryResult } from './query-result'

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
  const row = omitGone(pool.row('issue', id)) as Loaded<ScreeningSummary>
  if (row === LOADING) return LOADING
  if (!row || !isScreenableRoot(row)) return undefined
  const seen = new Set<string>([row.id])
  let parentId = row.parentId,
    pending = false
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = omitGone(pool.row('issue', parentId)) as Loaded<ScreeningSummary>
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
      order: (id) => readScreeningOrder(pool, id),
    },
  )
}

function readScreeningOrder(pool: MobxPool, id: string) {
  const row = omitGone(pool.row('issue', id))
  return row && row !== LOADING ? screeningOrderKey(row as never) : ''
}

/** The board count and the opened deck share this selection. Text candidates
 * own the projection's membership, before eligibility or order demands rows. */
export class ProposalQueue {
  constructor(
    readonly pool: MobxPool,
    readonly text: string,
  ) {}

  @lazy private get filtered() {
    const query: BoardQuery = {
      kind: 'board',
      filter: { stage: 'proposed', text: this.text },
      showAgentTasks: true,
    }
    const matches = omitGone(this.pool.row('issueBoardQuery', JSON.stringify(query)))
    if (!matches || matches === LOADING) return matches
    const ids = new Set(matches.ids)
    return createQueryResult({
      name: 'mobileInbox.filteredScreeningIds',
      ids: () => ids,
      has: (id) => ids.has(id),
      read: (id) => readScreeningId(this.pool, id),
      order: (id) => readScreeningOrder(this.pool, id),
      // Membership changes invalidate this lazy field, replacing the result.
      // The result itself observes only the matched rows and their ancestors.
      subscribe: () => () => {},
    })
  }

  @lazy get queue(): Loaded<string[]> {
    if (!this.text.trim()) return screeningQueue(this.pool)
    const result = this.filtered
    return !result || result === LOADING ? result : result.get()
  }
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
  private readonly waits = new SideSet<() => void>('proposalScreening.waits')
  constructor(
    readonly pool: MobxPool,
    readonly text = '',
  ) {}
  @lazy private get selection() {
    return new ProposalQueue(this.pool, this.text)
  }
  @lazy get queue() {
    return this.selection.queue
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
    const stop = reaction(
      () => (this.booting ? undefined : this.queue),
      (queue) => {
        if (queue && queue !== LOADING) this.reconcile(queue)
      },
      { fireImmediately: true },
    )
    // The deck reads its page while open, which holds it, every page of it
    // (POD-7158); nearing the end of the cards the device holds asks for the
    // next page (design "Proposal screening"), again each time cards arrive.
    const stopPaging = reaction(
      () =>
        !this.pool.collections.pageEnded(PROPOSED_PAGE) && this.order.length - this.index <= 5
          ? this.order.length
          : undefined,
      (near) => {
        if (near !== undefined) this.pool.collections.nextPage(PROPOSED_PAGE)
      },
      { fireImmediately: true },
    )
    return () => {
      stopPaging()
      stop()
      for (const cancel of this.waits) cancel()
    }
  }
}
