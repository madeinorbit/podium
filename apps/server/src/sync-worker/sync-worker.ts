import { parentPort, workerData } from 'node:worker_threads'
import { createLogger } from '@podium/logger'
import { produceBootstrap } from './producer'
import { SYNC_CHUNK_BYTES, SYNC_JOB_DEADLINE_MS, SYNC_WORKER_MAX_JOBS, SYNC_WORKER_QUEUE_DEPTH, SyncWorkerError, type BootstrapJob, type FromWorker, type ToWorker } from './types'

interface Work {
  job: BootstrapJob
  abort: AbortController
  credits: number
  wake?: () => void
  timer: ReturnType<typeof setTimeout>
  queuedAt: number
  active: boolean
}
if (parentPort) {
  const port = parentPort
  const dbPath = (workerData as { dbPath: string }).dbPath
  const jobs = new Map<string, Work>()
  const queue: Work[] = []
  let active = 0, stopped = false
  const log = createLogger('server:sync-worker')
  const send = (message: FromWorker, transfer: ArrayBuffer[] = []) => port.postMessage(message, transfer)
  const cancel = (work: Work, reason: SyncWorkerError) => {
    if (work.abort.signal.aborted) return
    work.abort.abort(reason)
    work.wake?.()
    if (!work.active) {
      const at = queue.indexOf(work)
      if (at >= 0) queue.splice(at, 1)
      finish(work, reason)
    }
  }
  const finish = (work: Work, error?: SyncWorkerError) => {
    if (!jobs.delete(work.job.transferId)) return
    clearTimeout(work.timer)
    if (work.active) active--
    send(error ? { type: 'error', transferId: work.job.transferId, reason: error.reason } : { type: 'end', transferId: work.job.transferId })
    pump()
    if (stopped && jobs.size === 0) port.close()
  }
  const credit = async (work: Work) => {
    while (!work.credits && !work.abort.signal.aborted) await new Promise<void>(resolve => { work.wake = resolve })
    work.wake = undefined
    if (work.abort.signal.aborted) throw work.abort.signal.reason
    work.credits--
  }
  const run = async (work: Work) => {
    let failure: SyncWorkerError | undefined
    const queueWaitMs = performance.now() - work.queuedAt
    log.info('bootstrap admitted', { transferId: work.job.transferId, queueWaitMs })
    try {
      for await (const bytes of produceBootstrap(dbPath, work.job, work.abort.signal, meta => send({ type: 'meta', transferId: work.job.transferId, meta }), metrics => send({ type: 'metrics', transferId: work.job.transferId, metrics: { ...metrics, queueWaitMs } }))) {
        for (let at = 0; at < bytes.byteLength; at += SYNC_CHUNK_BYTES) {
          await credit(work)
          // Copy just the bounded chunk; transferring a view's backing buffer could
          // detach the rest of the record, or transfer an oversized allocation.
          const chunk = bytes.slice(at, at + SYNC_CHUNK_BYTES).buffer as ArrayBuffer
          send({ type: 'bytes', transferId: work.job.transferId, chunk }, [chunk])
        }
      }
    } catch (error) { failure = error instanceof SyncWorkerError ? error : new SyncWorkerError('producer-failed') }
    finally { finish(work, failure) }
  }
  const pump = () => {
    while (!stopped && active < SYNC_WORKER_MAX_JOBS && queue.length) {
      const work = queue.shift()!
      work.active = true; active++
      void run(work)
    }
  }
  const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 1000)
  port.on('message', (message: ToWorker) => {
    if (message.type === 'stop') {
      stopped = true; clearInterval(heartbeat)
      for (const work of [...jobs.values()]) cancel(work, new SyncWorkerError('shutdown'))
      if (!jobs.size) port.close()
      return
    }
    if (message.type === 'start') {
      const job = { ...message.job, deadlineMs: message.job.deadlineMs ?? Date.now() + SYNC_JOB_DEADLINE_MS }
      if (stopped || jobs.has(job.transferId) || (active >= SYNC_WORKER_MAX_JOBS && queue.length >= SYNC_WORKER_QUEUE_DEPTH)) {
        send({ type: 'error', transferId: job.transferId, reason: stopped ? 'shutdown' : 'queue-full' }); return
      }
      const work: Work = { job, abort: new AbortController(), credits: 0, queuedAt: performance.now(), active: false,
        timer: setTimeout(() => cancel(work, new SyncWorkerError('deadline')), Math.max(0, job.deadlineMs - Date.now())) }
      jobs.set(job.transferId, work); queue.push(work); pump(); return
    }
    const work = jobs.get(message.transferId)
    if (!work) return
    if (message.type === 'cancel') cancel(work, new SyncWorkerError(message.reason ?? 'cancelled'))
    else if (Number.isSafeInteger(message.n) && message.n > 0) {
      // The main client has one pending pull; defensive cap keeps transfer memory bounded.
      work.credits = Math.min(work.credits + message.n, 1)
      work.wake?.()
    }
  })
  send({ type: 'ready' })
}
