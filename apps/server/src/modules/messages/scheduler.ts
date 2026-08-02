/**
 * WHEN a delivery attempt happens — extracted from `MessageDeliveryService`
 * (POD-1397). The service decides what a delivery DOES; this owner decides when
 * one is tried, and holds the state that answers that.
 *
 * ONE OWNER, NOT TWO. The issue brief proposed splitting this in half — a
 * delivery queue and a retry/sweep — and the code refuses that line. The eleven
 * fields here are exactly the closure of {@link MessageDeliveryStats}, and two
 * of them are read across the proposed seam: `triggerFailures` is incremented
 * by every path (trigger, boot walk, retry page, prepare), and `oldestJobAgeMs`
 * is a minimum over the queue's `enqueuedAt` values AND `retryPassStartedAt`.
 * Splitting them would leave one counter and one clock shared BY REFERENCE
 * between two modules, which is the coupling `docs/architecture/god-object-audit.md`
 * names as the one a decomposition can hide rather than remove (observationLeases,
 * POD-1396). So it is one owner of three entry paths into the same mechanism:
 *
 *   1. the coalesced trigger queue — an eligibility event enqueues a durable
 *      target; a macrotask timer drains a finite snapshot of them;
 *   2. the boot reconcile walk — one bounded page per macrotask, so a restart
 *      with a deep queue never spends one unbounded turn enumerating it;
 *   3. the slow retry backstop — the safety net for an edge no event covered.
 *
 * WHAT IT DOES NOT OWN. It never decides whether a message may be delivered,
 * renders nothing, and writes no message row. That reasoning stays in the
 * service and arrives through {@link DeliveryRunner}: the scheduler hands it a
 * finite snapshot and takes back which rows were consumed.
 */

import type { SessionMeta } from '@podium/model'
import type { MessageRow } from '../../store'
import type { MessagePageCursor, MessagesRepository } from '../../store/messages'
import {
  compareCursor,
  cursorOf,
  DELIVERY_TARGET_PAGE_LIMIT,
  type DeliveryTarget,
  deliveryTargetKey,
} from './targets'

/** The low-frequency sweep remains a bounded safety net while event coverage is
 * proven. One pass never revisits an unbounded historical queue. [spec:SP-c29e] */
export const DELIVERY_RETRY_BACKSTOP_LIMIT = 100
/** Five minutes: event triggers are primary; this only heals a missed edge. */
export const DELIVERY_RETRY_BACKSTOP_MS = 5 * 60_000

const DELIVERY_RECONCILE_PAGE_LIMIT = 100

interface DeliveryTargetWork {
  target: DeliveryTarget
  after?: MessagePageCursor
  through?: MessagePageCursor
  preferred?: SessionMeta
  enqueuedAt: number
}

export interface MessageDeliveryStats {
  pendingTargetCount: number
  coalescedTriggerCount: number
  oldestJobAgeMs: number
  retryPageCursor: MessagePageCursor | null
  retryPagesProcessed: number
  triggerFailures: number
}

/**
 * The delivery reasoning, as seen from the scheduler. Every method here is the
 * service's; the scheduler calls them and never inspects what they do.
 */
export interface DeliveryRunner {
  /** The durable target a row is addressed to, or null when it has none
   *  (operator-addressed rows are not queued against a target). */
  targetOf(message: MessageRow): DeliveryTarget | null
  /**
   * Idle drain for one preferred session: the snapshot of rows pulled for it.
   * Returns the ids this drain took responsibility for — including rows it
   * deliberately suppressed (a composer-draft hold), which must NOT then be
   * attempted down the generic path. A non-idle session takes nothing, and its
   * rows fall through to {@link attemptOne}.
   *
   * CONTRACT: total. It reports its own failures (through
   * {@link DeliveryScheduler.recordTriggerFailure}) and still returns what it
   * took, because a row dropped from the handled set would be attempted twice.
   */
  drainPreferred(
    session: SessionMeta,
    messages: readonly MessageRow[],
    nowMs: number,
  ): readonly string[]
  /** One row, attempted against the live session set. */
  attemptOne(message: MessageRow, allSessions: readonly SessionMeta[], nowMs: number): void
  listSessions(): SessionMeta[]
  /** ONE clock read per pass, shared by every row in it — as it was when all of
   *  this lived in one object. */
  nowMs(): number
}

