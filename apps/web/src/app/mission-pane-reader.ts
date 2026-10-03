import {
  type FlightDeckMode,
  machineViewsFromWire,
  reposToViews,
} from '@podium/client-core/viewmodels'
import { missionView, readMissionHandoff, readMissionView } from '@podium/client-graph/mission-view'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'

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
  if (mission === LOADING) return LOADING
  for (const id of new Set([
    input.paneA,
    input.split ? input.paneB : null,
    ...mission.rows.map((row) => row.issue.startedBySession),
  ])) {
    if (id && reader.session(id) === LOADING) return LOADING
  }
  const handoff =
    input.handoff && mission.root ? readMissionHandoff(reader, mission.root.id) : undefined
  if (handoff === LOADING) return LOADING
  const machines = machineViewsFromWire(pool.headerViews.machines())
  const scans = pool.headerViews.ids('repository').flatMap((id) => {
    const scan = pool.headerViews.row('repository', id)
    return scan ? [scan] : []
  })
  const repo = reposToViews(scans).find((repo) => repo.path === mission.root?.repoPath)
  const hosts = mission.root?.machineId
    ? machines.filter((view) => view.machine.id === mission.root!.machineId)
    : machines.filter((view) =>
        repo?.machines.some((machine) => machine.machineId === view.machine.id),
      )
  return { mission, handoff, hosts }
}
