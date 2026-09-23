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

import type { WorldIndexReader } from '../world-index'
import { createLogger } from '@podium/logger'
import type { MessageRow, MessagePageCursor, DeliveryMessages } from '../../hot-path-ports'
import {
  compareCursor,
  cursorOf,
  DELIVERY_TARGET_PAGE_LIMIT,
  type DeliveryTarget,
  deliveryTargetKey,
} from './targets'

const log = createLogger('server:messages')

/** The low-frequency sweep remains a bounded safety net while event coverage is
 * proven. One pass never revisits an unbounded historical queue. [spec:SP-c29e] */
export const DELIVERY_RETRY_BACKSTOP_LIMIT = 100
/** Five minutes: event triggers are primary; this only heals a missed edge. */
export const DELIVERY_RETRY_BACKSTOP_MS = 5 * 60_000

const DELIVERY_RECONCILE_PAGE_LIMIT = 100

interface DeliveryTargetWork {
  target: DeliveryTarget
  after?: MessagePageCursor
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
  /** One row, attempted. Takes NO session listing [POD-1653]: delivery resolves
   *  its recipient through the narrow by-id / by-issue reads, so the scheduler
   *  no longer builds (and this no longer carries) a full reader-scoped pass. */
  attemptOne(message: MessageRow, nowMs: number): void | Promise<void>
  /** ONE clock read per pass, shared by every row in it — as it was when all of
   *  this lived in one object. */
  nowMs(): number
}

export interface DeliverySchedulerDeps {
  messages: DeliveryMessages
  worldIndex: Pick<WorldIndexReader, 'pendingCount'>
  now(): string
  runner: DeliveryRunner
}

export class DeliveryScheduler {
  /** Bounded delivery jobs coalesce by durable recipient principal. */
  private readonly pendingDeliveryTargets = new Map<string, DeliveryTargetWork>()
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

  async queueDeliveryTarget(target: DeliveryTarget, after?: MessagePageCursor): Promise<void> {
    const key = deliveryTargetKey(target)
    try {
      // Eligibility bus listeners run at root after commit (ModuleBus.emit).
      // Boot and cooldown timers likewise enter outside a span. This is a committed reader,
      // never a read-your-writes seam inside an open mutation.
      if (this.deps.worldIndex.pendingCount(target) === 0) return
    } catch (error) {
      this.recordTriggerFailure(`target count ${deliveryTargetKey(target)}`, error)
      return
    }

    const existing = this.pendingDeliveryTargets.get(key)
    if (existing) {
      this.coalescedTriggerCount += 1
      if (!after) existing.after = undefined
      else if (existing.after && compareCursor(after, existing.after) < 0) existing.after = after
      else if (!existing.after) existing.after = after
    } else {
      this.pendingDeliveryTargets.set(key, {
        target,
        ...(after ? { after } : {}),
        enqueuedAt: this.runner.nowMs(),
      })
    }
    this.scheduleDeliveryFlush()
  }

  private scheduleDeliveryFlush(): void {
    if (this.deliveryTriggerTimer) return
    this.deliveryTriggerTimer = setTimeout(async () => {
      this.deliveryTriggerTimer = null
      try {
        await this.flushDeliveryTriggers()
      } catch (error) {
        this.recordTriggerFailure('coalesced delivery flush', error)
      }
    }, 0)
    this.deliveryTriggerTimer.unref?.()
  }

  /** Deterministic test/shutdown seam for one bounded coalesced turn. */
  async flushDeliveryTriggers(): Promise<void> {
    if (this.deliveryTriggerTimer) {
      clearTimeout(this.deliveryTriggerTimer)
      this.deliveryTriggerTimer = null
    }
    if (this.pendingDeliveryTargets.size === 0) return
    const works = [...this.pendingDeliveryTargets.values()]
    this.pendingDeliveryTargets.clear()
    const selected = new Map<string, MessageRow>()

    for (const work of works) {
      let page: MessageRow[]
      try {
        page = await this.deps.messages.pendingForPage(work.target, {
          ...(work.after ? { after: work.after } : {}),
          limit: DELIVERY_TARGET_PAGE_LIMIT,
        })
      } catch (error) {
        this.recordTriggerFailure(`target page ${deliveryTargetKey(work.target)}`, error)
        continue
      }
      const pageCursor = page.length > 0 ? cursorOf(page.at(-1)!) : undefined
      if (page.length === DELIVERY_TARGET_PAGE_LIMIT && pageCursor) {
        await this.queueDeliveryTarget(work.target, pageCursor)
      }
      for (const message of page) selected.set(message.id, message)
    }

    if (selected.size === 0) return
    const nowMs = this.runner.nowMs()
    for (const message of selected.values()) {
      try {
        await this.runner.attemptOne(message, nowMs)
      } catch (error) {
        this.recordTriggerFailure(`message ${message.id}`, error)
      }
    }
  }

