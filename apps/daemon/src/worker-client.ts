// apps/daemon/src/worker-client.ts
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { WorkerJob, WorkerResult } from './discovery-worker'
import { DISCOVERY_WORKER_EMBEDDED_PATH } from './discovery-worker-embed.js'

export interface WorkerLike {
  postMessage(m: unknown): void
  on(ev: 'message' | 'error' | 'exit', cb: (a: any) => void): void
  terminate(): void
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function workerUrl(): URL {
  // In the `bun build --compile` daemon, `new URL('./discovery-worker.ts', import.meta.url)`
  // does NOT resolve — import.meta.url collapses to the main entry (file:///$bunfs/root/<binary>)
  // and the worker is embedded (as a separate entrypoint, see scripts/build-bun.ts) at a nested
  // `.js` path. Detect the standalone binary via its `/$bunfs/` module URL and spawn the worker
  // from its embedded path. Running from source (bun run host / bun test) we spawn the sibling
  // `.ts` on disk instead. See discovery-worker-embed.ts for the shared path.
  if (import.meta.url.includes('/$bunfs/'))
    return new URL(`file://${DISCOVERY_WORKER_EMBEDDED_PATH}`)
  return new URL('./discovery-worker.ts', import.meta.url)
}

function defaultSpawn(): WorkerLike {
  // `{ type: 'module' }` is honored by the Bun/web Worker runtime this daemon runs
  // under; cast past node:worker_threads' stricter WorkerOptions type which omits it.
  return new Worker(workerUrl(), {
    type: 'module',
  } as unknown as ConstructorParameters<typeof Worker>[1]) as unknown as WorkerLike
}

export class DiscoveryWorkerClient {
  private worker?: WorkerLike
  private readonly pending = new Map<string, Pending>()
  private readonly inflightByKind = new Map<string, Promise<unknown>>()
  private readonly spawn: () => WorkerLike
  private readonly timeoutMs: number
  private readonly log: (m: string) => void

  constructor(
    opts: { spawn?: () => WorkerLike; timeoutMs?: number; log?: (m: string) => void } = {},
  ) {
    this.spawn = opts.spawn ?? defaultSpawn
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.log = opts.log ?? ((m) => console.warn(m))
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker
    const w = this.spawn()
    w.on('message', (r: WorkerResult) => this.settle(r))
    w.on('error', (e: Error) => this.crash(e))
    w.on('exit', (code: number) => {
      if (code !== 0) this.crash(new Error(`worker exited ${code}`))
    })
    this.worker = w
    return w
  }

  private settle(r: WorkerResult): void {
    const p = this.pending.get(r.id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(r.id)
    if (r.ok) p.resolve(r.value)
    else p.reject(new Error(r.error))
  }

  private crash(err: Error): void {
    this.log(`[podium:daemon] discovery worker crashed: ${err.message} — respawning`)
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
    this.inflightByKind.clear()
    try {
      this.worker?.terminate()
    } catch {}
    this.worker = undefined
  }

  runJob(kind: WorkerJob['kind'], input: unknown): Promise<unknown> {
    const existing = this.inflightByKind.get(kind)
    if (existing) return existing
    const id = randomUUID()
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => this.settle({ id, ok: false, error: `${kind} timed out` }),
        this.timeoutMs,
      )
      this.pending.set(id, { resolve, reject, timer })
      this.ensureWorker().postMessage({ id, kind, input } as WorkerJob)
    }).finally(() => {
      // Guarded delete: only clear the map if it still holds THIS promise. A
      // stale/abandoned finally (e.g. one rejected by crash()/stop()) must never
      // delete a newer same-kind entry that was set after this job was replaced.
      if (this.inflightByKind.get(kind) === promise) this.inflightByKind.delete(kind)
    })
    // Keep an internally-swallowed copy so an abandoned/coalesced in-flight job
    // rejected by stop()/crash() never surfaces as an unhandled rejection; the
    // promise returned to the caller still rejects for real awaiters.
    this.inflightByKind.set(kind, promise)
    promise.catch(() => {})
    return promise
  }

  stop(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('stopped'))
    }
    this.pending.clear()
    this.inflightByKind.clear()
    try {
      this.worker?.terminate()
    } catch {}
    this.worker = undefined
  }
}
