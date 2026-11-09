import { issueAgentKind, issueAgentLabel, modelLabel } from '@podium/client-core/agent-models'
import { useCommands, useHarnessDescriptors } from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import type { SessionModel } from '@podium/client-graph/models'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asIssueId, type SessionId } from '@podium/model'
import { isFinished } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import * as Haptics from 'expo-haptics'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useMissionOpening } from '../client/hooks'
import { useMobilePool } from '../client/mobile-pool'
import type { MobileTrpc } from '../client/trpc'
import { useIssueCloseGuard } from '../client/use-issue-close'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { HarnessChip } from '../components/AgentMark'
import { ConfiguredIssueLaunchSheet } from '../components/ConfiguredIssueLaunchSheet'
import { Icon } from '../components/Icon'
import { IssueCloseSheet } from '../components/IssueCloseSheet'
import { MoreVertical, SquareTerminal } from '../components/icons'
import { BootstrapCrossfade, DetailSkeleton } from '../components/LaunchPlaceholders'
import { MissionBar } from '../components/MissionBar'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionConversation } from '../components/SessionConversation'
import { TaskSheet } from '../components/TaskSheet'
import { EmptyState } from '../components/ui'
import { mostRelevantSession } from '../lib/mission-session'
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
 * The conversation stays first. The mission bar keeps its vital signs visible,
 * while the full deck now opens in a native form sheet with system detents,
 * dismissal, focus containment, and keyboard behavior.
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
  const store = useCommands<MobileTrpc>()
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
  // must not open on an agent that has since been archived.
  const auto = mostRelevantSession(missionSessions)
  const current =
    missionSessions.find((s) => s.sessionId === pinnedSessionId) ??
    missionSessions.find((s) => s.sessionId === auto?.sessionId) ??
    auto
  useEffect(() => {
    if (requestedSessionId) setPinnedSessionId(requestedSessionId as SessionId)
  }, [requestedSessionId])
  // The header names the task the shown session works on, when it is one of
  // this mission's members; otherwise the mission itself.
  const currentValue =
    ready && current?.issueId && screen.members.has(current.issueId)
      ? screen.reader.issue(current.issueId)
      : undefined
  const currentIssue = currentValue && currentValue !== LOADING ? currentValue : root
  const headerIssue = currentIssue ?? root

  const attention = missionSessions.filter((s) => (s as SessionModel).attention).length
  const live = missionSessions.filter((s) => (s as SessionModel).open).length
  const working = missionSessions.filter((s) => (s as SessionModel).executing).length

  const openSession = useCallback((session: SessionView) => {
    setPinnedSessionId(session.sessionId)
    void Haptics.selectionAsync().catch(() => {})
  }, [])

  const closeAndTuckRoot = useCallback(() => {
    if (!root) return
    setFileRootPending(false)
    void store.issues
      .close(root.id, 'done')
      .then(() => store.issues.setTucked(root.id, true))
      .catch(() => {})
  }, [root, store])
  const fileRoot = useCallback(() => {
    if (!root) return
    if (isFinished(root)) {
      void store.issues.setTucked(root.id, true).catch(() => {})
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
          void store.preferences.setPinned('issue', headerIssue.id, !headerIssue.pinned)
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

  const currentKind = current ? issueAgentKind(current.agentKind) : null
  const currentModel = current?.observedModel ?? current?.model
  // Served descriptors for the session's machine (POD-4475): the harness
  // name and model render from the report, bundled copy offline.
  const { served } = useHarnessDescriptors<MobileTrpc>(current?.machineId)
  const provenance = current
    ? `${issueAgentLabel(current.agentKind, served)}${currentKind && currentModel ? ` · ${modelLabel(currentKind, currentModel, undefined, served)}` : ''}`
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
      leading={
        current ? (
          <HarnessChip kind={current.agentKind} size={20} descriptors={served} />
        ) : undefined
      }
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
        {root && screen ? (
          <MissionBody
            current={current}
            currentIssue={currentIssue}
            full={screen.full}
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
  live,
  working,
  attention,
  findRequest,
  onOpenDetails,
}: {
  current: SessionView | undefined
  currentIssue: IssueViewModel | undefined
  full: FullDeck
  live: number
  working: number
  attention: number
  findRequest: number
  onOpenDetails: () => void
}) {
  return (
    <View style={styles.body}>
      <MissionBar
        full={full}
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

const styles = StyleSheet.create({
  body: {
    flex: 1,
    minHeight: 0,
  },
  stage: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
})
