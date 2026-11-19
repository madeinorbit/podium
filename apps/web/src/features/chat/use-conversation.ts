import {
  type ConversationOptions,
  type ConversationPendingTurn,
  ConversationService,
  hubConnection,
  nativeSessionCanInterrupt,
} from '@podium/client-core/conversation'
import { randomUUID } from '@podium/client-core/id'
import {
  useClientRuntime,
  useConversation as useOwnedConversation,
} from '@podium/client-core/react'
import type { ClientRuntime } from '@podium/client-core/runtime-root'
import {
  chatSendRoute,
  composerState,
  OPTIMISTIC_SEND_CEILING_MS,
  parseEnvelopeBatch,
  type SuperThreadRef,
  stagedAttachmentId,
} from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { chatItemMessage } from '@podium/client-graph/chat-context'
import { here, omitGone } from '@podium/client-graph/lookup'
import { currentMessageRecord, ingestMessageRecords } from '@podium/client-graph/message-models'
import type { SessionModel } from '@podium/client-graph/models'
import { superagentThread } from '@podium/client-graph/superagent'
import { lazy } from '@podium/mobx-helpers'
import { asMutationId, asSessionId, HarnessAgent, type SessionId } from '@podium/model/browser'
import { actionBound, compareShallow, observable, reaction } from 'mobx'
import { useCallback, useEffect, useRef } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { superagentWrites } from '@/features/superagent/superagent-writes'
import {
  type ConversationPresentation,
  INITIAL_LIMIT,
  PAGE_LIMIT,
} from './conversation-presentation'

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
const loaded = <T>(row: T): Loaded<T> | undefined =>
  typeof row === 'symbol' ? undefined : (row as Loaded<T>)

/** Web ports and worker presentation; the inherited model owns every live state. */
export class WebConversation extends ConversationService {
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
    return () => {
      this.views.delete(view)
      view.dispose()
    }
  }
  changed(change: import('@podium/client-core/conversation').TranscriptChange): void {
    for (const view of this.views) view.changed(change)
  }
  get retainHistory(): boolean {
    return [...this.views].some((view) => view.retainHistory)
  }
  get retainFrom(): string | undefined {
    let earliest: string | undefined
    let position = Infinity
    for (const view of this.views) {
      const id = view.retainFrom
      const at = id === undefined ? undefined : this.transcript.position(id)
      if (at !== undefined && at < position) {
        earliest = id
        position = at
      }
    }
    return earliest
  }
  @lazy get session(): SessionModel | undefined {
    return here(this.pool.model('session', this.sessionId))
  }
  /** The mounted superagent thread's synced record (POD-6675). */
  @lazy get thread() {
    return this.mount.superThread
      ? superagentThread(this.pool, this.mount.superThread.threadId).thread
      : undefined
  }
  @lazy({ equals: compareShallow }) get records() {
    return (
      loaded(omitGone(this.pool.row('chatContextReader', 'reader')))?.records(this.sessionId)
        .records ?? []
    )
  }
  @lazy({ equals: compareShallow }) get heldSends() {
    return loaded(omitGone(this.pool.row('chatHeld', this.sessionId)))?.sends ?? []
  }
  @lazy get hasPending(): boolean {
    return this.sends.bubbles.length > 0
  }
  @lazy get ready(): boolean {
    const reader = loaded(omitGone(this.pool.row('chatContextReader', 'reader')))
    const held = loaded(omitGone(this.pool.row('chatHeld', this.sessionId)))
    return !!reader && !!held && reader.records(this.sessionId).pending === 0
  }
  @lazy override get canInterrupt(): boolean {
    return this.mount.superThread !== undefined || this.session?.headless === true
      ? this.mount.superThread !== undefined && this.turnRunning
      : nativeSessionCanInterrupt(this.session?.status)
  }
  @lazy override get latestOperatorPrompt(): string | null {
    const prompt = this.lastSubmittedPrompt ?? this.transcript.latestOperatorPrompt
    return prompt ? (parseEnvelopeBatch(prompt)?.operatorText ?? prompt) : null
  }
  @actionBound rememberPrompt(text: string): void {
    this.lastSubmittedPrompt = text || null
  }
  override dispose(): void {
    for (const view of this.views) view.dispose()
    this.views.clear()
    super.dispose()
  }
}

