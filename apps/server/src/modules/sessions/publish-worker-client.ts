import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { SessionMeta } from '@podium/protocol'
import type {
  PreparedPublication,
  PreparePublicationInput,
  SessionProjectionState,
  ViewKey,
} from './publish-worker-actor.js'
import { isCompiledBunfsUrl, publishWorkerEmbeddedTarget } from './publish-worker-embed.js'
import type { PublishWorkerCommand, PublishWorkerResult } from './publish-worker-protocol.js'
import type { SessionProjectionEvent } from './service.js'

export interface PublishWorkerLike {
  postMessage(message: unknown): void
  on<Event extends keyof PublishWorkerEventMap>(
    event: Event,
    handler: (value: PublishWorkerEventMap[Event]) => void,
  ): void
  terminate(): void
}

interface PublishWorkerEventMap {
  message: PublishWorkerResult
  error: Error
  exit: number
}

interface QueuedJob {
  id: string
  input: PreparePublicationInput
  focused: boolean
  order: number
  enqueuedAt: number
  resolve(publication: PreparedPublication): void
  reject(error: Error): void
  settled: boolean
  superseded: boolean
  timer?: ReturnType<typeof setTimeout>
}

export interface PublishWorkerMetrics {
  queueDepth: number
  coalescedJobs: number
  supersededJobs: number
  completedJobs: number
  failures: number
  maxJobAgeMs: number
  maxUninterruptedSliceMs: number
}

export class PublicationSupersededError extends Error {
  constructor(viewKey: ViewKey) {
    super(`publication for ViewKey ${viewKey} was superseded`)
    this.name = 'PublicationSupersededError'
  }
}

function workerTarget(): URL | string {
  if (isCompiledBunfsUrl(import.meta.url)) return publishWorkerEmbeddedTarget()
  return new URL('./publish-worker.ts', import.meta.url)
}

function defaultSpawn(): PublishWorkerLike {
  return new Worker(workerTarget(), {
    type: 'module',
  } as unknown as ConstructorParameters<typeof Worker>[1]) as unknown as PublishWorkerLike
}
class RespawnThrottledError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('publish worker crash-looping — respawn throttled')
    this.name = 'RespawnThrottledError'
  }
}

const RESPAWN_COOLDOWN_MS = 3_000

/**
 * Main-loop scheduler for the pure publication actor [spec:SP-c29e]. Only one
 * job enters the Worker at a time so queued ViewKeys remain reprioritizable and
 * replaceable; sockets, authorization, and stale-result acceptance stay here.
 */
export class PublishWorkerClient {
  private worker?: PublishWorkerLike
  private active?: QueuedJob
  private readonly queued = new Map<ViewKey, QueuedJob>()
  private readonly sessions = new Map<string, SessionMeta>()
  private readonly spawn: () => PublishWorkerLike
  private readonly timeoutMs: number
  private readonly log: (message: string) => void
  private generation = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private ledgerCursor = 0
  private appliedLedgerCursor = 0
  private pendingProjectionEvents: SessionProjectionEvent[] = []
  private nextOrder = 0
  private lastCrashAtMs = 0
  private fastCrashes = 0
  private stopped = false
  private counters: Omit<PublishWorkerMetrics, 'queueDepth'> = {
    coalescedJobs: 0,
    supersededJobs: 0,
    completedJobs: 0,
    failures: 0,
    maxJobAgeMs: 0,
    maxUninterruptedSliceMs: 0,
  }

  constructor(
    options: {
      spawn?: () => PublishWorkerLike
      timeoutMs?: number
      log?: (message: string) => void
    } = {},
  ) {
    this.spawn = options.spawn ?? defaultSpawn
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.log = options.log ?? ((message) => console.warn(message))
  }

  replaceProjection(state: SessionProjectionState): void {
    this.invalidateAll()
    this.pendingProjectionEvents = []
    this.generation = state.generation
    this.ledgerCursor = state.ledgerCursor
    this.appliedLedgerCursor = state.ledgerCursor
    this.sessions.clear()
    for (const session of state.sessions)
      this.sessions.set(session.sessionId, structuredClone(session))
    this.worker?.postMessage({
      type: 'reset',
      state: this.projectionState(),
    } satisfies PublishWorkerCommand)
  }

  applyProjection(event: SessionProjectionEvent): void {
    if (event.generation <= this.generation) {
      throw new Error('publication client received an out-of-order projection patch')
    }
    for (const change of event.changes) {
      if (change.entity !== 'session')
        throw new Error('publication client received non-session patch')
      if (change.seq > event.ledgerCursor) {
        throw new Error('publication client received a change beyond its ledger cursor')
      }
    }
    this.generation = event.generation
    this.ledgerCursor = Math.max(this.ledgerCursor, event.ledgerCursor)
    this.pendingProjectionEvents.push(structuredClone(event))
    this.invalidateAll()
  }

