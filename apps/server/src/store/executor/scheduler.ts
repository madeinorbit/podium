/**
 * The scheduler: three lanes over a driver, with the queue that makes
 * serialisation deliberate instead of accidental [POD-3248, spec §3.2].
 *
 * WHAT IT REPLACES. Today the store is serialised by the accident of one
 * synchronous thread holding one connection: nothing can interleave between two
 * lines because nothing can yield. Once every call is awaited that accident is
 * gone, and SQLite cannot restore it — its busy wait is synchronous, so a second
 * connection waiting for the write lock blocks the loop the first connection's
 * `await` needs. Serialisation therefore belongs to whoever hands out the
 * connection: this queue on bun:sqlite, the platform on Turso.
 *
 * ADMISSION. One FIFO of waiters, scanned in order:
 *   - `write` needs a write slot. On a driver that declares no per-workspace
 *     writes (bun:sqlite, libsql) there is ONE, so writes stay FIFO among
 *     themselves — today's behaviour exactly.
 *   - `read` takes a write slot too when the driver's `readConcurrency` is 0
 *     (bun:sqlite: one connection, one lane, today's behaviour exactly), and
 *     otherwise runs on its own slots and may overtake a blocked write — which
 *     is what "the remote implementation may run the read lane concurrently"
 *     means.
 *   - `exclusive` is a BARRIER: the scan stops at one, so nothing overtakes it
 *     and a stream of reads cannot starve it. It starts only when the scheduler
 *     is empty.
 *
 * ONE WRITE SLOT PER WORKSPACE [POD-6996, POD-6958 design 2.4]. A driver that
 * serialises each workspace's writers itself — Postgres, whose write takes the
 * workspace's `sync_feed` row lock first (contract C4) — declares
 * `LanePolicy.workspaceWrites` (driver.ts). The scheduler then keys a write's
 * slot by the workspace of its {@link StoreContext}: one slot per workspace, so a
 * workspace's writes stay FIFO and never overlap, while writes of different
 * workspaces run at once, up to `workspaceWrites` of them (a bound the driver sets
 * below its pool size, so reads keep connections). Global-context writes share
 * one slot of their own. A waiter blocked by its own workspace does not hold up
 * a later write of another one. `exclusive` is still a barrier over all of them.
 * The in-process slot and the database lock agree on purpose: a write that
 * reaches the lock has no in-process rival for it, so the lock only ever waits
 * for another PROCESS.
 *
 * The slot is taken in the caller's own turn, before the first `await`, so the
 * queue order is the call order — which is what makes the interleaving tests
 * deterministic rather than merely usually right.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { rootStatementContext } from './context'
import type { BusyRetryPolicy, DriverSession, Lane, StoreDriver } from './driver'
import { SchedulerClosedError, StaleTransactionError } from './errors'
import type { StoreContext } from './executor'

/** The one write slot of a driver without per-workspace writes. */
const PROCESS_SLOT = 'process'
/** The write slot global-context work shares on a driver with per-workspace writes. */
const GLOBAL_SLOT = 'global'
/** A workspace's write slot. Prefixed, so no workspace id can name another slot. */
const workspaceSlot = (workspaceId: string): string => `workspace:${workspaceId}`

export interface Lease {
  readonly id: number
  readonly lane: Lane
  readonly session: DriverSession
  active(): boolean
  /**
   * Open this lane's transaction, with the driver's bounded busy retry. It is
   * here rather than on the session because the retry is the SCHEDULER's
   * business: nothing of the body has run yet, so this is the last point at
   * which trying again is safe (spec §6 rule 7 — a network blip closes a remote
   * transaction permanently, so retry belongs above it, never inside it).
   */
  begin(lane: Lane): Promise<void>
  /**
   * Run an IMPLICIT atomic write — a root autocommit statement, or a root batch
   * — with the same bounded busy retry `begin` gets.
   *
   * These never pass through `begin`, so without this they are the one write
   * path outside the declared policy, which on Turso is the COMMON path: a root
   * batch acquires the write lock inside the driver call. It is safe for the
   * same reason `begin` is and for no other: a busy classification is raised at
   * ACQUISITION, before any of the unit applied, and the unit is atomic, so a
   * second attempt cannot double-apply a prefix. Anything the driver does not
   * classify `busy` — `TRANSACTION_CLOSED`, an ambiguous post-application
   * failure — is fatal and is never retried.
   */
  atomicWrite<T>(attempt: () => Promise<T>): Promise<T>
  /**
   * Wall time this lease has held its connection, ms.
   *
   * DIAGNOSTIC ONLY. No engine budget bounds it, so nothing may be compared
   * against one — the quantity that is bounded is {@link Lease.idleMs}.
   */
  heldMs(): number
  /**
   * Ms since the last driver call on this lease settled; 0 while one is in
   * flight. THIS is the quantity the driver's declared `writeBudgetMs` bounds —
   * see {@link leaseActivity} for the measurement behind that (POD-3345).
   */
  idleMs(): number
}

