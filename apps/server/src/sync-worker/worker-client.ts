import { perfPrincipal } from '../modules/perf/principal'
import { perf } from '../modules/perf/registry'
import type { BootstrapMetrics, SyncFailureReason } from './types'

export interface BootstrapCompletion {
  metrics?: BootstrapMetrics
  reason?: SyncFailureReason
}

import { Worker } from 'node:worker_threads'
import { isCompiledSyncWorkerUrl, syncWorkerEmbeddedTarget } from './sync-worker-embed'
import {
  type BootstrapJob,
  type FromWorker,
  SYNC_JOB_DEADLINE_MS,
  type SyncMetaSummary,
  SyncWorkerError,
  type ToWorker,
} from './types'

export type { BootstrapJob, SyncMetaSummary } from './types'
export { SyncWorkerError } from './types'

interface Pending {
  principal: BootstrapJob['principal']
  controller: ReadableStreamDefaultController<Uint8Array>
  resolve(meta: SyncMetaSummary): void
  reject(error: Error): void
  cleanup(): void
  pullDone?: () => void
}
/** Main-thread boundary: only bounded opaque buffers and the small meta record cross it. */
export class SyncWorkerClient {
  private worker?: Worker
  private closed = false
  private ready = false
  private jobs = new Map<string, Pending>()
  private completions = new Map<
    string,
    { resolve(result: BootstrapCompletion): void; metrics?: BootstrapMetrics }
  >()
  private restartTimer?: ReturnType<typeof setTimeout>
  private monitorTimer: ReturnType<typeof setInterval>
  private lastMessage = Date.now()
  private lastProgress = Date.now()
  private workerProgress = 0
  private workerJobs = 0
  private spawnedAt = Date.now()
  private fastCrashes = 0
  private terminations = new Set<Promise<unknown>>()
  private readonly exited = new WeakSet<Worker>()
  private closing?: Promise<void>
  constructor(
    private readonly options: {
      dbPath: string
      monitorMs?: number
      wedgedMs?: number
      onMetrics?: (metrics: BootstrapMetrics) => void
    },
  ) {
    this.spawn()
    this.monitorTimer = setInterval(() => {
      const now = Date.now()
      const wedgedMs = options.wedgedMs ?? 600_000
      const silent = now - this.lastMessage >= wedgedMs
      const stalled =
        (this.jobs.size > 0 || this.workerJobs > 0) && now - this.lastProgress >= wedgedMs
      if (this.worker && (silent || stalled)) this.fail(this.worker)
    }, options.monitorMs ?? 5000)
    this.monitorTimer.unref()
  }
  state(): 'running' | 'degraded' | 'stopped' {
    return this.closed ? 'stopped' : this.ready ? 'running' : 'degraded'
  }
  activeJobCount(): number {
    return this.jobs.size
  }
  private spawn() {
    if (this.closed) return
    this.spawnedAt = this.lastMessage = this.lastProgress = Date.now()
    this.workerJobs = this.workerProgress = 0
    try {
      const target = isCompiledSyncWorkerUrl(import.meta.url)
        ? syncWorkerEmbeddedTarget()
        : new URL('./sync-worker.ts', import.meta.url)
      const worker = new Worker(target, { workerData: { dbPath: this.options.dbPath } })
      this.worker = worker
      worker.on('message', (message: FromWorker) => {
        if (worker !== this.worker) return
        this.lastMessage = Date.now()
        if (message.type === 'ready') {
          this.ready = true
          return
        }
        if (message.type === 'heartbeat') {
          this.workerJobs = message.jobs
          if (message.progressVersion !== this.workerProgress || message.jobs === 0)
            this.lastProgress = Date.now()
          this.workerProgress = message.progressVersion
          return
        }
        this.lastProgress = Date.now()
        const completion = this.completions.get(message.transferId)
        if (message.type === 'metrics' && completion) completion.metrics = message.metrics
        if (message.type === 'end' || message.type === 'error') {
          this.complete(message.transferId, message.type === 'error' ? message.reason : undefined)
        }
        const job = this.jobs.get(message.transferId)
        if (!job) return
        if (message.type === 'metrics') {
          const attribution = perfPrincipal(job.principal)
          for (const [name, value] of Object.entries(message.metrics.phases))
            perf.record('phase', `syncBootstrap.${name}`, value.ms, attribution, value.bytes)
          this.options.onMetrics?.(message.metrics)
        } else if (message.type === 'meta') job.resolve(message.meta)
        else if (message.type === 'bytes') {
          job.controller.enqueue(new Uint8Array(message.chunk))
          const done = job.pullDone
          job.pullDone = undefined
          done?.()
        } else if (message.type === 'error')
          this.end(message.transferId, new SyncWorkerError(message.reason))
        else this.end(message.transferId)
      })
      worker.on('error', () => this.fail(worker))
      worker.on('exit', () => {
        this.exited.add(worker)
        this.fail(worker, true)
      })
    } catch {
      this.restart()
    }
  }
  private complete(id: string, reason?: SyncFailureReason) {
    const completion = this.completions.get(id)
    if (!completion) return
    this.completions.delete(id)
    completion.resolve({ metrics: completion.metrics, reason })
  }
  private send(message: ToWorker) {
    const worker = this.worker
    try {
      worker?.postMessage(message)
    } catch {
      if (worker) this.fail(worker)
    }
  }
  private end(id: string, error?: SyncWorkerError, cancelled: false | 'stream' | 'signal' = false) {
    const job = this.jobs.get(id)
    if (!job) return
    this.jobs.delete(id)
    job.cleanup()
    job.pullDone?.()
    if (error) {
      job.reject(error)
      if (!cancelled) job.controller.error(error)
      // Abort can precede the transport cancelling its reader. Settle pending
      // reads normally so the disconnected consumer has no rejection to handle.
      else if (cancelled === 'signal') job.controller.close()
    } else job.controller.close()
  }
  private terminate(worker: Worker) {
    if (this.exited.has(worker)) return
    const termination = new Promise<void>((resolve) => {
      // Bun may leave a repeated terminate() promise pending after exit. The
      // exit event is also a completion signal, and exited workers need no kill.
      worker.once('exit', () => resolve())
      try {
        void worker.terminate().then(
          () => resolve(),
          () => resolve(),
        )
      } catch {
        resolve()
      }
    })
    this.terminations.add(termination)
    void termination.then(() => this.terminations.delete(termination))
  }
  private fail(worker: Worker, alreadyExited = false) {
    if (worker !== this.worker || this.closed) return
    this.worker = undefined
    this.ready = false
    if (!alreadyExited) this.terminate(worker)
    for (const id of [...this.jobs.keys()]) this.end(id, new SyncWorkerError('worker-crashed'))
    for (const id of [...this.completions.keys()]) this.complete(id, 'worker-crashed')
    this.restart()
  }
  private restart() {
    if (this.closed || this.restartTimer) return
    this.fastCrashes = Date.now() - this.spawnedAt < 3000 ? this.fastCrashes + 1 : 1
    const delay = [0, 1000, 3000, 10_000, 30_000][Math.min(this.fastCrashes - 1, 4)]!
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.spawn()
    }, delay)
    this.restartTimer.unref()
  }
  bootstrap(
    input: BootstrapJob,
    signal?: AbortSignal,
  ): {
    meta: Promise<SyncMetaSummary>
    body: ReadableStream<Uint8Array>
    completed: Promise<BootstrapCompletion>
  } {
    const job = { ...input, deadlineMs: input.deadlineMs ?? Date.now() + SYNC_JOB_DEADLINE_MS }
    if (this.closed || !this.worker)
      throw new SyncWorkerError(this.closed ? 'shutdown' : 'unavailable')
    if (this.completions.has(job.transferId)) throw new SyncWorkerError('unavailable')
    const completed = new Promise<BootstrapCompletion>((resolve) => {
      this.completions.set(job.transferId, { resolve })
    })
    let resolve!: Pending['resolve'], reject!: Pending['reject']
    const meta = new Promise<SyncMetaSummary>((yes, no) => {
      resolve = yes
      reject = no
    })
    // A caller may consume only the body; still surface rejection through the original promise.
    void meta.catch(() => {})
    const cancel = (reason: 'cancelled' | 'deadline', streamCancelled = false) => {
      this.send({ type: 'cancel', transferId: job.transferId, reason })
      this.end(
        job.transferId,
        new SyncWorkerError(reason),
        streamCancelled ? 'stream' : reason === 'cancelled' ? 'signal' : false,
      )
    }
    const onAbort = () => cancel('cancelled')
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          const timer = setTimeout(
            () => cancel('deadline'),
            Math.max(0, job.deadlineMs - Date.now()),
          )
          timer.unref()
          this.jobs.set(job.transferId, {
            principal: job.principal,
            controller,
            resolve,
            reject,
            cleanup: () => {
              clearTimeout(timer)
              signal?.removeEventListener('abort', onAbort)
            },
          })
          this.send({ type: 'start', job })
          signal?.addEventListener('abort', onAbort, { once: true })
          if (signal?.aborted) onAbort()
        },
        pull: () => {
          const pending = this.jobs.get(job.transferId)
          if (!pending) return
          return new Promise<void>((done) => {
            pending.pullDone = done
            this.send({ type: 'credit', transferId: job.transferId, n: 1 })
          })
        },
        cancel: () => cancel('cancelled', true),
      },
      { highWaterMark: 0 },
    )
    return { meta, body, completed }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.ready = false
    clearInterval(this.monitorTimer)
    clearTimeout(this.restartTimer)
    for (const id of [...this.jobs.keys()]) this.end(id, new SyncWorkerError('shutdown'))
    for (const id of [...this.completions.keys()]) this.complete(id, 'shutdown')
    const worker = this.worker
    this.worker = undefined
    if (worker) {
      try {
        worker.postMessage({ type: 'stop' })
      } catch {
      } finally {
        this.terminate(worker)
      }
    }
    this.closing = Promise.all([...this.terminations]).then(() => undefined)
    return this.closing
  }
}
