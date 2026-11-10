import type { IssueNavigationModel } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asIssueId } from '@podium/model'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useCallback, useState } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import { useMissionOpening } from '../client/hooks'
import { useMobilePoolProjection } from '../client/mobile-pool'
import { DetailSkeleton } from '../components/LaunchPlaceholders'
import { MissionDeck } from '../components/MissionDeck'
import { EmptyState } from '../components/ui'
import { WorkIssueMenu } from '../components/WorkIssueMenu'

/**
 * The flight deck, presented as the route's native form sheet (detents and
 * grabber come from the root layout). The sheet draws its own header — the
 * mission title, gauge and counts — instead of a navigation bar: a nav bar in
 * a form sheet floated over the deck's first rows ("deck sheet header
 * collides with toolbar", POD-2347 shots 09/10).
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
  const router = useRouter()
  const [menuIssue, setMenuIssue] = useState<IssueNavigationModel | null>(null)
  const menuIssueId = menuIssue?.id
  const readSessionCount = useCallback(
    (pool: MobxPool) => (menuIssueId ? pool.graph.size('issue', menuIssueId, 'pageSessions') : 0),
    [menuIssueId],
  )
  const sessionCount = useMobilePoolProjection(readSessionCount, 0)

  return (
    <View style={styles.root}>
      {!resolved ? (
        <DetailSkeleton />
      ) : root && screen ? (
        <MissionDeck
          screen={screen}
          currentSessionId={
            screen.crew.find((session) => session.sessionId === rawSession)?.sessionId
          }
          onOpenSession={(session) =>
            router.dismissTo(
              `/mission/${encodeURIComponent(root.id)}?sessionId=${encodeURIComponent(session.sessionId)}`,
            )
          }
          onOpenTask={(issue) => router.replace(`/inspect/${encodeURIComponent(issue.id)}`)}
          onOpenTaskMenu={setMenuIssue}
          onScreenProposals={() => router.replace('/screen-proposed')}
          {...(Platform.OS === 'web' ? { onDone: () => router.back() } : {})}
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
    </View>
  )
})

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
})
