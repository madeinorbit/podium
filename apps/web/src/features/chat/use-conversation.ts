import { ingestMessageRecords } from '@podium/client-graph/message-models'
import { here } from '@podium/client-graph/lookup'
import { omitGone } from '@podium/client-graph/lookup'
import { loadedPaneSession } from '@podium/client-graph/session-pane'
import {
  Conversation, type ConversationPendingTurn, type ConversationOptions, hubConnection, nativeSessionCanInterrupt,
} from '@podium/client-core/conversation'
import type { ClientRuntime } from '@podium/client-core/engine'
import { randomUUID } from '@podium/client-core/id'
import { REPLICA_TRANSCRIPT_ITEM_CAP } from '@podium/client-core/replica'
import { useStoreHandle, useConversation as useOwnedConversation } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { chatSendRoute, composerState, parseEnvelopeBatch, type SuperThreadRef, OPTIMISTIC_SEND_CEILING_MS } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { asMutationId, asSessionId, HarnessAgent, type SessionId } from '@podium/model/browser'
import { actionBound, compareShallow, computed, observable, reaction } from 'mobx'
import { useCallback, useEffect, useRef } from 'react'
import { lazy } from '@podium/mobx-helpers'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { ConversationPresentation, INITIAL_LIMIT, PAGE_LIMIT } from './conversation-presentation'

export interface ConversationMountOptions {
  active?: boolean
  superThread?: SuperThreadRef
  initialTurnRunning?: boolean
  initialPendingText?: string
  onInitialPendingSettled?: () => void
  deferInitialTranscript?: boolean
  compact?: boolean
}
type Loaded<T> = Exclude<T, symbol>
const loaded = <T,>(row: T): Loaded<T> | undefined => typeof row === 'symbol' ? undefined : row as Loaded<T>

/** Web ports and worker presentation; the inherited model owns every live state. */
export class WebConversation extends Conversation {
  /** Mounted reader registry; removing a reader drops all of its UI state. */
  private readonly views = new Set<ConversationPresentation>()
  @observable accessor lastSubmittedPrompt: string | null = null
  constructor(
    options: ConversationOptions,
    readonly pool: MobxPool,
    readonly runtime: ClientRuntime<Trpc>,
    readonly mount: ConversationMountOptions,
  ) {
    super(options)
  }
  addView(view: ConversationPresentation): () => void {
    this.views.add(view)
    view.bind(this.transcript, this.graph)
    return () => { this.views.delete(view); view.dispose() }
  }
  changed(change: import('@podium/client-core/conversation').TranscriptChange): void {
    for (const view of this.views) view.changed(change)
  }
  get retainHistory(): boolean { return [...this.views].some(view => view.retainHistory) }
  @lazy get session(): SessionView | undefined { return loadedPaneSession(this.pool, this.sessionId) }
  @lazy get thread() { return this.mount.superThread ? loaded(omitGone(this.pool.row('superThread', this.mount.superThread.threadId))) : undefined }
  @lazy get hasPending(): boolean { return this.sends.bubbles.length > 0 }
  @lazy get ready(): boolean {
    const reader = loaded(omitGone(this.pool.row('chatContextReader', 'reader')))
    const held = loaded(omitGone(this.pool.row('chatHeld', this.sessionId)))
    return !!reader && !!held && reader.records(this.sessionId).pending === 0
  }
  @actionBound rememberPrompt(text: string): void { this.lastSubmittedPrompt = text || null }
  override dispose(): void { for (const view of this.views) view.dispose(); this.views.clear(); super.dispose() }

}

