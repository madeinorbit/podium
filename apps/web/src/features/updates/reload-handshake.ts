import {
  type ReloadHandshakeResult,
  type ReloadHandshakeDeps as SharedReloadHandshakeDeps,
  startReloadHandshake as startSharedReloadHandshake,
} from '@podium/client-core/service-worker'
import { reloadLog } from '@/lib/logging/update-logs'

/**
 * The desktop shell's reload handshake: the shared one (the phone website swaps
 * its worker through the same function, POD-7179), writing to `web:reload`.
 */
export type ReloadHandshakeDeps = Omit<SharedReloadHandshakeDeps, 'log'>

export {
  notReloadedStatus,
  RELOAD_HANDSHAKE_BUDGET_MS,
  type ReloadHandshakeOutcome,
  type ReloadHandshakePhase,
  type ReloadHandshakeResult,
  type ReloadHandshakeStatus,
  type ReloadPath,
  type ReloadTrigger,
  type ServiceWorkerSnapshot,
} from '@podium/client-core/service-worker'

export function startReloadHandshake(deps: ReloadHandshakeDeps): Promise<ReloadHandshakeResult> {
  return startSharedReloadHandshake({ ...deps, log: reloadLog })
}
