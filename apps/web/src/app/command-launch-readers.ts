import {
  commandLaunchViews,
} from '@podium/client-graph/command-launch-views'
import type { MobxPool } from '@podium/client-graph/pool'
import { launchOptionViews } from '@podium/client-graph/launch-option-views'
import type { RepoView } from '@podium/client-core/values'
import { agentCapabilityRejectionForSelection, onlineMachinesForRepoOrClone, type MachineWire } from '@podium/model/browser'
import { LOADING } from '@podium/client-graph/worklist/rollup'

// Shared with the structural work harness: measure the app's actual consumers.
export const readLaunch = (pool: MobxPool) => commandLaunchViews(pool).launch()
export const readLaunchOrigin = (pool: MobxPool, path: string) => launchOptionViews(pool).origin(path)
export function readTargetMachines(pool: MobxPool, repo: RepoView, machines: MachineWire[], kinds: readonly string[]) {
  return Object.fromEntries(kinds.map(kind => {
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
