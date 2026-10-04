import { useStoreHandle } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { shallowEqual } from '@podium/client-core/store'
import type { FlightDeckMode } from '@podium/client-core/viewmodels'
import { LOADING, type MobxPool } from '@podium/client-graph'
import { missions } from '@podium/client-graph/mission'
import { missionView, readMissionActionInputs } from '@podium/client-graph/mission-view'
import { compareStructural, computed, observer } from '@podium/client-graph/react'
import { type ComponentProps, type JSX, type ReactNode, useCallback, useMemo } from 'react'
import { IssueContextMenu } from '@/features/issues/IssueContextMenu'
import {
  FlightDeckContent,
  type FlightDeckPreferences,
  type FlightDeckProps,
  type FlightDeckSource,
  SettlingDeck,
} from './FlightDeck'
import { measurePoolMission } from './mission-pane-perf'
import { readMissionPane } from './mission-pane-reader'
import { useStoreSelector } from './store'
import { useWorklistPool, useWorklistPoolProjection } from './store-worklist-pool'

type PaneValues = Exclude<ReturnType<typeof readMissionPane>, typeof LOADING>

/** The same pool and mutation owner as the sidebar. This module loads only
 * for the mission pane and reads only pool entity values. */
export default observer(function PoolFlightDeck(
  props: FlightDeckProps & { preferences: FlightDeckPreferences },
): JSX.Element {
  const { selectedIssueId, paneA, paneB, split } = useStoreSelector(
    (store) => ({
      selectedIssueId: store.selectedIssueId,
      paneA: store.paneA,
      paneB: store.paneB,
      split: store.split,
    }),
    shallowEqual,
  )
  const pool = useWorklistPool()
  const owner = useStoreHandle()
  const { mode, view } = props.preferences
  const read = useCallback(
    (pool: MobxPool): PaneValues | typeof LOADING =>
      measurePoolMission(owner, () =>
        readMissionPane(pool, {
          selectedIssueId,
          paneA,
          paneB,
          split,
          mode,
          handoff: view === 'handoff',
        }),
      ),
    [owner, selectedIssueId, paneA, paneB, split, mode, view],
  )
  // Observe the projection from its first read, retaining rows across pane
  // selection. Equal catalog publications must not redraw the whole roster.
  const values = useMemo(
    () => computed(() => (pool ? read(pool) : LOADING), { equals: compareStructural }),
    [pool, read],
  ).get()
  const source = useMemo<FlightDeckSource | null>(() => {
    if (!pool || values === LOADING) return null
    const reader = missionView(pool)
    return {
      mission: values.mission,
      handoff: values.handoff,
      agentHosts: values.hosts,
      IssueMenu: PoolIssueContextMenu,
      ArchivedSessions: PoolArchivedSessions,
      issues: [...values.mission.byId.values()].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      ),
      allWorktreePaths: [],
      issue: (id) => {
        const issue = reader.issue(id)
        return issue === LOADING ? undefined : issue
      },
      session: (id) => {
        const session = reader.session(id)
        return session === LOADING ? undefined : session
      },
      rootFor: (id) => {
        const root = missions(pool).rootFor(id)
        return root === LOADING ? null : (root ?? id)
      },
      attached: (id) => {
        const sessions = reader.attached(id)
        return sessions === LOADING ? [] : sessions
      },
    }
  }, [pool, values])
  return source ? <FlightDeckContent {...props} source={source} /> : <SettlingDeck />
})

/** The archived list is read only while its section is open: the pane carries
 * its count, so archived rows never re-derive the deck (review finding 2). */
function PoolArchivedSessions(props: {
  rootId: string
  mode: FlightDeckMode
  children: (sessions: readonly SessionView[]) => ReactNode
}) {
  const owner = useStoreHandle()
  const { rootId, mode } = props
  const read = useCallback(
    (pool: MobxPool) => measurePoolMission(owner, () => missionView(pool).archive(rootId, mode)),
    [owner, rootId, mode],
  )
  const sessions = useWorklistPoolProjection(read, LOADING)
  return sessions === LOADING ? null : props.children(sessions)
}

function PoolIssueContextMenu(props: Omit<ComponentProps<typeof IssueContextMenu>, 'poolInputs'>) {
  const owner = useStoreHandle()
  const ids = props.issues.map((issue) => issue.id).join('\n')
  const read = useCallback(
    (pool: MobxPool) =>
      measurePoolMission(owner, () => readMissionActionInputs(missionView(pool), ids.split('\n'))),
    [owner, ids],
  )
  const values = useWorklistPoolProjection(read, LOADING)
  return values === LOADING ? null : (
    <IssueContextMenu
      {...props}
      issues={values.issues}
      allIssues={values.allIssues}
      poolInputs={values}
    />
  )
}
