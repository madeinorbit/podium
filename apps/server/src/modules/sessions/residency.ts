import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import type { SessionRow, SessionStore } from '../../store'
import type { Session } from './session'
import { isRunningStatus } from './session-record'

const log = createLogger('server:session-residency')

/**
 * WHICH SESSIONS ARE IN MEMORY (POD-6160 D2f).
 *
 * The session map holds the sessions that RUN, and a stopped (parked) session
 * only while something USES it: an operation that writes it or drives its
 * runtime holds a LEASE for its duration, and a client that views it (an
 * attached terminal, a transcript subscription) keeps it for as long as it
 * looks. Everything else about a parked session is its durable record
 * (`records.ts`), read from the database.
 *
 * MATERIALIZE. A lease on a parked session that is not resident reads its row
 * and restores it the way the boot load does (`SessionRepository
 * .materializeStoredSession`), so the object an operation gets is the one a
 * restart would have built. Loads of the same session at the same time share
 * one read, and a session that became resident while its row was read (a
 * resurrect, a spawn racing it) wins over the restored copy.
 *
 * EVICT. A resident session leaves the map once it does not run, no lease holds
 * it, no client views it and nothing about it still waits to reach its row
 * (`settled`: no write queued or in flight, no volatile capture or activity
 * flush pending), and its process-only state holds no unfinished work (a draft
 * edit or write timer). Eviction drops memory only: nothing is written and
 * nothing is published, because nothing about the session changed. A release
 * or a viewer leaving tries at once; a session that parks by itself (an exit,
 * a hibernation) or was unsettled when tried is found by the sweep.
 *
 * Eviction is OFF until the map shrinks (D2g): until then the map holds every
 * session, every lease finds its session resident, and nothing leaves.
 */

export interface SessionResidencyPorts {
  readonly sessions: ReadonlyMap<SessionId, Session>
  readonly store: SessionStore
  /** Restore a parked session from its row and install it (the boot mapping). */
  materialize(row: SessionRow): Promise<Session | undefined>
  /** Nothing about this resident session still waits to reach its row. */
  settled(sessionId: SessionId): boolean
  /** A client views it: an attached terminal or a transcript subscription. */
  viewed(sessionId: SessionId): boolean
  /** Process-only state holds unfinished work for it (a draft edit, a timer). */
  holdsWork(sessionId: SessionId): boolean
  /** Drop it from the process. Memory only: the reverse of materialize. */
  evict(session: Session): void
  /** Evict parked sessions. Off until the map shrinks (D2g). */
  readonly evictParked: boolean
  /** How often the sweep looks for parked sessions; 0 = never by itself. */
  readonly sweepIntervalMs?: number
}

/** Why a session is held resident, for the logs. */
export type ResidencyReason = string