export interface DeliverySchedulerDeps {
  messages: Pick<
    MessagesRepository,
    'countPending' | 'countQueued' | 'listQueuedPage' | 'pendingForPage'
  >
  now(): string
  runner: DeliveryRunner
}

export class DeliveryScheduler {
  /** Bounded delivery jobs coalesce by durable recipient principal. */
  private readonly pendingDeliveryTargets = new Map<string, DeliveryTargetWork>()
  /** A synchronous idle drain owns these finite-snapshot targets. Fresh,
   * reentrant triggers are retained separately for the next macrotask. */
  private readonly activeBoundaryTargets = new Map<string, number>()
  private readonly deferredBoundaryTargets = new Map<string, DeliveryTarget>()
  private deliveryTriggerTimer: ReturnType<typeof setTimeout> | null = null
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null
  private retryBackstopTimer: ReturnType<typeof setTimeout> | null = null
  private retryBackstopCursor: MessagePageCursor | null = null
  private retryPassStartedAt: number | null = null
  private retryPagesProcessed = 0
  private coalescedTriggerCount = 0
  private triggerFailures = 0

  constructor(private readonly deps: DeliverySchedulerDeps) {}

  private get runner(): DeliveryRunner {
    return this.deps.runner
  }

  // ---- entry path 1: the coalesced trigger queue ---------------------------

  queueDeliveryTarget(
    target: DeliveryTarget,
    preferred?: SessionMeta,
    after?: MessagePageCursor,
    through?: MessagePageCursor,
  ): void {
    const key = deliveryTargetKey(target)
    if (!after && !through && this.activeBoundaryTargets.has(key)) {
      if (this.deferredBoundaryTargets.has(key)) this.coalescedTriggerCount += 1
      else this.deferredBoundaryTargets.set(key, target)
      return
    }

    try {
      if (this.deps.messages.countPending(target) === 0) return
    } catch (error) {
      this.recordTriggerFailure(`target count ${deliveryTargetKey(target)}`, error)
      return
    }

    const existing = this.pendingDeliveryTargets.get(key)
    if (existing) {
      this.coalescedTriggerCount += 1
      if (through) existing.through = through
      if (!after) existing.after = undefined
      else if (existing.after && compareCursor(after, existing.after) < 0) existing.after = after
      else if (!existing.after) existing.after = after
      if (preferred) existing.preferred = preferred
    } else {
      this.pendingDeliveryTargets.set(key, {
        target,
        ...(after ? { after } : {}),
        ...(through ? { through } : {}),
        ...(preferred ? { preferred } : {}),
        enqueuedAt: this.runner.nowMs(),
      })
    }
    this.scheduleDeliveryFlush()
  }

  private scheduleDeliveryFlush(): void {
    if (this.deliveryTriggerTimer) return
    this.deliveryTriggerTimer = setTimeout(() => {
      this.deliveryTriggerTimer = null
      try {
        this.flushDeliveryTriggers()
      } catch (error) {
        this.recordTriggerFailure('coalesced delivery flush', error)
      }
    }, 0)
    this.deliveryTriggerTimer.unref?.()
  }

