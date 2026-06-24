// apps/daemon/src/discovery-worker.ts
import { parentPort } from 'node:worker_threads'
import { type MemoryBreakdownJobInput, runMemoryBreakdownJob } from './discovery-jobs'

export type WorkerJob = { id: string; kind: 'memoryBreakdown'; input: MemoryBreakdownJobInput }
export type WorkerResult =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: string }

if (parentPort) {
  const port = parentPort
  port.on('message', (job: WorkerJob) => {
    try {
      let value: unknown
      if (job.kind === 'memoryBreakdown') value = runMemoryBreakdownJob(job.input)
      else throw new Error(`unknown job kind: ${(job as { kind: string }).kind}`)
      port.postMessage({ id: job.id, ok: true, value } satisfies WorkerResult)
    } catch (err) {
      port.postMessage({
        id: job.id, ok: false, error: err instanceof Error ? err.message : String(err),
      } satisfies WorkerResult)
    }
  })
}
