import type { SessionView } from '@podium/client-core/session-values'
import type { IssueNavigationModel } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asIssueId } from '@podium/model'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useCallback, useState } from 'react'
import { Platform } from 'react-native'
import { useMissionOpening, useTaskSeatMemory } from '../client/hooks'
import { useMobilePoolProjection } from '../client/mobile-pool'
import { useScreenReadFocus } from '../client/screen-read-focus'
import { DetailSkeleton } from '../components/LaunchPlaceholders'
import { MissionDeck, useRevealSeat } from '../components/MissionDeck'
import { Screen } from '../components/Screen'
import { EmptyState } from '../components/ui'
import { WorkIssueMenu } from '../components/WorkIssueMenu'
import { deckTaskOpen } from '../navigation/mission-deck-targets'

/**
 * The flight deck as its own URL, for the web build whose history records only
 * focused screens. Native shows the same deck as the page right of the chat.
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
  const seatMemory = useTaskSeatMemory()
  const [menuIssue, setMenuIssue] = useState<IssueNavigationModel | null>(null)
  const menuIssueId = menuIssue?.id
  const readSessionCount = useCallback(
    (pool: MobxPool) => (menuIssueId ? pool.graph.size('issue', menuIssueId, 'pageSessions') : 0),
    [menuIssueId],
  )
  const sessionCount = useMobilePoolProjection(readSessionCount, 0)
  useRevealSeat(screen, rawSession)

  return (
    <Screen
      grouped
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
          onOpenTask={(issue) => {
            if (Platform.OS === 'web' || issue.stage === 'proposed') {
              const path = `/inspect/${encodeURIComponent(issue.id)}` as const
              if (Platform.OS === 'web') router.replace(path)
              else router.push(path)
              return
            }
            // A task tap chooses from that task's own open seats. Restoring the
            // mission workspace without an explicit seat can reopen its parent.
            const open = deckTaskOpen(
              issue,
              screen,
              screen.crew as unknown as readonly SessionView[],
              seatMemory.recall(root.id),
            )
            router.push(
              open.kind === 'chat'
                ? `/mission/${encodeURIComponent(issue.id)}?sessionId=${encodeURIComponent(open.sessionId)}`
                : open.href,
            )
          }}
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
