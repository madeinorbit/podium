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
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Store } from '@/app/store'
import { assertSendAccepted } from '@/lib/assert-send-accepted'
import type { DeadLetteredChatMessage, PendingItem, QueuedChatMessage } from './chat'
import { deadLetteredOperatorMessages } from './chat'
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
  pending: PendingItem[]
  queuedMessages: QueuedChatMessage[]
  /** Dead-lettered ledger rows, restored so a failed delivery stays visible. */
  failedMessages: DeadLetteredChatMessage[]
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
    async (
      turn: ConversationPendingTurn,
    ): Promise<{ state: 'queued' | 'sent'; position?: number }> => {
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
        case 'session': {
          const result = await trpc.sessions.sendText.mutate({
            sessionId,
            text: turn.wire,
            ...(turn.attachments?.length ? { attachments: [...turn.attachments] } : {}),
            mutationId: turn.deliveryId,
          })
          assertSendAccepted(result)
          if (result.disposition === 'queued' || result.disposition === 'accepted') {
            return {
              state: 'queued',
              ...(result.position !== undefined ? { position: result.position } : {}),
            }
          }
          return { state: 'sent' }
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

  /**
   * DEAD-LETTERED ROWS, RESTORED (POD-1761). A delivery the authority gave up on
   * is not in the queued projection the controller keeps — it is terminal — but
   * dropping it off the surface is what made a failed send look like a send that
   * never happened. Read here rather than in the shared controller because the
   * wording is the web ledger's (`deadLetterDeliveryLine`).
   */
  const [failedMessages, setFailedMessages] = useState<DeadLetteredChatMessage[]>([])
  useEffect(() => {
    if (headless) {
      setFailedMessages([])
      return
    }
    let live = true
    setFailedMessages([])
    void trpc.messages.ledger
      .query({ sessionId, limit: 100 })
      .then((rows) => {
        if (live) setFailedMessages(deadLetteredOperatorMessages(rows, sessionId))
      })
      .catch(() => {
        // Chat stays usable without the optional ledger read; keep the last set.
      })
    return () => {
      live = false
    }
  }, [headless, sessionId, trpc, state.queued])

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
    pending: state.projected.pending,
    queuedMessages: state.projected.queued,
    failedMessages,
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
