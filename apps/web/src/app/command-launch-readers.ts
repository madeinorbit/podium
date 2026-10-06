import {
  commandLaunchViews,
} from '@podium/client-graph/command-launch-views'
import type { MobxPool } from '@podium/client-graph/pool'
import type { launchOptionViews } from '@podium/client-graph/launch-option-views'
import type { RepoView } from '@podium/client-core/values'
import { agentCapabilityRejectionForSelection, onlineMachinesForRepoOrClone, type MachineWire } from '@podium/model/browser'
import { LOADING } from '@podium/client-graph/worklist/rollup'

// Shared with the structural work harness: measure the app's actual consumers.
function launchOptions(pool: MobxPool) {
  const view = pool.sources.peekView<ReturnType<typeof launchOptionViews>>('launch.options')
  // The existing lazy command attachment installs the view before its source.
  // Observe that source while pending so its publication wakes this reader.
  if (!view) pool.row('commandWindow', 'window')
  return view
}
export const readLaunchOrigin = (pool: MobxPool, path: string) => launchOptions(pool)?.origin(path) ?? LOADING
export const readLaunchCatalog = (pool: MobxPool) => launchOptions(pool)?.catalog() ?? LOADING
export function readTargetMachines(pool: MobxPool, repo: RepoView | undefined, machines: MachineWire[], kinds: readonly string[]) {
  return Object.fromEntries(kinds.map(kind => {
    if (!repo) return [kind, undefined]
    const eligible = onlineMachinesForRepoOrClone(repo, machines)
      .filter(machine => agentCapabilityRejectionForSelection(machine, kind) === undefined)
    return [kind, pool.queries.latestMachineSession(eligible.map(machine => machine.id))?.machineId ?? eligible[0]?.id]
  }))
}
export const readPalette = (pool: MobxPool) => commandLaunchViews(pool).palette()
export const readSessions = (pool: MobxPool) => commandLaunchViews(pool).sessions()
export const readSession = (pool: MobxPool, id: string) => commandLaunchViews(pool).session(id)
export const readOpen = (pool: MobxPool) => {
  const value = commandLaunchViews(pool).window('paletteOpen')
  return value !== LOADING ? value ?? false : false
}
export const EMPTY_FILES: import('@podium/client-core/engine').Store['recentFiles'] = []
export const readFiles = (pool: MobxPool) => {
  const value = commandLaunchViews(pool).window('recentFiles')
  return value && value !== LOADING ? value : EMPTY_FILES
}
