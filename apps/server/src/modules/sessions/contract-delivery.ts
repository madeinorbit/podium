import { loadConfig, type PodiumConfig } from '@podium/runtime/config'
import { driverFamilyForId } from '../../harness-manifest'
import type { Session } from './session'

/** Hot, server-local rollout switch. Re-read on admission; no restart required.
 * Ships off and is independent of runtime-drivers (which selects new spawns).
 * Unknown/missing driver ids must retain the contract path: no known PTY exists.
 */
export function contractDeliveryRequested(
  session: Pick<Session, 'runtimeContract' | 'driverId'>,
  config?: PodiumConfig,
): boolean {
  if (session.runtimeContract !== true) return false
  if (driverFamilyForId(session.driverId ?? '') !== 'terminal') return true
  return (config ?? loadConfig()).features?.['daemon-headed-delivery'] === true
}
