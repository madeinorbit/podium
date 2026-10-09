import { useStoreHandle } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { shallowEqual } from '@podium/client-core/shallow-equal'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import type { FlightDeckMode } from '@podium/client-core/values'
import { LOADING, type MobxPool } from '@podium/client-graph'
import { missions } from '@podium/client-graph/mission'
import { MissionScreen, missionRootId } from '@podium/client-graph/mission-screen'
import { missionView, readMissionActionInputs, settled } from '@podium/client-graph/mission-view'
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
} from 'react'
import { throughRestarts } from '@/lib/chunk-recovery'
import { useFeature } from '@/lib/use-feature'
import { sessionDisplayName } from '@/lib/WorkerLabel'
import {
  FlightDeckContent,
  type FlightDeckModes,
  type FlightDeckProps,
  type FlightDeckSource,
  MissionlessDeck,
  SettlingDeck,
} from './FlightDeck'
import { measurePoolMission } from './mission-pane-perf'
import { useRuntimeSelector } from './store'
import type { Trpc } from './trpc'
import { useWorklistPool, useWorklistPoolProjection } from './store-worklist-pool'

const IssueContextMenu = lazy(() =>
  throughRestarts(() => import('@/features/issues/IssueContextMenu')).then((module) => ({
    default: module.IssueContextMenu,
  })),
)

/** The same pool and mutation owner as the sidebar. This module loads only
 * for the mission pane: it resolves which mission the selection opens, and
 * each opening gets its own view model. */
export default observer(function PoolFlightDeck(
  props: FlightDeckProps & { development: boolean; modes: FlightDeckModes },
): JSX.Element {
  const selectedIssueId = useRuntimeSelector((store) => store.selectedIssueId)
  const pool = useWorklistPool()
  const owner = useStoreHandle()
  const readRoot = useCallback(
    (pool: MobxPool) => measurePoolMission(owner, () => missionRootId(pool, selectedIssueId)),
    [owner, selectedIssueId],
  )
  const rootId = useWorklistPoolProjection(readRoot, LOADING)
  if (!pool || rootId === LOADING) return <SettlingDeck />
  if (!rootId) return <PoolMissionlessDeck onCollapse={props.onCollapse} />
  return <MissionOpening key={rootId} pool={pool} rootId={rootId} {...props} />
})

/** What the column says with no mission: the focused session decides. */
function PoolMissionlessDeck({ onCollapse }: { onCollapse: () => void }): JSX.Element {
  const { paneA, paneB, split } = useRuntimeSelector(
    (store) => ({ paneA: store.paneA, paneB: store.paneB, split: store.split }),
    shallowEqual,
  )
  const read = useCallback(
    (pool: MobxPool): 'shell' | 'settling' | 'none' => {
      for (const id of [paneA, split ? paneB : null]) {
        if (!id) continue
        const session = settled(() => {
          const model = pool.sessionObject(id)
          return model.exists ? { agentKind: model.agentKind, issueId: model.issueId } : undefined
        })
        if (!session || session === LOADING) continue
        return session.agentKind === 'shell' ? 'shell' : session.issueId ? 'settling' : 'none'
      }
      return 'none'
    },
    [paneA, paneB, split],
  )
  const focus = useWorklistPoolProjection(read, 'none')
  return <MissionlessDeck onCollapse={onCollapse} focus={focus} />
}

/** One opening of a mission: creates its view model, closes it on unmount. */
const MissionOpening = observer(function MissionOpening({
  pool,
  rootId,
  development,
  modes,
  ...props
}: FlightDeckProps & {
  pool: MobxPool
  rootId: string
  development: boolean
  modes: FlightDeckModes
}): JSX.Element {
  const handle = useStoreHandle<Trpc>()
  const ui = handle.access.uiState as RoutedUiState | undefined
  const trpc = handle.access.trpc
  const screen = useMemo(
    () =>
      new MissionScreen(pool, rootId, {
        development,
        setPreference: (key, raw) => ui?.set(key, raw),
        sessionName: sessionDisplayName,
        issueEvents: (input) => trpc.issues.events.query(input),
      }),
    [pool, rootId, development, ui, trpc],
  )
  useEffect(() => {
    screen.open()
    return () => screen.close()
  }, [screen])
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
    <FlightDeckContent {...props} screen={screen} source={source} modes={modes} />
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
  const owner = useStoreHandle()
  const sessions = measurePoolMission(owner, () => props.screen.reader.archive(props.rootId, props.mode))
  return sessions === LOADING ? null : props.children(sessions)
})

function PoolIssueContextMenu(props: Omit<ComponentProps<typeof IssueContextMenu>, 'poolInputs'>) {
  const owner = useStoreHandle()
  const handoffEnabled = useFeature('session-handoff')
  const ids = props.issues.map((issue) => issue.id).join('\n')
  const read = useCallback(
    (pool: MobxPool) =>
      measurePoolMission(owner, () => readMissionActionInputs(missionView(pool), ids.split('\n'), undefined, handoffEnabled)),
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