  /** Deterministic test/shutdown seam for one bounded coalesced turn. */
  flushDeliveryTriggers(onlyPreferredSessionId?: string): void {
    if (this.deliveryTriggerTimer) {
      clearTimeout(this.deliveryTriggerTimer)
      this.deliveryTriggerTimer = null
    }
    if (this.pendingDeliveryTargets.size === 0) return
    const works: DeliveryTargetWork[] = []
    if (onlyPreferredSessionId) {
      for (const [key, work] of this.pendingDeliveryTargets) {
        if (work.preferred?.sessionId !== onlyPreferredSessionId) continue
        works.push(work)
        this.pendingDeliveryTargets.delete(key)
      }
      // Non-boundary/reentrant work is deliberately retained for the next
      // macrotask; it cannot expand this synchronous finite snapshot.
      if (this.pendingDeliveryTargets.size > 0) this.scheduleDeliveryFlush()
    } else {
      works.push(...this.pendingDeliveryTargets.values())
      this.pendingDeliveryTargets.clear()
    }
    if (works.length === 0) return
    const selected = new Map<string, MessageRow>()
    const preferredGroups = new Map<
      string,
      { session: SessionMeta; messages: Map<string, MessageRow> }
    >()

    for (const work of works) {
      let page: MessageRow[]
      try {
        page = this.deps.messages.pendingForPage(work.target, {
          ...(work.after ? { after: work.after } : {}),
          ...(work.through ? { through: work.through } : {}),
          limit: DELIVERY_TARGET_PAGE_LIMIT,
        })
      } catch (error) {
        this.recordTriggerFailure(`target page ${deliveryTargetKey(work.target)}`, error)
        continue
      }
      const pageCursor = page.length > 0 ? cursorOf(page.at(-1)!) : undefined
      if (
        page.length === DELIVERY_TARGET_PAGE_LIMIT &&
        pageCursor &&
        (!work.through || compareCursor(pageCursor, work.through) < 0)
      ) {
        this.queueDeliveryTarget(work.target, work.preferred, pageCursor, work.through)
      }
      for (const message of page) {
        selected.set(message.id, message)
        if (!work.preferred) continue
        let group = preferredGroups.get(work.preferred.sessionId)
        if (!group) {
          group = { session: work.preferred, messages: new Map() }
          preferredGroups.set(work.preferred.sessionId, group)
        }
        group.messages.set(message.id, message)
      }
    }

    if (selected.size === 0) return
    const all = this.runner.listSessions()
    const nowMs = this.runner.nowMs()
    const handled = new Set<string>()
    for (const group of preferredGroups.values()) {
      const taken = this.runner.drainPreferred(group.session, [...group.messages.values()], nowMs)
      for (const id of taken) handled.add(id)
    }
    for (const message of selected.values()) {
      if (handled.has(message.id)) continue
      try {
        this.runner.attemptOne(message, all, nowMs)
      } catch (error) {
        this.recordTriggerFailure(`message ${message.id}`, error)
      }
    }
  }

  // ---- the boundary drain --------------------------------------------------

  /**
   * A turn boundary drains synchronously against a finite high-water snapshot.
   * While it runs, a fresh trigger for one of ITS target keys must not expand
   * the snapshot — it is deferred and re-queued after, or the drain could chase
   * a queue that grows under it.
   *
   * The service supplies `enqueue` (what to put in the queue) and the session
   * whose preferred work this drain owns; the depth counting, the deferral set
   * and the loop bound stay here, because they are this owner's invariant.
   */
  runBoundaryDrain(keys: readonly string[], sessionId: string, enqueue: () => void): void {
    for (const key of keys) {
      this.activeBoundaryTargets.set(key, (this.activeBoundaryTargets.get(key) ?? 0) + 1)
    }
    try {
      enqueue()
      do {
        this.flushDeliveryTriggers(sessionId)
        // Each preferred continuation is bounded by the captured high-water.
        // A fresh/reentrant trigger is held for the next macrotask instead of
        // resetting this snapshot's cursor or expanding its synchronous work.
      } while (
        [...this.pendingDeliveryTargets.values()].some(
          (work) => work.preferred?.sessionId === sessionId,
        )
      )
    } finally {
      for (const key of keys) {
        const depth = this.activeBoundaryTargets.get(key) ?? 0
        if (depth <= 1) this.activeBoundaryTargets.delete(key)
        else this.activeBoundaryTargets.set(key, depth - 1)
      }
      const deferred = [...this.deferredBoundaryTargets.values()]
      this.deferredBoundaryTargets.clear()
      for (const target of deferred) this.queueDeliveryTarget(target)
    }
  }

  // ---- entry path 2: the boot reconcile walk -------------------------------

  /** True when there is nothing durable to walk — the service skips the whole
   *  boot enumeration on the overwhelmingly common empty-queue path. */
  queueIsEmpty(): boolean {
    return this.deps.messages.countQueued() === 0
  }

  /** Begin a bounded startup walk. Each page schedules the next macrotask so
   * every durable principal is enumerated without one unbounded boot turn. */
  reconcile(): void {
    this.runReconcilePage()
  }

