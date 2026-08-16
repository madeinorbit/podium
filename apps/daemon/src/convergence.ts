import type { PendingGrant } from './pending-grant'

export const MAX_CONVERGENCE_ATTEMPTS = 2

/**
 * THE REFUSAL A FOREGROUND ALL-IN-ONE OWES ITS OPERATOR (POD-2210).
 *
 * Every convergence in this system ends the same way: the daemon exits and
 * something starts it again. An INSTALLED all-in-one is safe because it is not
 * one process — systemd resolves it into server, janitor and daemon units, each
 * `Restart=always`, so the daemon's exit restarts the daemon alone and the
 * coordinating server is never touched (the shipped update unit `try-restart`s
 * that unit specifically). The desktop sidecar is safe for the same reason with
 * a different manager: the shell respawns the child it supervises.
 *
 * `podium all` — and a bare `podium` on a box with no persistence — is neither.
 * There the server and the daemon are ONE process, so the daemon's exit is the
 * server's exit, and nothing exists to start it again. Converging would take
 * down the server the operator is watching, from the browser it is serving, and
 * it would not come back.
 *
 * SO THE DAEMON DECLINES, IN THE FIRST PERSON, BEFORE ANYTHING IS FETCHED OR
 * MOVED. Not after: git delivery detaches the checkout the running server is
 * reading from — its web assets, its migrations, the `scripts/cli.ts` it spawns
 * lifecycle workers from — so a convergence that stops short of the restart
 * would leave a live old process reading new source. Nothing changed is the only
 * honest half-way state.
 *
 * AND NOT BY SELF-RESTARTING INSTEAD. A source checkout moved to a new commit
 * may not boot without an install or a build; that is precisely the gate the
 * redeploy unit runs before it restarts anything, and a foreground process has
 * nowhere to run it and nobody to catch it if the new code fails to start. A
 * re-exec would trade a server that always dies for one that sometimes dies —
 * and orphan the operator's terminal job on the way.
 *
 * The refusal is spelled like every other one the panel reads: a leading
 * `cannot converge:` and a stable token (`foreground-all-in-one`) the web copy
 * matches on, followed by the sentence itself.
 */
export const FOREGROUND_ALL_IN_ONE_REFUSAL =
  'cannot converge: foreground-all-in-one — this daemon shares its process with the ' +
  'Podium server and nothing would start that process again, so updating it here would ' +
  'stop the server and it would not come back'

export interface ProcessShape {
  /**
   * Does this daemon's exit also stop the coordinating server? Answered by the
   * composition root, which is the only place that knows which roles this PID
   * took (`apps/cli` — `daemonOptionsForPlan`).
   */
  exitStopsServer?: boolean
  env: NodeJS.ProcessEnv
}

/**
 * Will something start this process again if it exits?
 *
 * `INVOCATION_ID` is the same signal the SERVER uses to decide it may restart
 * itself (`apps/server/src/modules/updates/source-redeploy.ts` returns no
 * restart capability without it), and asking the same question two different
 * ways about the same process is how the two answers drift apart.
 * `PODIUM_DESKTOP_SUPERVISED` is the shell's, matching every other reader of
 * that flag.
 */
function restartedByAManager(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.INVOCATION_ID) || env.PODIUM_DESKTOP_SUPERVISED === '1'
}

/**
 * Why this daemon must not converge at all, or `undefined` when it may.
 *
 * Deliberately a sentence rather than a boolean: a refusal that reaches the
 * operator as "one or more machines cannot use this update" is a refusal nobody
 * can act on, and §6.2/§7 of the update spec require a failure to name itself.
 */
export function refuseConvergence(shape: ProcessShape): string | undefined {
  if (!shape.exitStopsServer) return undefined
  if (restartedByAManager(shape.env)) return undefined
  return FOREGROUND_ALL_IN_ONE_REFUSAL
}

/**
 * Should the daemon's `restartAfterUpdate` seam — whose default is
 * `process.exit(0)` — be replaced by one that refuses to exit?
 *
 * The grant path never reaches it (the refusal above lands first), so this is
 * about the OTHER caller and any future one: the protocol-mismatch self-update
 * in `connection-state`, whose restart is the same fatal exit in the same shape.
 * Disarming the seam makes "this process must not stop itself to finish an
 * update" a property of the process rather than of one code path.
 *
 * `provided` wins outright: an embedder or test that passed its own restart has
 * said what happens instead of an exit, and second-guessing it would break every
 * harness that drives a co-hosted daemon.
 */
export function disarmExitSeam(input: { provided?: () => void; shape: ProcessShape }): boolean {
  if (input.provided !== undefined) return false
  return refuseConvergence(input.shape) !== undefined
}

export type BootVerdict =
  | { action: 'confirm'; state: 'current' }
  | { action: 'retry'; attempts: number }
  | { action: 'rollback'; state: 'rejected' | 'stuck'; detail: string }

export function resolveOnBoot(ctx: {
  pending: PendingGrant | null
  runningVersion: string
}): BootVerdict | null {
  const { pending, runningVersion } = ctx
  if (!pending) return null

  // The bound limits failures, not successes: a daemon that arrived on its last
  // permitted attempt is current.
  if (runningVersion === pending.targetVersion) return { action: 'confirm', state: 'current' }

  if (pending.attempts < MAX_CONVERGENCE_ATTEMPTS) {
    return { action: 'retry', attempts: pending.attempts + 1 }
  }

  return {
    action: 'rollback',
    state: 'stuck',
    detail:
      `did not reach ${pending.targetVersion} after ${pending.attempts} attempt(s); ` +
      `running ${runningVersion}, pinned to last-known-good`,
  }
}
