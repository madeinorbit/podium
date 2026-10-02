import type { UiState } from '@podium/client-core/ui-state'
import { mobxPilotEnabled } from './mobx-pilot'

/** The shared device setting defaults OFF; frozen for this app load. */
let startup: 'legacy' | 'pool' | undefined
let check = false
export function initializeCommandLaunchDataLayer(ui: Pick<UiState, 'get'>): void {
  if (startup !== undefined) return
  let params: URLSearchParams | undefined
  try { params = new URLSearchParams(location.search) } catch { /* SSR */ }
  startup = mobxPilotEnabled(ui, params, 'mobxCommands') ? 'pool' : 'legacy'
  check = startup === 'pool' && params?.get('mobxCommandsCheck') === '1'
}
export function commandLaunchDataLayer(): 'legacy' | 'pool' { return startup ?? 'legacy' }
export function commandLaunchCheckRequested(): boolean { return check }

const owners = new WeakMap<object, { legacyReads: number }>()
let enabled = false
export const commandLaunchReadStats = {
  enable() { enabled = true },
  reset(owner: object) { owners.set(owner, { legacyReads: 0 }) },
  legacy(owner: object) { if (enabled) { const counts = owners.get(owner) ?? { legacyReads: 0 }; counts.legacyReads++; owners.set(owner, counts) } },
  read(owner: object) { return owners.get(owner) ?? { legacyReads: 0 } },
}

/** Startup declarations stay independent of component hooks and the web store.
 * The existing registry owns both late attachment and source disposal. */
export const commandLaunchScreen = {
  id: 'commands',
  initialize: initializeCommandLaunchDataLayer,
  enabled: () => commandLaunchDataLayer() === 'pool',
  options: () => ({ summaries: COMMAND_SUMMARIES }),
  async attach(runtime: ClientRuntime, pool: MobxPool) {
    const { attachCommandLaunchSource } = await import('@podium/client-graph/command-launch-source')
    const source = attachCommandLaunchSource(pool, runtime)
    let stopCheck: (() => void) | undefined
    if (commandLaunchCheckRequested()) {
      const { startCommandLaunchCheck } = await import('@podium/client-graph/diagnostics/command-launch-check')
      stopCheck = startCommandLaunchCheck(runtime, pool)
    }
    return () => { stopCheck?.(); source.dispose() }
  },
}
import type { ClientRuntime } from '@podium/client-core/engine'
import type { MobxPool } from '@podium/client-graph'
import { COMMAND_SUMMARIES } from '@podium/client-graph/command-launch-schema'
