import {
  type FlightDeckMode,
  machineViewsFromWire,
  reposToViews,
} from '@podium/client-core/values'
import { cachedKey } from '@podium/client-graph/cached'
import { missionView, readMissionHandoff, readMissionView } from '@podium/client-graph/mission-view'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'

/** The deck's catalog answers, cached apart from the mission: a click that
 * changes the selection reads them by address instead of re-grouping every
 * repo scan and machine (review finding 2). */
const NO_HOSTS: ReturnType<typeof machineViewsFromWire> = []
function deckCatalog(pool: MobxPool) {
  return pool.sources.view('missionPaneCatalog', () => {
    const repoViews = cachedKey('MissionPane', 'repos', () => {
      const scans = pool.headerViews.ids('repository').flatMap((id) => {
        const scan = pool.headerViews.row('repository', id)
        return scan ? [scan] : []
      })
      // The first view at a path, as the whole-list find answered.
      const byPath = new Map<string, ReturnType<typeof reposToViews>[number]>()
      for (const repo of reposToViews(scans))
        if (!byPath.has(repo.path)) byPath.set(repo.path, repo)
      return byPath
    })
    const machineViews = cachedKey('MissionPane', 'machines', () =>
      machineViewsFromWire(pool.headerViews.machines()),
    )
    /** Keyed by `[machineId, repoPath]`: the hosts a mission root can run on. */
    const hosts = cachedKey('MissionPane', 'hosts', (key) => {
      const [machineId, repoPath] = JSON.parse(key) as [string | null, string | null]
      const machines = machineViews('')
      if (machines.length === 0) return NO_HOSTS
      if (machineId) return machines.filter((view) => view.machine.id === machineId)
      const repo = repoPath === null ? undefined : repoViews('').get(repoPath)
      return machines.filter((view) =>
        repo?.machines.some((machine) => machine.machineId === view.machine.id),
      )
    })
    return { hosts }
  })
}

/** The pane's actual projection, shared with the structural work harness. */
export function readMissionPane(
  pool: MobxPool,
  input: {
    selectedIssueId: string | null
    paneA: string | null
    paneB: string | null
    split: boolean
    mode: FlightDeckMode
    handoff: boolean
  },
) {
  const reader = missionView(pool)
  const mission = readMissionView(reader, input.selectedIssueId, input.mode)
  let pending = mission === LOADING
  for (const id of new Set([
    input.paneA,
    input.split ? input.paneB : null,
  ])) {
    if (id && reader.session(id) === LOADING) pending = true
  }
  if (pending || mission === LOADING) return LOADING
  const handoff =
    input.handoff && mission.root ? readMissionHandoff(reader, mission.root.id) : undefined
  if (handoff === LOADING) return LOADING
  const hosts = deckCatalog(pool).hosts(
    JSON.stringify([mission.root?.machineId || null, mission.root?.repoPath ?? null]),
  )
  return { mission, handoff, hosts }
}