/**
 * POD-3243 records query counts and frames, not idle-gap percentiles. Those
 * database-only bursts reset the clock on every statement; allow one second of
 * silence as diagnostic headroom, below the measured 9 s Turso idle limit.
 * This is a policy default, not a duration inferred from the query counts.
 */
export const DEFAULT_WATCHDOG_BUDGET_MS = 1_000

export interface WatchdogOptions {
  budgetMs?: number
  report: (report: WatchdogReport) => void
  /** Reporting failures must not escape the timer or affect the holder. */
  onReportFailure?: (error: unknown) => void
}

export interface WatchdogReport {
  /** Lease request stack, captured before queueing; identifies the body's caller. */
  readonly stack: string
  readonly leaseId: number
  readonly lane: Lane
  /**
   * The gap that tripped the budget: ms since the lease's last driver call
   * settled. This is the number to read — it is the one the engine acts on.
   */
  readonly idleMs: number
  /**
   * How long the lease has been open, for context. A LARGE VALUE HERE IS NOT A
   * PROBLEM on its own: a chatty transaction may outlive the write budget many
   * times over and still commit (POD-3250 proof 9).
   */
  readonly heldMs: number
  readonly budgetMs: number
}

export interface SchedulerOptions {
  driver: StoreDriver<unknown>
  /** Boot may keep the scheduler open for exclusive setup before its first ordinary operation. */
  startOpen?: boolean
  /** Grace for a parked body during shutdown. Driver calls are allowed to settle before rollback. */
  drainGraceMs?: number
  /**
   * Reports a lease that has gone QUIET past its budget — `budgetMs` with no
   * driver call settling and none in flight. It is a gap, not a duration: see
   * {@link leaseActivity} for why, and {@link Lease.idleMs} for the clock.
   *
   * Injectable because the useful sink differs by caller: the server logs it,
   * the tests collect it, and on Turso the budget has to sit below the
   * platform's own idle-stream timeout — the driver's own declared
   * `limits.writeBudgetMs`, measured at about 9 s (POD-3250/POD-3251, spec §6
   * rule 7), which the constructor below checks against rather than any number
   * written here.
   */
  watchdog?: WatchdogOptions
  now?: () => number
  /** Injectable so the busy-retry backoff is a test's choice, not a duration to wait out. */
  sleep?: (ms: number) => Promise<void>
  /**
   * An idle listener threw.
   *
   * Idle is raised from `runLease`'s release `finally`, which is on the path of
   * every operation the scheduler runs — including the one that has just
   * COMMITTED. An unguarded listener therefore replaces that operation's result
   * with its own error, and a caller reads a publication failure as a rollback
   * of a durable write. That is exactly the guarantee POD-3310 gave mechanism
   * 1, so idle gets it too: every listener is isolated, the rest still run, and
   * the failure is reported here instead of propagating. Absent, it is dropped.
   */
  onIdleFailure?: (error: unknown) => void
}

export type SchedulerState = 'open' | 'accepting' | 'draining' | 'closed'

