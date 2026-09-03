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
 *   - `write` and `exclusive` need the single write slot, so writes stay FIFO
 *     among themselves.
 *   - `read` takes the write slot too when the driver's `readConcurrency` is 0
 *     (bun:sqlite: one connection, one lane, today's behaviour exactly), and
 *     otherwise runs on its own slots and may overtake a blocked write — which
 *     is what "the remote implementation may run the read lane concurrently"
 *     means.
 *   - `exclusive` is a BARRIER: the scan stops at one, so nothing overtakes it
 *     and a stream of reads cannot starve it. It starts only when the scheduler
 *     is empty.
 *
 * The slot is taken in the caller's own turn, before the first `await`, so the
 * queue order is the call order — which is what makes the interleaving tests
 * deterministic rather than merely usually right.
 */

import type { BusyRetryPolicy, DriverSession, Lane, StoreDriver } from './driver'
import { SchedulerClosedError } from './errors'

export interface Lease {
  readonly id: number
  readonly lane: Lane
  readonly session: DriverSession
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

export interface WatchdogReport {
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
  watchdog?: { budgetMs: number; report: (report: WatchdogReport) => void }
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

export type SchedulerState = 'accepting' | 'draining' | 'closed'

export interface Scheduler {
  readonly state: SchedulerState
  run<T>(lane: Lane, body: (lease: Lease) => Promise<T>): Promise<T>
  /**
   * A read on a connection outside the lanes, for the committed view from
   * inside an open body. Rejects when the driver has no such connection.
   */
  detachedRead<T>(body: (session: DriverSession) => Promise<T>): Promise<T>
  /** Called when the scheduler has nothing in flight and nothing queued. */
  onIdle(listener: () => void): () => void
  /** Stop accepting work, drain what is queued, close the driver. */
  close(): Promise<void>
}

type LeaseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

interface Waiter {
  readonly lane: Lane
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
  /** Arm the gap timer. Returns the stop the lease's `finally` owes it. */
  watch(budgetMs: number, onGap: () => void): () => void
} {
  let inFlight = 0
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
    inFlight++
    disarm()
    try {
      return await call()
    } finally {
      inFlight--
      lastSettledAt = now()
      // A REJECTION IS ACTIVITY TOO: the statement reached the engine, so the
      // stream was not quiet, and the next gap is measured from here.
      if (inFlight === 0) arm()
    }
  }

  return {
    session: {
      execute: (statement) => track(() => session.execute(statement)),
      executeBatch: (statements) => track(() => session.executeBatch(statements)),
      begin: (lane) => track(() => session.begin(lane)),
      commit: () => track(() => session.commit()),
      rollback: () => track(() => session.rollback()),
      enterSavepoint: (name) => track(() => session.enterSavepoint(name)),
      releaseSavepoint: (name) => track(() => session.releaseSavepoint(name)),
      rollbackToSavepoint: (name) => track(() => session.rollbackToSavepoint(name)),
      // NOT TRACKED, deliberately: the scheduler closes the connection after the
      // body has ended and the watch is already stopped, so stamping the clock
      // here could only arm a timer nobody will ever read.
      close: () => session.close(),
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
  /**
   * BOTH NUMBERS BOUND THE SAME QUANTITY — the gap between statements — which
   * is what makes comparing them meaningful (POD-3345; before that the guard
   * compared a duration against a gap and so gave false confidence). A watchdog
   * whose gap budget is at or above the engine's can only fire after the engine
   * has already reaped the stream, so it reports a transaction that is already
   * dead. That is a misconfiguration, and the constructor is where it is cheap
   * to find.
   */
  if (options.watchdog && options.watchdog.budgetMs >= limits.writeBudgetMs) {
    throw new Error(
      `watchdog budget ${options.watchdog.budgetMs}ms is not below driver ${driver.kind}'s ` +
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
  /** Reads with no lane of their own take the write slot (bun:sqlite). */
  const readsUseWriteSlot = readConcurrency === 0

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
  let writeSlotHeld = false
  let readsInFlight = 0
  let inFlight = 0
  let state: SchedulerState = 'accepting'
  let nextLeaseId = 1
  let closing: Promise<void> | undefined
  let finishClose: (() => void) | undefined

  function canStart(lane: Lane): boolean {
    if (lane === 'exclusive') return inFlight === 0
    if (lane === 'write') return !writeSlotHeld
    return readsUseWriteSlot ? !writeSlotHeld : readsInFlight < readConcurrency
  }

  function take(lane: Lane): void {
    inFlight++
    if (lane === 'read' && !readsUseWriteSlot) readsInFlight++
    else writeSlotHeld = true
  }

  function give(lane: Lane): void {
    inFlight--
    if (lane === 'read' && !readsUseWriteSlot) readsInFlight--
    else writeSlotHeld = false
  }

  function pump(): void {
    for (let i = 0; i < pending.length; ) {
      const waiter = pending[i] as Waiter
      if (canStart(waiter.lane)) {
        pending.splice(i, 1)
        take(waiter.lane)
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
      finishClose?.()
    }
  }

  function admit(lane: Lane): Promise<void> | undefined {
    if (pending.length === 0 && canStart(lane)) {
      take(lane)
      return undefined
    }
    return new Promise<void>((resolve) => {
      pending.push({ lane, start: resolve })
    })
  }

  async function runLease<T>(lane: Lane, body: (lease: Lease) => Promise<T>): Promise<T> {
    if (state !== 'accepting') throw new SchedulerClosedError(`scheduler is ${state}`)
    const queued = admit(lane)
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
        session = await withBusyRetry(() => driver.open(lane))
        const startedAt = now()
        // OBSERVED, not merely held: the gap clock the watchdog reads only
        // exists because every call the body makes goes through this wrapper.
        const activity = leaseActivity(session, now)
        const observed = activity.session
        const lease: Lease = {
          id: nextLeaseId++,
          lane,
          session: observed,
          begin: (beginLane: Lane) => withBusyRetry(() => observed.begin(beginLane)),
          atomicWrite: (attempt) => withBusyRetry(attempt),
          heldMs: () => now() - startedAt,
          idleMs: () => activity.idleMs(),
        }
        const watchdog = options.watchdog
        const stopWatch = watchdog
          ? activity.watch(watchdog.budgetMs, () => {
              watchdog.report({
                leaseId: lease.id,
                lane,
                idleMs: lease.idleMs(),
                heldMs: lease.heldMs(),
                budgetMs: watchdog.budgetMs,
              })
            })
          : undefined
        try {
          return { ok: true, value: await body(lease) }
        } finally {
          stopWatch?.()
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
      give(lane)
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
    run(lane, body) {
      return runLease(lane, body)
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
      const session = await openReader.call(driver)
      let outcome: LeaseOutcome<T>
      try {
        outcome = { ok: true, value: await body(session) }
      } catch (error) {
        outcome = { ok: false, error }
      }
      try {
        await session.close()
      } catch (closeError) {
        outcome = closeOutcome(outcome, closeError)
      }
      if (outcome.ok) return outcome.value
      throw outcome.error
    },
    onIdle(listener) {
      idleListeners.add(listener)
      return () => idleListeners.delete(listener)
    },
    close() {
      if (closing) return closing
      state = 'draining'
      closing = new Promise<void>((resolve) => {
        finishClose = () => {
          finishClose = undefined
          resolve()
        }
        if (inFlight === 0 && pending.length === 0) finishClose()
      }).then(async () => {
        await driver.close()
        state = 'closed'
      })
      return closing
    },
  }
}
