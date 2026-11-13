import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { sessionTitle, taskOpenSeat } from '@podium/client-core/values'
import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asIssueId, type SessionId } from '@podium/model'
import { isFinished } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import * as Haptics from 'expo-haptics'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { type LayoutChangeEvent, Platform, StyleSheet, View } from 'react-native'
import { useMissionOpening, useStoreActions, useTaskSeatMemory } from '../client/hooks'
import { useMobilePool } from '../client/mobile-pool'
import { useScreenReadFocus } from '../client/screen-read-focus'
import type { MobileTrpc } from '../client/trpc'
import { useIssueCloseGuard } from '../client/use-issue-close'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { ConfiguredIssueLaunchSheet } from '../components/ConfiguredIssueLaunchSheet'
import { Glass } from '../components/Glass'
import { Icon } from '../components/Icon'
import { IssueCloseSheet } from '../components/IssueCloseSheet'
import { MoreVertical } from '../components/icons'
import { BootstrapCrossfade, DetailSkeleton } from '../components/LaunchPlaceholders'
import { MissionBar } from '../components/MissionBar'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionConversation } from '../components/SessionConversation'
import { TaskSheet } from '../components/TaskSheet'
import { EmptyState } from '../components/ui'
import { useHeaderInset } from '../navigation/header-inset'
import { useMissionDeckReturn } from '../navigation/use-mission-deck-return'
import { color } from '../theme/theme'

/**
 * THE TASK, AS THE PHONE SHOULD OPEN IT [POD-724].
 *
 * Tapping a task in Work used to land on the flight deck: a spine of subtasks
 * and agent bands, with the actual conversation one more push away. That is the
 * right FIRST screen at a desk, where the deck is a column beside the chat and
 * costs nothing to keep open — and the wrong one in a pocket, where the thing
 * you opened the app to do is answer somebody. Ninety percent of a phone visit
 * ends in the transcript, and every one of them was paying two navigations for
 * it.
 *
 * The conversation opens first. The full deck sits beneath it in the native
 * stack, so the system back button and iOS 26 content swipe reveal the deck.
 */

const NO_SESSIONS: readonly SessionView[] = []