export function createWebConversation(runtime: ClientRuntime<Trpc>, pool: MobxPool, sessionId: SessionId, mount: ConversationMountOptions): WebConversation {
  const store = runtime.access
  const { hub, trpc, replica } = store
  const readSession = () => loadedPaneSession(pool, sessionId)
  const readReader = () => loaded(omitGone(pool.row('chatContextReader', 'reader')))
  const recordValues = computed(() => readReader()?.records(sessionId).records ?? [], { equals: compareShallow })
  const heldValues = computed(() => loaded(omitGone(pool.row('chatHeld', sessionId)))?.sends ?? [], { equals: compareShallow })
  const headless = mount.superThread !== undefined || readSession()?.headless === true
  let conversation: WebConversation
  const held: ConversationPendingTurn[] = headless ? [] : heldValues.get().map((send, index) => ({
    id: `outbox-${index}-${send.mutationId}`, deliveryId: send.mutationId,
    text: send.text, wire: send.text, at: send.queuedAt, state: send.state, kind: 'message',
    ...(send.attachments ? { attachments: send.attachments } : {}),
    ...(send.failure ? { error: send.failure.message, ...(send.failure.retryable ? {} : { retryable: false }) } : {}),
  }))
  const initialPending = mount.initialPendingText ? [{
    id: 'pending-first-turn', deliveryId: 'pending-first-turn', text: mount.initialPendingText,
    wire: mount.initialPendingText, at: Date.now(), state: 'sent' as const, kind: 'message' as const,
    reconcile: 'next-user-item' as const,
  }, ...held] : held
  conversation = new WebConversation({
    sessionId, drafts: runtime.drafts, ...(typeof hub.on === 'function' ? { hub } : {}), headless,
    initialTurnRunning: mount.initialTurnRunning,
    readSession,
    ...(mount.superThread ? { readTurnRunning: () => conversation.thread?.turnRunning } : {}),
    readContext: () => {
      const session = readSession()
      const prompt = conversation.lastSubmittedPrompt ?? conversation.transcript.latestOperatorPrompt
      return { agentSince: session?.agentState?.since, agentPhase: session?.agentState?.phase,
        agentError: session?.agentState?.error, offer: session?.offer,
        canInterrupt: headless ? mount.superThread !== undefined && conversation.turnRunning : nativeSessionCanInterrupt(session?.status),
        latestOperatorPrompt: prompt ? parseEnvelopeBatch(prompt)?.operatorText ?? prompt : null }
    },
    ...(typeof hub.connectionHealth === 'function' && typeof hub.on === 'function' ? { connection: hubConnection(hub) } : {}),
    transcript: {
      initialLimit: INITIAL_LIMIT, pageLimit: PAGE_LIMIT,
      retainHistory: () => conversation?.retainHistory ?? false,
      collapseMachineContext: headless,
      visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
      source: {
        read: request => trpc.sessions.transcriptRead.query(request),
        subscribe: (id, since, listener) => hub.subscribeTranscript(id, since, listener),
      },
      ...(replica ? { cache: { maxItems: REPLICA_TRANSCRIPT_ITEM_CAP, read: id => replica.transcriptWindow(id), write: (id, items) => replica.putTranscriptWindow(id, [...items]) } } : {}),
    },
    onTranscriptChange: change => conversation?.changed(change),
    ...(mount.superThread ? { latestTurnFailure: () => trpc.superagent.latestTurnFailure.query({ threadId: mount.superThread!.threadId }) } : {}),
    sends: {
      ...(headless ? { reconcile: 'next-user-item' as const } : {
        records: { getSnapshot: () => recordValues.get(), subscribe: listener => reaction(() => recordValues.get().map(record => record.row), listener, { equals: compareShallow }) },
        outbox: { held: () => heldValues.get(), subscribe: listener => reaction(() => heldValues.get(), listener) },
        messageRecords: { read: id => here(pool.model('message', id)), ingest: records => ingestMessageRecords(pool, records) },
        lookupRecords: ids => trpc.messages.records.query({ ids: [...ids] }).then(answer => answer.records),
        retract: id => trpc.messages.cancel.mutate({ id }).then(message => message.deliveryStatus),
        discard: id => store.discardChat(asMutationId(id)),
        dismissNotice: id => trpc.messages.dismissNotice.mutate({ id }).then(() => undefined),
      }),
      initialPending,
      initialJustSent: mount.initialPendingText !== undefined && !headless,
      createDeliveryId: () => `msg_${randomUUID()}`,
      optimisticSendCeilingMs: OPTIMISTIC_SEND_CEILING_MS,
      optimisticDismissOffer: false,
      dismissOffer: at => store.dismissOffer(sessionId, at),
      interrupt: async messageId => {
        if (headless && mount.superThread) { await trpc.superagent.interruptTurn.mutate({ threadId: mount.superThread.threadId }); return }
        const result = await trpc.sessions.interrupt.mutate({ sessionId, ...(messageId ? { messageId } : {}) })
        if (result && typeof result === 'object' && 'ok' in result && result.ok === false)
          throw new Error('reason' in result && typeof result.reason === 'string' ? result.reason : 'the agent refused the interrupt')
      },
      deliver: async turn => {
        conversation.rememberPrompt(turn.text)
        if (!conversation.ready) throw new Error('Conversation context is loading.')
        const composer = composerState({ session: conversation.session, headless, turnRunning: conversation.turnRunning, compact: mount.compact ?? false })
        const route = chatSendRoute({ sessionId, headless, superThread: mount.superThread, composer,
          ...(mount.superThread ? { ownThreadIds: new Set(conversation.thread ? [conversation.thread.id] : []) } : {}),
        })
        if (heldValues.get().some(send => send.mutationId === turn.deliveryId))
          return store.sendChat({ sessionId, text: turn.wire, wake: route.kind === 'resume' }, asMutationId(turn.deliveryId))
        if (turn.attachments?.length && route.kind !== 'session') throw new Error('file attachments require a live agent session')
        if (route.kind === 'session' || route.kind === 'resume') {
          store.setPanelMode(sessionId, 'chat')
          return store.sendChat({ sessionId, text: turn.wire, wake: route.kind === 'resume', ...(turn.attachments?.length ? { attachments: turn.attachments } : {}) }, asMutationId(turn.deliveryId))
        }
        if (route.kind === 'refused') { conversation.setTurnError(route.reason); throw new Error(route.reason) }
        const focus = store.getUserFocus()
        const backend = turn.backend ?? { model: conversation.thread?.model ?? 'auto', effort: conversation.thread?.effort ?? 'auto', agentKind: conversation.thread?.agentKind }
        const harness = HarnessAgent.safeParse(backend.agentKind)
        const choice = { ...(backend.model ? { model: backend.model } : {}), ...(backend.effort ? { effort: backend.effort } : {}), ...(harness.success && backend.model !== 'auto' ? { agentKind: harness.data } : {}) }
        try {
          if (route.kind === 'concierge') { await trpc.superagent.concierge.mutate({ repoPath: route.repoPath, text: turn.wire, focus, ...choice }); return { state: 'sent' } }
          const attached = store.attachedSessionId
          const answer = await trpc.superagent.sendTurn.mutate({ threadId: route.threadId, text: turn.wire, focus, ...(attached ? { attachSessionId: attached } : {}), ...choice })
          if (attached) store.clearAttachedSession()
          return { state: answer?.queued ? 'queued' : 'sent' }
        } catch (error) { conversation.setTurnError(error instanceof Error ? error.message : String(error)); throw error }
      },
    },
  }, pool, runtime, mount)
  return conversation
}

