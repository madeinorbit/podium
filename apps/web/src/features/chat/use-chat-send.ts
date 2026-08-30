import {
  createConversationController,
  type ConversationController,
  type ConversationPendingTurn,
  type ConversationTranscript,
} from '@podium/client-core/conversation'
import { randomUUID } from '@podium/client-core/id'
import type {
  ChatBlock,
  ChatSendRoute,
  ComposerState,
  SuperThreadRef,
} from '@podium/client-core/viewmodels'
import { chatSendRoute, OPTIMISTIC_SEND_CEILING_MS } from '@podium/client-core/viewmodels'
import { asMutationId, type SessionOffer } from '@podium/model'
import type { SessionId, TranscriptItem } from '@podium/model/browser'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Store } from '@/app/store'
import { assertSendAccepted } from '@/lib/assert-send-accepted'
import type { PendingItem, QueuedChatMessage } from './chat'
import type { UseHeadlessTurnResult } from './use-headless-turn'

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
  trpc: Store['trpc']
  resumeAndSend: Store['resumeAndSend']
  dismissOffer: Store['dismissOffer']
  setPanelMode: Store['setPanelMode']
  setSessionDraft: Store['setSessionDraft']
  initialDraft: string
  getUserFocus: Store['getUserFocus']
  attachedSessionId: Store['attachedSessionId']
  clearAttachedSession: Store['clearAttachedSession']
  getIssueSeq: (issueId: string) => number | null
  headless: boolean
  superThread: SuperThreadRef | undefined
  compact: boolean
  active: boolean
  composer: Pick<ComposerState, 'sendable' | 'canResume'>
  ownThreadIds: ReadonlySet<string> | undefined
  blocks: readonly ChatBlock[]
  session:
    | {
        agentState?: { phase?: string; since?: string } | undefined
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
  pending: PendingItem[]
  queuedMessages: QueuedChatMessage[]
  justSent: boolean
  ctxSeq: number | null
  draft: string
  setDraft: (text: string) => void
  send: (fullText: string, tags?: PendingItem['tags'], toolPaths?: string[]) => Promise<void>
  sendOfferPrompt: (prompt: string, offerAt: string) => Promise<void>
  dismissOffer: (offerAt: string) => Promise<void>
  retryPending: (id: string) => Promise<void>
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
    trpc,
    resumeAndSend,
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
    active,
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
    async (turn: ConversationPendingTurn): Promise<{ state: 'queued' | 'sent' }> => {
      if (route.kind === 'session' || route.kind === 'resume') setPanelMode(sessionId, 'chat')
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
        case 'session': {
          const result = await trpc.sessions.sendText.mutate({
            sessionId,
            text: turn.wire,
            mutationId: turn.deliveryId,
          })
          assertSendAccepted(result)
          return {
            state:
              result.disposition === 'queued' || result.disposition === 'accepted'
                ? 'queued'
                : 'sent',
          }
        }
        case 'resume':
          await resumeAndSend(sessionId, turn.wire, asMutationId(turn.deliveryId))
          return { state: 'queued' }
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
      trpc,
      resumeAndSend,
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
  const operationsRef = useRef({ trpc, dismissOfferWrite })
  operationsRef.current = { trpc, dismissOfferWrite }

  // biome-ignore lint/correctness/useExhaustiveDependencies: controller identity is scoped to session
  const controller = useMemo<ConversationController>(() => {
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
            acceptsAppendedBrief: true,
          },
        ]
      : []
    return createConversationController({
      sessionId,
      transcript: transcriptBridge.port,
      initialDraft,
      initialPending,
      initialJustSent: initialPendingText !== undefined && !headless,
      onDraftChange: (text) => setSessionDraft(sessionId, text),
      createDeliveryId: () => `msg_${randomUUID()}`,
      deliver: (turn) => deliverRef.current(turn),
      ...(headless
        ? {}
        : {
            readQueue: () =>
              operationsRef.current.trpc.messages.ledger.query({ sessionId, limit: 100 }),
            retract: (id: string) =>
              operationsRef.current.trpc.messages.cancel.mutate({ id }).then(() => undefined),
          }),
      dismissOffer: (offerAt) => operationsRef.current.dismissOfferWrite(sessionId, offerAt),
      optimisticDismissOffer: false,
      interrupt: (messageId) => interruptRef.current(messageId),
      echoMode: headless ? 'any-user' : 'matching-user',
      optimisticSendCeilingMs: OPTIMISTIC_SEND_CEILING_MS,
    })
  }, [sessionId])

  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    void controller.start()
    return () => controller.stop()
  }, [controller])
  useEffect(() => controller.setActive(active), [active, controller])
  useEffect(
    () =>
      controller.updateContext({
        agentSince: session?.agentState?.since,
        agentPhase: session?.agentState?.phase,
        offer: session?.offer ?? null,
        canInterrupt,
        latestOperatorPrompt,
      }),
    [
      canInterrupt,
      controller,
      latestOperatorPrompt,
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
    async (fullText: string, tags?: PendingItem['tags'], toolPaths?: string[]) => {
      pinToBottom()
      await controller.submit({
        text: fullText,
        wire: fullText,
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(toolPaths && toolPaths.length > 0 ? { toolPaths } : {}),
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
    pending: state.projected.pending,
    queuedMessages: state.projected.queued,
    justSent: state.justSent,
    ctxSeq,
    draft: state.draft,
    setDraft: controller.setDraft.bind(controller),
    send,
    sendOfferPrompt,
    dismissOffer: controller.dismissOffer.bind(controller),
    retryPending: controller.retry.bind(controller),
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
