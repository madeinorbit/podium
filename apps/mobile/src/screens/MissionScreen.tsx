import { useSlice } from '@podium/client-core/react'
import {
  agentBadge,
  isSessionWorking,
  missionCrewLabel,
  missionProgress,
  missionRootFor,
  missionSessions as missionSessionsOf,
  sessionNeedsHuman,
  sessionTitle,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import type { AgentKind, IssueWire, SessionId, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import * as Haptics from 'expo-haptics'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronDown, MoreVertical, SquareTerminal } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Dimensions, StyleSheet, Text, View } from 'react-native'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'
import { useBooting, useIssues, useMobileStore, useSessions } from '../client/hooks'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { Icon } from '../components/Icon'
import { IdSquare } from '../components/IdSquare'
import { IssueColorSheet } from '../components/IssueColorSheet'
import { BootstrapCrossfade, DetailSkeleton } from '../components/LaunchPlaceholders'
import { MissionDeck } from '../components/MissionDeck'
import { PressableScale } from '../components/PressableScale'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionConversation } from '../components/SessionConversation'
import { BrailleSpinner } from '../components/StatusGlyphs'
import { TaskSheet } from '../components/TaskSheet'
import { EmptyState } from '../components/ui'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { mostRelevantSession } from '../lib/mission-session'
import { FLOW_HEX, flow, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, mono, monoLabel, radius, space, spring } from '../theme/theme'

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
 * So the mission screen IS the conversation of whoever is most worth talking to
 * on this mission, and the deck is a panel that pulls down over it from a bar
 * that is always on screen. Three things follow, and they are the reason this
 * is not merely "the chat screen with a button":
 *
 *  1. THE BAR IS THE DECK, COLLAPSED. Even shut, it carries the mission's vital
 *     signs — progress, who is working, how many are asking. You do not open the
 *     panel to find out whether you need to; the bar already told you.
 *  2. THE PANEL SWITCHES THE TRANSCRIPT IN PLACE. Tapping an agent band swaps
 *     the conversation underneath and closes the panel. No push, no back stack,
 *     no losing your place in a twenty-row spine. This is the thing a phone can
 *     do that the desktop's fixed three columns cannot, and it is what makes
 *     the deck worth having in a pocket at all.
 *  3. IT OPENS FROM A FIXED PLACE, downward, under the navigation bar — the
 *     mailbox-switcher gesture, not a second modal. A bottom sheet would have
 *     fought the composer for the one edge the thumb owns.
 */

/** How much of the screen the deck panel may claim when fully open. */
const PANEL_FRACTION = 0.62
/** Past this velocity the flick decides, not the position. */
const FLICK_VELOCITY = 450

