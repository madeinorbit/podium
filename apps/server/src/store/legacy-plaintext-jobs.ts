// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
/**
 * THE LONG FILE WORK OF DESTROYING THE OLD PLAINTEXT KEYS, OFF THE BOOT THREAD
 * (POD-7252).
 *
 * The dev.38 update stalled nine minutes in one synchronous call: the boot
 * compacted a 3.6 GB database and scrubbed every retained snapshot with the
 * event loop held, so it sent its supervisor no progress, the handover's stall
 * window ran out, and the update was given up while the server was still
 * working. Two jobs now run here, on a worker thread with their own connection:
 *
 *  - `vacuum`: the live file's `VACUUM`, at boot, while nothing else writes.
 *    The boot thread awaits it and reports a fresh progress step every
 *    {@link HEARTBEAT_MS} ({@link withProgressHeartbeat}), each with a name of its
 *    own: the supervisor counts only steps it has not seen.
 *  - `scrub`: the retained snapshots, after the server is up
 *    (`legacy-snapshot-scrub.ts`).
 *
 * A small file runs in this thread instead: starting a worker costs more than
 * its whole job.
 *
 * The worker imports this module, so it stays free of what a worker started
 * from a test runner cannot resolve: the lifecycle channel is the caller's.
 */

import { Worker } from 'node:worker_threads'
import { openDatabase } from '@podium/runtime/sqlite'
import {
  type SnapshotFailure,
  type SnapshotScrubResult,
  type SnapshotStamp,
  scrubLegacySnapshots,
} from '../migrations/legacy-snapshot-scrub'
import { legacyPlaintextWorkerTarget } from './legacy-plaintext-worker-embed'

/** One job, as it crosses to the worker (structured-clone data only). */
export type LegacyPlaintextJob =
  | { kind: 'vacuum'; dbPath: string }
  | {
      kind: 'scrub'
      dbPath: string
      knownValues: readonly string[]
      done: readonly SnapshotStamp[]
      failures: readonly SnapshotFailure[]
      cleanSinceMs?: number
    }

export type LegacyPlaintextJobResult =
  | { kind: 'vacuum' }
  | { kind: 'scrub'; results: SnapshotScrubResult[] }

/** Runs a job to its end; the default puts a large file on a worker thread. */
export type LegacyPlaintextJobRunner = (
  job: LegacyPlaintextJob,
  /** The largest file the job reads, to choose a thread by. */
  bytes: number,
  /** Aborted when the store closes: a worker is ended, a result dropped. */
  signal?: AbortSignal,
) => Promise<LegacyPlaintextJobResult>

/** Below this a job runs in the calling thread: a second or less of work. */
export const IN_THREAD_BELOW_BYTES = 32 * 1024 * 1024

/** How often a long boot step tells the supervisor it is still moving. */
export const HEARTBEAT_MS = 15_000

/** The job itself, synchronous: in the worker, or in the caller for a small file. */
export function executeLegacyPlaintextJob(job: LegacyPlaintextJob): LegacyPlaintextJobResult {
  if (job.kind === 'vacuum') {
    const db = openDatabase(job.dbPath)
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('PRAGMA secure_delete = ON')
      db.exec('VACUUM')
      // In WAL mode the compacted file is written back through the WAL, as large
      // as the file. Folding it in here keeps that copy off the boot thread; the
      // caller's truncate (`finishCompaction`) then has little left to do. Best
      // effort: a reader keeping it busy is the caller's to wait out.
      db.exec('PRAGMA busy_timeout = 0')
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    } finally {
      db.close()
    }
    return { kind: 'vacuum' }
  }
  return {
    kind: 'scrub',
    results: scrubLegacySnapshots(job.dbPath, {
      knownValues: job.knownValues,
      done: job.done,
      failures: job.failures,
      ...(job.cleanSinceMs === undefined ? {} : { cleanSinceMs: job.cleanSinceMs }),
    }),
  }
}

/**
 * Run `job` on its own worker thread; resolves with its result, rejects with its
 * error. The thread does not keep the process alive. Aborting ends it: a thread
 * inside a synchronous SQLite call ends when the call returns or the process
 * exits, and either way a scrub leaves its snapshot whole (the copy is renamed
 * over it, or removed at the next start) and a `VACUUM` its database.
 */
export function runLegacyPlaintextJobInWorker(
  job: LegacyPlaintextJob,
  signal?: AbortSignal,
): Promise<LegacyPlaintextJobResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('the store closed'))
      return
    }
    const worker = new Worker(legacyPlaintextWorkerTarget())
    worker.unref()
    let settled = false
    const onAbort = (): void => settle(() => reject(new Error('the store closed')))
    signal?.addEventListener('abort', onAbort, { once: true })
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      finish()
      void worker.terminate()
    }
    worker.once(
      'message',
      (message: { ok: true; result: LegacyPlaintextJobResult } | { ok: false; error: string }) =>
        settle(() => (message.ok ? resolve(message.result) : reject(new Error(message.error)))),
    )
    worker.once('error', (error) => settle(() => reject(error)))
    worker.once('exit', (code) =>
      settle(() =>
        reject(new Error(`the old-plaintext worker exited (code ${code}) with no result`)),
      ),
    )
    worker.postMessage(job)
  })
}

/** The default runner: a worker thread for a large file, this thread for a small one. */
export function defaultLegacyPlaintextJobRunner(
  inThreadBelowBytes: number = IN_THREAD_BELOW_BYTES,
): LegacyPlaintextJobRunner {
  return async (job, bytes, signal) =>
    bytes < inThreadBelowBytes
      ? executeLegacyPlaintextJob(job)
      : await runLegacyPlaintextJobInWorker(job, signal)
}

/**
 * Report `stage` to the supervisor, then a further step every `everyMs` while
 * `run` is pending (`<stage>, 15 s`, `<stage>, 30 s`, …). Each name is new, so
 * each restarts the handover's stall window and stretches systemd's start
 * limit; a child that crashes and starts again repeats the same names, which
 * the supervisor does not count twice.
 */
export async function withProgressHeartbeat<T>(
  stage: string,
  run: () => Promise<T>,
  report: (stage: string) => void,
  everyMs: number = HEARTBEAT_MS,
): Promise<T> {
  report(stage)
  let beats = 0
  const timer = setInterval(() => {
    beats += 1
    report(`${stage}, ${(beats * everyMs) / 1000} s`)
  }, everyMs)
  try {
    return await run()
  } finally {
    clearInterval(timer)
  }
}
