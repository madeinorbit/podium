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

import type { DriverSession, Lane, StoreDriver } from './driver'
import { SchedulerClosedError } from './errors'

export interface Lease {
  readonly id: number
  readonly lane: Lane
  readonly session: DriverSession
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
   * 5-second interactive-transaction timeout.
   */
  watchdog?: { budgetMs: number; report: (report: WatchdogReport) => void }
  now?: () => number
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

interface Waiter {
  readonly lane: Lane
  readonly start: () => void
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { driver } = options
  const now = options.now ?? (() => Date.now())
  const readConcurrency = driver.lanes.readConcurrency
  /** Reads with no lane of their own take the write slot (bun:sqlite). */
  const readsUseWriteSlot = readConcurrency === 0

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
      for (const listener of [...idleListeners]) listener()
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
    const session = await driver.open(lane)
    const startedAt = now()
    const lease: Lease = {
      id: nextLeaseId++,
      lane,
      session,
      heldMs: () => now() - startedAt,
    }
    const watchdog = options.watchdog
    // `unref` so a forgotten timer can never hold a process open — the watchdog
    // is a report, never a deadline.
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
      return await body(lease)
    } finally {
      if (timer) clearTimeout(timer)
      await session.close()
      give(lane)
      pump()
    }
  }

  return {
    get state() {
      return state
    },
    run(lane, body) {
      return runLease(lane, body)
    },
    async detachedRead(body) {
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
      try {
        return await body(session)
      } finally {
        await session.close()
      }
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
