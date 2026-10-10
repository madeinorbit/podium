import { omitGone } from '@podium/client-graph/lookup'
import type { commandLaunchViews } from '@podium/client-graph/command-launch-views'
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
  if (!view) omitGone(pool.row('commandWindow', 'window'))
  return view
}
export const readLaunchOptions = launchOptions
export const readLaunchOrigin = (pool: MobxPool, path: string) => launchOptions(pool)?.origin(path) ?? LOADING
export function readTargetMachines(pool: MobxPool, repo: RepoView | undefined, machines: MachineWire[], kinds: readonly string[], preferred?: Record<string, string | undefined>) {
  return Object.fromEntries(kinds.map(kind => {
    if (!repo) return [kind, undefined]
    const eligible = onlineMachinesForRepoOrClone(repo, machines)
      .filter(machine => agentCapabilityRejectionForSelection(machine, kind) === undefined)
    return [kind, preferred === undefined
      ? pool.queries.latestMachineSession(eligible.map(machine => machine.id))?.machineId ?? eligible[0]?.id
      : eligible.find(machine => machine.id === preferred[kind])?.id ?? eligible[0]?.id]
  }))
}
function commandViews(pool: MobxPool) {
  const view = pool.sources.peekView<ReturnType<typeof commandLaunchViews>>('commands')
  if (!view) omitGone(pool.row('commandWindow', 'window'))
  return view
}
export const readPalette = (pool: MobxPool) => {
  const view = commandViews(pool)
  return view ? view.palette() : LOADING
}
export const readSessions = (pool: MobxPool) => {
  const view = commandViews(pool)
  return view ? view.sessions() : LOADING
}
export const readSession = (pool: MobxPool, id: string) => {
  const view = commandViews(pool)
  return view ? view.session(id) : LOADING
}
export const readOpen = (pool: MobxPool) => {
  const window = omitGone(pool.row('commandWindow', 'window'))
  return window && window !== LOADING ? window.paletteOpen : false
}
export const EMPTY_FILES: import('@podium/client-core/engine').Store['recentFiles'] = []
export const readFiles = (pool: MobxPool) => {
  const window = omitGone(pool.row('commandWindow', 'window'))
  return window && window !== LOADING ? window.recentFiles : EMPTY_FILES
}