export interface Scheduler {
  readonly state: SchedulerState
  /**
   * Run `body` on a lease of `lane`.
   *
   * `context` is the work's store context, which picks a write's slot on a driver
   * with per-workspace writes (`LanePolicy.workspaceWrites`). Absent, it is the
   * workspace of the root statement being run (`rootStatementContext()`), and
   * failing that the global context. Every other driver ignores it.
   */
  run<T>(lane: Lane, body: (lease: Lease) => Promise<T>, context?: StoreContext): Promise<T>
  /**
   * A read on a connection outside the lanes, for the committed view from
   * inside an open body. Rejects when the driver has no such connection.
   */
  detachedRead<T>(body: (session: DriverSession) => Promise<T>): Promise<T>
  /** Retained effects may finish root writes during the bounded shutdown window. */
  retain<T>(body: () => T): T
  settled(): Promise<void>
  /** Called when the scheduler has nothing in flight and nothing queued. */
  onIdle(listener: () => void): () => void
  /** Stop accepting work, drain what is queued, close the driver. */
  close(persist?: () => Promise<void>): Promise<void>
}

type LeaseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

interface Waiter {
  readonly lane: Lane
  /** The write slot it needs; undefined for a read on its own lane and for `exclusive`. */
  readonly slot: string | undefined
  readonly start: () => void
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })

/**
 * A lease's ACTIVITY CLOCK, and the watchdog timer that reads it [POD-3345].
 *
 * THE ENGINE'S WRITE BUDGET BOUNDS THE GAP BETWEEN STATEMENTS, NOT THE
 * TRANSACTION'S DURATION. Measured on Turso (POD-3250 proof 9, kept in
 * `store/spike/turso-append/run-proofs.ts`): a 21.6 s transaction issuing a
 * statement every 2 s COMMITTED, while a 12.2 s one with a single idle gap was
 * reaped with `SQLITE_BUSY: … the stream was idle for too long`; the proof's own
 * 250-row append ran 27.8 s of continuous statements and committed.
 *
 * A clock started at BEGIN is therefore wrong in both directions: it reports the
 * chatty append the engine is perfectly happy with, and it cannot see the gap
 * that actually kills — it only ever fires at one moment, whenever that gap
 * happens to start. So the clock restarts at every driver call, which means the
 * lease has to OBSERVE the session rather than merely hand it out.
 *
 * A CALL IN FLIGHT IS NOT IDLE. The stream is busy for as long as the driver has
 * not answered, so the timer is disarmed for the duration of every call and
 * `idleMs` reads 0. Without that, one slow statement would look exactly like the
 * silence that kills.
 *
 * ONE REPORT PER GAP. Firing does not re-arm; the next call's completion does.
 * A stall that lasts a minute is one event, not sixty.
 */
