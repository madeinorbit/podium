/**
 * The three models for mutable process-owned state [POD-3248, spec §3.6].
 *
 * The store is full of objects the process owns and mutates in the same frame
 * as the write that persists them — issue rows mutated then restored by
 * assignment on failure, session metadata, the registries in `relay.ts`. That
 * works only because nothing can yield between the mutation and the commit.
 * With awaits in the picture each one needs an explicit model, and there are
 * exactly three; a site picks one, and the choice is recorded per site (B0.4).
 *
 *   1. DRAFT-THEN-INSTALL — build an immutable draft from a committed snapshot,
 *      persist it, install it only after the write commits, and refuse the
 *      install if the committed revision moved underneath. This is what
 *      replaces rollback-by-assignment: there is nothing to roll back, because
 *      the shared object was never touched.
 *   2. WRITE-LEASE-BEFORE-READ — take the write unit of work BEFORE reading or
 *      mutating, and make every reader take the read lease. The mirror update
 *      goes in the post-commit tail of the same lease (spec §6 rule 12), so no
 *      reader can observe the new value before the commit or miss it after.
 *   3. VERSIONED MUTEX — serialise access to state that has no database write
 *      to hang off, with a version a caller can pin so a stale decision is
 *      refused rather than applied.
 *
 * All three are exercised over an injected async persistence function that
 * parks on a barrier, because the failure they exist to prevent only appears
 * while a write is in flight.
 */

import type { StoreExecutor } from './executor'
import { postCommit } from './executor'

export class StaleRevisionError extends Error {
  constructor(
    readonly expected: number,
    readonly found: number,
  ) {
    super(`state moved under this draft: expected revision ${expected}, found ${found}`)
    this.name = 'StaleRevisionError'
  }
}

export class StaleVersionError extends Error {
  constructor(
    readonly expected: number,
    readonly found: number,
  ) {
    super(`state moved under this caller: expected version ${expected}, found ${found}`)
    this.name = 'StaleVersionError'
  }
}

export interface Revisioned {
  readonly revision: number
}

/**
 * Model 1. The installed value is only ever REPLACED, never mutated, so a
 * reader always holds a consistent object and a failed persist leaves the
 * registry exactly as it was.
 */
export class DraftRegistry<T extends Revisioned> {
  private readonly installed = new Map<string, T>()

  constructor(private readonly persist: (id: string, next: T) => Promise<void>) {}

  seed(id: string, value: T): void {
    this.installed.set(id, value)
  }

  /** The committed snapshot. Callers may hold it: it is never mutated. */
  snapshot(id: string): T | undefined {
    return this.installed.get(id)
  }

  async update(id: string, mutate: (current: T) => Omit<T, 'revision'>): Promise<T> {
    const current = this.installed.get(id)
    if (!current) throw new Error(`no state for ${id}`)
    const draft = { ...mutate(current), revision: current.revision + 1 } as T
    await this.persist(id, draft)
    // Re-read AFTER the await: another update may have committed while this one
    // was in flight, and installing over it would silently lose that write.
    const now = this.installed.get(id)
    if (!now || now.revision !== current.revision) {
      throw new StaleRevisionError(current.revision, now?.revision ?? -1)
    }
    this.installed.set(id, draft)
    return draft
  }
}

/**
 * Model 2. Reads take the read lease and therefore queue behind an open write
 * body; the mirror is installed in the post-commit tail of the write's own
 * lease, so "committed" and "visible in memory" are one step.
 */
export class LeasedState<T> {
  constructor(
    private readonly executor: StoreExecutor<unknown>,
    private value: T,
  ) {}

  /** The value as of the read lease. Never read it outside one. */
  read<R>(project: (value: T) => R): Promise<R> {
    return this.executor.read(async () => project(this.value))
  }

  update(mutate: (value: T) => T, persist: (next: T) => Promise<void>): Promise<T> {
    return this.executor.transact(async () => {
      const next = mutate(this.value)
      await persist(next)
      // The mirror moves with the commit, not with the write: a reader must
      // never see it before COMMIT, and must never miss it after.
      postCommit().applyCommit(() => {
        this.value = next
      }, 'mirror-install')
      return next
    })
  }
}

/**
 * Model 3. A plain mutex with a version, independent of the database
 * scheduler — for state whose consistency has nothing to do with a transaction.
 */
export class VersionedMutex {
  private tail: Promise<unknown> = Promise.resolve()
  private current = 0

  get version(): number {
    return this.current
  }

  /** Serialised. The version advances once `fn` resolves. */
  run<T>(fn: (version: number) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const result = await fn(this.current)
      this.current++
      return result
    })
    // The tail must not reject, or every later caller inherits the failure.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Serialised, and refused if the state moved since `expected` was read. */
  runIfUnchanged<T>(expected: number, fn: (version: number) => Promise<T>): Promise<T> {
    return this.run((version) => {
      if (version !== expected) throw new StaleVersionError(expected, version)
      return fn(version)
    })
  }
}
