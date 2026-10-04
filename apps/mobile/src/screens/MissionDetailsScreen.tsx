import type { IssueNavigationModel } from '@podium/client-core/viewmodels'
import type { MobxPool } from '@podium/client-graph/pool'
import { asIssueId } from '@podium/model'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { useMissionScreenData, useStoreActions } from '../client/hooks'
import { useMobilePoolProjection } from '../client/mobile-pool'
import { ConfiguredIssueLaunchSheet } from '../components/ConfiguredIssueLaunchSheet'
import { DetailSkeleton } from '../components/LaunchPlaceholders'
import { MissionDeck } from '../components/MissionDeck'
import { Screen } from '../components/Screen'
import { EmptyState } from '../components/ui'
import { WorkIssueMenu } from '../components/WorkIssueMenu'
import { FLOW_HEX, issueColorHex } from '../theme/issueColors'

const ignoreContentHeight = (_height: number): void => undefined

export function MissionDetailsScreen() {
  const params = useLocalSearchParams<{
    missionId: string | string[]
    sessionId?: string | string[]
  }>()
  const rawId = Array.isArray(params.missionId) ? params.missionId[0] : params.missionId
  const rawSession = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId
  const missionId = asIssueId(decodeURIComponent(rawId ?? ''))
  const { root, issues, sessions, missionSessions, resolved } = useMissionScreenData(missionId)
  const store = useStoreActions()
  const router = useRouter()
  const [menuIssue, setMenuIssue] = useState<IssueNavigationModel | null>(null)
  const menuIssueId = menuIssue?.id
  const readSessionCount = useCallback(
    (pool: MobxPool) => (menuIssueId ? pool.graph.size('issue', menuIssueId, 'pageSessions') : 0),
    [menuIssueId],
  )
  const sessionCount = useMobilePoolProjection(readSessionCount, 0)
  const [launchIssue, setLaunchIssue] = useState<(typeof issues)[number] | null>(null)

  return (
    <Screen title="Mission details" onBack={() => router.back()} backAs="text" backLabel="Done">
      {!resolved ? (
        <DetailSkeleton />
      ) : root ? (
        <MissionDeck
          root={root}
          sessions={sessions}
          accent={issueColorHex(root.color) ?? FLOW_HEX}
          currentSessionId={
            missionSessions.find((session) => session.sessionId === rawSession)?.sessionId
          }
          onOpenSession={(session) =>
            router.dismissTo(
              `/mission/${encodeURIComponent(root.id)}?sessionId=${encodeURIComponent(session.sessionId)}`,
            )
          }
          onOpenTask={(issue) => router.replace(`/inspect/${encodeURIComponent(issue.id)}`)}
          onOpenTaskMenu={setMenuIssue}
          onLaunchAgent={() => setLaunchIssue(root)}
          onTuckRoot={() => {
            void store.setIssueTucked(root.id, true).catch(() => {})
          }}
          onFileRoot={() => {
            void store
              .closeIssue(root.id, 'done')
              .then(() => store.setIssueTucked(root.id, true))
              .catch(() => {})
          }}
          onOpenDeparture={(issueId) =>
            router.replace(`/mission/${encodeURIComponent(issueId)}/details`)
          }
          onContentHeight={ignoreContentHeight}
        />
      ) : (
        <EmptyState fill title="Mission not found." />
      )}
      {menuIssue ? (
        <WorkIssueMenu
          target={{ issue: menuIssue, lane: 'live', sessionCount }}
          issues={issues}
          sessions={sessions}
          onClose={() => setMenuIssue(null)}
        />
      ) : null}
      <ConfiguredIssueLaunchSheet issue={launchIssue} onClose={() => setLaunchIssue(null)} />
    </Screen>
  )
}