export const MissionScreen = observer(function MissionScreen() {
  const pool = useMobilePool()
  const params = useLocalSearchParams<{
    missionId: string | string[]
    sessionId?: string | string[]
  }>()
  const raw = Array.isArray(params.missionId) ? params.missionId[0] : (params.missionId ?? '')
  const selectedId = asIssueId(decodeURIComponent(raw))
  const router = useRouter()
  const store = useStoreActions()
  const hasCloseBlockers = useIssueCloseGuard()
  // The mission is the whole subtree above and below the selected task, exactly
  // as the desktop resolves it — open a child from a notification and you land
  // on the same deck the sidebar would have given you.
  const { screen, resolved } = useMissionOpening(selectedId)
  const ready = resolved && screen?.ready === true
  const rootValue = ready ? screen.reader.issue(screen.rootId) : undefined
  const root = rootValue && rootValue !== LOADING ? rootValue : undefined
  const missionSessions = ready ? (screen.crew as unknown as readonly SessionView[]) : NO_SESSIONS

  const requestedSessionId = Array.isArray(params.sessionId)
    ? params.sessionId[0]
    : params.sessionId
  const [pinnedSessionId, setPinnedSessionId] = useState<SessionId | null>(
    requestedSessionId ? (requestedSessionId as SessionId) : null,
  )
  const [peek, setPeek] = useState<IssueViewModel | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [launchOpen, setLaunchOpen] = useState(false)
  const [fileRootPending, setFileRootPending] = useState(false)
  const [findRequest, setFindRequest] = useState(0)

  // An explicit pick from the deck outranks the automatic one, but only while it
  // still names a session on THIS mission — a mission you return to hours later
  // must not open on an agent that has since been archived. The automatic one
  // is the desktop sidebar's (`taskOpenSeat`: the session this phone last showed
  // on the mission, else the tapped task's coordinator, the root's, the most
  // recently active), and it is pinned the moment it is shown: the seat changes
  // only when the operator picks another, never because a sibling spoke last
  // while they read.
  const seatMemory = useTaskSeatMemory()
  const rootId = root?.id
  // Read once per mission: the seat written below must not feed back into it.
  const remembered = useMemo(
    () => (rootId ? seatMemory.recall(rootId) : null),
    [rootId, seatMemory],
  )
  const selectedValue = ready ? screen.reader.issue(selectedId) : undefined
  const selected = selectedValue && selectedValue !== LOADING ? selectedValue : undefined
  const pinned = missionSessions.find((s) => s.sessionId === pinnedSessionId)
  const autoSeat =
    pinned || !root
      ? null
      : taskOpenSeat({
          members: missionSessions,
          remembered,
          taskCoordinatorSessionId: selected?.coordinatorSessionId,
          rootCoordinatorSessionId: root.coordinatorSessionId,
        })
  const auto = autoSeat ? missionSessions.find((s) => s.sessionId === autoSeat) : undefined
  const current = pinned ?? auto
  const autoId = auto?.sessionId
  useEffect(() => {
    // Wait for the root: its coordinator decides the pick.
    if (root && autoId) setPinnedSessionId(autoId as SessionId)
  }, [root, autoId])
  useEffect(() => {
    if (requestedSessionId) setPinnedSessionId(requestedSessionId as SessionId)
  }, [requestedSessionId])
  // Whatever the screen shows is what reopening this task lands on next time.
  const currentId = current?.sessionId
  useMissionDeckReturn(rootId, currentId)
  useEffect(() => {
    if (rootId && currentId) seatMemory.remember(rootId, currentId as SessionId)
  }, [rootId, currentId, seatMemory])
  // The header names the task the shown session works on, when it is one of
  // this mission's members; otherwise the mission itself.
  const currentValue =
    ready && current?.issueId && screen.members.has(current.issueId)
      ? screen.reader.issue(current.issueId)
      : undefined
  const currentIssue = currentValue && currentValue !== LOADING ? currentValue : root
  const headerIssue = currentIssue ?? root
  useScreenReadFocus(headerIssue?.id, current?.sessionId)

  const openSession = useCallback((session: SessionView) => {
    setPinnedSessionId(session.sessionId)
    void Haptics.selectionAsync().catch(() => {})
  }, [])

  const closeAndTuckRoot = useCallback(() => {
    if (!root) return
    setFileRootPending(false)
    void store
      .closeIssue(root.id, 'done')
      .then(() => store.setIssueTucked(root.id, true))
      .catch(() => {})
  }, [root, store])
  const fileRoot = useCallback(() => {
    if (!root) return
    if (isFinished(root)) {
      void store.setIssueTucked(root.id, true).catch(() => {})
      return
    }
    if (hasCloseBlockers(root.id)) {
      setFileRootPending(true)
      return
    }
    closeAndTuckRoot()
  }, [closeAndTuckRoot, root, hasCloseBlockers, store])

  const menuActions = useMemo<SheetAction[]>(() => {
    if (!root) return []
    return [
      {
        label: 'Task details',
        hint: 'The full task page',
        onPress: () => router.push(`/issue/${encodeURIComponent(root.id)}`),
      },
      {
        label: 'Inspect task',
        hint: 'The inspector sheet, without leaving the chat',
        onPress: () => setPeek(root),
      },
      {
        label: headerIssue?.pinned ? 'Unpin' : 'Pin',
        onPress: () => {
          if (!headerIssue) return
          void store.updateIssue(headerIssue.id, { pinned: !headerIssue.pinned })
        },
      },
      { label: 'Launch an agent…', onPress: () => setLaunchOpen(true) },
      ...(current
        ? [
            {
              label: 'Find in transcript',
              onPress: () => setFindRequest((request) => request + 1),
            },
            {
              label: 'Open native CLI',
              onPress: () =>
                router.push(`/session/${encodeURIComponent(current.sessionId)}/terminal`),
            },
          ]
        : []),
    ]
  }, [current, headerIssue, root, router, store])

  // The nav bar names the task and, beneath it, whose conversation this is:
  // "Coordinator" for the mission's own lead, else the agent and its task.
  const coordinatorId = ready && screen.full.ready ? screen.full.coordinatorSessionId : null
  const seat = current
    ? current.sessionId === coordinatorId
      ? 'Coordinator'
      : `${sessionTitle(current)}${currentIssue && currentIssue.id !== root?.id ? ` · ${issueDisplayRef(currentIssue)}` : ''}`
    : null

  return (
    <Screen
      title={headerIssue ? headerIssue.title : 'Mission'}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/work'))}
      backLabel={Platform.OS === 'web' ? 'Back' : 'Flight deck'}
      bareBack
      underHeader
      subtitle={seat ?? (root ? 'No agent on this mission' : undefined)}
      // One tap to the task page, as Messages opens a contact from its name.
      onTitlePress={root ? () => router.push(`/issue/${encodeURIComponent(root.id)}`) : undefined}
      right={
        <HeaderButton label="Mission actions" onPress={() => setMenuOpen(true)} size={32} bare>
          <Icon as={MoreVertical} size={17} color={color.textDim} />
        </HeaderButton>
      }
    >
      <BootstrapCrossfade resolved={resolved} placeholder={<DetailSkeleton />}>
        {root && screen ? (
          <MissionBody
            current={current}
            currentIssue={currentIssue}
            full={screen.full}
            findRequest={findRequest}
            onOpenDetails={() => {
              if (Platform.OS === 'web') {
                router.push(
                  `/mission/${encodeURIComponent(root.id)}/details${current ? `?sessionId=${encodeURIComponent(current.sessionId)}` : ''}`,
                )
              } else router.back()
            }}
          />
        ) : (
          <EmptyState title="Mission not found." />
        )}
      </BootstrapCrossfade>

      <TaskSheet
        pool={pool}
        issue={peek}
        onClose={() => setPeek(null)}
        onOpenSession={(session) => {
          setPeek(null)
          openSession(session)
        }}
        onOpenIssue={(target) => setPeek(target)}
      />
      <ActionSheet
        visible={menuOpen}
        testID="mission-actions-sheet"
        title={root ? `${issueDisplayRef(root)} ${root.title}` : ''}
        actions={menuActions}
        onClose={() => setMenuOpen(false)}
      />
      <ConfiguredIssueLaunchSheet
        issue={launchOpen ? (root ?? null) : null}
        onClose={() => setLaunchOpen(false)}
      />
      {root ? (
        <IssueCloseSheet
          issue={root}
          reason={fileRootPending ? 'done' : null}
          onConfirm={closeAndTuckRoot}
          onClose={() => setFileRootPending(false)}
        />
      ) : null}
    </Screen>
  )
})

