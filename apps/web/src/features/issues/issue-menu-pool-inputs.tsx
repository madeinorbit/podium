import type { SessionView } from '@podium/client-core/session-values'
import type { IssueNavigationModel } from '@podium/client-core/viewmodels'
import { LOADING, type MobxPool } from '@podium/client-graph'
import type { MissionActionInputs } from '@podium/client-graph/mission-view'
import { type ComponentProps, lazy, Suspense, useCallback } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { throughRestarts } from '@/lib/chunk-recovery'

const IssueContextMenu = lazy(() =>
  throughRestarts(() => import('./IssueContextMenu')).then((module) => ({
    default: module.IssueContextMenu,
  })),
)

export type IssueMenuPoolInputs = Pick<MissionActionInputs, 'sessions' | 'repos' | 'machines'>

/** Menus need only the selected members for handoff and close concerns.
 * Missing cold payloads wait for the existing pool's batch. */
export function readIssueMenuPoolInputs(
  pool: MobxPool,
  issues: readonly Pick<IssueNavigationModel, 'memberSessionIds'>[],
): IssueMenuPoolInputs | typeof LOADING {
  const sessions: SessionView[] = []
  let pending = false
  for (const id of new Set(issues.flatMap((issue) => issue.memberSessionIds ?? []))) {
    const row = pool.row('session', id) as SessionView | typeof LOADING | undefined
    if (row === LOADING) pending = true
    else if (row) sessions.push(row)
  }
  if (pending) return LOADING
  const repos = pool.headerViews.ids('repository').flatMap((id) => {
    const repo = pool.headerViews.row('repository', id)
    return repo ? [repo] : []
  })
  return { sessions, repos, machines: pool.headerViews.machines() }
}

/** Mounted on menu open; the content never borrows store reader inputs. */
export function PoolIssueContextMenu(
  props: Omit<ComponentProps<typeof IssueContextMenu>, 'poolInputs'>,
) {
  const read = useCallback(
    (pool: MobxPool) => readIssueMenuPoolInputs(pool, props.issues),
    [props.issues],
  )
  const inputs = useWorklistPoolProjection(read, LOADING)
  return inputs === LOADING ? null : (
    <Suspense fallback={null}>
      <IssueContextMenu {...props} poolInputs={inputs} />
    </Suspense>
  )
}
