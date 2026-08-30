import { useSlice } from '@podium/client-core/react'
import {
  agentFleetStatus,
  candidateFromAvailability,
  isSessionWorking,
  type MissionProgress,
  machineViewsFromWire,
  missionCrewLabel,
  missionProgress,
  missionRootFor,
  missionSessions as missionSessionsOf,
  panelLabel,
  reposToViews,
  sessionNeedsHuman,
  spawnIssueAgent,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import {
  type AgentKind,
  asIssueId,
  type IssueId,
  type IssueWire,
  type SessionId,
  type SessionMeta,
} from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import * as Haptics from 'expo-haptics'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronDown, MoreVertical, SquareTerminal } from '../components/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Dimensions, StyleSheet, Text, View } from 'react-native'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'
import Animated, {
  cancelAnimation,
  Extrapolation,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated'
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets'
import {
  useBooting,
  useIssues,
  useMachines,
  useRepos,
  useSessions,
  useStoreActions,
  useTrpc,
} from '../client/hooks'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { HarnessChip } from '../components/AgentMark'
import { Icon } from '../components/Icon'
import { IssueCloseSheet } from '../components/IssueCloseSheet'
import { IssueColorSheet } from '../components/IssueColorSheet'
import { BootstrapCrossfade, DetailSkeleton } from '../components/LaunchPlaceholders'
import { MissionDeck } from '../components/MissionDeck'
import { PressableScale } from '../components/PressableScale'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionConversation } from '../components/SessionConversation'
import { TaskSheet } from '../components/TaskSheet'
import { EmptyState } from '../components/ui'
import { WorkingMark } from '../components/WorkingMark'
import { issueAgentKind, modelLabel } from '../lib/agent-models'
import { DECK_GRAB_H, deckPanelHeight } from '../lib/deck-rows'
import { issueCloseBlockers } from '../lib/issue-close'
import { mostRelevantSession } from '../lib/mission-session'
import { FLOW_HEX, issueColorHex } from '../theme/issueColors'
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

/**
 * How much of the screen the deck panel may claim when fully open. This is the
 * CAP, not the height: the panel is sized to the deck's own rows
 * (`deckPanelHeight`), so a two-item mission opens a two-item panel, and only
 * a deck taller than this fraction fills it and scrolls internally.
 */
const PANEL_FRACTION = 0.62
/** Past this velocity the flick decides, not the position. */
const FLICK_VELOCITY = 450

const DECK_SPRING = {
  ...spring.snappy,
  reduceMotion: ReduceMotion.System,
}

function impactLight() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
}

