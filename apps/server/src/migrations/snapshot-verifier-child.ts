/**
 * Child-process entry for recovery-snapshot verification (POD-3068).
 *
 * Reached by re-invoking the podium entry with `PODIUM_VERIFY_SNAPSHOT` set to
 * the JSON request — see `runSnapshotVerifierChildIfRequested`, which both the
 * source and the compiled entry call before the CLI. A separate PROCESS rather
 * than a worker thread because `PRAGMA quick_check` is a synchronous native
 * call: `Worker.terminate()` cannot interrupt one that is mid-scan, so a stuck
 * verification would be unkillable on a thread. A process can be SIGKILLed.
 *
 * The contract is deliberately tiny: one JSON request in through the
 * environment, one JSON result out on stdout, exit 0 whatever the verdict.
 * A non-zero exit or unparsable stdout therefore means the CHILD failed, which
 * the parent records as `failed` rather than as a bad snapshot.
 */

import type { VerifySnapshotRequest } from './snapshot-verification'

/** Environment variable carrying the JSON {@link VerifySnapshotRequest}. */
export const SNAPSHOT_VERIFIER_ENV = 'PODIUM_VERIFY_SNAPSHOT'

/**
 * Run the verification and print its result when this process was launched as a
 * verifier; answer `false` when it was not, so the caller proceeds to the CLI.
 */
export async function runSnapshotVerifierChildIfRequested(
  env: Readonly<Record<string, string | undefined>> = process.env,
  write: (line: string) => void = (line) => {
    process.stdout.write(line)
  },
): Promise<boolean> {
  const raw = env[SNAPSHOT_VERIFIER_ENV]
  if (!raw) return false
  // Imported lazily so the ordinary CLI boot never pays for the SQLite verifier.
  const { verifySnapshotFile } = await import('./snapshot-verification')
  const request = JSON.parse(raw) as VerifySnapshotRequest
  write(`${JSON.stringify(verifySnapshotFile(request))}\n`)
  return true
}
