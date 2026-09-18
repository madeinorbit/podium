import { desiredParentUnit } from '@podium/runtime/topology-migration'
import type { ReconcileResult } from './topology-reconcile'

/** Describe the returned handover without observing or changing the host. */
export function reconcileSentences(result: ReconcileResult): string[] {
  const parent = desiredParentUnit(result.observation.instanceId)
  const actions: Record<string, string> = {
    'write-parent': `Wrote parent service ${parent}.`,
    'refresh-parent': `Refreshed parent service ${parent} and reloaded systemd.`,
    'enable-parent': `Enabled parent service ${parent} for boot.`,
    'mask-legacy': 'Runtime-masked legacy services until reboot.',
    'start-parent': `Started parent service ${parent}.`,
    'retire-legacy': 'Stopped and removed legacy service units after the parent became healthy.',
    'abort-keep-legacy': 'The parent health wait expired; restored legacy services and disabled the parent service.',
    'spawn-detached-parent': 'Started a detached parent process.',
    'reclaim-stale-roles': 'Reclaimed the stale janitor process.',
    'refuse-foreground': 'Left foreground supervision unchanged; it cannot restart this machine.',
  }
  const sentences = result.actions.flatMap((action) => actions[action] ? [actions[action]] : [])
  if (result.actions.at(-1) === 'await-healthy') {
    sentences.push(
      `Topology handover is unfinished: waiting for ${parent} to report healthy before retiring legacy services.`,
      `Run \`systemctl --user start ${parent}\` to start the parent if needed; the handover finishes after its health gate, or on the parent's next boot once healthy.`,
    )
  }
  if (result.problem) {
    if (result.problem.reason) sentences.push(`Problem: ${result.problem.reason}`)
    if (result.problem.remedy) sentences.push(`Remedy: ${result.problem.remedy}`)
  }
  sentences.push(`Armed if killed: ${result.armed}.`)
  return sentences
}
