/**
 * THE HEADER'S REQUEST ANSWERS (POD-5798).
 *
 * Quota and usage are LiveStore conditions now, pushed by the server. Two
 * header readings stay requests (ADR 12 D1, "request answers"), and this owner
 * asks for them only while a mounted, visible header retains it:
 *
 * - the 24-hour agent concurrency history: asked on retain, every 5 minutes
 *   while retained, and again when the number of working sessions changes (the
 *   live count is merged into the last bucket by the view, so this keeps the
 *   older buckets honest, not the current one);
 * - the host lifecycle settings (hibernation, worktree GC): asked once, and
 *   handed to the pool's settings record.
 *
 * A failed request keeps the previous answer: the header shows the last good
 * chart rather than an empty one, as before.
 */

import type { AgentConcurrencyHistoryResult, PodiumClientApi } from '@podium/client-core/api'
import { createLogger } from '@podium/logger'
import { action, observableRef, reaction } from 'mobx'
import { headerView } from './header-views'
import type { MobxPool } from './pool'
import { ingestSettings } from './requested-record-source'

const log = createLogger('client.header-requests')

export const HEADER_HISTORY_REFRESH_MS = 5 * 60_000

type Settings = Awaited<ReturnType<PodiumClientApi['settings']['get']['query']>>
export type HeaderLifecycle = Pick<Settings, 'hibernation' | 'worktreeGc'>

export interface HeaderRequestsApi {
  readonly settings: { readonly get: { query(): Promise<Settings> } }
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
  @observableRef accessor lifecycle: HeaderLifecycle | null = null

  private retained = 0
  private stop: (() => void) | undefined
  private historyInFlight = false
  private lifecycleAsked = false
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
    if (!this.lifecycleAsked) void this.askLifecycle(generation)
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

  private async askLifecycle(generation: number): Promise<void> {
    this.lifecycleAsked = true
    try {
      const settings = await this.api.settings.get.query()
      if (generation !== this.generation || this.disposed) {
        this.lifecycleAsked = false
        return
      }
      this.setLifecycle(settings)
    } catch (error) {
      this.lifecycleAsked = false
      log.debug('settings request failed; the header asks again on its next retain', { error })
    }
  }

  /** The history request's answer (public for fixtures). */
  @action setHistory(reading: AgentConcurrencyHistoryResult): void {
    this.history = reading
  }

  /** The settings request's answer (public for fixtures). */
  @action setLifecycle(settings: Settings): void {
    ingestSettings(this.pool, settings)
    this.lifecycle = { hibernation: settings.hibernation, worktreeGc: settings.worktreeGc }
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
