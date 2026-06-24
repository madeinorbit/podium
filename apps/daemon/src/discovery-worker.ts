// apps/daemon/src/discovery-worker.ts
import { parentPort } from 'node:worker_threads'
import {
  type IndexRefreshJobInput,
  type MemoryBreakdownJobInput,
  runIndexRefreshJob,
  runMemoryBreakdownJob,
} from './discovery-jobs'

export type WorkerJob =
  | { id: string; kind: 'memoryBreakdown'; input: MemoryBreakdownJobInput }
  | { id: string; kind: 'indexRefresh'; input: IndexRefreshJobInput }
export type WorkerResult =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: string }

if (parentPort) {
  const port = parentPort
  port.on('message', async (job: WorkerJob) => {
    try {
      let value: unknown
      if (job.kind === 'memoryBreakdown') value = runMemoryBreakdownJob(job.input)
      else if (job.kind === 'indexRefresh') value = await runIndexRefreshJob(job.input)
      else throw new Error(`unknown job kind: ${(job as { kind: string }).kind}`)
      port.postMessage({ id: job.id, ok: true, value } satisfies WorkerResult)
    } catch (err) {
      port.postMessage({
        id: job.id, ok: false, error: err instanceof Error ? err.message : String(err),
      } satisfies WorkerResult)
    }
  })
}
