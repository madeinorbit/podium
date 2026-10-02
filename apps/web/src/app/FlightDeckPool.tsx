import { machineViewsFromWire, reposToViews } from '@podium/client-core/viewmodels'
import { shallowEqual } from '@podium/client-core/store'
import { LOADING, type MobxPool } from '@podium/client-graph'
import { missions } from '@podium/client-graph/mission'
import { missionView, readMissionHandoff, readMissionView, readMissionActionInputs, type MissionHandoffValues, type MissionViewValues } from '@podium/client-graph/mission-view'
import { useCallback, useMemo, type ComponentProps, type JSX } from 'react'
import { IssueContextMenu } from '@/features/issues/IssueContextMenu'
import { SessionContextMenu } from '@/lib/SessionContextMenu'
import { MissionSessionMenu } from './mission-session-menu'
import { FlightDeckContent, SettlingDeck, type FlightDeckPreferences, type FlightDeckProps, type FlightDeckSource } from './FlightDeck'
import { useStoreSelector } from './store'
import { useWorklistPool, useWorklistPoolProjection } from './store-worklist-pool'

interface PaneValues {
  mission: MissionViewValues
  handoff?: MissionHandoffValues
  hosts: ReturnType<typeof machineViewsFromWire>
}

/** The same pool and mutation owner as the sidebar. This module loads only
 * after the startup pane choice, and never subscribes to legacy entity slices. */
export default function PoolFlightDeck(props: FlightDeckProps & { preferences: FlightDeckPreferences }): JSX.Element {
  const { selectedIssueId, paneA, paneB, split } = useStoreSelector(store => ({
    selectedIssueId: store.selectedIssueId, paneA: store.paneA, paneB: store.paneB, split: store.split,
  }), shallowEqual)
  const pool = useWorklistPool()
  const { mode, view } = props.preferences
  const read = useCallback((pool: MobxPool): PaneValues | typeof LOADING => {
    const reader = missionView(pool)
    const mission = readMissionView(reader, selectedIssueId, mode)
    if (mission === LOADING) return LOADING
    // Displayed names outside the drawn roster still participate in tracking.
    for (const id of new Set([paneA, split ? paneB : null, ...mission.rows.map(row => row.issue.startedBySession)])) {
      if (id && reader.session(id) === LOADING) return LOADING
    }
    const handoff = view === 'handoff' && mission.root ? readMissionHandoff(reader, mission.root.id) : undefined
    if (handoff === LOADING) return LOADING
    const machines = machineViewsFromWire(pool.headerViews.machines())
    const scans = pool.headerViews.ids('repository').flatMap(id => {
      const scan = pool.headerViews.row('repository', id)
      return scan ? [scan] : []
    })
    const repo = reposToViews(scans).find(repo => repo.path === mission.root?.repoPath)
    const hosts = mission.root?.machineId
      ? machines.filter(view => view.machine.id === mission.root!.machineId)
      : machines.filter(view => repo?.machines.some(machine => machine.machineId === view.machine.id))
    return { mission, handoff, hosts }
  }, [selectedIssueId, paneA, paneB, split, mode, view])
  const values = useWorklistPoolProjection(read, LOADING)
  const source = useMemo<FlightDeckSource | null>(() => {
    if (!pool || values === LOADING) return null
    const reader = missionView(pool)
    return {
      kind: 'pool', mission: values.mission, handoff: values.handoff, agentHosts: values.hosts,
      IssueMenu: PoolIssueContextMenu,
      issues: [...values.mission.byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      sessions: [...values.mission.sessions], allWorktreePaths: [],
      issue: id => { const issue = reader.issue(id); return issue === LOADING ? undefined : issue },
      session: id => { const session = reader.session(id); return session === LOADING ? undefined : session },
      rootFor: id => { const root = missions(pool).rootFor(id); return root === LOADING ? null : root },
      attached: id => { const sessions = reader.attached(id); return sessions === LOADING ? [] : sessions },
    }
  }, [pool, values])
  return source ? <MissionSessionMenu.Provider value={PoolSessionContextMenu}><FlightDeckContent {...props} source={source} /></MissionSessionMenu.Provider> : <SettlingDeck />
}

function PoolIssueContextMenu(props: ComponentProps<typeof IssueContextMenu>) {
  const ids = props.issues.map(issue => issue.id).join('\n')
  const read = useCallback((pool: MobxPool) => readMissionActionInputs(missionView(pool), ids.split('\n')), [ids])
  const values = useWorklistPoolProjection(read, LOADING)
  return values === LOADING ? null : <IssueContextMenu {...props} issues={values.issues} allIssues={values.allIssues} poolInputs={values} />
}
function PoolSessionContextMenu(props: ComponentProps<typeof SessionContextMenu>) {
  const id = props.session.sessionId
  const read = useCallback((pool: MobxPool) => readMissionActionInputs(missionView(pool), [], id), [id])
  const values = useWorklistPoolProjection(read, LOADING)
  return values === LOADING || !values.session ? null : <SessionContextMenu {...props} session={values.session} poolInputs={values} />
}
