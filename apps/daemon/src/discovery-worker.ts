// apps/daemon/src/discovery-worker.ts

import { parentPort } from 'node:worker_threads'
import { ConversationDiscoveryCache } from '@podium/agent-bridge'
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
  // The worker owns discovery.db exclusively. Hold ONE long-lived cache across all
  // `indexRefresh` ticks (opened lazily from the first job's cachePath) so the
  // every-15s scan reuses one SQLite connection instead of leaking one (and
  // re-running migrate()) per pass.
  let cache: ConversationDiscoveryCache | undefined
  const indexCache = (cachePath?: string): ConversationDiscoveryCache => {
    if (!cache) cache = new ConversationDiscoveryCache(cachePath)
    return cache
  }
  port.on('message', async (job: WorkerJob) => {
    try {
      let value: unknown
      if (job.kind === 'memoryBreakdown') value = runMemoryBreakdownJob(job.input)
      else if (job.kind === 'indexRefresh')
        value = await runIndexRefreshJob(job.input, indexCache(job.input.cachePath))
      else throw new Error(`unknown job kind: ${(job as { kind: string }).kind}`)
      port.postMessage({ id: job.id, ok: true, value } satisfies WorkerResult)
    } catch (err) {
      port.postMessage({
        id: job.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies WorkerResult)
    }
  })
}