export function MissionScreen() {
  const params = useLocalSearchParams<{ missionId: string | string[] }>()
  const raw = Array.isArray(params.missionId) ? params.missionId[0] : (params.missionId ?? '')
  const selectedId = decodeURIComponent(raw)
  const router = useRouter()
  const store = useMobileStore()
  const booting = useBooting()
  const issues = useIssues()
  const sessions = useSessions()
  // The worktree-path index the worklist already derives once per snapshot —
  // deriving it a second time here is exactly the per-consumer cost the
  // published slice exists to remove.
  const { allWorktreePaths } = useSlice(worklistSlice)
  const reduceMotion = useReduceMotion()

  // The mission is the whole subtree above and below the selected task, exactly
  // as the desktop resolves it — open a child from a notification and you land
  // on the same deck the sidebar would have given you.
  const root = useMemo(() => missionRootFor(issues, selectedId), [issues, selectedId])
  // Every session on the mission — the subtree's, not just the root's. The deck
  // and this screen must agree about who is on it, so both read the mission
  // module's own answer rather than each filtering the session world.
  const missionSessions = useMemo(
    () => (root ? missionSessionsOf(issues, sessions, root.id) : []),
    [issues, root, sessions],
  )

  const [pinnedSessionId, setPinnedSessionId] = useState<SessionId | null>(null)
  const [peek, setPeek] = useState<IssueWire | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [launchOpen, setLaunchOpen] = useState(false)
  const [colorOpen, setColorOpen] = useState(false)

  // An explicit pick from the deck outranks the automatic one, but only while it
  // still names a session on THIS mission — a mission you return to hours later
  // must not open on an agent that has since been archived.
  const auto = useMemo(() => mostRelevantSession(missionSessions), [missionSessions])
  const current =
    missionSessions.find((s) => s.sessionId === pinnedSessionId) ??
    missionSessions.find((s) => s.sessionId === auto?.sessionId) ??
    auto
  const currentIssue = useMemo(
    () => issues.find((i) => i.id === current?.issueId) ?? root,
    [current?.issueId, issues, root],
  )

  const progress = useMemo(
    () => missionProgress(issues, sessions, root?.id),
    [issues, sessions, root?.id],
  )
  const attention = missionSessions.filter(sessionNeedsHuman).length
  const live = missionSessions.filter((s) => !s.archived && s.status !== 'exited').length
  const working = missionSessions.filter(isSessionWorking).length

  const accent = root ? (issueColorHex(root.color) ?? FLOW_HEX) : undefined

  const openSession = useCallback((session: SessionMeta) => {
    setPinnedSessionId(session.sessionId)
    void Haptics.selectionAsync().catch(() => {})
  }, [])

  const launch = useCallback(
    (agentKind?: AgentKind) => {
      if (!root) return
      // Started issues take another agent into the SAME worktree; an unstarted
      // one has to be started first, which is what creates the branch and the
      // checkout. The desktop's own menu makes exactly this split.
      const started = Boolean(root.worktreePath ?? root.branch)
      const input = agentKind ? { id: root.id, agentKind } : { id: root.id }
      const call = started
        ? store.trpc.issues.addSession.mutate(input)
        : store.trpc.issues.start.mutate(input)
      void call.catch(() => {})
    },
    [root, store.trpc],
  )

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
      { label: 'Launch an agent…', onPress: () => setLaunchOpen(true) },
      { label: 'Colour…', onPress: () => setColorOpen(true) },
      ...(current
        ? [
            {
              label: 'Open native CLI',
              onPress: () =>
                router.push(`/session/${encodeURIComponent(current.sessionId)}/terminal`),
            },
          ]
        : []),
    ]
  }, [current, root, router])

  const resolved = root !== undefined || (!booting && issues.length > 0)

  return (
    <Screen
      title={root ? root.title : 'Mission'}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/work'))}
      accent={accent}
      subtitle={
        current
          ? `${sessionTitle(current)} · ${agentBadge(current, currentIssue)?.label ?? current.status}`
          : root
            ? 'No agent on this mission'
            : undefined
      }
      leading={
        root ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Colour ${issueDisplayRef(root)}`}
            onPress={() => setColorOpen(true)}
            hitSlop={8}
            scaleTo={0.9}
          >
            <IdSquare
              issue={root}
              state={attention > 0 ? 'waiting' : live > 0 ? 'working' : 'queued'}
              size={18}
            />
          </PressableScale>
        ) : undefined
      }
      right={
        <>
          {current ? (
            <HeaderButton
              label="Open native CLI"
              onPress={() =>
                router.push(`/session/${encodeURIComponent(current.sessionId)}/terminal`)
              }
            >
              <Icon as={SquareTerminal} size={17} color={color.textDim} />
            </HeaderButton>
          ) : null}
          <HeaderButton label="Mission actions" onPress={() => setMenuOpen(true)}>
            <Icon as={MoreVertical} size={17} color={color.textDim} />
          </HeaderButton>
        </>
      }
    >
      <BootstrapCrossfade resolved={resolved} placeholder={<DetailSkeleton />}>
        {root ? (
          <MissionBody
            root={root}
            issues={issues}
            sessions={sessions}
            allWorktreePaths={allWorktreePaths}
            current={current}
            currentIssue={currentIssue}
            progress={progress}
            live={live}
            working={working}
            attention={attention}
            accent={accent ?? FLOW_HEX}
            reduceMotion={reduceMotion}
            onOpenSession={openSession}
            onOpenTask={setPeek}
            onLaunchAgent={() => setLaunchOpen(true)}
          />
        ) : (
          <EmptyState title="Mission not found." />
        )}
      </BootstrapCrossfade>

      <TaskSheet
        issue={peek}
        issues={issues}
        sessions={sessions}
        onClose={() => setPeek(null)}
        onOpenSession={(session) => {
          setPeek(null)
          openSession(session)
        }}
        onOpenIssue={(target) => setPeek(target)}
        onToggleTodo={(index, done) => {
          if (!peek) return
          void store.trpc.issues.panelApply
            .mutate({ id: peek.id, op: done ? 'todo-done' : 'todo-undone', index })
            .catch(() => {})
        }}
      />
      <ActionSheet
        visible={menuOpen}
        title={root ? `${issueDisplayRef(root)} ${root.title}` : ''}
        actions={menuActions}
        onClose={() => setMenuOpen(false)}
      />
      <ActionSheet
        visible={launchOpen}
        title="Launch an agent"
        subtitle={
          root && (root.worktreePath ?? root.branch)
            ? 'Joins this task’s existing worktree.'
            : 'Creates the task’s branch and worktree first.'
        }
        actions={LAUNCHABLE.map(({ kind, label }) => ({
          label,
          onPress: () => launch(kind),
        }))}
        onClose={() => setLaunchOpen(false)}
      />
      <IssueColorSheet
        issue={colorOpen ? (root ?? null) : null}
        onClose={() => setColorOpen(false)}
      />
    </Screen>
  )
}

const LAUNCHABLE: { kind: AgentKind; label: string }[] = [
  { kind: 'claude-code', label: 'Claude Code' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'grok', label: 'Grok' },
  { kind: 'opencode', label: 'OpenCode' },
  { kind: 'cursor', label: 'Cursor' },
  { kind: 'shell', label: 'Shell' },
]

function MissionBody({
  root,
  issues,
  sessions,
  allWorktreePaths,
  current,
  currentIssue,
  progress,
  live,
  working,
  attention,
  accent,
  reduceMotion,
  onOpenSession,
  onOpenTask,
  onLaunchAgent,
}: {
  root: IssueWire
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  allWorktreePaths: string[]
  current: SessionMeta | undefined
  currentIssue: IssueWire | undefined
  progress: { total: number; done: number; run: number; block: number; wait: number }
  live: number
  working: number
  attention: number
  accent: string
  reduceMotion: boolean
  onOpenSession: (session: SessionMeta) => void
  onOpenTask: (issue: IssueWire) => void
  onLaunchAgent: () => void
}) {
  const panelHeight = Math.round(Dimensions.get('window').height * PANEL_FRACTION)
  const y = useRef(new Animated.Value(-panelHeight)).current
  const yValue = useRef(-panelHeight)
  const dragStart = useRef(-panelHeight)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const id = y.addListener(({ value }) => {
      yValue.current = value
    })
    return () => y.removeListener(id)
  }, [y])

  const settle = useCallback(
    (next: boolean) => {
      setOpen(next)
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
      Animated.spring(y, {
        toValue: next ? 0 : -panelHeight,
        // JS driver on purpose: the drag below feeds this same node through
        // Animated.Value.setValue, which a native-driven node rejects.
        useNativeDriver: false,
        ...(reduceMotion ? spring.smooth : spring.snappy),
      }).start()
    },
    [panelHeight, reduceMotion, y],
  )

  const pan = usePanGesture({
    activeOffsetY: [-4, 4],
    failOffsetX: [-8, 8],
    runOnJS: true,
    onActivate: () => {
      y.stopAnimation()
      dragStart.current = yValue.current
    },
    onUpdate: ({ translationY }) => {
      const raw = dragStart.current + translationY
      // Rubber-band past fully open: the panel can be pulled further, but at a
      // fraction of the finger, so the stop is felt rather than merely obeyed.
      y.setValue(raw > 0 ? raw * 0.3 : Math.max(raw, -panelHeight))
    },
    onDeactivate: ({ canceled, translationX, translationY, velocityY }) => {
      if (canceled) return settle(open)
      if (Math.abs(translationY) < 6 && Math.abs(translationX) < 6) return settle(!open)
      if (velocityY > FLICK_VELOCITY) return settle(true)
      if (velocityY < -FLICK_VELOCITY) return settle(false)
      settle(dragStart.current + translationY > -panelHeight / 2)
    },
  })

  const scrim = y.interpolate({
    inputRange: [-panelHeight, 0],
    outputRange: [0, 0.55],
    extrapolate: 'clamp',
  })

  return (
    <View style={styles.body}>
      <GestureDetector gesture={pan} touchAction="none" userSelect="none">
        <View>
          <MissionBar
            progress={progress}
            live={live}
            working={working}
            attention={attention}
            accent={accent}
            open={open}
            onToggle={() => settle(!open)}
          />
        </View>
      </GestureDetector>

      <View style={styles.stage}>
        {current ? (
          <SessionConversation key={current.sessionId} session={current} issue={currentIssue} />
        ) : (
          <EmptyState
            fill
            title="No agent on this task yet"
            body="Pull the deck down to see the mission, or launch an agent to get it moving."
          />
        )}

        {/* The scrim is the panel's own shadow on the conversation: it fades in
            with the pull, and it is only interactive once the panel is actually
            open, so a shut deck never eats a tap meant for the transcript. */}
        <Animated.View
          style={[styles.scrim, { opacity: scrim }]}
          pointerEvents={open ? 'auto' : 'none'}
          onTouchEnd={() => settle(false)}
        />

        <Animated.View
          style={[styles.panel, { height: panelHeight, transform: [{ translateY: y }] }]}
          pointerEvents={open ? 'auto' : 'none'}
          accessibilityViewIsModal={open}
        >
          <MissionDeck
            root={root}
            issues={issues}
            sessions={sessions}
            allWorktreePaths={allWorktreePaths}
            accent={accent}
            currentSessionId={current?.sessionId}
            onOpenSession={(session) => {
              onOpenSession(session)
              settle(false)
            }}
            onOpenTask={(issue) => {
              onOpenTask(issue)
              settle(false)
            }}
            onLaunchAgent={() => {
              onLaunchAgent()
              settle(false)
            }}
          />
          {/* The panel's own grab edge, so closing it is the same gesture as
              opening it rather than a hunt for the bar underneath. */}
          <GestureDetector gesture={pan} touchAction="none" userSelect="none">
            <View style={styles.panelGrab}>
              <View style={styles.panelGrabber} />
            </View>
          </GestureDetector>
        </Animated.View>
      </View>
    </View>
  )
}

/**
 * THE MISSION BAR — the deck, collapsed to one line it can always afford.
 *
 * Four facts, in the order an operator triages them: how much of the mission is
 * done, whether anything is asking, who is computing (or who is on the task),
 * and that there is more behind it. The segmented meter is the same derivation
 * the deck's own progress uses, so the shut bar and the open panel can never
 * disagree.
 */
function MissionBar({
  progress,
  live,
  working,
  attention,
  accent,
  open,
  onToggle,
}: {
  progress: { total: number; done: number; run: number; block: number; wait: number }
  live: number
  working: number
  attention: number
  accent: string
  open: boolean
  onToggle: () => void
}) {
  const total = Math.max(1, progress.total)
  const pct = (n: number) => `${Math.round((n / total) * 10000) / 100}%` as const
  const crew = missionCrewLabel(live, working)
  const crewCount = working > 0 ? working : live
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel="Flight deck"
      accessibilityHint={`${progress.done} of ${progress.total} tasks done, ${crew}${attention > 0 ? `, ${attention} asking` : ''}`}
      onPress={onToggle}
      scaleTo={0.995}
      haptic={false}
      style={({ pressed }) => [
        styles.bar,
        { backgroundColor: flow.paneHeaderBg(accent) },
        pressed && styles.barPressed,
      ]}
    >
      <Text style={styles.barLabel}>DECK</Text>
      <Text style={styles.barCount}>
        {progress.done}/{progress.total}
      </Text>
      {crewCount > 0 ? (
        <View style={styles.barLive}>
          {working > 0 ? <BrailleSpinner size={9} /> : null}
          <Text style={styles.barLiveText}>{crewCount}</Text>
        </View>
      ) : null}
      {attention > 0 ? <Text style={styles.barAsk}>{`${attention} asking`}</Text> : null}
      <View style={styles.barSpacer} />
      <View style={open ? styles.chevronOpen : undefined}>
        <Icon as={ChevronDown} size={16} color={color.textDim} />
      </View>
      {/* The bar's baseline rule IS the mission meter — it costs no height, and
          it sits at the seam where the deck will emerge. */}
      <View style={styles.barMeter}>
        <View
          style={[styles.barSeg, { width: pct(progress.done), backgroundColor: color.working }]}
        />
        <View
          style={[
            styles.barSeg,
            { width: pct(progress.run), backgroundColor: alpha(color.working, 0.45) },
          ]}
        />
        <View
          style={[styles.barSeg, { width: pct(progress.block), backgroundColor: color.danger }]}
        />
      </View>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    minHeight: 0,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: space.lg,
    paddingBottom: 3,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  barPressed: {
    opacity: 0.85,
  },
  barLabel: {
    ...monoLabel(),
    color: color.label,
  },
  barCount: {
    ...mono(600),
    color: color.body,
    fontSize: font.micro,
  },
  barLive: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  barLiveText: {
    ...mono(500),
    color: color.working,
    fontSize: font.micro,
  },
  barAsk: {
    ...mono(600),
    color: color.needsYouText,
    fontSize: font.micro,
  },
  barSpacer: {
    flex: 1,
  },
  chevronOpen: {
    transform: [{ rotate: '180deg' }],
  },
  barMeter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    height: 2,
    backgroundColor: alpha(color.border, 0.6),
  },
  barSeg: {
    height: '100%',
  },
  stage: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
  },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: color.bg,
    borderBottomLeftRadius: radius.xl + 4,
    borderBottomRightRadius: radius.xl + 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.borderStrong,
    overflow: 'hidden',
  },
  panelGrab: {
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  panelGrabber: {
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: color.borderStrong,
  },
})
