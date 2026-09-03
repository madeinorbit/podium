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
  /** Wall time this lease has held its connection, ms. */
  heldMs(): number
}

export interface WatchdogReport {
  readonly leaseId: number
  readonly lane: Lane
  readonly heldMs: number
  readonly budgetMs: number
}

export interface SchedulerOptions {
  driver: StoreDriver<unknown>
  /**
   * Reports a body that has held its connection past its budget. Injectable
   * because the useful sink differs by caller: the server logs it, the tests
   * collect it, and on Turso the budget has to sit below the platform's own
   * interactive-transaction timeout — the driver's own declared
   * `limits.writeBudgetMs`, measured at about 9 s (POD-3251, spec §6 rule 7),
   * which the constructor below checks against rather than any number written
   * here.
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

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { driver } = options
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep
  const limits = driver.limits
  /**
   * The watchdog reports a body that has held its connection too long, so a
   * budget at or above the engine's own hard limit reports a transaction the
   * server has already killed — it can never fire first. This is a
   * misconfiguration, and the constructor is where it is cheap to find.
   */
  if (options.watchdog && options.watchdog.budgetMs >= limits.writeBudgetMs) {
    throw new Error(
      `watchdog budget ${options.watchdog.budgetMs}ms is not below driver ${driver.kind}'s ` +
        `write budget of ${limits.writeBudgetMs}ms: the engine would end the transaction ` +
        'before the watchdog could report it',
    )
  }

  /**
   * A bounded retry for an ACQUISITION only. It stops on the attempt count, on
   * a non-busy failure, and on the driver's own write budget: waiting longer
   * than the transaction could have lived buys nothing.
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
        const held = session
        const startedAt = now()
        const lease: Lease = {
          id: nextLeaseId++,
          lane,
          session,
          begin: (beginLane: Lane) => withBusyRetry(() => held.begin(beginLane)),
          atomicWrite: (attempt) => withBusyRetry(attempt),
          heldMs: () => now() - startedAt,
        }
        const watchdog = options.watchdog
        // `unref` so a forgotten timer can never hold a process open — the
        // watchdog is a report, never a deadline.
        const timer = watchdog
          ? setTimeout(() => {
              watchdog.report({
                leaseId: lease.id,
                lane,
                heldMs: lease.heldMs(),
                budgetMs: watchdog.budgetMs,
              })
            }, watchdog.budgetMs)
          : undefined
        timer?.unref?.()
        try {
          return { ok: true, value: await body(lease) }
        } finally {
          if (timer) clearTimeout(timer)
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