  private runReconcilePage(after?: MessagePageCursor): void {
    this.reconcileTimer = null
    let page: MessageRow[]
    try {
      page = this.deps.messages.listQueuedPage({
        ...(after ? { after } : {}),
        limit: DELIVERY_RECONCILE_PAGE_LIMIT,
      })
    } catch (error) {
      this.recordTriggerFailure('startup page query', error)
      return
    }
    for (const message of page) {
      const target = this.runner.targetOf(message)
      if (target) this.queueDeliveryTarget(target)
    }
    this.flushDeliveryTriggers()
    if (page.length < DELIVERY_RECONCILE_PAGE_LIMIT) return
    const next = cursorOf(page.at(-1)!)
    this.reconcileTimer = setTimeout(() => this.runReconcilePage(next), 0)
    this.reconcileTimer.unref?.()
  }

  // ---- entry path 3: the slow retry backstop -------------------------------

  /** Slow delivery backstop. Calendar expiry belongs exclusively to the fenced
   *  janitor; this actor-owned retry may resolve live session state. [spec:SP-c29e] */
  sweep(): void {
    const now = this.deps.now()
    if (this.retryBackstopTimer) return
    this.retryBackstopCursor = null
    this.retryPassStartedAt = Date.parse(now)
    this.runRetryBackstopPage()
  }

  private runRetryBackstopPage(after?: MessagePageCursor): void {
    this.retryBackstopTimer = null
    let page: MessageRow[]
    try {
      page = this.deps.messages.listQueuedPage({
        ...(after ? { after } : {}),
        limit: DELIVERY_RETRY_BACKSTOP_LIMIT,
      })
    } catch (error) {
      this.recordTriggerFailure('retry page query', error)
      this.retryBackstopCursor = null
      this.retryPassStartedAt = null
      return
    }

    const all = this.runner.listSessions()
    const nowMs = this.runner.nowMs()
    for (const message of page) {
      try {
        this.runner.attemptOne(message, all, nowMs)
      } catch (error) {
        this.recordTriggerFailure(`retry message ${message.id}`, error)
      }
    }
    this.retryPagesProcessed += 1

    if (page.length < DELIVERY_RETRY_BACKSTOP_LIMIT) {
      this.retryBackstopCursor = null
      this.retryPassStartedAt = null
      return
    }
    const next = cursorOf(page.at(-1)!)
    this.retryBackstopCursor = next
    this.retryBackstopTimer = setTimeout(() => this.runRetryBackstopPage(next), 0)
    this.retryBackstopTimer.unref?.()
  }

  // ---- observation + lifetime ----------------------------------------------

  /** The one place a delivery-trigger failure is counted. Every entry path
   *  reports here, which is the reason they are one owner. */
  recordTriggerFailure(context: string, error: unknown): void {
    this.triggerFailures += 1
    console.warn(`[podium] message delivery trigger failed (${context})`, error)
  }

  deliveryStats(): MessageDeliveryStats {
    const now = this.runner.nowMs()
    let oldest = this.retryPassStartedAt
    for (const work of this.pendingDeliveryTargets.values()) {
      oldest = oldest === null ? work.enqueuedAt : Math.min(oldest, work.enqueuedAt)
    }
    return {
      pendingTargetCount: this.pendingDeliveryTargets.size,
      coalescedTriggerCount: this.coalescedTriggerCount,
      oldestJobAgeMs: oldest === null ? 0 : Math.max(0, now - oldest),
      retryPageCursor: this.retryBackstopCursor,
      retryPagesProcessed: this.retryPagesProcessed,
      triggerFailures: this.triggerFailures,
    }
  }

  /**
   * All three timers and every queue this owner holds. Each entry path arms its
   * own timer and each one is cleared here — a reconcile or retry page that
   * fired after shutdown would call back into a service whose store is closed,
   * the shape POD-1390 found in session memory.
   */
  dispose(): void {
    if (this.deliveryTriggerTimer) clearTimeout(this.deliveryTriggerTimer)
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    if (this.retryBackstopTimer) clearTimeout(this.retryBackstopTimer)
    this.deliveryTriggerTimer = null
    this.reconcileTimer = null
    this.retryBackstopTimer = null
    this.pendingDeliveryTargets.clear()
    this.activeBoundaryTargets.clear()
    this.deferredBoundaryTargets.clear()
  }
}