function MissionBody({
  current,
  currentIssue,
  full,
  findRequest,
  onOpenDetails,
}: {
  current: SessionView | undefined
  currentIssue: IssueViewModel | undefined
  full: FullDeck
  findRequest: number
  onOpenDetails: () => void
}) {
  // The deck bar floats over the feed so the chat scrolls under it (board
  // DeckA); its measured height is the transcript's top inset.
  // The screen runs under the transparent nav bar: the deck bar rests just
  // below it, and the transcript below both.
  const headerInset = useHeaderInset()
  const [barHeight, setBarHeight] = useState(0)
  const onBarLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.height)
    setBarHeight((prev) => (prev === next ? prev : next))
  }
  return (
    <View style={styles.body}>
      <Glass style={[styles.deck, { top: headerInset }]}>
        <View onLayout={onBarLayout}>
          <MissionBar full={full} onOpen={onOpenDetails} />
        </View>
      </Glass>
      <View style={styles.stage}>
        {current ? (
          <SessionConversation
            key={current.sessionId}
            session={current}
            issue={currentIssue}
            findRequest={findRequest}
            topInset={headerInset + barHeight}
          />
        ) : (
          <EmptyState
            fill
            title="No agent on this task yet"
            body="Open the flight deck to review the tasks, or launch an agent to get it moving."
          />
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    minHeight: 0,
  },
  deck: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
    // A full-width strip, not a chip: square corners, no outline.
    borderRadius: 0,
    borderWidth: 0,
  },
  stage: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
})
