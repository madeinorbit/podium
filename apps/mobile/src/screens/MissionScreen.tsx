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
} from '@podium/client-core/viewmodels'
import {
  type AgentKind,
  asIssueId,
  type IssueWire,
  type SessionId,
  type SessionMeta,
} from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import * as Haptics from 'expo-haptics'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useBooting, useIssues, useMobileStore, useSessions } from '../client/hooks'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { HarnessChip } from '../components/AgentMark'
import { Icon } from '../components/Icon'
import { IssueCloseSheet } from '../components/IssueCloseSheet'
import { IssueColorSheet } from '../components/IssueColorSheet'
import { ChevronRight, MoreVertical, SquareTerminal } from '../components/icons'
import { BootstrapCrossfade, DetailSkeleton } from '../components/LaunchPlaceholders'
import { PressableScale } from '../components/PressableScale'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionConversation } from '../components/SessionConversation'
import { TaskSheet } from '../components/TaskSheet'
import { EmptyState } from '../components/ui'
import { WorkingMark } from '../components/WorkingMark'
import { issueAgentKind, modelLabel } from '../lib/agent-models'
import { issueCloseBlockers } from '../lib/issue-close'
import { mostRelevantSession } from '../lib/mission-session'
import { alpha } from '../theme/mix'
import { color, font, mono, monoLabel, space } from '../theme/theme'

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
 * The conversation stays first. The mission bar keeps its vital signs visible,
 * while the full deck now opens in a native form sheet with system detents,
 * dismissal, focus containment, and keyboard behavior.
 */

export function MissionScreen() {
  const params = useLocalSearchParams<{
    missionId: string | string[]
    sessionId?: string | string[]
  }>()
  const raw = Array.isArray(params.missionId) ? params.missionId[0] : (params.missionId ?? '')
  const selectedId = asIssueId(decodeURIComponent(raw))
  const router = useRouter()
  const store = useMobileStore()
  const booting = useBooting()
  const issues = useIssues()
  const sessions = useSessions()
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

  const requestedSessionId = Array.isArray(params.sessionId)
    ? params.sessionId[0]
    : params.sessionId
  const [pinnedSessionId, setPinnedSessionId] = useState<SessionId | null>(
    requestedSessionId ? (requestedSessionId as SessionId) : null,
  )
  const [peek, setPeek] = useState<IssueWire | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [launchOpen, setLaunchOpen] = useState(false)
  const [colorOpen, setColorOpen] = useState(false)
  const [fileRootPending, setFileRootPending] = useState(false)
  const [findRequest, setFindRequest] = useState(0)

  // An explicit pick from the deck outranks the automatic one, but only while it
  // still names a session on THIS mission — a mission you return to hours later
  // must not open on an agent that has since been archived.
  const auto = useMemo(() => mostRelevantSession(missionSessions), [missionSessions])
  const current =
    missionSessions.find((s) => s.sessionId === pinnedSessionId) ??
    missionSessions.find((s) => s.sessionId === auto?.sessionId) ??
    auto
  useEffect(() => {
    if (requestedSessionId) setPinnedSessionId(requestedSessionId as SessionId)
  }, [requestedSessionId])
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

  const openSession = useCallback((session: SessionMeta) => {
    setPinnedSessionId(session.sessionId)
    void Haptics.selectionAsync().catch(() => {})
  }, [])

  const launch = useCallback(
    (agentKind?: AgentKind) => {
      if (!root) return
      const input = agentKind ? { id: root.id, agentKind } : { id: root.id }
      void spawnIssueAgent(store.trpc.issues, input).catch(() => {})
    },
    [root, store.trpc],
  )

  /** The same host-capability reading as the desktop deck. This launch sheet
   * cannot become a login pane after the pick, so its signed-out warning is a
   * disabled row here; the visible hint still says how to repair it. */
  const launchHosts = useMemo(() => {
    if (!root) return []
    const views = machineViewsFromWire(store.machines)
    if (root.machineId) return views.filter((view) => view.machine.id === root.machineId)
    const repo = reposToViews(store.repos).find((candidate) => candidate.path === root.repoPath)
    const ids = new Set((repo?.machines ?? []).map((machine) => machine.machineId))
    return views.filter((view) => ids.has(view.machine.id))
  }, [root, store.machines, store.repos])
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
    void store
      .closeIssue(root.id, 'done')
      .then(() => store.setIssueTucked(root.id, true))
      .catch(() => {})
  }, [root, store])
  const fileRoot = useCallback(() => {
    if (!root) return
    if (root.closedReason || root.stage === 'done') {
      void store.setIssueTucked(root.id, true).catch(() => {})
      return
    }
    if (issueCloseBlockers(root, sessions).length > 0) {
      setFileRootPending(true)
      return
    }
    closeAndTuckRoot()
  }, [closeAndTuckRoot, root, sessions, store])

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
      { label: 'Colour…', onPress: () => setColorOpen(true) },
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
            current={current}
            currentIssue={currentIssue}
            progress={progress}
            live={live}
            working={working}
            attention={attention}
            findRequest={findRequest}
            onOpenDetails={() =>
              router.push(
                `/mission/${encodeURIComponent(root.id)}/details${current ? `?sessionId=${encodeURIComponent(current.sessionId)}` : ''}`,
              )
            }
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

const LAUNCHABLE: { kind: AgentKind; label: string }[] = [
  { kind: 'claude-code', label: 'Claude Code' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'grok', label: 'Grok' },
  { kind: 'opencode', label: 'OpenCode' },
  { kind: 'cursor', label: 'Cursor' },
  { kind: 'pi', label: 'Pi' },
  { kind: 'shell', label: 'Shell' },
]

function MissionBody({
  current,
  currentIssue,
  progress,
  live,
  working,
  attention,
  findRequest,
  onOpenDetails,
}: {
  current: SessionMeta | undefined
  currentIssue: IssueWire | undefined
  progress: MissionProgress
  live: number
  working: number
  attention: number
  findRequest: number
  onOpenDetails: () => void
}) {
  return (
    <View style={styles.body}>
      <MissionBar
        progress={progress}
        live={live}
        working={working}
        attention={attention}
        onOpen={onOpenDetails}
      />

      <View style={styles.stage}>
        {current ? (
          <SessionConversation
            key={current.sessionId}
            session={current}
            issue={currentIssue}
            findRequest={findRequest}
          />
        ) : (
          <EmptyState
            fill
            title="No agent on this task yet"
            body="Open mission details to review the deck, or launch an agent to get it moving."
          />
        )}
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
  onOpen,
}: {
  progress: MissionProgress
  live: number
  working: number
  attention: number
  onOpen: () => void
}) {
  const total = Math.max(1, progress.total)
  const pct = (n: number) => `${Math.round((n / total) * 10000) / 100}%` as const
  const crew = missionCrewLabel(live, working)
  const crewCount = working > 0 ? working : live
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel="Mission details"
      accessibilityHint={`${progress.done} of ${progress.total} tasks done, ${crew}${progress.stall > 0 ? `, ${progress.stall} stalled` : ''}${attention > 0 ? `, ${attention} asking` : ''}`}
      onPress={onOpen}
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
      <Icon as={ChevronRight} size={16} color={color.textDim} />
      {/* The bar's baseline rule IS the mission meter — it costs no height, and
          it sits at the seam where the deck will emerge. */}
      <View style={styles.barMeter}>
        <View
          style={[styles.barSeg, { width: pct(progress.done), backgroundColor: color.workingText }]}
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
    color: color.workingText,
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
})