export function createWebConversation(
  runtime: ClientRuntime<Trpc>,
  pool: MobxPool,
  sessionId: SessionId,
  mount: ConversationMountOptions,
): WebConversation {
  pool.bindSessionDrafts(runtime.drafts)
  const { api: trpc, replica, commands, chatSends } = runtime
  const hub = runtime.services.connection.hub
  const readSession = () => here(pool.model('session', sessionId))
  const readRecords = () =>
    loaded(omitGone(pool.row('chatContextReader', 'reader')))?.records(sessionId).records ?? []
  const readHeld = () => loaded(omitGone(pool.row('chatHeld', sessionId)))?.sends ?? []
  const headless = mount.superThread !== undefined || readSession()?.headless === true
  const attachmentHistoryReads = new Set<string>()
  let conversation: WebConversation
  const held: ConversationPendingTurn[] = headless
    ? []
    : readHeld().map((send, index) => ({
        id: `outbox-${index}-${send.mutationId}`,
        deliveryId: send.mutationId,
        text: send.text,
        wire: send.text,
        at: send.queuedAt,
        state: send.state,
        kind: 'message',
        ...(send.attachments ? { attachments: send.attachments } : {}),
        ...(send.failure
          ? { error: send.failure.message, ...(send.failure.retryable ? {} : { retryable: false }) }
          : {}),
      }))
  const initialPending = mount.initialPendingText
    ? [
        {
          id: 'pending-first-turn',
          deliveryId: 'pending-first-turn',
          text: mount.initialPendingText,
          wire: mount.initialPendingText,
          at: Date.now(),
          state: 'sent' as const,
          kind: 'message' as const,
          reconcile: headless ? ('next-user-item' as const) : ('initial-prompt' as const),
        },
        ...held,
      ]
    : held
  conversation = new WebConversation(
    {
      sessionId,
      drafts: {
        get: (id) => pool.sessionObject(id).messageDraft,
        set: (id, text) => pool.sessionObject(id).setMessageDraft(text),
      },
      ...(typeof hub.on === 'function' ? { hub } : {}),
      headless,
      initialTurnRunning: mount.initialTurnRunning,
      readSession,
      ...(mount.superThread ? { readTurnRunning: () => conversation.thread?.turnRunning } : {}),
      ...(typeof hub.connectionHealth === 'function' && typeof hub.on === 'function'
        ? { connection: hubConnection(hub) }
        : {}),
      transcript: {
        initialLimit: INITIAL_LIMIT,
        pageLimit: PAGE_LIMIT,
        retainHistory: () => conversation?.retainHistory ?? false,
        retainFrom: () => conversation?.retainFrom,
        collapseMachineContext: headless,
        visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
        source: {
          read: async (request) => {
            const page = await trpc.sessions.transcriptRead.query(request)
            const ids = page.items
              .filter((item) => {
                if (item.role !== 'user') return false
                if (chatItemMessage(pool, request.sessionId, item.id)) {
                  attachmentHistoryReads.delete(item.id)
                  return false
                }
                return (
                  !attachmentHistoryReads.has(item.id) &&
                  (item.tags?.length ||
                    item.toolPaths?.length ||
                    item.text === '' ||
                    stagedAttachmentId(item.text.split('\n', 1)[0] ?? '') ||
                    /^\[Image #\d+\]/.test(item.text))
                )
              })
              .map((item) => item.id)
            // The feed has a bounded confirmation window. Ask for attachment
            // records by item identity when loading history, including after a
            // reload or session exit. These reads never delay transcript display.
            for (let at = 0; at < ids.length; at += 100) {
              const batch = ids.slice(at, at + 100)
              for (const id of batch) attachmentHistoryReads.add(id)
              void trpc.messages.records
                .query({ sessionId: request.sessionId, transcriptItemIds: batch })
                .then((answer) => {
                  ingestMessageRecords(pool, answer.records, (id) =>
                    currentMessageRecord(pool, replica, id),
                  )
                })
                .catch(() => {
                  for (const id of batch) attachmentHistoryReads.delete(id)
                })
            }
            return page
          },
          subscribe: (id, since, listener) => hub.subscribeTranscript(id, since, listener),
        },
        ...(replica?.transcripts ? { cache: replica.transcripts } : {}),
      },
      onTranscriptChange: (change) => conversation?.changed(change),
      // The last failure is status on the thread's record (POD-6675): read, not asked for.
      ...(mount.superThread
        ? { readTurnFailure: () => conversation.thread?.lastTurnFailure ?? null }
        : {}),
      sends: {
        ...(headless
          ? { reconcile: 'next-user-item' as const }
          : {
              records: {
                getSnapshot: () => conversation?.records ?? readRecords(),
                subscribe: (listener) =>
                  reaction(() => conversation.records.map((record) => record.row), listener, {
                    equals: compareShallow,
                  }),
              },
              outbox: {
                held: () => conversation?.heldSends ?? readHeld(),
                subscribe: (listener) => reaction(() => conversation.heldSends, listener),
              },
              messageRecords: {
                read: (id) => here(pool.model('messageRecord', id)),
                ingest: (records) =>
                  ingestMessageRecords(pool, records, (id) =>
                    currentMessageRecord(pool, replica, id),
                  ),
              },
              lookupRecords: (ids) =>
                trpc.messages.records.query({ ids: [...ids] }).then((answer) => answer.records),
              retract: (id) =>
                trpc.messages.cancel.mutate({ id }).then((message) => message.deliveryStatus),
              discard: (id) => chatSends.discardChat(asMutationId(id)),
              dismissNotice: (id) =>
                trpc.messages.dismissNotice.mutate({ id }).then(() => undefined),
            }),
        initialPending,
        initialJustSent: mount.initialPendingText !== undefined && !headless,
        createDeliveryId: () => `msg_${randomUUID()}`,
        optimisticSendCeilingMs: OPTIMISTIC_SEND_CEILING_MS,
        optimisticDismissOffer: false,
        dismissOffer: (at) => commands.issues.dismissOffer(sessionId, at),
        interrupt: async (messageId) => {
          if (headless && mount.superThread) {
            await superagentWrites(trpc).interruptTurn.mutate({
              threadId: mount.superThread.threadId,
            })
            return
          }
          // A `session.interrupt` record naming the turn on screen (POD-6397):
          // a late Stop never reaches the next turn, and every device shows
          // Interrupting… (then Kill, if the turn runs on) from the record.
          const turn = conversation.session?.turnStartedAt
          await commands.sessions.interrupt(sessionId, {
            ...(turn !== undefined ? { turn } : {}),
            ...(messageId ? { messageId } : {}),
          })
        },
        deliver: async (turn) => {
          conversation.rememberPrompt(turn.text)
          if (!conversation.ready) throw new Error('Conversation context is loading.')
          const composer = composerState({
            session: conversation.session,
            headless,
            turnRunning: conversation.turnRunning,
            compact: mount.compact ?? false,
          })
          const route = chatSendRoute({
            sessionId,
            headless,
            superThread: mount.superThread,
            composer,
            ...(mount.superThread
              ? { ownThreadIds: new Set(conversation.thread ? [conversation.thread.id] : []) }
              : {}),
          })
          if (conversation.heldSends.some((send) => send.mutationId === turn.deliveryId))
            return chatSends.sendChat(
              { sessionId, text: turn.wire, wake: route.kind === 'resume' },
              asMutationId(turn.deliveryId),
            )
          if (route.kind === 'session' || route.kind === 'resume') {
            runtime.ui.setPanelMode(sessionId, 'chat')
            return chatSends.sendChat(
              {
                sessionId,
                text: turn.wire,
                wake: route.kind === 'resume',
                ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
              },
              asMutationId(turn.deliveryId),
            )
          }
          if (route.kind === 'refused') {
            conversation.setTurnError(route.reason)
            throw new Error(route.reason)
          }
          // The superagent's turn is its text alone, queued durably as text, so a
          // staged attachment rides there as its path ahead of the words: the
          // path-text form its headless driver declares (POD-6093).
          const wire = turn.attachments?.length
            ? [...turn.attachments.map((attachment) => attachment.path), turn.wire]
                .filter(Boolean)
                .join('\n')
            : turn.wire
          const focus = runtime.ui.getUserFocus()
          const backend = turn.backend ?? {
            model: conversation.thread?.model ?? 'auto',
            effort: conversation.thread?.effort ?? 'auto',
            agentKind: conversation.thread?.agentKind,
          }
          const harness = HarnessAgent.safeParse(backend.agentKind)
          const choice = {
            ...(backend.model ? { model: backend.model } : {}),
            ...(backend.effort ? { effort: backend.effort } : {}),
            ...(harness.success && backend.model !== 'auto' ? { agentKind: harness.data } : {}),
          }
          try {
            if (route.kind === 'concierge') {
              await superagentWrites(trpc).concierge.mutate({
                repoPath: route.repoPath,
                text: wire,
                focus,
                ...choice,
              })
              return { state: 'sent' }
            }
            const attached = runtime.ui.attachedSessionId
            const answer = await superagentWrites(trpc).sendTurn.mutate({
              threadId: route.threadId,
              text: wire,
              focus,
              ...(attached ? { attachSessionId: attached } : {}),
              ...choice,
            })
            if (attached) runtime.ui.clearAttachedSession()
            return { state: answer?.queued ? 'queued' : 'sent' }
          } catch (error) {
            conversation.setTurnError(error instanceof Error ? error.message : String(error))
            throw error
          }
        },
      },
    },
    pool,
    runtime,
    mount,
  )
  return conversation
}

/** One lifecycle hook for session and thread chat; all state stays in its owner. */
export function useConversation(
  sessionId: SessionId,
  options: ConversationMountOptions = {},
): WebConversation | null {
  const runtime = useClientRuntime<Trpc>()
  const pool = useWorklistPool()
  const readReady = useCallback(
    (pool: MobxPool) => {
      const reader = loaded(omitGone(pool.row('chatContextReader', 'reader')))
      const held = loaded(omitGone(pool.row('chatHeld', sessionId)))
      return !!reader && !!held && reader.records(sessionId).pending === 0
    },
    [sessionId],
  )
  const ready = useWorklistPoolProjection(readReady, false)
  const gate = useRef({ runtime, sessionId, ready: false })
  if (gate.current.runtime !== runtime || gate.current.sessionId !== sessionId)
    gate.current = { runtime, sessionId, ready: false }
  if (ready) gate.current.ready = true
  const cacheId = options.superThread
    ? asSessionId(`${sessionId}:thread:${options.superThread.threadId}`)
    : sessionId
  const conversation =
    useOwnedConversation<WebConversation>(
      cacheId,
      () => createWebConversation(runtime, pool!, sessionId, options),
      { enabled: !!pool && gate.current.ready && !options.deferInitialTranscript },
    ) ?? null
  const active = options.active !== false && !options.deferInitialTranscript
  const activation = useRef({ runtime, cacheId, active, conversation })
  useEffect(() => {
    const previous = activation.current
    if (previous.runtime !== runtime || previous.cacheId !== cacheId) {
      activation.current = { runtime, cacheId, active, conversation }
      return
    }
    if (!active) previous.active = false
    else if (conversation) {
      // First acquisition already starts the shared owner's newest-window read.
      // Only a return to a conversation this view held needs an activation heal,
      // including when its original read is still pending.
      const reactivating = !previous.active && previous.conversation === conversation
      previous.active = true
      if (reactivating) void conversation.transcript.refresh({ disclose: true }).catch(() => {})
    }
    // Deferral releases this reader, but the owner may keep its conversation warm.
    if (conversation) previous.conversation = conversation
  }, [runtime, cacheId, active, conversation])
  const onInitialPendingSettled =
    options.onInitialPendingSettled ?? conversation?.mount.onInitialPendingSettled
  useEffect(() => {
    if (
      !conversation ||
      !onInitialPendingSettled ||
      conversation.mount.initialPendingText === undefined
    )
      return
    let settled = false
    return reaction(
      () =>
        conversation.sends.pending.some(
          (turn) => turn.id === 'pending-first-turn' && turn.reconcile !== 'record',
        ),
      (pending) => {
        if (!pending && !settled) {
          settled = true
          onInitialPendingSettled()
        }
      },
      { fireImmediately: true },
    )
  }, [conversation, onInitialPendingSettled])
  return conversation
}
