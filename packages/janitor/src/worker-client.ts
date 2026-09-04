import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { createLogger } from '@podium/logger'
import { isCompiledBunfsUrl, janitorWorkerEmbeddedTarget } from './janitor-worker-embed.js'

const log = createLogger('server:janitor-worker')

const DEFAULT_MONITOR_MS = 5_000
/** Matches the parent component watchdog window: twenty normal 30s janitor ticks. */
export const JANITOR_WORKER_WEDGED_MS = 600_000
const FAST_CRASH_WINDOW_MS = 3_000
const RESTART_BACKOFF_MS = [0, 1_000, 3_000, 10_000, 30_000] as const

export type JanitorWorkerState = 'running' | 'degraded' | 'stopped'

export interface JanitorWorkerStartOptions {
  serverUrl: string
  token: string
  dbPath?: string
  tickMs?: number
}

export interface JanitorWorkerHandle {
  progressVersion(): number
  state(): JanitorWorkerState
  reason(): string | undefined
  close(): void
}

export interface WorkerLike {
  postMessage(message: unknown): void
  on(event: 'message' | 'error' | 'exit', callback: (value: any) => void): void
  terminate(): void
}

type WorkerMessage =
  | { type: 'ready'; progressVersion: number }
  | { type: 'progress'; progressVersion: number }
  | { type: 'compatibilityRefusal'; reason: string }
  | { type: 'testBlockStarted'; id: string }
  | { type: 'testBlockFinished'; id: string }

interface ProbeWaiters {
  started: { resolve(): void; reject(error: Error): void }
  done: { resolve(): void; reject(error: Error): void }
}

function workerTarget(): URL | string {
  if (isCompiledBunfsUrl(import.meta.url)) return janitorWorkerEmbeddedTarget()
  return new URL('./janitor-worker.ts', import.meta.url)
}

