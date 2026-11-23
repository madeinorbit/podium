// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
/**
 * The thread that runs the old plaintext keys' long file work (POD-7252): the
 * live database's `VACUUM` and the retained snapshots' scrub. One job per
 * thread; the result is posted back and the thread ends. The boot thread stays
 * free meanwhile, so it can tell its supervisor the boot is still moving.
 */

import { parentPort } from 'node:worker_threads'
import { describeError } from '@podium/logger'
import { executeLegacyPlaintextJob, type LegacyPlaintextJob } from './legacy-plaintext-jobs'

parentPort?.once('message', (job: LegacyPlaintextJob) => {
  try {
    parentPort?.postMessage({ ok: true, result: executeLegacyPlaintextJob(job) })
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: describeError(error) })
  }
})
