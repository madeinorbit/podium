import {
  createConversationController,
  type ConversationController,
  type ConversationPendingTurn,
  type ConversationTranscript,
  hubConnection,
} from '@podium/client-core/conversation'
import { randomUUID } from '@podium/client-core/id'
import type {
  ChatBlock,
  ChatSendRoute,
  ComposerState,
  SuperThreadRef,
} from '@podium/client-core/values'
import { chatSendRoute, OPTIMISTIC_SEND_CEILING_MS } from '@podium/client-core/values'
import { asMutationId, type SessionOffer } from '@podium/model'
import type { SessionId, TranscriptItem } from '@podium/model/browser'
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Store } from '@/app/store'
import type { PendingItem } from './chat'
import type { UseHeadlessTurnResult } from './use-headless-turn'
import { useChatConversationPorts } from './use-chat-context'

interface TranscriptBridge {
  port: ConversationTranscript
  update(items: readonly TranscriptItem[]): void
}

function createTranscriptBridge(initialItems: readonly TranscriptItem[]): TranscriptBridge {
  let items = initialItems
  const listeners = new Set<() => void>()
  return {
    port: {
      getSnapshot: () => ({ items }),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    update(next) {
      if (next === items) return
      items = next
      for (const listener of listeners) listener()
    },
  }
}

function refusalReason(result: unknown): string | null {
  if (result === null || typeof result !== 'object') return null
  if (!('ok' in result) || (result as { ok: unknown }).ok !== false) return null
  const reason = (result as { reason?: unknown }).reason
  return typeof reason === 'string' && reason !== '' ? reason : 'the agent refused the interrupt'
}

export interface UseChatSendOptions {
  sessionId: SessionId
  /** The store, for the synced message records and the outbox's held sends. */
  store: {
    getSnapshot(): Pick<Store, 'messageRecords' | 'outboxDeadLetters' | 'chatSendsFor'>
    subscribe(listener: () => void): () => void
  }
  trpc: Store['trpc']
  /** The socket hub, when the surface has one: back online is when the chat
   *  catches up on its own messages by id (POD-4811). */
  hub?: Store['hub']
  sendChat: Store['sendChat']
  chatSendsFor?: Store['chatSendsFor']
  discardChat: Store['discardChat']
  dismissOffer: Store['dismissOffer']
  setPanelMode: Store['setPanelMode']
  setSessionDraft: Store['setSessionDraft']
  initialDraft?: string
  getUserFocus: Store['getUserFocus']
  attachedSessionId: Store['attachedSessionId']
  clearAttachedSession: Store['clearAttachedSession']
  getIssueSeq: (issueId: string) => number | null
  headless: boolean
  superThread: SuperThreadRef | undefined
  compact: boolean
  composer: Pick<ComposerState, 'sendable' | 'canResume' | 'refusalReason'>
  ownThreadIds: ReadonlySet<string> | undefined
  blocks: readonly ChatBlock[]
  session:
    | {
        agentState?:
          | {
              phase?: string
              since?: string
              error?: { class: string; retryable: boolean; detail?: string }
            }
          | undefined
        offer?: SessionOffer | null | undefined
      }
    | undefined
  headlessTurn: Pick<UseHeadlessTurnResult, 'sendTurn' | 'interrupt'>
  canInterrupt: boolean
  latestOperatorPrompt: string | null
  pinToBottom: () => void
  initialPendingText: string | undefined
  onInitialPendingSettled?: () => void
}

export interface UseChatSendResult {
  ready: boolean
  pending: PendingItem[]
  justSent: boolean
  ctxSeq: number | null
  draft: string
  setDraft: (text: string) => void
  /** Send composed text plus out-of-band staged refs. */
  send: (
    fullText: string,
    tags?: PendingItem['tags'],
    toolPaths?: string[],
    attachments?: readonly RuntimeAttachmentRef[],
  ) => Promise<void>
  sendOfferPrompt: (prompt: string, offerAt: string) => Promise<void>
  dismissOffer: (offerAt: string) => Promise<void>
  /** "not sent — retry": the SAME message goes out again, under its id. */
  retryPending: (id: string) => Promise<void>
  /** "not sent — discard": the queued copy is dropped with the bubble; on a
   *  message the server says did not arrive, the notice is dismissed. */
  discardPending: (id: string) => Promise<void>
  /** "Send again" on a message the server says did not (or may not have)
   *  arrived: its text goes back into the composer, to be sent as a NEW message. */
  sendAgain: (id: string) => Promise<void>
  retractQueuedMessage: (id: string) => Promise<void>
  interruptMessageId: string | null
  markInterrupted: (deliveryId?: string, interruptedAt?: number) => void
  dismissedOfferAt: string | null
  offer: SessionOffer | null
  canInterrupt: boolean
  interrupt: (draft: string) => Promise<boolean>
  interruptError: string | null
}

/** React adapter around the platform-neutral conversation state machine. */
export function useChatSend(opts: UseChatSendOptions): UseChatSendResult {
  const {
    sessionId,
    store,
    trpc,
    hub,
    sendChat,
    discardChat,
    dismissOffer: dismissOfferWrite,
    setPanelMode,
    setSessionDraft,
    initialDraft,
    getUserFocus,
    attachedSessionId,
    clearAttachedSession,
    getIssueSeq,
    headless,
    superThread,
    compact,
    composer,
    ownThreadIds,
    blocks,
    session,
    headlessTurn,
    canInterrupt,
    latestOperatorPrompt,
    pinToBottom,
    initialPendingText,
    onInitialPendingSettled,
  } = opts
  const ports = useChatConversationPorts(sessionId, store)
  const heldSends = ports.held

  const transcriptItems = useMemo(() => blocks.map((block) => block.item), [blocks])
  // biome-ignore lint/correctness/useExhaustiveDependencies: one bridge per addressed conversation
  const transcriptBridge = useMemo(() => createTranscriptBridge(transcriptItems), [sessionId])
  useEffect(() => transcriptBridge.update(transcriptItems), [transcriptBridge, transcriptItems])

  const route = useMemo<ChatSendRoute>(
    () =>
      chatSendRoute({
        sessionId,
        headless,
        superThread,
        composer,
        ...(ownThreadIds !== undefined ? { ownThreadIds } : {}),
      }),
    [sessionId, headless, superThread, composer, ownThreadIds],
  )
  const [ctxSeq, setCtxSeq] = useState<number | null>(null)

  const deliver = useCallback(
    async (
      turn: ConversationPendingTurn,
    ): Promise<{ state: 'queued' | 'sent'; position?: number }> => {
      // A message the outbox already holds (a reloaded conversation following
      // it, or a retry of one that gave up) is waited on or re-issued as it is:
      // its command was chosen when it was written, whatever the route says now.
      if (!ports.ready) throw new Error('Conversation context is loading.')
      if (heldSends(sessionId).some((held) => held.mutationId === turn.deliveryId)) {
        return await sendChat(
          { sessionId, text: turn.wire, wake: route.kind === 'resume' },
          asMutationId(turn.deliveryId),
        )
      }
      if (route.kind === 'session' || route.kind === 'resume') setPanelMode(sessionId, 'chat')
      // Staged refs only exist for a live agent session; every other route has
      // no wire to carry them, so refuse rather than silently drop the files.
      if (turn.attachments?.length && route.kind !== 'session') {
        throw new Error('file attachments require a live agent session')
      }
      switch (route.kind) {
        case 'superagent-turn':
        case 'concierge':
        case 'refused': {
          const focus = getUserFocus()
          if (compact && route.kind !== 'refused') {
            setCtxSeq(focus.issueId ? getIssueSeq(focus.issueId) : null)
          }
          const attach = route.kind === 'superagent-turn' ? attachedSessionId : null
          const queued = await headlessTurn.sendTurn(route, turn.wire, focus, attach ?? undefined)
          if (attach) clearAttachedSession()
          return { state: queued ? 'queued' : 'sent' }
        }
        // THE ONE CHAT SEND PATH (POD-4762): live or parked, the message goes
        // into the durable outbox under its own id, and this resolves when the
        // server answered or the outbox gave up — so the bubble says `sending`
        // exactly as long as that is true, and a retry is the same message.
        case 'session':
        case 'resume':
          return await sendChat(
            {
              sessionId,
              text: turn.wire,
              ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
              wake: route.kind === 'resume',
            },
            asMutationId(turn.deliveryId),
          )
      }
    },
    [
      route,
      setPanelMode,
      sessionId,
      getUserFocus,
      compact,
      getIssueSeq,
      attachedSessionId,
      headlessTurn,
      clearAttachedSession,
      sendChat,
      heldSends,
      ports.ready,
    ],
  )

  const interruptDelivery = useCallback(
    async (messageId?: string) => {
      if (headless) {
        await headlessTurn.interrupt()
        return
      }
      const result = await trpc.sessions.interrupt.mutate({
        sessionId,
        ...(messageId ? { messageId } : {}),
      })
      const refused = refusalReason(result)
      if (refused) throw new Error(refused)
    },
    [headless, headlessTurn, sessionId, trpc],
  )

  const deliverRef = useRef(deliver)
  const interruptRef = useRef(interruptDelivery)
  deliverRef.current = deliver
  interruptRef.current = interruptDelivery
  const operationsRef = useRef({ trpc, dismissOfferWrite, discardChat })
  operationsRef.current = { trpc, dismissOfferWrite, discardChat }

  // biome-ignore lint/correctness/useExhaustiveDependencies: controller identity is scoped to session
  const controller = useMemo<ConversationController>(() => {
    // The messages the outbox still holds for this session come back as the
    // bubbles they were: a reload keeps an unconfirmed send on screen, still
    // sending (the controller waits on it again) or "not sent" with its retry.
    const held: ConversationPendingTurn[] = headless
      ? []
      : heldSends(sessionId).map((send, index) => ({
          id: `outbox-${index}-${send.mutationId}`,
          deliveryId: send.mutationId,
          text: send.text,
          wire: send.text,
          at: send.queuedAt,
          state: send.state,
          kind: 'message',
          ...(send.attachments ? { attachments: send.attachments } : {}),
          ...(send.failure
            ? {
                error: send.failure.message,
                ...(send.failure.retryable ? {} : { retryable: false }),
              }
            : {}),
        }))
    const initialPending: ConversationPendingTurn[] = initialPendingText
      ? [
          {
            id: 'pending-first-turn',
            deliveryId: 'pending-first-turn',
            text: initialPendingText,
            wire: initialPendingText,
            at: Date.now(),
            state: 'sent',
            kind: 'message',
            // The session's first prompt is typed at start, not sent as a
            // message, so there is no record to follow: the first user entry
            // in its history is it.
            reconcile: 'next-user-item',
          },
          ...held,
        ]
      : held
    return createConversationController({
      sessionId,
      transcript: transcriptBridge.port,
      // A headless thread's turns are not messages: no record follows them,
      // and each leaves when the thread's next user entry arrives.
      ...(headless
        ? { reconcile: 'next-user-item' as const }
        : {
            records: ports.records,
            outbox: ports.outbox,
            lookupRecords: (ids: readonly string[]) =>
              operationsRef.current.trpc.messages.records
                .query({ ids: [...ids] })
                .then((answer) => answer.records),
            ...(typeof hub?.connectionHealth === 'function' && typeof hub.on === 'function'
              ? { connection: hubConnection(hub) }
              : {}),
          }),
      initialDraft: initialDraft ?? ports.draft,
      initialPending,
      initialJustSent: initialPendingText !== undefined && !headless,
      onDraftChange: (text) => setSessionDraft(sessionId, text),
      createDeliveryId: () => `msg_${randomUUID()}`,
      deliver: (turn) => deliverRef.current(turn),
      ...(headless
        ? {}
        : {
            retract: (id: string) =>
              operationsRef.current.trpc.messages.cancel
                .mutate({ id })
                .then((message) => message.deliveryStatus),
            discard: (deliveryId: string) =>
              operationsRef.current.discardChat(asMutationId(deliveryId)),
            dismissNotice: (id: string) =>
              operationsRef.current.trpc.messages.dismissNotice
                .mutate({ id })
                .then(() => undefined),
          }),
      dismissOffer: (offerAt) => operationsRef.current.dismissOfferWrite(sessionId, offerAt),
      optimisticDismissOffer: false,
      interrupt: (messageId) => interruptRef.current(messageId),
      optimisticSendCeilingMs: OPTIMISTIC_SEND_CEILING_MS,
    })
  }, [sessionId, ports.ready])

  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    controller.start()
    return () => controller.stop()
  }, [controller])
  useEffect(
    () =>
      controller.updateContext({
        agentSince: session?.agentState?.since,
        agentPhase: session?.agentState?.phase,
        agentError: session?.agentState?.error,
        offer: session?.offer ?? null,
        canInterrupt,
        latestOperatorPrompt,
      }),
    [
      canInterrupt,
      controller,
      latestOperatorPrompt,
      session?.agentState?.error,
      session?.agentState?.phase,
      session?.agentState?.since,
      session?.offer,
    ],
  )

  const seedSettled = useRef(initialPendingText === undefined)
  useEffect(() => {
    if (seedSettled.current) return
    if (state.pending.some((turn) => turn.id === 'pending-first-turn')) return
    seedSettled.current = true
    onInitialPendingSettled?.()
  }, [onInitialPendingSettled, state.pending])

  const send = useCallback(
    async (
      fullText: string,
      tags?: PendingItem['tags'],
      toolPaths?: string[],
      attachments?: readonly RuntimeAttachmentRef[],
    ) => {
      pinToBottom()
      await controller.submit({
        text: fullText,
        wire: fullText,
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(toolPaths && toolPaths.length > 0 ? { toolPaths } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      })
    },
    [controller, pinToBottom],
  )
  const sendOfferPrompt = useCallback(
    async (prompt: string, offerAt: string) => {
      pinToBottom()
      await controller.sendOffer(prompt, offerAt)
    },
    [controller, pinToBottom],
  )

  return {
    ready: ports.ready,
    // The controller records a failed turn's reason as `error`; the bubble that
    // renders it calls the same fact `failure` (POD-2604). Bridged here, at the
    // one seam where a controller turn becomes a web pending item, rather than
    // teaching either side the other's word for it. A send the outbox gave up
    // on already reads "not sent — …" (POD-4762); any other failure happened
    // after the message left, and says so.
    pending: state.bubbles.map((bubble) =>
      bubble.error === undefined
        ? bubble
        : {
            ...bubble,
            // The server's own words for a message it says did not arrive;
            // this device's words for one it never got through.
            failure:
              bubble.notice !== undefined || bubble.error.startsWith('not sent')
                ? bubble.error
                : `not delivered — ${bubble.error}`,
          },
    ),
    justSent: state.justSent,
    ctxSeq,
    draft: state.draft,
    setDraft: controller.setDraft.bind(controller),
    send,
    sendOfferPrompt,
    dismissOffer: controller.dismissOffer.bind(controller),
    retryPending: controller.retry.bind(controller),
    discardPending: controller.discard.bind(controller),
    sendAgain: controller.sendAgain.bind(controller),
    retractQueuedMessage: controller.retract.bind(controller),
    interruptMessageId: state.interruptMessageId,
    markInterrupted: controller.markInterrupted.bind(controller),
    dismissedOfferAt: state.dismissedOfferAt,
    offer: state.offer,
    canInterrupt: state.canInterrupt,
    interrupt: controller.interrupt.bind(controller),
    interruptError: state.interruptError,
  }
}
