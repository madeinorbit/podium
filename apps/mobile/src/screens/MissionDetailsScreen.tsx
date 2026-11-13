import type { IssueNavigationModel } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asIssueId } from '@podium/model'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { useMissionOpening } from '../client/hooks'
import { useMobilePoolProjection } from '../client/mobile-pool'
import { useScreenReadFocus } from '../client/screen-read-focus'
import { DetailSkeleton } from '../components/LaunchPlaceholders'
import { MissionDeck } from '../components/MissionDeck'
import { Screen } from '../components/Screen'
import { EmptyState } from '../components/ui'
import { WorkIssueMenu } from '../components/WorkIssueMenu'

/**
 * The flight deck beneath chat. Each seat pushes its conversation; the system
 * back gesture returns to this opening with that seat selected.
 */
export const MissionDetailsScreen = observer(function MissionDetailsScreen() {
  const params = useLocalSearchParams<{
    missionId: string | string[]
    sessionId?: string | string[]
  }>()
  const rawId = Array.isArray(params.missionId) ? params.missionId[0] : params.missionId
  const rawSession = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId
  const missionId = asIssueId(decodeURIComponent(rawId ?? ''))
  const { screen, resolved } = useMissionOpening(missionId)
  const ready = resolved && screen?.ready === true
  const rootValue = ready ? screen.reader.issue(screen.rootId) : undefined
  const root = rootValue && rootValue !== LOADING ? rootValue : undefined
  useScreenReadFocus(root?.id)
  const router = useRouter()
  const [menuIssue, setMenuIssue] = useState<IssueNavigationModel | null>(null)
  const menuIssueId = menuIssue?.id
  const readSessionCount = useCallback(
    (pool: MobxPool) => (menuIssueId ? pool.graph.size('issue', menuIssueId, 'pageSessions') : 0),
    [menuIssueId],
  )
  const sessionCount = useMobilePoolProjection(readSessionCount, 0)
  useEffect(() => {
    if (!ready || !screen || !rawSession) return
    let id: string | null =
      screen.crew.find((session) => session.sessionId === rawSession)?.issueId ?? null
    // Reveal the selected seat using the deck's existing fold actions. A user
    // can fold it again without selection continually reopening it.
    while (id && screen.members.has(id)) {
      const task = screen.full.task(id)
      if (task.foldable && !task.open) screen.full.toggleFold(id)
      id = task.parentId
    }
  }, [ready, screen, rawSession])

  return (
    <Screen
      title={root?.title ?? 'Flight deck'}
      subtitle="Flight deck"
      underHeader
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/work'))}
      backLabel={Platform.OS === 'web' ? 'Back' : 'Work'}
    >
      {!resolved ? (
        <DetailSkeleton />
      ) : root && screen ? (
        <MissionDeck
          screen={screen}
          showTitle={false}
          currentSessionId={
            screen.crew.find((session) => session.sessionId === rawSession)?.sessionId
          }
          onOpenSession={(session) =>
            Platform.OS === 'web'
              ? router.dismissTo(
                  `/mission/${encodeURIComponent(root.id)}?sessionId=${encodeURIComponent(session.sessionId)}`,
                )
              : router.push(
                  `/mission/${encodeURIComponent(root.id)}?sessionId=${encodeURIComponent(session.sessionId)}`,
                )
          }
          onOpenTask={(issue) =>
            Platform.OS === 'web'
              ? router.replace(`/inspect/${encodeURIComponent(issue.id)}`)
              : router.push(
                  `/${issue.stage === 'proposed' ? 'inspect' : 'mission'}/${encodeURIComponent(issue.id)}`,
                )
          }
          onOpenTaskMenu={setMenuIssue}
          onScreenProposals={() =>
            Platform.OS === 'web'
              ? router.replace('/screen-proposed')
              : router.push('/screen-proposed')
          }
        />
      ) : (
        <EmptyState fill title="Mission not found." />
      )}
      {menuIssue ? (
        <WorkIssueMenu
          target={{ issue: menuIssue, lane: 'live', sessionCount }}
          onClose={() => setMenuIssue(null)}
        />
      ) : null}
    </Screen>
  )
})
