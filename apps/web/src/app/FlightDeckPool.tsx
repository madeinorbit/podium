import { useClientRuntime, useUiValue } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import type { FlightDeckMode } from '@podium/client-core/values'
import { LOADING, type MobxPool } from '@podium/client-graph'
import { missions } from '@podium/client-graph/mission'
import { MissionScreen, missionRootId } from '@podium/client-graph/mission-screen'
import { missionView, readMissionActionInputs } from '@podium/client-graph/mission-view'
import { observer } from '@podium/client-graph/react'
import {
  type ComponentProps,
  type JSX,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { throughRestarts } from '@/lib/chunk-recovery'
import { useFeature } from '@/lib/use-feature'
import { sessionDisplayName } from '@/lib/WorkerLabel'
import {
  FlightDeckContent,
  type FlightDeckProps,
  type FlightDeckSource,
  SettlingDeck,
} from './FlightDeck'
import { measurePoolMission } from './mission-pane-perf'
import { useWorklistPool, useWorklistPoolProjection } from './store-worklist-pool'
import type { Trpc } from './trpc'

const IssueContextMenu = lazy(() =>
  throughRestarts(() => import('@/features/issues/IssueContextMenu')).then((module) => ({
    default: module.IssueContextMenu,
  })),
)

/** The same pool and mutation owner as the sidebar. This module loads only
 * for the mission pane: it resolves which mission the selection opens, and
 * each opening gets its own view model. */
export default observer(function PoolFlightDeck(props: FlightDeckProps): JSX.Element {
  const selectedIssueId = useUiValue('selectedIssueId')
  const pool = useWorklistPool()
  const owner = useClientRuntime()
  const readRoot = useCallback(
    (pool: MobxPool) => measurePoolMission(owner, () => missionRootId(pool, selectedIssueId)),
    [owner, selectedIssueId],
  )
  const rootId = useWorklistPoolProjection(readRoot, LOADING)
  // The shell mounts this column only once the selection has a mission, so a
  // missing root here is the selection catching up: a load, never a state.
  if (!pool || !rootId || rootId === LOADING) return <SettlingDeck />
  return <MissionOpening key={rootId} pool={pool} rootId={rootId} {...props} />
})

/** One opening of a mission: creates its view model, closes it on unmount. */
const MissionOpening = observer(function MissionOpening({
  pool,
  rootId,
  ...props
}: FlightDeckProps & {
  pool: MobxPool
  rootId: string
}): JSX.Element {
  // The opening outlives renders: it reaches the store's writers when it
  // writes, never by being rebuilt when the handle's access object changes.
  const handle = useClientRuntime<Trpc>()
  const handleRef = useRef(handle)
  handleRef.current = handle
  const screen = useMemo(
    () =>
      new MissionScreen(pool, rootId, {
        fullOnly: true,
        setPreference: (key, raw) =>
          (handleRef.current.access.uiState as RoutedUiState | undefined)?.set(key, raw),
        sessionName: sessionDisplayName,
      }),
    [pool, rootId],
  )
  useEffect(() => () => screen.close(), [screen])
  const source = useMemo<FlightDeckSource>(() => {
    const reader = screen.reader
    return {
      IssueMenu: PoolIssueContextMenu,
      ArchivedSessions: (archive) => <PoolArchivedSessions screen={screen} {...archive} />,
      issue: (id) => {
        const issue = reader.issue(id)
        return issue === LOADING ? undefined : issue
      },
      menuIssue: (id) => {
        const issue = reader.menuIssue(id)
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
  }, [pool, screen])
  return screen.ready ? (
    <FlightDeckContent {...props} screen={screen} source={source} />
  ) : (
    <SettlingDeck />
  )
})

/** The archived list is read only while its section is open: the deck carries
 * its count, so archived rows never re-derive the deck (review finding 2). */
const PoolArchivedSessions = observer(function PoolArchivedSessions(props: {
  screen: MissionScreen
  rootId: string
  mode: FlightDeckMode
  children: (sessions: readonly SessionView[]) => ReactNode
}) {
  const owner = useClientRuntime()
  const sessions = measurePoolMission(owner, () =>
    props.screen.reader.archive(props.rootId, props.mode),
  )
  return sessions === LOADING ? null : props.children(sessions)
})

function PoolIssueContextMenu(props: Omit<ComponentProps<typeof IssueContextMenu>, 'poolInputs'>) {
  const owner = useClientRuntime()
  const handoffEnabled = useFeature('session-handoff')
  const ids = props.issues.map((issue) => issue.id).join('\n')
  const read = useCallback(
    (pool: MobxPool) =>
      measurePoolMission(owner, () =>
        readMissionActionInputs(missionView(pool), ids.split('\n'), undefined, handoffEnabled),
      ),
    [owner, ids, handoffEnabled],
  )
  const values = useWorklistPoolProjection(read, LOADING)
  return values === LOADING ? null : (
    <Suspense fallback={null}>
      <IssueContextMenu
        {...props}
        issues={values.issues}
        allIssues={values.allIssues}
        poolInputs={values}
      />
    </Suspense>
  )
}