/** One lifecycle hook for session and thread chat; all state stays in its owner. */
export function useConversation(sessionId: SessionId, options: ConversationMountOptions = {}): WebConversation | null {
  const runtime = useStoreHandle<Trpc>()
  const pool = useWorklistPool()
  const readReady = useCallback((pool: MobxPool) => {
    const reader = loaded(omitGone(pool.row('chatContextReader', 'reader')))
    const held = loaded(omitGone(pool.row('chatHeld', sessionId)))
    return !!reader && !!held && reader.records(sessionId).pending === 0
  }, [sessionId])
  const ready = useWorklistPoolProjection(readReady, false)
  const gate = useRef({ runtime, sessionId, ready: false })
  if (gate.current.runtime !== runtime || gate.current.sessionId !== sessionId) gate.current = { runtime, sessionId, ready: false }
  if (ready) gate.current.ready = true
  const cacheId = options.superThread ? asSessionId(`${sessionId}:thread:${options.superThread.threadId}`) : sessionId
  const conversation = useOwnedConversation<WebConversation>(cacheId,
    () => createWebConversation(runtime, pool!, sessionId, options),
    { enabled: !!pool && gate.current.ready && !options.deferInitialTranscript }) ?? null
  const active = options.active !== false && !options.deferInitialTranscript
  const activation = useRef({ runtime, cacheId, active })
  useEffect(() => {
    const previous = activation.current
    if (previous.runtime !== runtime || previous.cacheId !== cacheId) {
      activation.current = { runtime, cacheId, active }
      return
    }
    if (!active) previous.active = false
    else if (!previous.active && conversation) {
      previous.active = true
      void conversation.transcript.refresh({ disclose: true }).catch(() => {})
    }
  }, [runtime, cacheId, active, conversation])
  const onInitialPendingSettled = options.onInitialPendingSettled ?? conversation?.mount.onInitialPendingSettled
  useEffect(() => {
    if (!conversation || !onInitialPendingSettled || conversation.mount.initialPendingText === undefined) return
    let settled = false
    return reaction(() => conversation.sends.pending.some(turn => turn.id === 'pending-first-turn'), pending => {
      if (!pending && !settled) { settled = true; onInitialPendingSettled() }
    }, { fireImmediately: true })
  }, [conversation, onInitialPendingSettled])
  return conversation
}
