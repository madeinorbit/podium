/**
 * THE HEADER'S REQUEST ANSWERS (POD-5798).
 *
 * Quota and usage are LiveStore conditions now, pushed by the server, and the
 * host lifecycle settings (hibernation, worktree GC) are the synced instance
 * settings record (POD-6677). One header reading stays a request (ADR 12 D1,
 * "request answers"), and this owner asks for it only while a mounted, visible
 * header retains it: the 24-hour agent concurrency history, asked on retain,
 * every 5 minutes while retained, and again when the number of working sessions
 * changes (the live count is merged into the last bucket by the view, so this
 * keeps the older buckets honest, not the current one).
 *
 * A failed request keeps the previous answer: the header shows the last good
 * chart rather than an empty one, as before.
 */

import type { AgentConcurrencyHistoryResult } from '@podium/client-core/api'
import { createLogger } from '@podium/logger'
import { action, observableRef, reaction } from 'mobx'
import { headerView } from './header-views'
import type { MobxPool } from './pool'

const log = createLogger('client.header-requests')

export const HEADER_HISTORY_REFRESH_MS = 5 * 60_000

export interface HeaderRequestsApi {
  readonly sessions?: {
    readonly concurrencyHistory?: { query(): Promise<AgentConcurrencyHistoryResult> }
  }
}

/** A history reading the chart can draw: 24 hourly buckets of non-negative counts. */
export function isDrawableHistory(reading: AgentConcurrencyHistoryResult): boolean {
  return (
    reading.buckets.length === 24 &&
    Number.isFinite(reading.bucketMs) &&
    reading.bucketMs > 0 &&
    Number.isInteger(reading.peak) &&
    reading.peak >= 0 &&
    reading.buckets.every(
      (bucket) =>
        Number.isInteger(bucket.count) &&
        bucket.count >= 0 &&
        Number.isFinite(Date.parse(bucket.start)),
    )
  )
}

export class HeaderRequests {
  @observableRef accessor history: AgentConcurrencyHistoryResult | null = null

  private retained = 0
  private stop: (() => void) | undefined
  private historyInFlight = false
  private generation = 0
  private disposed = false

  constructor(
    private readonly pool: MobxPool,
    private readonly api: HeaderRequestsApi,
  ) {}

  /** A visible header asks for these answers while it is mounted. */
  retain(): () => void {
    if (this.disposed) return () => {}
    this.retained += 1
    if (this.retained === 1) this.begin()
    let released = false
    return () => {
      if (released) return
      released = true
      this.retained -= 1
      if (this.retained === 0) this.end()
    }
  }

  dispose(): void {
    this.disposed = true
    this.end()
  }

  private begin(): void {
    const generation = ++this.generation
    const timer = setInterval(() => void this.askHistory(generation), HEADER_HISTORY_REFRESH_MS)
    const stopWorking = reaction(
      () => headerView(this.pool).workingCount(),
      () => void this.askHistory(generation),
    )
    this.stop = () => {
      clearInterval(timer)
      stopWorking()
    }
    void this.askHistory(generation)
  }

  private end(): void {
    this.generation += 1
    this.stop?.()
    this.stop = undefined
  }

  private async askHistory(generation: number): Promise<void> {
    const query = this.api.sessions?.concurrencyHistory
    if (!query || this.historyInFlight) return
    this.historyInFlight = true
    try {
      const reading = await query.query()
      if (generation !== this.generation || this.disposed || !isDrawableHistory(reading)) return
      this.setHistory(reading)
    } catch (error) {
      log.debug('concurrency history request failed; keeping the last answer', { error })
    } finally {
      this.historyInFlight = false
    }
  }

  /** The history request's answer (public for fixtures). */
  @action setHistory(reading: AgentConcurrencyHistoryResult): void {
    this.history = reading
  }
}

/** Create (once) the pool's header request owner: the header source attachment, or a fixture. */
export function attachHeaderRequests(pool: MobxPool, api: HeaderRequestsApi): HeaderRequests {
  return pool.sources.view('header.requests', () => new HeaderRequests(pool, api))
}

/** The pool's one header request owner, created by the header source attachment. */
export function headerRequests(pool: MobxPool): HeaderRequests | undefined {
  return pool.sources.peekView<HeaderRequests>('header.requests')
}
