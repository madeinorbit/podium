import type { MobxPool } from '@podium/client-graph/pool'
import { commandLaunchViews, type CommandLaunchData } from '@podium/client-graph/command-launch-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'

// Shared with the structural work harness: measure the app's actual consumers.
export const readLaunch = (pool: MobxPool) => commandLaunchViews(pool).launch()
export const readPalette = (pool: MobxPool) => commandLaunchViews(pool).palette()
const EMPTY_SESSIONS: CommandLaunchData['sessions'] = []
export const readGuardSessions = (pool: MobxPool) => {
  const sessions = commandLaunchViews(pool).sessions()
  return sessions && sessions !== LOADING ? sessions : EMPTY_SESSIONS
}
export const readOpen = (pool: MobxPool) => {
  const value = commandLaunchViews(pool).window('paletteOpen')
  return value !== LOADING ? value ?? false : false
}
const EMPTY_FILES: import('@podium/client-core/engine').Store['recentFiles'] = []
export const readFiles = (pool: MobxPool) => {
  const value = commandLaunchViews(pool).window('recentFiles')
  return value && value !== LOADING ? value : EMPTY_FILES
}
