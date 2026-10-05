import { Conversation, DraftStore, ConversationCache } from '@podium/client-core/conversation'
import { randomUUID } from '@podium/client-core/id'
import type { ChatBlock, ComposerState, SuperThreadRef } from '@podium/client-core/values'
import { OPTIMISTIC_SEND_CEILING_MS } from '@podium/client-core/values'
import { asMutationId, type SessionId, type SessionOffer } from '@podium/model'
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'
import { computed, compareStructural, observable, reaction, runInAction } from 'mobx'
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { afterEach } from 'vitest'
import type { Store } from '@/app/store'
import type { PendingItem } from '../chat'
import { useChatConversationPorts } from './conversation-ports'

export interface ModelSendOptions {
  sessionId: SessionId
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
  /** The chat shell reads drafts in its composer leaf instead of this subscription. */
  observeDraft?: boolean
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
  headlessTurn: { sendTurn: (...args: never[]) => Promise<boolean>; interrupt: () => Promise<void> }
  canInterrupt: boolean
  latestOperatorPrompt: string | null
  pinToBottom: () => void
  initialPendingText: string | undefined
  onInitialPendingSettled?: () => void
}

export interface ModelSendResult {
  conversation: Conversation
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


const owners = new Set<{ cache: ConversationCache; drafts: DraftStore }>()
afterEach(() => { for (const owner of owners) { owner.cache.dispose(); owner.drafts.dispose() } owners.clear() })

/** Probe the real model with controllable record/outbox and session ports. */
export function useModelSend(options: ModelSendOptions): ModelSendResult {
  const ports = useChatConversationPorts(options.sessionId)
  const latest = useMemo(() => observable.box(options, { deep: false }), [options.sessionId])
  useLayoutEffect(() => { runInAction(() => latest.set(options)) })
  const owner = useMemo(() => {
    const drafts = new DraftStore({
      storage: { get: () => null, set: () => {} },
      hub: { on: () => () => {}, sendDraftEdit: () => {}, connectionHealth: () => ({ status: 'ok' }) } as never,
      onChange: (id, text) => latest.get().setSessionDraft(id, text),
    })
    const cache = new ConversationCache({ create: id => {
      const input = latest.get()
      drafts.values.set(id, input.initialDraft ?? ports.draft)
      const held = input.headless ? [] : ports.held(id).map((send, index) => ({
        id: `outbox-${index}-${send.mutationId}`, deliveryId: send.mutationId, text: send.text,
        wire: send.text, at: send.queuedAt, state: send.state, kind: 'message' as const,
      }))
      const initialPending = input.initialPendingText ? [{
        id: 'pending-first-turn', deliveryId: 'pending-first-turn', text: input.initialPendingText,
        wire: input.initialPendingText, at: Date.now(), state: 'sent' as const, kind: 'message' as const,
        reconcile: 'next-user-item' as const,
      }, ...held] : held
      return new Conversation({
        sessionId: id, drafts,
        transcript: { source: { read: async () => ({ items: latest.get().blocks.map(b => b.item), hasMore: false }), subscribe: () => () => {} } },
        readContext: () => {
          const p = latest.get()
          return { agentSince: p.session?.agentState?.since, agentPhase: p.session?.agentState?.phase,
            agentError: p.session?.agentState?.error, offer: p.session?.offer,
            canInterrupt: p.canInterrupt, latestOperatorPrompt: p.latestOperatorPrompt }
        },
        sends: {
          records: ports.records, outbox: ports.outbox,
          initialPending, initialJustSent: input.initialPendingText !== undefined && !input.headless,
          createDeliveryId: () => `msg_${randomUUID()}`,
          optimisticSendCeilingMs: OPTIMISTIC_SEND_CEILING_MS,
          optimisticDismissOffer: false,
          deliver: turn => latest.get().sendChat({ sessionId: id, text: turn.wire, wake: latest.get().composer.canResume }, asMutationId(turn.deliveryId)),
          discard: deliveryId => latest.get().discardChat(asMutationId(deliveryId)),
          dismissNotice: messageId => latest.get().trpc.messages.dismissNotice.mutate({ id: messageId }).then(() => undefined),
          dismissOffer: at => latest.get().dismissOffer(id, at),
          retract: messageId => latest.get().trpc.messages.cancel.mutate({ id: messageId }).then(message => message.deliveryStatus),
          interrupt: async messageId => { await latest.get().trpc.sessions.interrupt.mutate({ sessionId: id, messageId }) },
        },
      })
    } })
    const owner = { cache, drafts }; owners.add(owner); return owner
  }, [options.sessionId, ports.ready])
  const lease = useMemo(() => owner.cache.acquire(options.sessionId), [owner, options.sessionId])
  const conversation = lease.conversation
  const sends = conversation.sends
  useEffect(() => lease.release, [lease])
  useLayoutEffect(() => conversation.transcript.merge(options.blocks.map(b => b.item), { reset: false }), [conversation, options.blocks])
  const snapshot = useMemo(() => computed(() => ({
    pending: sends.bubbles, justSent: sends.justSent, interruptError: sends.interruptError,
    interruptMessageId: sends.interruptMessageId, dismissedOfferAt: sends.dismissedOfferAt,
    offer: sends.offer, canInterrupt: sends.canInterrupt,
    draft: options.observeDraft === false ? '' : conversation.draft,
  }), { equals: compareStructural }), [conversation, options.observeDraft])
  const source = useMemo(() => {
    let current = snapshot.get()
    return {
      subscribe: (listener: () => void) => reaction(() => snapshot.get(), listener),
      getSnapshot: () => {
        const next = snapshot.get()
        if (!compareStructural(current, next)) current = next
        return current
      },
    }
  }, [snapshot])
  const hadInitialPending = useMemo(() => sends.pending.some(turn => turn.id === 'pending-first-turn'), [sends])
  useEffect(() => {
    const onSettled = options.onInitialPendingSettled
    if (!hadInitialPending || !onSettled) return
    let settled = false
    return reaction(() => sends.pending.some(turn => turn.id === 'pending-first-turn'), pending => {
      if (!pending && !settled) { settled = true; onSettled() }
    }, { fireImmediately: true })
  }, [sends, hadInitialPending, options.onInitialPendingSettled])
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot)
  return {
    conversation, ...state, ready: ports.ready, ctxSeq: null,
    get draft() { return conversation.draft },
    pending: state.pending.map(b => b.error === undefined ? b : { ...b, failure: b.error.startsWith('not sent') || b.notice !== undefined ? b.error : `not delivered — ${b.error}` }),
    setDraft: text => { conversation.draft = text },
    send: async (text, tags, toolPaths, attachments) => { options.pinToBottom(); await sends.submit({ text, wire: text, tags, toolPaths, attachments }) },
    sendOfferPrompt: async (prompt, at) => { await sends.sendOffer(prompt, at) }, dismissOffer: sends.dismissOffer.bind(sends),
    retryPending: sends.retry.bind(sends), discardPending: sends.discard.bind(sends),
    sendAgain: sends.sendAgain.bind(sends), retractQueuedMessage: sends.retract.bind(sends),
    markInterrupted: sends.markInterrupted.bind(sends), interrupt: sends.interrupt.bind(sends),
  }
}
