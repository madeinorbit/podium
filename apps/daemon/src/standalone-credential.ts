import { loadSupervisorState, SUPERVISOR_MACHINE_ID_ENV } from '@podium/runtime/machine-supervisor'
import { loadIdentity } from './identity'

/**
 * Why an UNSUPERVISED daemon entry (scripts/daemon.ts) cannot authenticate, or
 * `undefined` when it has something to present or something to wait for (POD-4626).
 *
 * The split daemon used to authenticate with the local shared secret; POD-4150
 * (6fd4f7221) removed that on purpose; the secret is maintenance-only now. A daemon
 * holds a credential only after setup has enrolled this state dir's machine key. Without
 * that, `credential()` returns nothing and the reconnect loop retried
 * `daemon has no machine credential` forever. Nothing in that loop can mint a
 * credential, so the entry point stops at startup and names the missing step.
 *
 * This check must accept at least everything `credential()` in connection-state.ts
 * would present. A pending setup request also counts, because the server confirms it
 * on boot or from the setup page and `credential()` re-reads the state dir on each dial.
 * A parent-supervised daemon is never refused: its parent owns enrollment, which may
 * happen after this process starts.
 */
export function standaloneCredentialGap(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.PODIUM_UNDER_PARENT === '1' || env[SUPERVISOR_MACHINE_ID_ENV] !== undefined)
    return undefined
  const supervisor = loadSupervisorState(dir)
  if (supervisor.enrolledPublicKey || supervisor.setupEnrollment || supervisor.token)
    return undefined
  if (loadIdentity({ dir }).token) return undefined
  return (
    `podium daemon: the state dir ${dir} has no machine credential and no pending setup, ` +
    'so this daemon cannot authenticate. The split daemon no longer uses the local shared secret. ' +
    'First complete setup for this state dir: run the server and finish the setup page, ' +
    "which enrolls this host's machine key, and restart the server if it asks. " +
    'Then start the daemon again.'
  )
}
