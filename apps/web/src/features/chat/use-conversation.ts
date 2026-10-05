import {
  Conversation, type ConversationPendingTurn, type ConversationOptions, hubConnection, nativeSessionCanInterrupt,
} from '@podium/client-core/conversation'
import type { ClientRuntime } from '@podium/client-core/engine'
import { randomUUID } from '@podium/client-core/id'
import { useStoreHandle, useConversation as useOwnedConversation } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { chatSendRoute, composerState, parseEnvelopeBatch, type SuperThreadRef, OPTIMISTIC_SEND_CEILING_MS } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { asMutationId, HarnessAgent, type SessionId } from '@podium/model/browser'
import { action, actionBound, compareShallow, computed, makeObservable, observable, observableRef, reaction, runInAction } from 'mobx'
import { useCallback, useEffect, useRef } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { ConversationPresentation, INITIAL_LIMIT, PAGE_LIMIT } from './conversation-presentation'

export interface ConversationMountOptions {
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
  readonly presentation: ConversationPresentation
  lastSubmittedPrompt: string | null = null
  ctxSeq: number | null = null
  backendPick: { model?: string; effort?: string; agentKind?: string | null } = {}
  constructor(
    options: ConversationOptions,
    readonly pool: MobxPool,
    readonly runtime: ClientRuntime<Trpc>,
    readonly mount: ConversationMountOptions,
    presentation: ConversationPresentation,
  ) {
    super(options)
    this.presentation = presentation
    makeObservable(this, {
      lastSubmittedPrompt: observable,
      rememberPrompt: actionBound,
      ctxSeq: observable,
      backendPick: observableRef,
      session: computed,
      thread: computed,
      backend: computed,
      ready: computed,
      hasPending: computed,
      setBackendModel: actionBound,
      setBackendEffort: actionBound,
    })
    presentation.bind(this.transcript)
  }
  get session(): SessionView | undefined { return this.pool.sessionPanes.session(this.sessionId) }
  get thread() { return this.mount.superThread ? loaded(this.pool.row('superThread', this.mount.superThread.threadId)) : undefined }
  get backend() {
    const model = this.backendPick.model ?? this.thread?.model ?? 'auto'
    return {
      model,
      effort: this.backendPick.effort ?? this.thread?.effort ?? 'auto',
      agentKind: this.backendPick.agentKind !== undefined
        ? this.backendPick.agentKind ?? undefined
        : model !== 'auto' ? this.thread?.agentKind : undefined,
    }
  }
  get hasPending(): boolean { return this.sends.bubbles.length > 0 }
  get ready(): boolean {
    const reader = loaded(this.pool.row('chatContextReader', 'reader'))
    const held = loaded(this.pool.row('chatHeld', this.sessionId))
    return !!reader && !!held && reader.records(this.sessionId).pending === 0
  }
  rememberPrompt(text: string): void { this.lastSubmittedPrompt = text || null }
  setBackendModel(model: string, agentKind?: string): void {
    this.backendPick = { ...this.backendPick, model, agentKind: model === 'auto' ? null : agentKind ?? this.backendPick.agentKind, effort: 'auto' }
  }
  setBackendEffort(effort: string): void { this.backendPick = { ...this.backendPick, effort } }
  override dispose(): void { this.presentation.dispose(); super.dispose() }
}

export function createWebConversation(runtime: ClientRuntime<Trpc>, pool: MobxPool, sessionId: SessionId, mount: ConversationMountOptions): WebConversation {
  const store = runtime.access
  const { hub, trpc, replica } = store
  const presentation = new ConversationPresentation()
  const readSession = () => pool.sessionPanes.session(sessionId)
  const readReader = () => loaded(pool.row('chatContextReader', 'reader'))
  const recordValues = computed(() => readReader()?.records(sessionId).records ?? [], { equals: compareShallow })
  const heldValues = computed(() => loaded(pool.row('chatHeld', sessionId))?.sends ?? [], { equals: compareShallow })
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
      retainHistory: () => presentation.retainHistory,
      visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
      source: {
        read: request => trpc.sessions.transcriptRead.query(request),
        subscribe: (id, since, listener) => hub.subscribeTranscript(id, since, listener),
      },
      ...(replica ? { cache: { read: id => replica.transcriptWindow(id), write: (id, items) => replica.putTranscriptWindow(id, [...items]) } } : {}),
    },
    onTranscriptChange: change => presentation.changed(change),
    ...(mount.superThread ? { latestTurnFailure: () => trpc.superagent.latestTurnFailure.query({ threadId: mount.superThread!.threadId }) } : {}),
    sends: {
      ...(headless ? { reconcile: 'next-user-item' as const } : {
        records: { getSnapshot: () => recordValues.get(), subscribe: listener => reaction(() => recordValues.get(), listener) },
        outbox: { held: () => heldValues.get(), subscribe: listener => reaction(() => heldValues.get(), listener) },
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
        if (mount.compact) runInAction(() => { conversation.ctxSeq = focus.issueId ? loaded(readReader()?.issue(focus.issueId))?.seq ?? null : null })
        const backend = conversation.backend
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
  }, pool, runtime, mount, presentation)
  return conversation
}

/** One lifecycle hook for session and thread chat; all state stays in its owner. */
export function useConversation(sessionId: SessionId, options: ConversationMountOptions = {}): WebConversation | null {
  const runtime = useStoreHandle<Trpc>()
  const pool = useWorklistPool()
  const readReady = useCallback((pool: MobxPool) => {
    const reader = loaded(pool.row('chatContextReader', 'reader'))
    const held = loaded(pool.row('chatHeld', sessionId))
    return !!reader && !!held && reader.records(sessionId).pending === 0
  }, [sessionId])
  const ready = useWorklistPoolProjection(readReady, false)
  const gate = useRef({ runtime, sessionId, ready: false })
  if (gate.current.runtime !== runtime || gate.current.sessionId !== sessionId) gate.current = { runtime, sessionId, ready: false }
  if (ready) gate.current.ready = true
  const conversation = useOwnedConversation<WebConversation>(sessionId,
    () => createWebConversation(runtime, pool!, sessionId, options),
    { enabled: !!pool && gate.current.ready && !options.deferInitialTranscript }) ?? null
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
