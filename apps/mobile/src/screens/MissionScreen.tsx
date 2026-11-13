import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { type IssueNavigationModel, sessionTitle, taskOpenSeat } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asIssueId, type SessionId } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import * as Haptics from 'expo-haptics'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { NavigationRouteContext } from 'expo-router/build/react-navigation/core/NavigationProvider'
import { observer } from 'mobx-react-lite'
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, type LayoutChangeEvent, Platform, StyleSheet, View } from 'react-native'
import { useMissionOpening, useStoreActions, useTaskSeatMemory } from '../client/hooks'
import { useMobilePool, useMobilePoolProjection } from '../client/mobile-pool'
import { useScreenReadFocus } from '../client/screen-read-focus'
import {
  useSessionContextChromeIssue,
  useSessionContextSession,
} from '../client/use-session-context'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { ChatDeckPager } from '../components/ChatDeckPager'
import { ConfiguredIssueLaunchSheet } from '../components/ConfiguredIssueLaunchSheet'
import type { ChatDeckPagerHandle, PagerPage } from '../components/chat-deck-pager.types'
import { Glass } from '../components/Glass'
import { Icon } from '../components/Icon'
import { MoreVertical } from '../components/icons'
import { MissionBar } from '../components/MissionBar'
import { MissionDeck, useRevealSeat } from '../components/MissionDeck'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionConversation } from '../components/SessionConversation'
import { TaskSheet } from '../components/TaskSheet'
import { EmptyState } from '../components/ui'
import { WorkIssueMenu } from '../components/WorkIssueMenu'
import { useHeaderInset } from '../navigation/header-inset'
import { type DeckOpen, deckTaskOpen } from '../navigation/mission-deck-targets'
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
 * The conversation opens first. The full deck is the page to its right: a
 * swipe from right to left, or a tap on the status bar under the nav bar, pages
 * over to it, and a tap on any seat there brings that conversation back here.
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
  const [findRequest, setFindRequest] = useState(0)

  // An explicit pick from the deck outranks the automatic one, but only while it
  // still names a session on THIS mission — a mission you return to hours later
  // must not open on an agent that has since been archived. Opening follows the
  // routing contract shared with Work, Tasks and search: a seat named in the
  // route is shown; otherwise the desktop's pick (`taskOpenSeat`) with no
  // remembered pane, so the tapped task's coordinator wins, then the root's,
  // then the most recently active. The pick is pinned the moment it is shown:
  // the seat changes only when the operator picks another, never because a
  // sibling spoke last while they read. The remembered pane still steers task
  // taps on the deck, as on the desktop.
  const seatMemory = useTaskSeatMemory()
  const rootId = root?.id
  // Name the requested chat from the existing pool before the full deck settles.
  const openingSession = useSessionContextSession(requestedSessionId as SessionId | undefined)
  const openingIssue = useSessionContextChromeIssue(openingSession?.issueId ?? selectedId)
  const selectedValue = ready ? screen.reader.issue(selectedId) : undefined
  const selected = selectedValue && selectedValue !== LOADING ? selectedValue : undefined
  const pinned = missionSessions.find((s) => s.sessionId === pinnedSessionId)
  // An explicit session in the route (Work, Tasks, search and notifications
  // name the seat they picked) stands in for the remembered pane, so the
  // shared pick lands on it whenever it is a member, and a remembered helper
  // can never outrank it.
  const autoSeat =
    pinned || !root
      ? null
      : taskOpenSeat({
          members: missionSessions,
          remembered: requestedSessionId ?? null,
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
  // Whatever the screen shows is what reopening this task lands on next time.
  const currentId = current?.sessionId
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
  const headerIssue = currentIssue ?? root ?? openingIssue
  useScreenReadFocus(headerIssue?.id, current?.sessionId)

  // Native shows the deck as the page right of the chat. The web build keeps
  // the deck as its own URL, because its history records only focused screens.
  const paged = Platform.OS !== 'web'
  const pager = useRef<ChatDeckPagerHandle>(null)
  const [page, setPage] = useState<PagerPage>(0)
  const onDeck = paged && page === 1
  // The stack's back swipe belongs to the chat page; the native pager switches
  // it off itself the moment its offset leaves page 0 (no JS round trip).
  // Paging with the keyboard up is allowed and never drops focus mid-drag (a
  // drag that snaps back keeps typing going). Coming to rest on the deck puts
  // the composer off screen, so the keyboard goes; the draft stays.
  const settlePage = useCallback((next: PagerPage) => {
    setPage(next)
    if (next === 1) Keyboard.dismiss()
  }, [])
  const openDeck = useCallback(() => {
    if (!rootId) return
    if (paged) {
      pager.current?.setPage(1)
      return
    }
    router.push(
      `/mission/${encodeURIComponent(rootId)}/details${currentId ? `?sessionId=${encodeURIComponent(currentId)}` : ''}`,
    )
  }, [currentId, paged, rootId, router])
  const showSession = useCallback((sessionId: SessionId) => {
    setPinnedSessionId(sessionId)
    pager.current?.setPage(0)
    void Haptics.selectionAsync().catch(() => {})
  }, [])
  const openSession = useCallback(
    (session: SessionView) => showSession(session.sessionId),
    [showSession],
  )
  // A link or a Work tap that lands on this already mounted screen (the stack
  // reuses the focused route and hands it new params) is a new opening: the
  // seat it names, or with none the coordinator-first pick, replaces whatever
  // was pinned, and the chat page comes back into view. Deck picks pin locally
  // and never change the params.
  const routeParams = use(NavigationRouteContext)?.params
  const openedWith = useRef(routeParams)
  useEffect(() => {
    if (openedWith.current === routeParams) return
    openedWith.current = routeParams
    setPinnedSessionId(requestedSessionId ? (requestedSessionId as SessionId) : null)
    pager.current?.setPage(0)
  }, [routeParams, requestedSessionId])

  // The deck page reads the same shared deck; its taps change which session
  // the chat page shows and page back, or leave for another screen.
  const follow = useCallback(
    (open: DeckOpen) => {
      if (open.kind === 'chat') showSession(open.sessionId)
      else router.push(open.href)
    },
    [router, showSession],
  )
  // The deck lists only this mission's crew, so a seat it offers is always
  // one the chat page can show.
  const openDeckSession = useCallback(
    (session: SessionView) => showSession(session.sessionId),
    [showSession],
  )
  const openDeckTask = useCallback(
    (issue: IssueNavigationModel) => {
      if (!rootId || !screen?.ready) return
      follow(deckTaskOpen(issue, screen, seatMemory.recall(rootId)))
    },
    [follow, rootId, screen, seatMemory],
  )
  const screenProposals = useCallback(() => router.push('/screen-proposed'), [router])
  const [menuIssue, setMenuIssue] = useState<IssueNavigationModel | null>(null)
  const menuIssueId = menuIssue?.id
  const readSessionCount = useCallback(
    (source: MobxPool) =>
      menuIssueId ? source.graph.size('issue', menuIssueId, 'pageSessions') : 0,
    [menuIssueId],
  )
  const sessionCount = useMobilePoolProjection(readSessionCount, 0)
  useRevealSeat(paged ? screen : null, currentId)

  const menuActions = useMemo<SheetAction[]>(() => {
    if (!root) return []
    return [
      onDeck
        ? { label: 'Chat', onPress: () => pager.current?.setPage(0) }
        : { label: 'Flight deck', onPress: openDeck },
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
      ...(current && !onDeck
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
  }, [current, headerIssue, onDeck, openDeck, root, router, store])

  // The nav bar names the task and, beneath it, whose conversation this is:
  // "Coordinator" for the mission's own lead, else the agent and its task.
  // On the deck page it names the mission and the page, as the deck screen did.
  const coordinatorId = ready && screen.full.ready ? screen.full.coordinatorSessionId : null
  const seat = current
    ? current.sessionId === coordinatorId
      ? 'Coordinator'
      : `${sessionTitle(current)}${currentIssue && currentIssue.id !== root?.id ? ` · ${issueDisplayRef(currentIssue)}` : ''}`
    : null
  const chatTitle = headerIssue?.title ?? (openingSession ? sessionTitle(openingSession) : '')

  // Page contents are built once per input, so a page change (which renders
  // this screen for the header) never renders the transcript or the deck.
  const chatPage = useMemo(
    () =>
      root && screen ? (
        <MissionChat
          current={current}
          currentIssue={currentIssue}
          findRequest={findRequest}
          bar={<MissionBar full={screen.full} onOpen={openDeck} />}
        />
      ) : null,
    [current, currentIssue, findRequest, openDeck, root, screen],
  )
  const deckPage = useMemo(
    () =>
      paged && root && screen?.ready ? (
        <View style={styles.deck} collapsable={false}>
          <MissionDeck
            screen={screen}
            showTitle={false}
            currentSessionId={currentId}
            onOpenSession={openDeckSession}
            onOpenTask={openDeckTask}
            onOpenTaskMenu={setMenuIssue}
            onScreenProposals={screenProposals}
          />
        </View>
      ) : null,
    [currentId, openDeckSession, openDeckTask, paged, root, screen, screenProposals],
  )

  return (
    <Screen
      title={onDeck ? (root?.title ?? 'Flight deck') : chatTitle}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/work'))}
      backLabel={Platform.OS === 'web' ? 'Back' : 'Work'}
      bareBack
      underHeader
      subtitle={onDeck ? 'Flight deck' : (seat ?? (root ? 'No agent on this mission' : undefined))}
      // One tap to the task page, as Messages opens a contact from its name.
      onTitlePress={
        headerIssue
          ? () => router.push(`/issue/${encodeURIComponent(root?.id ?? selectedId)}`)
          : undefined
      }
      right={
        <HeaderButton label="Mission actions" onPress={() => setMenuOpen(true)} size={32} bare>
          <Icon as={MoreVertical} size={17} color={color.textDim} />
        </HeaderButton>
      }
    >
      {/* The conversation owns transcript readiness. Deck metadata can still be
          loading while that conversation already has history in the pool. */}
      {root && screen ? (
        paged ? (
          <ChatDeckPager
            ref={pager}
            chat={chatPage}
            deck={deckPage}
            onPageChange={setPage}
            onPageSettle={settlePage}
          />
        ) : (
          chatPage
        )
      ) : resolved ? (
        <EmptyState title="Mission not found." />
      ) : null}

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
      {menuIssue ? (
        <WorkIssueMenu
          target={{ issue: menuIssue, lane: 'live', sessionCount }}
          onClose={() => setMenuIssue(null)}
        />
      ) : null}
    </Screen>
  )
})

/**
 * The chat page: the deck's status bar pinned under the transparent nav bar,
 * and the transcript scrolling under both.
 */
function MissionChat({
  current,
  currentIssue,
  findRequest,
  bar,
}: {
  current: SessionView | undefined
  currentIssue: IssueViewModel | undefined
  findRequest: number
  bar: React.ReactNode
}) {
  const headerInset = useHeaderInset()
  const [barHeight, setBarHeight] = useState(0)
  const onBarLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.height)
    setBarHeight((prev) => (prev === next ? prev : next))
  }
  return (
    <View style={styles.body} collapsable={false}>
      <Glass style={[styles.bar, { top: headerInset }]}>
        <View onLayout={onBarLayout}>{bar}</View>
      </Glass>
      <View style={styles.stage} collapsable={false}>
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
            body="Swipe left for the flight deck to review the tasks, or launch an agent to get it moving."
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
  bar: {
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
  deck: {
    flex: 1,
    minHeight: 0,
    backgroundColor: color.groupedBg,
  },
})