export class SessionResidency {
  private readonly leases = new Map<SessionId, number>()
  private readonly loading = new Map<SessionId, Promise<Session | undefined>>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly ports: SessionResidencyPorts) {
    const interval = ports.sweepIntervalMs ?? 5_000
    if (ports.evictParked && interval > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), interval)
      this.sweepTimer.unref?.()
    }
  }

  get evictsParked(): boolean {
    return this.ports.evictParked
  }

  /**
   * Run `fn` with the session resident, materialized from its row when it is
   * parked out of memory; it stays resident until `fn` settles. `fn` gets
   * undefined for a session that does not exist (never created, or deleted).
   */
  async withSession<T>(
    sessionId: SessionId,
    reason: ResidencyReason,
    fn: (session: Session | undefined) => T | Promise<T>,
  ): Promise<T> {
    const session = await this.acquire(sessionId, reason)
    try {
      return await fn(session)
    } finally {
      if (session) this.release(sessionId)
    }
  }

  /**
   * Hold the session resident until {@link release}; undefined (and nothing
   * held) when it does not exist. Every acquire that returns a session needs
   * exactly one release.
   */
  async acquire(sessionId: SessionId, reason: ResidencyReason): Promise<Session | undefined> {
    // Counted before any await, so a sweep running while the row is read cannot
    // evict what this lease is about to hold.
    this.leases.set(sessionId, (this.leases.get(sessionId) ?? 0) + 1)
    let session: Session | undefined
    try {
      session = await this.ensure(sessionId, reason)
    } catch (error) {
      this.drop(sessionId)
      throw error
    }
    if (!session) this.drop(sessionId)
    return session
  }

  /**
   * Hold a session that is resident NOW, without an await: for a caller that
   * must reach its session before yielding (a bind installs its pictures
   * first). False, and nothing held, when it is not resident.
   */
  hold(sessionId: SessionId): boolean {
    if (!this.ports.sessions.has(sessionId)) return false
    this.leases.set(sessionId, (this.leases.get(sessionId) ?? 0) + 1)
    return true
  }

  release(sessionId: SessionId): void {
    this.drop(sessionId)
    this.tryEvict(sessionId)
  }

  /**
   * The session, made resident if it is parked out of memory, WITHOUT holding
   * it: for a caller whose use keeps it resident by other means (a client that
   * views it), or that only needs it for the current synchronous step.
   */
  async ensure(sessionId: SessionId, reason: ResidencyReason): Promise<Session | undefined> {
    const resident = this.ports.sessions.get(sessionId)
    if (resident) return resident
    const pending = this.loading.get(sessionId)
    if (pending) return await pending
    const load = this.load(sessionId, reason)
    this.loading.set(sessionId, load)
    try {
      return await load
    } finally {
      this.loading.delete(sessionId)
    }
  }

  private async load(sessionId: SessionId, reason: ResidencyReason): Promise<Session | undefined> {
    // Through the operation's loader: the access check that let this operation
    // in has usually read the row already.
    const row = await this.ports.store.sessions.loadSession(sessionId)
    // Resident wins: it became resident while the row was read.
    const raced = this.ports.sessions.get(sessionId)
    if (raced) return raced
    if (!row || row.deletedAt) return undefined
    if (isRunningStatus(row.status as Session['status'])) {
      // A running session is resident from its spawn or the boot load; a row
      // that says running without one is the boot reconcile's to settle.
      log.warn('materializing a session whose row says it runs', { sessionId, status: row.status, reason })
    }
    const session = await this.ports.materialize(row)
    log.debug('session materialized', { sessionId, reason })
    return session
  }

  /** Any of these resident and evictable now leaves the map. */
  tryEvict(sessionId: SessionId): boolean {
    if (!this.ports.evictParked) return false
    const session = this.ports.sessions.get(sessionId)
    if (!session || !this.evictable(session)) return false
    this.ports.evict(session)
    return true
  }

  /** Evict every parked session nothing uses; the number evicted. */
  sweep(): number {
    if (!this.ports.evictParked) return 0
    let evicted = 0
    for (const session of [...this.ports.sessions.values()]) {
      if (this.evictable(session)) {
        this.ports.evict(session)
        evicted += 1
      }
    }
    return evicted
  }

  /** Held by a lease now (tests and diagnostics). */
  leased(sessionId: SessionId): boolean {
    return (this.leases.get(sessionId) ?? 0) > 0
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  /** Why this resident session stays in memory, or undefined when it may leave. */
  residentBecause(sessionId: SessionId): 'running' | 'leased' | 'loading' | 'viewed' | 'work' | 'unsettled' | undefined {
    const session = this.ports.sessions.get(sessionId)
    if (!session) return undefined
    // A headless session is driven turn by turn for as long as its row exists,
    // and a failed establish (status exited) is retried on machine attach: it
    // never leaves memory by eviction.
    if (isRunningStatus(session.status) || session.headless) return 'running'
    if (this.leased(sessionId)) return 'leased'
    if (this.loading.has(sessionId)) return 'loading'
    if (this.ports.viewed(sessionId)) return 'viewed'
    if (this.ports.holdsWork(sessionId)) return 'work'
    if (!this.ports.settled(sessionId)) return 'unsettled'
    return undefined
  }

  private evictable(session: Session): boolean {
    return this.residentBecause(session.sessionId) === undefined
  }

  private drop(sessionId: SessionId): void {
    const held = (this.leases.get(sessionId) ?? 0) - 1
    if (held > 0) this.leases.set(sessionId, held)
    else this.leases.delete(sessionId)
  }
}
