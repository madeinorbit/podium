/**
 * Playwright globalTeardown: stop the live harness, then reap its isolated sessions.
 * The webServer can still own transcript-lake writes while globalTeardown runs, so
 * cleanup must wait for its shutdown acknowledgement before removing state.
 */
import { reapHarnessSessions, reapStaleHarnessDirs, stopHarnessProcess } from './harness-env'

export default async function globalTeardown(): Promise<void> {
  const port = Number(process.env.PORT ?? 8799)
  await stopHarnessProcess(port)
  try {
    reapHarnessSessions(port)
    // Sweep abandoned sibling-port dirs too (dead harness pid or long-stale dir);
    // a hard-killed ad-hoc run is otherwise never revisited — POD-107.
    reapStaleHarnessDirs()
  } catch (err) {
    // Cleanup is best-effort at the END of a run: a stale isolated temp dir is
    // self-healed at the next harness startup, while throwing here would mask
    // the product assertion that made this run fail in the first place.
    console.warn('[podium:e2e] harness cleanup did not fully settle:', err)
  }
}