  sourceCursor(): number {
    return this.ledgerCursor
  }

  advanceCursor(cursor: number): boolean {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new Error('publication client received an invalid source cursor')
    }
    if (cursor <= this.ledgerCursor) return false
    this.ledgerCursor = cursor
    this.pendingProjectionEvents.push({
      generation: this.generation,
      ledgerCursor: cursor,
      changes: [],
    })
    this.invalidateAll()
    return true
  }

  request(
    input: PreparePublicationInput,
    options: { focused?: boolean } = {},
  ): Promise<PreparedPublication> {
    if (this.stopped) return Promise.reject(new Error('publish worker stopped'))
    this.flushProjectionEvents()
    const existing = this.queued.get(input.view.key)
    if (existing) {
      this.queued.delete(input.view.key)
      this.counters.coalescedJobs += 1
      this.supersede(existing)
    }
    if (this.active?.input.view.key === input.view.key) {
      const stale = this.active
      this.supersede(stale)
      if (stale.timer) clearTimeout(stale.timer)
      this.active = undefined
      this.abandonWorker()
    }

    const promise = new Promise<PreparedPublication>((resolve, reject) => {
      const job: QueuedJob = {
        id: randomUUID(),
        input: structuredClone(input),
        focused: options.focused ?? false,
        order: this.nextOrder++,
        enqueuedAt: performance.now(),
        resolve,
        reject,
        settled: false,
        superseded: false,
      }
      this.queued.set(input.view.key, job)
    })
    // Callers normally await, but a result invalidated by an arriving patch must
    // never become an unhandled rejection when the owning socket disappeared.
    promise.catch(() => {})
    this.dispatchNext()
    return promise
  }

  metrics(): PublishWorkerMetrics {
    return { queueDepth: this.queued.size + (this.active ? 1 : 0), ...this.counters }
  }

  prioritize(focused: ReadonlySet<ViewKey>): void {
    for (const job of this.queued.values()) job.focused = focused.has(job.input.view.key)
  }

  stop(): void {
    this.stopped = true
    if (this.active?.timer) clearTimeout(this.active.timer)
    if (this.active) this.reject(this.active, new Error('publish worker stopped'))
    this.active = undefined
    for (const job of this.queued.values()) this.reject(job, new Error('publish worker stopped'))
    this.queued.clear()
    try {
      this.worker?.terminate()
    } catch {}
    this.worker = undefined
  }

  private projectionState(): SessionProjectionState {
    return {
      generation: this.generation,
      ledgerCursor: this.ledgerCursor,
      sessions: [...this.sessions.values()].map((session) => structuredClone(session)),
    }
  }

  /**
   * Ledger callbacks can re-enter: seq N+1 may publish its service callback before
   * the outer seq N call unwinds. Coalesce every callback observed before the next
   * build and order immutable rows by ledger seq before updating/sending the actor.
   */
  private flushProjectionEvents(): void {
    if (this.pendingProjectionEvents.length === 0) return
    const changes = this.pendingProjectionEvents
      .flatMap((event) => event.changes)
      .sort((left, right) => left.seq - right.seq)
    this.pendingProjectionEvents = []
    for (const change of changes) {
      if (change.seq <= this.appliedLedgerCursor) {
        throw new Error('publication client projection coalescing crossed an applied cursor')
      }
      if (change.op === 'remove') this.sessions.delete(change.id)
      else this.sessions.set(change.id, structuredClone(change.value) as SessionMeta)
    }
    const event: SessionProjectionEvent = {
      generation: this.generation,
      ledgerCursor: this.ledgerCursor,
      changes,
    }
    this.appliedLedgerCursor = this.ledgerCursor
    this.worker?.postMessage({ type: 'patch', event } satisfies PublishWorkerCommand)
  }

  private ensureWorker(): PublishWorkerLike {
    if (this.worker) return this.worker
    const sinceCrash = Date.now() - this.lastCrashAtMs
    if (this.fastCrashes >= 2 && sinceCrash < RESPAWN_COOLDOWN_MS) {
      throw new RespawnThrottledError(RESPAWN_COOLDOWN_MS - sinceCrash)
    }
    const worker = this.spawn()
    worker.on('message', (result: PublishWorkerResult) => this.onResult(worker, result))
    worker.on('error', (error: Error) => this.crash(worker, error))
    worker.on('exit', (code: number) =>
      this.crash(worker, new Error(`publish worker exited ${code}`)),
    )
    this.worker = worker
    worker.postMessage({
      type: 'reset',
      state: this.projectionState(),
    } satisfies PublishWorkerCommand)
    return worker
  }

  private dispatchNext(): void {
    if (this.active || this.queued.size === 0 || this.stopped) return
    const [next] = [...this.queued.values()].sort(
      (left, right) => Number(right.focused) - Number(left.focused) || left.order - right.order,
    )
    if (!next) return
    this.queued.delete(next.input.view.key)
    this.active = next
    try {
      const worker = this.ensureWorker()
      next.timer = setTimeout(
        () => this.crash(worker, new Error(`publish job ${next.id} timed out`)),
        this.timeoutMs,
      )
      worker.postMessage({
        type: 'prepare',
        id: next.id,
        input: next.input,
      } satisfies PublishWorkerCommand)
    } catch (error) {
      this.active = undefined
      if (error instanceof RespawnThrottledError) {
        this.queued.set(next.input.view.key, next)
        this.scheduleRetry(error.retryAfterMs)
        return
      }
      this.counters.failures += 1
      this.reject(next, error instanceof Error ? error : new Error(String(error)))
      this.dispatchNext()
    }
  }

  private onResult(worker: PublishWorkerLike, result: PublishWorkerResult): void {
    if (worker !== this.worker) return
    if (result.id === null) {
      this.crash(worker, new Error(result.error))
      return
    }
    const job = this.active
    if (!job || job.id !== result.id) return
    if (job.timer) clearTimeout(job.timer)
    this.active = undefined
    this.fastCrashes = 0
    this.observeAge(job)
    if (!result.ok) {
      this.counters.failures += 1
      this.reject(job, new Error(result.error))
    } else if (
      !job.superseded &&
      result.publication.generation === this.generation &&
      result.publication.ledgerCursor === this.ledgerCursor &&
      result.publication.viewKey === job.input.view.key &&
      result.publication.viewRevision === job.input.view.revision
    ) {
      this.counters.completedJobs += 1
      this.counters.maxUninterruptedSliceMs = Math.max(
        this.counters.maxUninterruptedSliceMs,
        result.durationMs,
      )
      this.resolve(job, result.publication)
    } else if (!job.settled) {
      this.supersede(job)
    }
    this.dispatchNext()
  }

  private invalidateAll(): void {
    if (this.active) {
      const stale = this.active
      this.supersede(stale)
      if (stale.timer) clearTimeout(stale.timer)
      this.active = undefined
      this.abandonWorker()
    }
    for (const job of this.queued.values()) this.supersede(job)
    this.queued.clear()
  }

  private supersede(job: QueuedJob): void {
    if (job.superseded) return
    job.superseded = true
    this.counters.supersededJobs += 1
    this.reject(job, new PublicationSupersededError(job.input.view.key))
  }

  private crash(worker: PublishWorkerLike, error: Error): void {
    if (worker !== this.worker) return
    const now = Date.now()
    this.fastCrashes = now - this.lastCrashAtMs < RESPAWN_COOLDOWN_MS ? this.fastCrashes + 1 : 1
    this.lastCrashAtMs = now
    this.counters.failures += 1
    this.log(`[podium:server] publish worker crashed: ${error.message} — respawning`)
    const job = this.active
    if (job?.timer) clearTimeout(job.timer)
    this.active = undefined
    this.worker = undefined
    try {
      worker.terminate()
    } catch {}
    if (job && !job.settled && !job.superseded) {
      const newer = this.queued.get(job.input.view.key)
      if (newer) this.supersede(job)
      else this.queued.set(job.input.view.key, job)
    }
    this.dispatchNext()
  }

  private abandonWorker(): void {
    const worker = this.worker
    this.worker = undefined
    try {
      worker?.terminate()
    } catch {}
  }

  private scheduleRetry(delayMs: number): void {
    if (this.retryTimer || this.stopped) return
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined
        this.dispatchNext()
      },
      Math.max(1, delayMs),
    )
    this.retryTimer.unref?.()
  }

  private observeAge(job: QueuedJob): void {
    this.counters.maxJobAgeMs = Math.max(
      this.counters.maxJobAgeMs,
      performance.now() - job.enqueuedAt,
    )
  }

  private resolve(job: QueuedJob, publication: PreparedPublication): void {
    if (job.settled) return
    job.settled = true
    job.resolve(publication)
  }

  private reject(job: QueuedJob, error: Error): void {
    if (job.settled) return
    job.settled = true
    job.reject(error)
  }
}
