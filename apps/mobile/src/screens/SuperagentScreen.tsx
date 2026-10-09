import { loadedPaneSession } from '@podium/client-graph/session-pane'
import { useModelCatalog } from '@podium/client-core/react'
import type { Conversation } from '@podium/client-core/conversation'
import type { SuperagentSliceValue } from '@podium/client-core/values'
import { buildImagePrompt, matchesQuestionInteraction } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { superagentQuestion, superagentState } from '@podium/client-graph/superagent'
import { asThreadId, type SessionId } from '@podium/model'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { action } from 'mobx'
import { observer } from 'mobx-react-lite'
import { useThreadConversation } from '../client/use-thread-conversation'
import { pendingTurnOf } from '../components/pending-delivery'
import { StyleSheet, Text, View } from 'react-native'
import { useHttpOrigin, useStoreActions, useTrpc } from '../client/hooks'
import { useMobilePoolProjection } from '../client/mobile-pool'
import type { MobileTrpc } from '../client/trpc'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icon'
import { Eraser } from '../components/icons'
import { BootstrapCrossfade, TranscriptSkeleton } from '../components/LaunchPlaceholders'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { HeaderButton, Screen } from '../components/Screen'
import { SuperagentBackendRail } from '../components/SuperagentBackendRail'
import { type PendingTurn, TranscriptList } from '../components/TranscriptList'
import { EmptyState } from '../components/ui'
import { type SentAttachment, useComposerAttachments } from '../components/useComposerAttachments'
import { useKeyboardLift } from '../hooks/useKeyboardHeight'
import { useRefreshableList } from '../hooks/useRefreshableTab'
import { useTabBarInset } from '../hooks/useTabBarInset'
import { humanizeSendFailure } from '../lib/send-failure'
import {
  applySuperagentModelPick,
  resolveSuperagentBackend,
  superagentTurnChoice,
  type SuperagentBackendPick,
} from '../lib/superagent-backend'
import { liveTranscriptItem } from '../lib/superagent-transcript'
import { color, font, sans, space } from '../theme/theme'

/**
 * The Superagent — the phone half of the engraved column's chat [POD-338].
 * It is the desktop surface, not a variant of it:
 *
 *  - ONE thread, always `global` (desktop `THREAD_ID`). Per-thread history is
 *    not a phone decision.
 *  - The SAME Flat Field transcript the session chat renders (the desktop
 *    embeds `ChatView` here for exactly this reason) instead of a second,
 *    bespoke chat vocabulary — and, since POD-344, over the same SOURCE: the
 *    thread's headless session transcript, and only that. `superagent.history`
 *    is the frozen legacy buffer, so a screen built on it rendered neither the
 *    turn it just sent nor the reply — the phone hung on "sending" forever.
 *    The desktop reads none of it and neither does this; see
 *    ../lib/superagent-transcript for why folding it back in is a trap.
 *  - Laid out like every other tab: the large Screen header Work and Tasks
 *    wear, one scroller, composer docked above the tab bar. Model and effort
 *    sit under the well, same contract as the desktop prompt-box rail.
 */
const THREAD_ID = asThreadId('global')
type LocalPendingTurn = PendingTurn & { wire: string }

const EMPTY_SUPERAGENT: SuperagentSliceValue & { booting: boolean; loading: boolean } = {
  threads: [],
  active: undefined,
  activeSessionId: undefined,
  booting: true,
  loading: true,
}
function usePoolSuperagent() {
  return useMobilePoolProjection(superagentState, EMPTY_SUPERAGENT)
}
function usePoolQuestion(id: SessionId | undefined) {
  const read = useCallback((pool: MobxPool) => superagentQuestion(pool, id).question, [id])
  return useMobilePoolProjection(read, undefined)
}
function usePoolTranscriptSession(id: SessionId | undefined) {
  const read = useCallback((pool: MobxPool) => loadedPaneSession(pool, id), [id])
  return useMobilePoolProjection(read, undefined)
}