function leaseActivity(
  session: DriverSession,
  now: () => number,
): {
  /** The session to give the lease: every call through it stamps the clock. */
  readonly session: DriverSession
  idleMs(): number
  active(): boolean
  revoke(): Promise<void>
  /** Arm the gap timer. Returns the stop the lease's `finally` owes it. */
  watch(budgetMs: number, onGap: () => void): () => void
} {
  let inFlight = 0
  let active = true
  let settle: (() => void) | undefined
  let lastSettledAt = now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let budgetMs: number | undefined
  let onGap: (() => void) | undefined
  let stopped = false

  function disarm(): void {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }

  function arm(): void {
    if (stopped || budgetMs === undefined || timer) return
    // `unref` so a forgotten timer can never hold a process open — the watchdog
    // is a report, never a deadline.
    timer = setTimeout(() => {
      timer = undefined
      onGap?.()
    }, budgetMs)
    timer.unref?.()
  }

  async function track<T>(call: () => Promise<T>): Promise<T> {
    if (!active) throw new StaleTransactionError('lease revoked during scheduler drain')
    inFlight++
    disarm()
    try {
      return await call()
    } finally {
      inFlight--
      lastSettledAt = now()
      // A REJECTION IS ACTIVITY TOO: the statement reached the engine, so the
      // stream was not quiet, and the next gap is measured from here.
      if (inFlight === 0) {
        settle?.()
        arm()
      }
    }
  }

  return {
    session: {
      execute: async (statement) => await track(async () => await session.execute(statement)),
      executeBatch: async (statements) =>
        await track(async () => await session.executeBatch(statements)),
      begin: async (lane) => await track(async () => await session.begin(lane)),
      commit: async () => await track(async () => await session.commit()),
      rollback: async () => await track(async () => await session.rollback()),
      enterSavepoint: async (name) => await track(async () => await session.enterSavepoint(name)),
      releaseSavepoint: async (name) =>
        await track(async () => await session.releaseSavepoint(name)),
      rollbackToSavepoint: async (name) =>
        await track(async () => await session.rollbackToSavepoint(name)),
      // NOT TRACKED, deliberately: the scheduler closes the connection after the
      // body has ended and the watch is already stopped, so stamping the clock
      // here could only arm a timer nobody will ever read.
      close: async () => await session.close(),
    },
    active: () => active,
    async revoke() {
      active = false
      stopped = true
      disarm()
      if (inFlight > 0)
        await new Promise<void>((resolve) => {
          settle = resolve
        })
      await session.rollback()
    },
    idleMs: () => (inFlight > 0 ? 0 : now() - lastSettledAt),
    watch(budget, gap) {
      budgetMs = budget
      onGap = gap
      // Armed from the moment the connection is open: a lease that opens and
      // then issues nothing is exactly the silence the engine reaps.
      arm()
      return () => {
        stopped = true
        disarm()
      }
    },
  }
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { driver } = options
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep
  const limits = driver.limits
  const watchdog = options.watchdog
  const budgetMs = watchdog?.budgetMs ?? DEFAULT_WATCHDOG_BUDGET_MS
  if (watchdog && (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 2_147_483_647)) {
    throw new Error('watchdog budget must be a positive finite timer duration at most 2147483647ms')
  }
  /**
   * BOTH NUMBERS BOUND THE SAME QUANTITY — the gap between statements — which
   * is what makes comparing them meaningful (POD-3345; before that the guard
   * compared a duration against a gap and so gave false confidence). A watchdog
   * whose gap budget is at or above the engine's can only fire after the engine
   * has already reaped the stream, so it reports a transaction that is already
   * dead. That is a misconfiguration, and the constructor is where it is cheap
   * to find.
   */
  if (watchdog && budgetMs >= limits.writeBudgetMs) {
    throw new Error(
      `watchdog budget ${budgetMs}ms is not below driver ${driver.kind}'s ` +
        `write budget of ${limits.writeBudgetMs}ms: both bound the gap between statements, so ` +
        'the engine would reap the stream before the watchdog could report it',
    )
  }

  /**
   * A bounded retry for an ACQUISITION only. It stops on the attempt count, on
   * a non-busy failure, and on the driver's own write budget, which is the cap
   * this policy is declared against: a caller kept waiting for longer than the
   * engine tolerates a quiet stream is no longer retrying contention, it is
   * hanging. (The budget is a GAP, not a transaction's lifetime — POD-3345 —
   * so it is a declared ceiling here, never a claim about how long the holder
   * can live.)
   */
  async function withBusyRetry<T>(attempt: () => Promise<T>): Promise<T> {
    const policy: BusyRetryPolicy = limits.busyRetry
    const startedAt = now()
    let delay = policy.initialDelayMs
    for (let tries = 1; ; tries++) {
      try {
        return await attempt()
      } catch (error) {
        const classified = driver.classify?.(error) ?? 'fatal'
        if (classified !== 'busy' || tries >= policy.attempts) throw error
        if (now() - startedAt + delay >= limits.writeBudgetMs) throw error
        await sleep(delay)
        delay = Math.min(delay * 2 || policy.initialDelayMs, policy.maxDelayMs)
      }
    }
  }
  const readConcurrency = driver.lanes.readConcurrency
  /** Reads with no lane of their own take a write slot (bun:sqlite). */
  const readsUseWriteSlot = readConcurrency === 0
  const declaredWorkspaceWrites = driver.lanes.workspaceWrites
  if (
    declaredWorkspaceWrites !== undefined &&
    (!Number.isInteger(declaredWorkspaceWrites) || declaredWorkspaceWrites < 1)
  ) {
    throw new Error(
      `driver ${driver.kind} declares ${declaredWorkspaceWrites} workspace write slots: ` +
        'the bound must be a positive integer',
    )
  }
  /** Writes are keyed by workspace (Postgres); otherwise one slot serves them all. */
  const perWorkspace = declaredWorkspaceWrites !== undefined
  /** Write slots that may be held at once. */
  const writeSlots = declaredWorkspaceWrites ?? 1

  /** The sink is itself a caller's adapter, so it gets the same isolation it provides. */
  function reportIdleFailure(error: unknown): void {
    try {
      options.onIdleFailure?.(error)
    } catch {
      /* the idle-failure sink threw; there is nowhere further to report it */
    }
  }

  const pending: Waiter[] = []
  const idleListeners = new Set<() => void>()
  /** The write slots held, by key: at most one lease per key, at most `writeSlots` keys. */
  const heldSlots = new Set<string>()
  let exclusiveSlotHeld = false
  /** Exclusive requests in `pending`: a barrier no newcomer may pass. */
  let pendingExclusive = 0
  let readsInFlight = 0
  let inFlight = 0
  let state: SchedulerState = options.startOpen ? 'open' : 'accepting'
  const drainers = new Set<() => void>()
  const shutdownScope = new AsyncLocalStorage<{ active: boolean }>()
  let persistenceSettled = true
  let nextLeaseId = 1
  let closing: Promise<void> | undefined
  let finishClose: (() => void) | undefined

  /**
   * The write slot `lane` needs for work of `context`, or undefined when it needs
   * none: a read on its own lane, and `exclusive`, which is a barrier rather than
   * a slot.
   */
  function slotFor(lane: Lane, context: StoreContext | undefined): string | undefined {
    if (lane === 'exclusive') return undefined
    if (lane === 'read' && !readsUseWriteSlot) return undefined
    if (!perWorkspace) return PROCESS_SLOT
    // A read that takes a write slot reads; it does not need its workspace's lock.
    if (lane === 'read') return GLOBAL_SLOT
    return context?.kind === 'workspace' ? workspaceSlot(context.workspaceId) : GLOBAL_SLOT
  }

  function canStart(lane: Lane, slot: string | undefined): boolean {
    // Concurrent readers may share an ordinary writer, but never an exclusive lease.
    // Keep this separate from the write slots so reads retain their independent lane.
    if (exclusiveSlotHeld) return false
    if (lane === 'exclusive') return inFlight === 0
    if (slot === undefined) return readsInFlight < readConcurrency
    return !heldSlots.has(slot) && heldSlots.size < writeSlots
  }

  function take(lane: Lane, slot: string | undefined): void {
    if (lane === 'exclusive') exclusiveSlotHeld = true
    inFlight++
    if (slot !== undefined) heldSlots.add(slot)
    else if (lane === 'read') readsInFlight++
  }

  function give(lane: Lane, slot: string | undefined): void {
    if (lane === 'exclusive') exclusiveSlotHeld = false
    inFlight--
    if (slot !== undefined) heldSlots.delete(slot)
    else if (lane === 'read') readsInFlight--
  }

  function pump(): void {
    for (let i = 0; i < pending.length; ) {
      const waiter = pending[i] as Waiter
      if (canStart(waiter.lane, waiter.slot)) {
        pending.splice(i, 1)
        if (waiter.lane === 'exclusive') pendingExclusive--
        take(waiter.lane, waiter.slot)
        waiter.start()
        continue
      }
      if (waiter.lane === 'exclusive') break
      i++
    }
    if (inFlight === 0 && pending.length === 0) {
      // ONE CATCH PER LISTENER: a throwing subscriber must not take out the
      // ones registered after it, and must not take out `finishClose` either —
      // a `close()` that never resolves because a logger threw is a hang.
      for (const listener of [...idleListeners]) {
        try {
          listener()
        } catch (error) {
          reportIdleFailure(error)
        }
      }
      if (persistenceSettled) finishClose?.()
    }
  }

  /**
   * May a newcomer start without queueing?
   *
   * With one write slot, only when nothing is queued: the queue is the call order,
   * exactly as before per-workspace slots existed. With per-workspace slots, when
   * no exclusive request is queued: after every pump each queued waiter is blocked
   * (by its own workspace's slot, the bound, or the read lane), so a newcomer that
   * can start overtakes no waiter it competes with — a queued write of its own
   * workspace would hold its slot blocked, and the bound blocks both alike.
   */
  function mayBypassQueue(): boolean {
    return perWorkspace ? pendingExclusive === 0 : pending.length === 0
  }

  function admit(lane: Lane, slot: string | undefined): Promise<void> | undefined {
    if (mayBypassQueue() && canStart(lane, slot)) {
      take(lane, slot)
      return undefined
    }
    if (lane === 'exclusive') pendingExclusive++
    return new Promise<void>((resolve) => {
      pending.push({ lane, slot, start: resolve })
    })
  }

  async function runLease<T>(
    lane: Lane,
    body: (lease: Lease) => Promise<T>,
    context: StoreContext | undefined,
  ): Promise<T> {
    if (state === 'open' && lane !== 'exclusive') state = 'accepting'
    if (
      state !== 'accepting' &&
      !(state === 'open' && lane === 'exclusive') &&
      !(state === 'draining' && !persistenceSettled && shutdownScope.getStore()?.active)
    ) {
      throw new SchedulerClosedError(`scheduler is ${state}`)
    }
    // Capture the caller once per lease, before queueing, without paying for a
    // stack capture on every statement in the transaction.
    const stack = watchdog ? (new Error('Transaction lease requested').stack ?? '') : ''
    const slot = slotFor(lane, context ?? rootStatementContext())
    const queued = admit(lane, slot)
    if (queued) await queued
    /**
     * THE SLOT IS HELD FROM HERE, so everything that can reject is inside the
     * release `finally` — acquiring the connection as much as the body and
     * returning it. `driver.open` is a network call on the remote driver and
     * `close` returns a connection to a pool; either can reject on a blip. A
     * rejection that skipped the release would leave the slot taken forever
     * while the scheduler still reported `accepting`: every later write and
     * `close()` would wait for a lease nobody holds. One transient failure
     * would wedge the server.
     */
    let session: DriverSession | undefined
    // Acquire and run, and never throw out of it: the caller below owns the
    // release, and a throw here is exactly what used to skip it.
    const acquireAndRun = async (): Promise<LeaseOutcome<T>> => {
      try {
        session = await withBusyRetry(async () => await driver.open(lane))
        const startedAt = now()
        // OBSERVED, not merely held: the gap clock the watchdog reads only
        // exists because every call the body makes goes through this wrapper.
        const activity = leaseActivity(session, now)
        const observed = activity.session
        const lease: Lease = {
          id: nextLeaseId++,
          lane,
          session: observed,
          active: activity.active,
          begin: async (beginLane: Lane) =>
            await withBusyRetry(async () => await observed.begin(beginLane)),
          atomicWrite: async (attempt) => await withBusyRetry(attempt),
          heldMs: () => now() - startedAt,
          idleMs: () => activity.idleMs(),
        }
        const stopWatch = watchdog
          ? activity.watch(budgetMs, () => {
              try {
                watchdog.report({
                  stack,
                  leaseId: lease.id,
                  lane,
                  idleMs: lease.idleMs(),
                  heldMs: lease.heldMs(),
                  budgetMs,
                })
              } catch (error) {
                try {
                  watchdog.onReportFailure?.(error)
                } catch {
                  /* Reporting is diagnostic; a broken sink cannot revoke a lease. */
                }
              }
            })
          : undefined
        let drainTimer: ReturnType<typeof setTimeout> | undefined
        let revoking: Promise<void> | undefined
        let rejectDrain: (error: unknown) => void = () => undefined
        const revoked = new Promise<never>((_, reject) => {
          rejectDrain = reject
        })
        const drain = (): void => {
          if (drainTimer !== undefined || lane === 'exclusive') return
          drainTimer = setTimeout(() => {
            revoking = activity.revoke()
            void revoking.then(
              () => rejectDrain(new StaleTransactionError('lease revoked during scheduler drain')),
              rejectDrain,
            )
          }, options.drainGraceMs ?? 1_000)
        }
        drainers.add(drain)
        if (state === 'draining') drain()
        try {
          return { ok: true, value: await Promise.race([body(lease), revoked]) }
        } finally {
          drainers.delete(drain)
          if (drainTimer !== undefined) clearTimeout(drainTimer)
          stopWatch?.()
          if (revoking) await revoking
        }
      } catch (error) {
        return { ok: false, error }
      }
    }
    let outcome = await acquireAndRun()
    try {
      // Only a session that was actually acquired is closed.
      if (session) await session.close()
    } catch (closeError) {
      outcome = closeOutcome(outcome, closeError)
    } finally {
      give(lane, slot)
      pump()
    }
    if (outcome.ok) return outcome.value
    throw outcome.error
  }

  /**
   * Returning the connection failed. Neither failure may be dropped: the body's
   * is what the caller asked about, and a connection that did not come back is
   * the driver's problem, so a double failure is reported as both.
   */
  function closeOutcome<T>(
    outcome: LeaseOutcome<T>,
    closeError: unknown,
  ): { ok: false; error: unknown } {
    if (outcome.ok) return { ok: false, error: closeError }
    return {
      ok: false,
      error: new AggregateError(
        [outcome.error, closeError],
        'the lease body failed and returning the connection failed',
      ),
    }
  }

  return {
    get state() {
      return state
    },
    async run(lane, body, context) {
      return await runLease(lane, body, context)
    },
    async detachedRead<T>(body: (session: DriverSession) => Promise<T>): Promise<T> {
      if (state === 'closed') throw new SchedulerClosedError('scheduler is closed')
      const openReader = driver.openReader
      if (!openReader) {
        throw new Error(
          `driver ${driver.kind} has no reader connection, so a committed-view read from ` +
            'inside an open body is not available: on one connection it would either see the ' +
            'uncommitted rows or deadlock behind the write lane',
        )
      }
      inFlight++
      let session: DriverSession | undefined
      let drainTimer: ReturnType<typeof setTimeout> | undefined
      let revoking: Promise<void> | undefined
      let drain: (() => void) | undefined
      let outcome: LeaseOutcome<T>
      try {
        session = await openReader.call(driver)
        const activity = leaseActivity(session, now)
        let rejectDrain: (error: unknown) => void = () => undefined
        const revoked = new Promise<never>((_, reject) => {
          rejectDrain = reject
        })
        drain = () => {
          if (drainTimer !== undefined) return
          drainTimer = setTimeout(() => {
            revoking = activity.revoke()
            void revoking.then(
              () =>
                rejectDrain(
                  new StaleTransactionError('detached reader revoked during scheduler drain'),
                ),
              rejectDrain,
            )
          }, options.drainGraceMs ?? 1_000)
        }
        drainers.add(drain)
        if (state === 'draining') drain()
        outcome = { ok: true, value: await Promise.race([body(activity.session), revoked]) }
      } catch (error) {
        outcome = { ok: false, error }
      } finally {
        if (drain) drainers.delete(drain)
        if (drainTimer !== undefined) clearTimeout(drainTimer)
        try {
          if (revoking) {
            try {
              await revoking
            } catch (error) {
              outcome = closeOutcome(outcome!, error)
            }
          }
          await session?.close()
        } catch (error) {
          outcome = closeOutcome(outcome!, error)
        } finally {
          inFlight--
          pump()
        }
      }
      if (outcome.ok) return outcome.value
      throw outcome.error
    },

    retain(body) {
      return shutdownScope.run({ active: true }, body)
    },
    async settled() {
      if (inFlight === 0 && pending.length === 0) return
      await new Promise<void>((resolve) => {
        const done = (): void => {
          idleListeners.delete(done)
          resolve()
        }
        idleListeners.add(done)
      })
    },
    onIdle(listener) {
      idleListeners.add(listener)
      return () => idleListeners.delete(listener)
    },
    close(persist) {
      if (closing) return closing
      state = 'draining'
      persistenceSettled = false
      for (const drain of drainers) drain()
      const idle = new Promise<void>((resolve) => {
        finishClose = () => {
          finishClose = undefined
          resolve()
        }
      })
      // Only the awaited shutdown callback may submit persistence after intake
      // closes. Its permission dies before the driver closes, including copies
      // inherited by continuations that the callback forgot to await.
      closing = (async () => {
        const permission = { active: true }
        try {
          await shutdownScope.run(permission, async () => {
            await persist?.()
          })
        } finally {
          permission.active = false
          persistenceSettled = true
          pump()
          await idle
          await driver.close()
          state = 'closed'
        }
      })()
      return closing
    },
  }
}
