import { useSlice } from '@podium/client-core/react'
import {
  type IssueNavigationModel,
  reposToViews,
  reposVisibleOnMachines,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import { asIssueId } from '@podium/model'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { useMissionScreenData, usePoolMissionDeckData, useStoreActions } from '../client/hooks'
import { mobileDataLayer, useMobileLaunchData } from '../client/mobile-pool'
import { ConfiguredIssueLaunchSheet } from '../components/ConfiguredIssueLaunchSheet'
import { DetailSkeleton } from '../components/LaunchPlaceholders'
import { MissionDeck } from '../components/MissionDeck'
import { Screen } from '../components/Screen'
import { EmptyState } from '../components/ui'
import { WorkIssueMenu } from '../components/WorkIssueMenu'
import { FLOW_HEX, issueColorHex } from '../theme/issueColors'

function useLegacyWorktreePaths() {
  return useSlice(worklistSlice).allWorktreePaths
}

function usePoolWorktreePaths() {
  const data = useMobileLaunchData()
  return useMemo(() => {
    if (!data) return []
    // These are machine-roster facts read by the pool's command source. Keep
    // legacy grouping, machine visibility and pin order without deriving work.
    const projects = reposToViews(reposVisibleOnMachines(data.repos, data.machines))
    const ordered = [
      ...data.pins.repos.flatMap((path) => {
        const repo = projects.find((candidate) => candidate.path === path)
        return repo ? [repo] : []
      }),
      ...projects.filter((repo) => !data.pins.repos.includes(repo.path)),
    ]
    return ordered.flatMap((repo) =>
      repo.worktrees
        .filter((tree) => !data.pins.worktrees.includes(tree.path))
        .map((tree) => tree.path),
    )
  }, [data])
}

const ignoreContentHeight = (_height: number): void => undefined

export function MissionDetailsScreen() {
  const params = useLocalSearchParams<{
    missionId: string | string[]
    sessionId?: string | string[]
  }>()
  const rawId = Array.isArray(params.missionId) ? params.missionId[0] : params.missionId
  const rawSession = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId
  const missionId = asIssueId(decodeURIComponent(rawId ?? ''))
  const { root, issues, sessions, missionSessions, resolved } = useMissionScreenData(
    missionId,
    'details',
  )
  const store = useStoreActions()
  const router = useRouter()
  // The app latches this choice before mounting signed-in screens. An attaching
  // pool supplies loading paths; it must never fall back to the legacy slice.
  const useWorktreePaths =
    mobileDataLayer() === 'pool' ? usePoolWorktreePaths : useLegacyWorktreePaths
  const allWorktreePaths = useWorktreePaths()
  const [menuIssue, setMenuIssue] = useState<IssueNavigationModel | null>(null)
  const [launchIssue, setLaunchIssue] = useState<(typeof issues)[number] | null>(null)

  return (
    <Screen title="Mission details" onBack={() => router.back()} backAs="text" backLabel="Done">
      {mobileDataLayer() === 'pool' && !resolved ? (
        <DetailSkeleton />
      ) : root ? (
        <MissionDeck
          usePoolPresentation={mobileDataLayer() === 'pool' ? usePoolMissionDeckData : undefined}
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
