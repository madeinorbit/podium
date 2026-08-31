import { useSlice } from '@podium/client-core/react'
import {
  missionRootFor,
  missionSessions as missionSessionsOf,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import { asIssueId } from '@podium/model'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { useIssues, useMobileStore, useSessions } from '../client/hooks'
import { MissionDeck } from '../components/MissionDeck'
import { ConfiguredIssueLaunchSheet } from '../components/ConfiguredIssueLaunchSheet'
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
  const issues = useIssues()
  const sessions = useSessions()
  const store = useMobileStore()
  const router = useRouter()
  const { allWorktreePaths } = useSlice(worklistSlice)
  const [menuIssue, setMenuIssue] = useState<(typeof issues)[number] | null>(null)
  const [launchIssue, setLaunchIssue] = useState<(typeof issues)[number] | null>(null)
  const root = useMemo(() => missionRootFor(issues, missionId), [issues, missionId])
  const missionSessions = useMemo(
    () => (root ? missionSessionsOf(issues, sessions, root.id) : []),
    [issues, root, sessions],
  )

  return (
    <Screen title="Mission details" onBack={() => router.back()} backAs="text" backLabel="Done">
      {root ? (
        <MissionDeck
          root={root}
          issues={issues}
          sessions={sessions}
          allWorktreePaths={allWorktreePaths}
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
          target={{ issue: menuIssue, lane: 'live' }}
          issues={issues}
          sessions={sessions}
          onClose={() => setMenuIssue(null)}
        />
      ) : null}
      <ConfiguredIssueLaunchSheet issue={launchIssue} onClose={() => setLaunchIssue(null)} />
    </Screen>
  )
}
