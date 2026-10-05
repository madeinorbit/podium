import { useStoreHandle } from '@podium/client-core/react'
import { LOADING, type MobxPool } from '@podium/client-graph'
import { missionView, readMissionActionInputs } from '@podium/client-graph/mission-view'
import type { SessionId } from '@podium/model/browser'
import { useCallback } from 'react'
import { measurePoolMission } from '@/app/mission-pane-perf'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { SessionContextMenu, type SessionContextMenuProps } from './SessionContextMenu'
import { useFeature } from './use-feature'

export type PoolSessionContextMenuProps = Omit<
  SessionContextMenuProps,
  'session' | 'poolInputs'
> & {
  sessionId: SessionId
}

/** Mounted only when a menu opens. Read its own session; handoff additionally
 * needs the attached issue's worktree and the machine/repository choices. */
export function PoolSessionContextMenu({ sessionId, ...props }: PoolSessionContextMenuProps) {
  const owner = useStoreHandle()
  const handoffEnabled = useFeature('session-handoff')
  const read = useCallback(
    (pool: MobxPool) =>
      measurePoolMission(owner, () => readMissionActionInputs(missionView(pool), [], sessionId, handoffEnabled)),
    [owner, sessionId, handoffEnabled],
  )
  const values = useWorklistPoolProjection(read, LOADING)
  return values === LOADING || !values.session ? null : (
    <SessionContextMenu {...props} session={values.session} poolInputs={values} />
  )
}