export function MissionScreen() {
  const params = useLocalSearchParams<{ missionId: string | string[] }>()
  const raw = Array.isArray(params.missionId) ? params.missionId[0] : (params.missionId ?? '')
  const selectedId = asIssueId(decodeURIComponent(raw))
  const router = useRouter()
  // Narrow subscriptions: actions and trpc are identity-stable statics, and
  // machines/repos are selected per field, so the screen hosting the live
  // conversation re-renders only when data IT paints actually moves.
  const { setIssueTucked, updateIssue, closeIssue } = useStoreActions()
  const trpc = useTrpc()
  const machines = useMachines()
  const repos = useRepos()
  const booting = useBooting()
  const issues = useIssues()
  const sessions = useSessions()
  // The worktree-path index the worklist already derives once per snapshot —
  // deriving it a second time here is exactly the per-consumer cost the
  // published slice exists to remove.
  const { allWorktreePaths } = useSlice(worklistSlice)
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
  const [fileRootPending, setFileRootPending] = useState(false)

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
  const headerIssue = currentIssue ?? root

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
      const input = agentKind ? { id: root.id, agentKind } : { id: root.id }
      void spawnIssueAgent(trpc.issues, input).catch(() => {})
    },
    [root, trpc],
  )

  /** The same host-capability reading as the desktop deck. This launch sheet
   * cannot become a login pane after the pick, so its signed-out warning is a
   * disabled row here; the visible hint still says how to repair it. */
  const launchHosts = useMemo(() => {
    if (!root) return []
    const views = machineViewsFromWire(machines)
    if (root.machineId) return views.filter((view) => view.machine.id === root.machineId)
    const repo = reposToViews(repos).find((candidate) => candidate.path === root.repoPath)
    const ids = new Set((repo?.machines ?? []).map((machine) => machine.machineId))
    return views.filter((view) => ids.has(view.machine.id))
  }, [root, machines, repos])
  const launchActions = useMemo<SheetAction[]>(
    () =>
      LAUNCHABLE.map(({ kind, label }) => {
        // No recorded hosts means inventory has not arrived; keep the option
        // offered, matching the desktop's fail-open rule for unknown inventory.
        const status =
          launchHosts.length === 0
            ? {}
            : agentFleetStatus(
                launchHosts.map((view) =>
                  candidateFromAvailability(view.machine, view.availability, kind),
                ),
                label,
              )
        return {
          label,
          ...(status.hint ? { hint: status.hint } : {}),
          disabled: status.reason !== undefined || status.warning !== undefined,
          onPress: () => launch(kind),
        }
      }),
    [launch, launchHosts],
  )

  const closeAndTuckRoot = useCallback(() => {
    if (!root) return
    setFileRootPending(false)
    void closeIssue(root.id, 'done')
      .then(() => setIssueTucked(root.id, true))
      .catch(() => {})
  }, [closeIssue, root, setIssueTucked])
  const fileRoot = useCallback(() => {
    if (!root) return
    if (root.closedReason || root.stage === 'done') {
      void setIssueTucked(root.id, true).catch(() => {})
      return
    }
    if (issueCloseBlockers(root, sessions).length > 0) {
      setFileRootPending(true)
      return
    }
    closeAndTuckRoot()
  }, [closeAndTuckRoot, root, sessions, setIssueTucked])

  const menuActions = useMemo<SheetAction[]>(() => {
    if (!root) return []
    return [
      {
        label: 'Task details',
        hint: 'The full task page',
        onPress: () => router.push(`/issue/${encodeURIComponent(root.id)}`),
      },
      {
        label: headerIssue?.pinned ? 'Unpin' : 'Pin',
        onPress: () => {
          if (!headerIssue) return
          void updateIssue(headerIssue.id, { pinned: !headerIssue.pinned })
        },
      },
      { label: 'Launch an agent…', onPress: () => setLaunchOpen(true) },
      {
        label: 'Add a shell',
        hint: 'A terminal session on this task’s checkout',
        // The same dispatch the deck's launch sheet used when Shell lived
        // there: spawn the shell harness onto the mission root.
        onPress: () => launch('shell'),
      },
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
  }, [current, headerIssue, launch, root, router, updateIssue])

  const resolved = root !== undefined || (!booting && issues.length > 0)
  const currentKind = current ? issueAgentKind(current.agentKind) : null
  const currentModel = current?.observedModel ?? current?.model
  const provenance = current
    ? `${current.agentKind === 'claude-code' ? 'Claude Code' : panelLabel(current.agentKind)}${currentKind && currentModel ? ` · ${modelLabel(currentKind, currentModel)}` : ''}`
    : null

  return (
    <Screen
      title={headerIssue ? headerIssue.title : 'Mission'}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/work'))}
      bareBack
      monoSubtitle
      subtitle={
        current
          ? `${headerIssue ? issueDisplayRef(headerIssue) : ''}${headerIssue ? '   ' : ''}${provenance}`
          : root
            ? 'No agent on this mission'
            : undefined
      }
      leading={current ? <HarnessChip kind={current.agentKind} size={20} /> : undefined}
      right={
        <>
          {current ? (
            <HeaderButton
              label="Open native CLI"
              size={32}
              onPress={() =>
                router.push(`/session/${encodeURIComponent(current.sessionId)}/terminal`)
              }
            >
              <Icon as={SquareTerminal} size={17} color={color.textDim} />
            </HeaderButton>
          ) : null}
          <HeaderButton label="Mission actions" onPress={() => setMenuOpen(true)} size={32} bare>
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
            onOpenSession={openSession}
            onOpenTask={setPeek}
            onLaunchAgent={() => setLaunchOpen(true)}
            onTuckRoot={() => {
              void setIssueTucked(root.id, true).catch(() => {})
            }}
            onFileRoot={fileRoot}
            onOpenDeparture={(issueId) => router.push(`/mission/${encodeURIComponent(issueId)}`)}
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
      />
      <ActionSheet
        visible={menuOpen}
        testID="mission-actions-sheet"
        title={root ? `${issueDisplayRef(root)} ${root.title}` : ''}
        actions={menuActions}
        onClose={() => setMenuOpen(false)}
      />
      <ActionSheet
        visible={launchOpen}
        title="Launch an agent"
        subtitle={
          root?.worktreePath
            ? 'Joins this task’s existing worktree.'
            : root?.branch
              ? 'Restores this task’s worktree first.'
              : 'Creates the task’s branch and worktree first.'
        }
        actions={launchActions}
        onClose={() => setLaunchOpen(false)}
      />
      <IssueColorSheet
        issue={colorOpen ? (root ?? null) : null}
        onClose={() => setColorOpen(false)}
      />
      {root ? (
        <IssueCloseSheet
          issue={root}
          sessions={sessions}
          reason={fileRootPending ? 'done' : null}
          onConfirm={closeAndTuckRoot}
          onClose={() => setFileRootPending(false)}
        />
      ) : null}
    </Screen>
  )
}

// No Shell here: the launch sheet is for AGENTS. Opening a terminal on the
// task lives in the chat's 3-dots menu as "Add a shell" (2026-08-27 device
// review), on the same spawn path this list uses.
const LAUNCHABLE: { kind: AgentKind; label: string }[] = [
  { kind: 'claude-code', label: 'Claude Code' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'grok', label: 'Grok' },
  { kind: 'opencode', label: 'OpenCode' },
  { kind: 'cursor', label: 'Cursor' },
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
  onOpenSession,
  onOpenTask,
  onLaunchAgent,
  onTuckRoot,
  onFileRoot,
  onOpenDeparture,
}: {
  root: IssueWire
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  allWorktreePaths: string[]
  current: SessionMeta | undefined
  currentIssue: IssueWire | undefined
  progress: MissionProgress
  live: number
  working: number
  attention: number
  accent: string
  onOpenSession: (session: SessionMeta) => void
  onOpenTask: (issue: IssueWire) => void
  onLaunchAgent: () => void
  onTuckRoot: () => void
  onFileRoot: () => void
  onOpenDeparture: (issueId: IssueId) => void
}) {
  const maxPanelHeight = Math.round(Dimensions.get('window').height * PANEL_FRACTION)
  // The deck reports its natural height (a pure derivation over its rows) and
  // the panel takes it, clamped between "controls plus a couple of strips" and
  // the historical fraction cap. Until the first report the cap stands in —
  // the panel is shut while that is true, so no wrong size is ever visible.
  const [contentHeight, setContentHeight] = useState<number | null>(null)
  const panelHeight = deckPanelHeight(contentHeight, maxPanelHeight)
  // The gesture math and the spring both read the height from a shared value:
  // the worklets run on the UI thread, and a height that changed between
  // render and release must not leave the flick clamping to a stale panel.
  const panelH = useSharedValue(panelHeight)
  const y = useSharedValue(-panelHeight)
  const dragStart = useSharedValue(-panelHeight)
  const dragging = useSharedValue(false)
  const openTarget = useSharedValue(false)
  const [open, setOpen] = useState(false)
  /**
   * LAZY-MOUNTED DECK. Ninety percent of a phone visit ends in the transcript
   * (see the screen doc above), yet the 900-line deck used to mount — and
   * re-derive its ~15 memos on every issues/sessions delta — beneath a panel
   * translated fully off screen. Nothing renders until the first bar tap or
   * drag reaches for it; after that it STAYS mounted so open/close is instant
   * and the fold/mode state survives. First-open sizing is unchanged:
   * `deckPanelHeight` falls back to the cap until the deck's first
   * onContentHeight report, and the settle spring already re-targets height
   * when the report lands.
   */
  const [deckMounted, setDeckMounted] = useState(false)
  const mountDeck = useCallback(() => setDeckMounted(true), [])

  const commitOpen = useCallback((next: boolean) => {
    setOpen(next)
    if (next) setDeckMounted(true)
  }, [])

  const settleOnUI = useCallback(
    (next: boolean, velocity = 0) => {
      'worklet'
      dragging.set(false)
      openTarget.set(next)
      scheduleOnRN(commitOpen, next)
      scheduleOnRN(impactLight)
      y.set(withSpring(next ? 0 : -panelH.get(), { ...DECK_SPRING, velocity }))
    },
    [commitOpen, dragging, openTarget, panelH, y],
  )

  // ROWS APPEAR AND DISAPPEAR WHILE THE PANEL IS UP — an agent launches, a
  // fold closes — and the bottom edge settles to the new height on the same
  // spring the open uses rather than jumping. Shut, the panel snaps silently:
  // it sits at `-height` off screen, so the closed offset must track the new
  // height in the same frame or a sliver of deck peeks under the bar.
  useEffect(() => {
    scheduleOnUI((height: number) => {
      'worklet'
      if (panelH.get() === height) return
      if (openTarget.get()) {
        panelH.set(withSpring(height, DECK_SPRING))
        return
      }
      panelH.set(height)
      // Mid-pull the finger owns `y`; the release settles onto the new height.
      if (!dragging.get()) {
        cancelAnimation(y)
        y.set(-height)
      }
    }, panelHeight)
  }, [dragging, openTarget, panelH, panelHeight, y])

  const settle = useCallback(
    (next: boolean, velocity = 0) => {
      scheduleOnUI(settleOnUI, next, velocity)
    },
    [settleOnUI],
  )

  const toggle = useCallback(() => {
    scheduleOnUI(() => {
      'worklet'
      settleOnUI(!openTarget.get())
    })
  }, [openTarget, settleOnUI])

  const beginDrag = useCallback(() => {
    'worklet'
    cancelAnimation(y)
    dragging.set(true)
    dragStart.set(y.get())
    // The pull is the earliest signal the deck is wanted — mount it now so the
    // panel the finger is revealing has content by the time it shows.
    scheduleOnRN(mountDeck)
  }, [dragStart, dragging, mountDeck, y])

  const moveDrag = useCallback(
    (translationY: number) => {
      'worklet'
      const raw = dragStart.get() + translationY
      // Rubber-band past fully open: the panel can be pulled further, but at a
      // fraction of the finger, so the stop is felt rather than merely obeyed.
      y.set(raw > 0 ? raw * 0.3 : Math.max(raw, -panelH.get()))
    },
    [dragStart, panelH, y],
  )

  const endDrag = useCallback(
    (event: {
      canceled: boolean
      translationX: number
      translationY: number
      velocityY: number
    }) => {
      'worklet'
      const { canceled, translationX, translationY, velocityY } = event
      if (canceled) return settleOnUI(openTarget.get())
      if (Math.abs(translationY) < 6 && Math.abs(translationX) < 6) {
        return settleOnUI(!openTarget.get())
      }
      if (velocityY > FLICK_VELOCITY) return settleOnUI(true, velocityY)
      if (velocityY < -FLICK_VELOCITY) return settleOnUI(false, velocityY)
      settleOnUI(dragStart.get() + translationY > -panelH.get() / 2, velocityY)
    },
    [dragStart, openTarget, panelH, settleOnUI],
  )

  // A gesture instance owns one native handler tag. The bar and panel edge need
  // distinct instances even though their worklet callbacks and physics match.
  const barPan = usePanGesture({
    activeOffsetY: [-4, 4],
    failOffsetX: [-8, 8],
    onActivate: () => {
      'worklet'
      beginDrag()
    },
    onUpdate: ({ translationY }) => {
      'worklet'
      moveDrag(translationY)
    },
    onDeactivate: (event) => {
      'worklet'
      endDrag(event)
    },
  })

  const panelPan = usePanGesture({
    activeOffsetY: [-4, 4],
    failOffsetX: [-8, 8],
    onActivate: () => {
      'worklet'
      beginDrag()
    },
    onUpdate: ({ translationY }) => {
      'worklet'
      moveDrag(translationY)
    },
    onDeactivate: (event) => {
      'worklet'
      endDrag(event)
    },
  })

  // Stable handlers so the memoized deck re-renders only when its DATA moves —
  // inline arrows here would mint new props every MissionBody render and void
  // the React.memo on MissionDeck.
  const deckOpenSession = useCallback(
    (session: SessionMeta) => {
      onOpenSession(session)
      settle(false)
    },
    [onOpenSession, settle],
  )
  const deckOpenTask = useCallback(
    (issue: IssueWire) => {
      onOpenTask(issue)
      settle(false)
    },
    [onOpenTask, settle],
  )
  const deckLaunchAgent = useCallback(() => {
    onLaunchAgent()
    settle(false)
  }, [onLaunchAgent, settle])
  const deckTuckRoot = useCallback(() => {
    onTuckRoot()
    settle(false)
  }, [onTuckRoot, settle])
  const deckFileRoot = useCallback(() => {
    onFileRoot()
    settle(false)
  }, [onFileRoot, settle])
  const deckOpenDeparture = useCallback(
    (issueId: IssueId) => {
      onOpenDeparture(issueId)
      settle(false)
    },
    [onOpenDeparture, settle],
  )

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.get(), [-panelH.get(), 0], [0, 0.55], Extrapolation.CLAMP),
  }))

  const panelStyle = useAnimatedStyle(() => ({
    height: panelH.get(),
    transform: [{ translateY: y.get() }],
  }))

  return (
    <View style={styles.body}>
      <GestureDetector gesture={barPan} touchAction="none" userSelect="none">
        <View>
          <MissionBar
            progress={progress}
            live={live}
            working={working}
            attention={attention}
            open={open}
            onToggle={toggle}
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
          testID="mission-deck-backdrop"
          style={[styles.scrim, scrimStyle]}
          pointerEvents={open ? 'auto' : 'none'}
          onTouchEnd={() => settle(false)}
        />

        <Animated.View
          testID="mission-deck-panel"
          style={[styles.panel, panelStyle]}
          pointerEvents={open ? 'auto' : 'none'}
          accessibilityViewIsModal={open}
        >
          {deckMounted ? (
            <MissionDeck
              root={root}
              issues={issues}
              sessions={sessions}
              allWorktreePaths={allWorktreePaths}
              accent={accent}
              currentSessionId={current?.sessionId}
              onOpenSession={deckOpenSession}
              onOpenTask={deckOpenTask}
              onLaunchAgent={deckLaunchAgent}
              onTuckRoot={deckTuckRoot}
              onFileRoot={deckFileRoot}
              onOpenDeparture={deckOpenDeparture}
              onContentHeight={setContentHeight}
            />
          ) : null}
          {/* The panel's own grab edge, so closing it is the same gesture as
              opening it rather than a hunt for the bar underneath. */}
          <GestureDetector gesture={panelPan} touchAction="none" userSelect="none">
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
  open,
  onToggle,
}: {
  progress: MissionProgress
  live: number
  working: number
  attention: number
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
      // `aria-expanded` beside `accessibilityState`: react-native-web 0.21 reads
      // only the former, so the web build announced no state at all. [POD-1664]
      accessibilityState={{ expanded: open }}
      aria-expanded={open}
      accessibilityLabel="Flight deck"
      accessibilityHint={`${progress.done} of ${progress.total} tasks done, ${crew}${progress.stall > 0 ? `, ${progress.stall} stalled` : ''}${attention > 0 ? `, ${attention} asking` : ''}`}
      onPress={onToggle}
      scaleTo={0.995}
      haptic={false}
      style={({ pressed }) => [styles.bar, pressed && styles.barPressed]}
    >
      <Text style={styles.barLabel}>DECK</Text>
      <Text style={styles.barCount}>
        {progress.done}/{progress.total}
      </Text>
      {crewCount > 0 ? (
        <View style={styles.barLive}>
          {working > 0 ? <WorkingMark size={11} /> : null}
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
          style={[styles.barSeg, { width: pct(progress.review), backgroundColor: color.needsYou }]}
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
    backgroundColor: color.bar,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairlineBar,
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
    height: DECK_GRAB_H,
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
