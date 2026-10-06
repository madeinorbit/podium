import type { IssueNavigationModel } from '@podium/client-core/values'
import { LOADING, type MobxPool } from '@podium/client-graph'
import { type MissionActionInputs, missionView, readMissionActionInputs } from '@podium/client-graph/mission-view'
import { type ComponentProps, lazy, Suspense, useCallback } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { throughRestarts } from '@/lib/chunk-recovery'
import { useFeature } from '@/lib/use-feature'

const IssueContextMenu = lazy(() =>
  throughRestarts(() => import('./IssueContextMenu')).then((module) => ({
    default: module.IssueContextMenu,
  })),
)

export type IssueMenuPoolInputs = Pick<MissionActionInputs, 'sessions' | 'repos' | 'machines' | 'handoff'>

/** Share the addressed menu computeds: counts and one handoff sender, plus
 * its source lane. Destination payloads belong to the opened target list. */
export function readIssueMenuPoolInputs(
  pool: MobxPool,
  issues: readonly Pick<IssueNavigationModel, 'id'>[],
  handoffEnabled = true,
): IssueMenuPoolInputs | typeof LOADING {
  return readMissionActionInputs(missionView(pool), issues.map(issue => issue.id), undefined, handoffEnabled)
}

/** Mounted on menu open; the content never borrows store reader inputs. */
export function PoolIssueContextMenu(
  props: Omit<ComponentProps<typeof IssueContextMenu>, 'poolInputs'>,
) {
  const handoffEnabled = useFeature('session-handoff')
  const read = useCallback(
    (pool: MobxPool) => readIssueMenuPoolInputs(pool, props.issues, handoffEnabled),
    [props.issues, handoffEnabled],
  )
  const inputs = useWorklistPoolProjection(read, LOADING)
  return inputs === LOADING ? null : (
    <Suspense fallback={null}>
      <IssueContextMenu {...props} poolInputs={inputs} />
    </Suspense>
  )
}