export const SuperagentScreen = observer(function SuperagentScreen() {
  // Narrow subscriptions: everything this screen reads off the store is
  // either an identity-stable static or the sessions slice it paints from.
  const trpc = useTrpc()
  const { refreshSuperThreads } = useStoreActions()
  const httpOrigin = useHttpOrigin()
  // The signed-in user's threads, from the store's published slice — the same
  // one the desktop superagent column reads. The screen used to fetch the list
  // itself on mount AND poll it on a 5s interval, which is a second copy of
  // state the store already holds, with its own staleness.
  //
  // The slice keys on `store.superThreadId`, which is 'global' by default and
  // which this screen never changes: one thread, always global, is the phone's
  // whole superagent model. `threadById` is deliberately not
  // used — the slice exposes no lookup that takes a bare id and goes looking,
  // which is what makes another user's thread unaddressable from here
  // (doc §3.1.6 S2).
  const superagent = usePoolSuperagent()
  const booting = superagent.booting
  const tabBarInset = useTabBarInset()
  const { connected, onRefresh, refreshing, refreshControl, refreshAccessibilityProps } =
    useRefreshableList()
  const [threadsLoaded, setThreadsLoaded] = useState(false)
  const followTranscript = useCallback((following: boolean) => {
    history.current.following = following
  }, [])
  const searchTranscript = useCallback((searching: boolean) => {
    history.current.searching = searching
  }, [])
  const [backendPick, setBackendPick] = useState<SuperagentBackendPick>({})
  const backend = useMemo(
    () => resolveSuperagentBackend(superagent.active, backendPick),
    [superagent.active, backendPick],
  )
  const history = useRef({ following: true, searching: false })
  const { conversation, podiumSid, binding } = useThreadConversation(history.current)
  const transcript = conversation?.transcript
  const transcriptLoaded = transcript?.initialLoaded ?? false
  const itemCount = transcript?.ids.length ?? 0
  const running = conversation?.turnRunning ?? false
  const justSent = conversation?.sends.justSent ?? false
  const working = running || justSent
  const statusLabel = conversation?.headless?.label
  const error = conversation?.turnError ?? null
  const currentQuestion = usePoolQuestion(podiumSid)
  const transcriptSession = usePoolTranscriptSession(podiumSid)
  const modelCatalog = useModelCatalog<MobileTrpc>(transcriptSession?.machineId)
  const prepareAttachmentSession = useCallback(async (): Promise<SessionId> => {
    if (podiumSid) return podiumSid
    const result = await trpc.superagent.ensureSession.mutate({ threadId: THREAD_ID })
    if (!result.podiumSessionId) throw new Error('Superagent could not prepare this attachment.')
    action(() => {
      binding.acked = result.podiumSessionId
    })()
    return result.podiumSessionId
  }, [binding, podiumSid, trpc.superagent.ensureSession])
  const attachments = useComposerAttachments(podiumSid, {
    prepareSession: prepareAttachmentSession,
  })
  const [draftInsertion, setDraftInsertion] = useState<{ id: number; text: string } | null>(null)
  const insertionSeq = useRef(0)
  // Each send re-pins the feed to its tail so the just-written turn is on
  // screen even if the operator had scrolled up (the web chat's pinToBottom).
  const [pinRequest, setPinRequest] = useState(0)
  const keyboardLift = useKeyboardLift()
  // The store owns the thread list; this completion bit only distinguishes an
  // unresolved first read from a genuinely empty global thread. The engine's
  // boot refresh may already have won, in which case this is a cheap refresh.
  useEffect(() => {
    let alive = true
    void refreshSuperThreads()
      .catch(() => {})
      .finally(() => {
        if (alive) setThreadsLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [refreshSuperThreads])

  const pendingTurns = conversation?.sends.bubbles.map(pendingTurnOf) ?? []
  const loadOlder = useCallback(() => {
    void conversation?.transcript.loadOlder()
  }, [conversation])
  const send = useCallback(
    (text: string, files?: readonly SentAttachment[]) => {
      const trimmed = text.trim(),
        attached = files ?? []
      if (!conversation || (!trimmed && attached.length === 0)) return
      setPinRequest((count) => count + 1)
      void conversation.sends.submit({
        text: trimmed,
        backend: superagentTurnChoice(backend),
        wire: buildImagePrompt(
          attached.map((file) => file.path),
          trimmed,
        ),
        ...(attached.length
          ? { files: attached, toolPaths: attached.map((file) => file.path) }
          : {}),
      })
    },
    [conversation, backend],
  )
  const retry = useCallback(
    (turn: PendingTurn) => {
      if (!conversation) return
      if (turn.id.startsWith('restored:')) {
        send(turn.text)
        return
      }
      setPinRequest((count) => count + 1)
      void conversation.sends.retry(turn.id)
    },
    [conversation, send],
  )
  const interrupt = useCallback(async () => {
    if (!conversation) return
    await conversation.sends.interrupt(conversation.draft)
    conversation.finishTurn()
  }, [conversation])

  const clear = useCallback(async () => {
    try {
      await trpc.superagent.clear.mutate({ threadId: THREAD_ID })
      // The server drops the thread's harness+headless binding, so the old
      // session's transcript is no longer this thread's: forget it and let the
      // next turn's ack hand back a fresh session.
      action(() => {
        binding.cleared = podiumSid
        binding.acked = undefined
      })()
      attachments.clear()
      conversation?.clear()
      void refreshSuperThreads().catch(() => {})
    } catch (error) {
      conversation?.setTurnError(humanizeSendFailure(error))
    }
  }, [attachments.clear, binding, conversation, podiumSid, refreshSuperThreads, trpc])

  const liveItem = useMemo(
    () => liveTranscriptItem(conversation?.headless?.text ?? '', running),
    [conversation?.headless?.text, running],
  )
  const visibleRestoredFailure =
    pendingTurns.length === 0 && !working ? conversation?.visibleFailure : null
  const restoredRow = useMemo((): LocalPendingTurn | null => {
    if (!visibleRestoredFailure?.userText) return null
    return {
      id: `restored:${visibleRestoredFailure.inputId}`,
      text: visibleRestoredFailure.userText,
      wire: visibleRestoredFailure.userText,
      failed: visibleRestoredFailure.error,
    }
  }, [visibleRestoredFailure])
  const visibleError = error ?? visibleRestoredFailure?.error ?? null
  const visiblePendingTurns = useMemo(
    () => (restoredRow ? [...pendingTurns, restoredRow] : pendingTurns),
    [pendingTurns, restoredRow],
  )
  // POD-332 retired `MobileClientValue` (and with it `client.sessionById`): every
  // screen reads the same store and the same published slices as the web.
  const transcriptResolved = podiumSid
    ? transcriptLoaded || itemCount > 0 || liveItem !== undefined
    : threadsLoaded
  const resolved = !booting && transcriptResolved
  const empty =
    resolved &&
    itemCount === 0 &&
    liveItem === undefined &&
    visiblePendingTurns.length === 0 &&
    !working

  return (
    <Screen
      large
      title="Superagent"
      right={
        <>
          {running ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Stop turn"
              onPress={() => void interrupt()}
              hitSlop={8}
            >
              <Text style={styles.stop}>Stop</Text>
            </PressableScale>
          ) : null}
          <HeaderButton label="Clear context — start the chat fresh" onPress={() => void clear()}>
            <Icon as={Eraser} size={15} color={color.textDim} />
          </HeaderButton>
        </>
      }
    >
      <View style={styles.column}>
        {/* The composer rides the keyboard on the view's own bottom edge — see
            useKeyboardHeight for why this is not a KeyboardAvoidingView. */}
        <View style={[styles.flex, { paddingBottom: keyboardLift }]}>
          {visibleError ? <Text style={styles.error}>{visibleError}</Text> : null}
          <BootstrapCrossfade resolved={resolved} placeholder={<TranscriptSkeleton />}>
            <PullToRefreshBoundary
              connected={connected}
              refreshing={refreshing}
              onRefresh={onRefresh}
            >
              <TranscriptList
                transcript={transcript}
                presentation={conversation?.presentation}
                transcriptQuestion={transcript?.pendingQuestion ?? null}
                liveItem={liveItem}
                live={working}
                collapseContext
                assetContext={
                  podiumSid && transcriptSession
                    ? {
                        httpOrigin,
                        sessionId: podiumSid,
                        cwd: transcriptSession.cwd,
                      }
                    : undefined
                }
                pendingTurns={visiblePendingTurns}
                pinRequest={pinRequest}
                onRetryPending={retry}
                onQuote={(text) => setDraftInsertion({ id: insertionSeq.current++, text })}
                streaming={liveItem !== undefined}
                tail={{
                  label: working
                    ? justSent && !running
                      ? 'Sending'
                      : (statusLabel ?? 'Working')
                    : 'Idle',
                  tone: working ? 'working' : 'idle',
                }}
                onLoadOlder={loadOlder}
                moreAbove={transcript?.hasMoreOlder}
                loadingOlder={transcript?.loadingOlder}
                onFollowChange={followTranscript}
                onSearchChange={searchTranscript}
                refreshControl={refreshControl}
                refreshAccessibilityProps={refreshAccessibilityProps}
                emptyComponent={
                  empty ? (
                    <EmptyState
                      fill
                      title="Hand off some work"
                      body="The superagent can read your repos, file tasks, spawn worker sessions and steer them — describe what you want done."
                    />
                  ) : undefined
                }
                answerInteractionId={currentQuestion?.id}
                onAnswer={async (answer) => {
                  if (
                    currentQuestion &&
                    (answer.interactionId !== currentQuestion.id ||
                      !answer.question ||
                      !matchesQuestionInteraction(currentQuestion, answer.question))
                  ) {
                    throw new Error('The question changed; wait for the current menu.')
                  }
                  if (!podiumSid) return
                  const sent = await trpc.sessions.answerAskUserQuestion.mutate({
                    sessionId: podiumSid,
                    interactionId: answer.interactionId,
                    ...answer,
                  })
                  if (sent?.ok === false) throw new Error(sent.reason ?? 'answer not delivered')
                }}
              />
            </PullToRefreshBoundary>
          </BootstrapCrossfade>
          {/* The tab bar floats over the content now, so the composer has to
              hold itself above it — it is the one thing on this screen that
              must never be scrolled under [POD-420]. The bar's measured inset
              already includes the bottom safe area, so it replaces rather than
              stacks with the composer's own [POD-502]. */}
          <ThreadComposer
            conversation={conversation}
            placeholder="Delegate a task…"
            onSend={send}
            draftInsertion={draftInsertion}
            attachments={attachments}
            bottomInset={tabBarInset}
            leading={
              <SuperagentBackendRail
                backend={backend}
                modelCatalog={modelCatalog}
                onModelChange={(model, agentKind) =>
                  setBackendPick((pick) => applySuperagentModelPick(pick, model, agentKind))
                }
                onEffortChange={(effort) => setBackendPick((pick) => ({ ...pick, effort }))}
              />
            }
          />
        </View>
      </View>
    </Screen>
  )
})

const ThreadComposer = observer(function ThreadComposer({
  conversation,
  ...props
}: React.ComponentProps<typeof Composer> & { conversation?: Conversation }) {
  return (
    <Composer
      {...props}
      value={conversation?.draft ?? ''}
      onChangeText={(text) => {
        if (conversation) conversation.draft = text
      }}
    />
  )
})

const styles = StyleSheet.create({
  column: {
    flex: 1,
    minHeight: 0,
    backgroundColor: color.engraved,
  },
  flex: {
    flex: 1,
    minHeight: 0,
  },
  stop: {
    ...sans(700),
    color: color.dangerText,
    fontSize: font.small,
  },
  error: {
    ...sans(400),
    color: color.dangerText,
    fontSize: font.small,
    paddingHorizontal: space.lg,
    paddingBottom: space.xs,
  },
})