  // ---- entry path 2: the boot reconcile walk -------------------------------

  /** True when there is nothing durable to walk — the service skips the whole
   *  boot enumeration on the overwhelmingly common empty-queue path. */
  async queueIsEmpty(): Promise<boolean> {
    return await this.deps.messages.countQueued() === 0
  }

  /** Begin a bounded startup walk. Each page schedules the next macrotask so
   * every durable principal is enumerated without one unbounded boot turn. */
  async reconcile(): Promise<void> {
    await this.runReconcilePage()
  }

  private async runReconcilePage(after?: MessagePageCursor): Promise<void> {
    this.reconcileTimer = null
    let page: MessageRow[]
    try {
      page = await this.deps.messages.listQueuedPage({
        ...(after ? { after } : {}),
        limit: DELIVERY_RECONCILE_PAGE_LIMIT,
      })
    } catch (error) {
      this.recordTriggerFailure('startup page query', error)
      return
    }
    for (const message of page) {
      const target = this.runner.targetOf(message)
      if (target) await this.queueDeliveryTarget(target)
    }
    await this.flushDeliveryTriggers()
    if (page.length < DELIVERY_RECONCILE_PAGE_LIMIT) return
    const next = cursorOf(page.at(-1)!)
    this.reconcileTimer = setTimeout(async () => await this.runReconcilePage(next), 0)
    this.reconcileTimer.unref?.()
  }

  // ---- entry path 3: the slow retry backstop -------------------------------

  /** Slow delivery backstop. Calendar expiry belongs exclusively to the fenced
   *  janitor; this actor-owned retry may resolve live session state. [spec:SP-c29e] */
  async sweep(): Promise<void> {
    const now = this.deps.now()
    // SINGLE-FLIGHT ON THE PASS, NOT ON THE TIMER HANDLE (POD-3258). A retry
    // pass spans pages, and `retryBackstopTimer` is null for the whole of every
    // page body — it is set only in the gap between one page and the next. The
    // handle therefore answers "is a page scheduled", which is not the question
    // this fence asks. That was harmless only while a page ran to completion in
    // one synchronous turn; the moment a page awaits its query, an overlapping
    // tick walks in on a live pass and both re-attempt the same rows.
    // `retryPassStartedAt` is non-null for exactly the pass's lifetime, so it is
    // the predicate that was already being maintained. An overlapping tick is
    // SKIPPED, not queued: this is a backstop whose next run is one interval
    // away, and the rows it would have read are still queued for that run.
    if (this.retryPassStartedAt !== null) return
    this.retryBackstopCursor = null
    this.retryPassStartedAt = Date.parse(now)
    await this.runRetryBackstopPage()
  }

  private async runRetryBackstopPage(after?: MessagePageCursor): Promise<void> {
    this.retryBackstopTimer = null
    let page: MessageRow[]
    try {
      page = await this.deps.messages.listQueuedPage({
        ...(after ? { after } : {}),
        limit: DELIVERY_RETRY_BACKSTOP_LIMIT,
      })
    } catch (error) {
      this.recordTriggerFailure('retry page query', error)
      this.retryBackstopCursor = null
      this.retryPassStartedAt = null
      return
    }

    const nowMs = this.runner.nowMs()
    for (const message of page) {
      try {
        await this.runner.attemptOne(message, nowMs)
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
    this.retryBackstopTimer = setTimeout(async () => await this.runRetryBackstopPage(next), 0)
    this.retryBackstopTimer.unref?.()
  }

  // ---- observation + lifetime ----------------------------------------------

  /** The one place a delivery-trigger failure is counted. Every entry path
   *  reports here, which is the reason they are one owner. */
  recordTriggerFailure(context: string, error: unknown): void {
    this.triggerFailures += 1
    log.warn('message delivery trigger failed', { err: error, context })
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
    // The pass fence goes with the pages it fenced; a disposed owner that kept it
    // set could never sweep again if it were reused.
    this.retryPassStartedAt = null
    this.pendingDeliveryTargets.clear()
  }
}