function defaultSpawn(options: JanitorWorkerStartOptions): WorkerLike {
  return new Worker(workerTarget(), {
    type: 'module',
    workerData: options,
  } as unknown as ConstructorParameters<typeof Worker>[1]) as unknown as WorkerLike
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Owns one autonomous janitor thread and keeps it observable and recoverable.
 *
 * A crash or a frozen heartbeat/progress token terminates the current generation and
 * respawns it with bounded backoff. Compatibility refusal is different: new code is
 * required, so it remains visibly degraded instead of crash-looping.
 */
export class JanitorWorkerClient implements JanitorWorkerHandle {
  private worker: WorkerLike | undefined
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private readonly monitorTimer: ReturnType<typeof setInterval>
  private componentState: JanitorWorkerState = 'degraded'
  private componentReason: string | undefined = 'janitor worker starting'
  private closed = false
  private compatibilityRefused = false
  private lastSpawnAtMs = 0
  private lastMessageAtMs = 0
  private lastProgressAtMs = 0
  private workerProgress = 0
  private progress = 0
  private fastCrashes = 0
  private restarts = 0
  private readonly probes = new Map<string, ProbeWaiters>()

  constructor(
    private readonly options: JanitorWorkerStartOptions,
    private readonly deps: {
      spawn?: (options: JanitorWorkerStartOptions) => WorkerLike
      now?: () => number
      monitorMs?: number
      wedgedMs?: number
      log?: (message: string) => void
    } = {},
  ) {
    this.spawnWorker()
    this.monitorTimer = setInterval(() => this.monitor(), deps.monitorMs ?? DEFAULT_MONITOR_MS)
    this.monitorTimer.unref?.()
  }

  progressVersion(): number {
    return this.progress
  }

  state(): JanitorWorkerState {
    return this.componentState
  }

  reason(): string | undefined {
    return this.componentReason
  }

  /** Test/evidence seam: number of automatic replacement generations. */
  restartCount(): number {
    return this.restarts
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private writeLog(message: string): void {
    if (this.deps.log) this.deps.log(message)
    else log.warn(message)
  }

  private spawnWorker(): void {
    if (this.closed || this.compatibilityRefused) return
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    this.componentState = 'degraded'
    this.componentReason =
      this.restarts > 0 ? 'janitor worker restarting' : 'janitor worker starting'
    this.workerProgress = 0
    const startedAt = this.now()
    this.lastSpawnAtMs = startedAt
    this.lastMessageAtMs = startedAt
    this.lastProgressAtMs = startedAt
    let worker: WorkerLike
    try {
      worker = (this.deps.spawn ?? defaultSpawn)(this.options)
    } catch (error) {
      this.scheduleRestart(asError(error))
      return
    }
    this.worker = worker
    worker.on('message', (message: WorkerMessage) => this.onMessage(worker, message))
    worker.on('error', (error: Error) => this.onFailure(worker, asError(error)))
    worker.on('exit', (code: number) => {
      this.onFailure(worker, new Error(`janitor worker exited ${code}`))
    })
  }

  private onMessage(worker: WorkerLike, message: WorkerMessage): void {
    if (worker !== this.worker || this.closed) return
    this.lastMessageAtMs = this.now()
    if (message.type === 'ready' || message.type === 'progress') {
      this.recordProgress(message.progressVersion)
      if (message.type === 'ready') {
        const recovered = this.restarts > 0
        this.componentState = 'running'
        this.componentReason = undefined
        if (recovered) log.info('janitor worker recovered', { restarts: this.restarts })
      }
      return
    }
    if (message.type === 'compatibilityRefusal') {
      this.compatibilityRefused = true
      this.componentState = 'degraded'
      this.componentReason = message.reason
      this.writeLog(`janitor worker refused compatibility: ${message.reason}`)
      this.rejectProbes(new Error(message.reason))
      this.worker = undefined
      try {
        worker.terminate()
      } catch {}
      return
    }
    const probe = this.probes.get(message.id)
    if (!probe) return
    if (message.type === 'testBlockStarted') probe.started.resolve()
    else {
      probe.done.resolve()
      this.probes.delete(message.id)
    }
  }

  private recordProgress(next: number): void {
    if (!Number.isFinite(next) || next < 0) return
    if (next > this.workerProgress) {
      this.progress += next - this.workerProgress
      this.workerProgress = next
      this.lastProgressAtMs = this.now()
    }
  }

  private onFailure(worker: WorkerLike, error: Error): void {
    if (worker !== this.worker || this.closed || this.compatibilityRefused) return
    this.worker = undefined
    try {
      worker.terminate()
    } catch {}
    this.rejectProbes(error)
    this.scheduleRestart(error)
  }

  private scheduleRestart(error: Error): void {
    if (this.closed || this.compatibilityRefused || this.restartTimer) return
    const now = this.now()
    this.fastCrashes = now - this.lastSpawnAtMs < FAST_CRASH_WINDOW_MS ? this.fastCrashes + 1 : 1
    const delay = RESTART_BACKOFF_MS[
      Math.min(this.fastCrashes - 1, RESTART_BACKOFF_MS.length - 1)
    ] as number
    this.componentState = 'degraded'
    this.componentReason = `${error.message}; restarting in ${delay}ms`
    this.writeLog(`janitor worker failed: ${error.message} — restarting in ${delay}ms`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.restarts += 1
      this.spawnWorker()
    }, delay)
    this.restartTimer.unref?.()
  }

  private monitor(): void {
    if (!this.worker || this.closed || this.compatibilityRefused) return
    const now = this.now()
    const wedgedMs = this.deps.wedgedMs ?? JANITOR_WORKER_WEDGED_MS
    const heartbeatAge = now - this.lastMessageAtMs
    const progressAge = now - this.lastProgressAtMs
    if (heartbeatAge < wedgedMs && progressAge < wedgedMs) return
    const cause =
      heartbeatAge >= wedgedMs
        ? `heartbeat stalled for ${heartbeatAge}ms`
        : `progress stalled for ${progressAge}ms`
    this.onFailure(this.worker, new Error(`janitor worker wedged: ${cause}`))
  }

  private rejectProbes(error: Error): void {
    for (const [, probe] of this.probes) {
      probe.started.reject(error)
      probe.done.reject(error)
    }
    this.probes.clear()
  }

  /** Deliberately blocks the worker event loop; used only by the isolation measurement. */
  blockForTest(durationMs: number): { started: Promise<void>; done: Promise<void> } {
    const worker = this.worker
    if (!worker) throw new Error('janitor worker is not running')
    const id = randomUUID()
    let resolveStarted!: () => void
    let rejectStarted!: (error: Error) => void
    let resolveDone!: () => void
    let rejectDone!: (error: Error) => void
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve
      rejectStarted = reject
    })
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    this.probes.set(id, {
      started: { resolve: resolveStarted, reject: rejectStarted },
      done: { resolve: resolveDone, reject: rejectDone },
    })
    worker.postMessage({ type: 'testBlock', id, durationMs })
    return { started, done }
  }

  /** Deliberately throws in the worker; used only by the recovery measurement. */
  crashForTest(): void {
    if (!this.worker) throw new Error('janitor worker is not running')
    this.worker.postMessage({ type: 'testCrash' })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.monitorTimer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    this.rejectProbes(new Error('janitor worker stopped'))
    const worker = this.worker
    this.worker = undefined
    try {
      worker?.postMessage({ type: 'stop' })
      worker?.terminate()
    } catch {}
    this.componentState = 'stopped'
    this.componentReason = undefined
  }
}

export async function startJanitorWorker(
  options: JanitorWorkerStartOptions,
): Promise<JanitorWorkerHandle> {
  return new JanitorWorkerClient(options)
}
