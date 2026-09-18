import type { UpdateStatusMessage } from '@podium/protocol'
import { legacyUpdateStatus } from '@podium/runtime/legacy-daemon-update'
import { readMachineUpdateJournal } from '@podium/runtime/machine-update'
import { clearPendingGrant, readPendingGrant, writePendingGrant } from './pending-grant'
import { MAX_CONVERGENCE_ATTEMPTS, resolveOnBoot, shouldClearPendingGrantOnBoot } from './convergence'

/** Reconcile at authenticated hello, including the first boot after legacy takeover. */
export function reconcilePendingUpdate({ runtimeDir, appVersion, env, parentHasServer, send, log }: {
  runtimeDir: string
  appVersion: string | undefined
  env: NodeJS.ProcessEnv
  parentHasServer: boolean
  send(status: UpdateStatusMessage): void
  log(message: string, fields: Record<string, unknown>): void
}): string | undefined {
  if (env.PODIUM_MACHINE_UPDATE_OWNER === 'supervisor') {
    const update = readMachineUpdateJournal(runtimeDir)
    // A journal belongs to the supervisor, even when it names another target.
    // Only its absence permits adopting a grant executed by the old daemon.
    if (update) return update.grant.target.version === appVersion ? appVersion : undefined
  }
  if (parentHasServer) return
  const pending = readPendingGrant(runtimeDir)
  if (!pending) return

  const runningVersion = appVersion ?? 'dev'
  if (pending.legacyHealth && env.PODIUM_UNDER_PARENT !== '1') {
    // connected() is invoked only after the server's authenticated helloOk.
    // Keep the durable verdict for reconnect replay and same-target refusal.
    const status = legacyUpdateStatus(runtimeDir, runningVersion)
    if (status) send(status)
    return status?.state === 'current' ? pending.targetVersion : undefined
  }
  const verdict = resolveOnBoot({ pending, runningVersion })
  if (!verdict) return

  let state: 'current' | 'rejected' | 'stuck'
  let detail: string | undefined
  if (verdict.action === 'confirm') {
    state = 'current'
  } else if (verdict.action === 'rollback') {
    state = verdict.state
    detail = verdict.detail
  } else {
    // A RETRY verdict is not "manual convergence is required" — this boot
    // used one of the permitted attempts and another is still allowed. Report
    // it as a failure the operator can retry, and KEEP the marker with the
    // attempt spent, so the next grant is the last one the bound permits
    // instead of restarting the count at zero.
    state = 'rejected'
    detail =
      'attempt ' +
      verdict.attempts +
      ' of ' +
      MAX_CONVERGENCE_ATTEMPTS +
      ' did not reach ' +
      pending.targetVersion +
      ' (running ' +
      runningVersion +
      '); applying again will retry it'
  }

  /**
   * WHAT THIS BOOT CONCLUDED ABOUT THE GRANT IT WAS APPLYING (POD-3224, q13).
   *
   * This is the only place that can answer "did the restart land on the
   * version it was supposed to?", and it answers it from the machine's own
   * disk rather than from a socket — which matters because the report below is
   * dropped outright if the coordinator is still coming back up. Without this
   * line, a machine that rolled back or spent one of its convergence attempts
   * left the coordinator with silence and left itself with nothing.
   */
  log('boot reconciled a pending update grant', {
    grantId: pending.grantId,
    targetVersion: pending.targetVersion,
    previousVersion: pending.previousVersion,
    runningVersion,
    action: verdict.action,
    attempts: pending.attempts,
    reported: state,
    ...(detail ? { detail } : {}),
  })
  send({
    type: 'updateStatus',
    grantId: pending.grantId,
    targetVersion: pending.targetVersion,
    state,
    version: runningVersion,
    ...(verdict.action === 'confirm' ? { phaseDetail: 'current' } : {}),
    ...(detail ? { detail } : {}),
  })
  if (verdict.action === 'retry') {
    writePendingGrant(runtimeDir, { ...pending, attempts: verdict.attempts })
    return
  }
  if (shouldClearPendingGrantOnBoot({ verdict, parentHasServer })) {
    clearPendingGrant(runtimeDir)
  }
  return verdict.action === 'confirm' ? pending.targetVersion : undefined
}
