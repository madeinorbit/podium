import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import type { readWorkspaceMission } from '@podium/client-graph/mission-view'
import { useCallback, useEffect, useState } from 'react'
import { useStoreSelector } from './store'
import { useWorklistPoolProjection } from './store-worklist-pool'

type Readers = typeof import('@podium/client-graph/mission-view') & {
  LOADING: typeof import('@podium/client-graph')['LOADING']
}
let readerImport: Promise<Readers> | undefined
function useMissionReaders() {
  const [readers, setReaders] = useState<Readers | null>(null)
  useEffect(() => {
    let alive = true
    readerImport ??= Promise.all([
      import('@podium/client-graph/mission-view'),
      import('@podium/client-graph'),
    ]).then(([view, { LOADING }]) => ({ ...view, LOADING }))
    void readerImport.then((readers) => {
      if (alive) setReaders(readers)
    })
    return () => {
      alive = false
    }
  }, [])
  return readers
}
type WorkspaceMission = Exclude<ReturnType<typeof readWorkspaceMission>, symbol>
const EMPTY_WORKSPACE_MISSION: WorkspaceMission = {
  missionRoot: undefined,
  missionIds: new Set(),
  missionIssues: [],
  issue: undefined,
  missionOnScreen: undefined,
  hasAnyTask: false,
  loading: true,
}
export function useWorkspaceMission(
  selectedId: string | null,
  focusedId: string | null,
  _sessions: readonly SessionView[],
) {
  const readers = useMissionReaders()
  const read = useCallback(
    (pool: MobxPool): WorkspaceMission => {
      if (!readers) return EMPTY_WORKSPACE_MISSION
      const values = readers.readWorkspaceMission(readers.missionView(pool), selectedId, focusedId)
      return values === readers.LOADING ? EMPTY_WORKSPACE_MISSION : values
    },
    [readers, selectedId, focusedId],
  )
  return useWorklistPoolProjection(read, EMPTY_WORKSPACE_MISSION)
}

const EMPTY_FOLDED = {
  root: undefined as WorkspaceMission['missionRoot'],
  progress: { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 },
  live: 0,
  working: 0,
  needs: 0,
}
export function usePoolMissionFolded() {
  const selectedId = useStoreSelector((store) => store.selectedIssueId)
  const readers = useMissionReaders()
  const read = useCallback(
    (pool: MobxPool) => {
      if (!readers) return EMPTY_FOLDED
      const values = readers.readMissionView(readers.missionView(pool), selectedId)
      if (values === readers.LOADING) return EMPTY_FOLDED
      return {
        root: values.root,
        progress: values.progress,
        live: values.rows[0]?.liveAgentCount ?? 0,
        working: values.rows[0]?.workingAgentCount ?? 0,
        needs: values.rows[0]?.actionableCount ?? 0,
      }
    },
    [readers, selectedId],
  )
  return useWorklistPoolProjection(read, EMPTY_FOLDED)
}
