import type {
  MessageRecordWire,
  SessionId,
  SessionOffer,
  TranscriptItem,
  TranscriptTag,
} from '@podium/model'
import { formatAgentError } from '@podium/model'
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'
import type { OutboxChatSend } from '../engine/chat-send'
import {
  type ConversationBubble,
  type ConversationPendingTurn,
} from './projection'

export interface ConversationTranscript {
  getSnapshot(): { items: readonly TranscriptItem[] }
  subscribe(listener: () => void): () => void
}

/** This session's message records, as the synced feed carries them (POD-4764). */
export interface ConversationRecords {
  getSnapshot(): readonly MessageRecordWire[]
  subscribe(listener: () => void): () => void
}

/**
 * This device's link to the server (POD-4811). Its return is the moment a
 * device that was away catches up on its own messages by id.
 */
export interface ConversationConnection {
  connected(): boolean
  subscribe(listener: (connected: boolean) => void): () => void
}

/** How many message ids one catch-up read names (`mail.records`). */
export const CATCH_UP_BATCH = 100

/** Why a message the server never stored shows "not sent": the device thought
 *  it had gone, and the server has no record of it. The way on is a retry. */
export const NOT_STORED = 'not sent — the server has no record of it'

/**
 * The chat sends this device's outbox holds for the session. A send parked
 * after giving up can be retried or discarded from elsewhere in the app (the
 * outbox recovery panel); the bubble follows what the outbox holds.
 */
export interface ConversationOutbox {
  held(): readonly OutboxChatSend[]
  subscribe(listener: () => void): () => void
}

export interface ConversationDeliveryResult {
  state?: 'queued' | 'sent'
  /** The authority's 1-based FIFO position, when it returned one. */
  position?: number
}

export interface ConversationSendInput {
  text: string
  wire?: string
  tags?: TranscriptTag[]
  toolPaths?: string[]
  attachments?: readonly RuntimeAttachmentRef[]
  files?: readonly { path: string }[]
  acceptsAppendedBrief?: boolean
}

export interface ConversationContext {
  agentSince?: string
  agentPhase?: string
  /** A terminal provider failure, when the session reports one. Authoritative
   *  for a turn still in flight; see {@link Sends.context}. */
  agentError?: { class: string; retryable: boolean; detail?: string } | undefined
  offer?: SessionOffer | null
  canInterrupt: boolean
  latestOperatorPrompt?: string | null
}

export interface ConversationClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(token: unknown): void
}

export interface ConversationSendOptions {
  sessionId: SessionId
  transcript: ConversationTranscript
  /** The synced records that say where each sent message stands. Absent for a
   *  conversation whose sends make no message record (a headless thread). */
  records?: ConversationRecords
  /**
   * Read these messages' records from the server by id, all in one request
   * (POD-4811) — the catch-up for this device's own sends the feed does not
   * carry: it was away while they were confirmed and left the feed, or it
   * reloaded while the outbox still held them. Answers only the ids the server
   * has and this person may read.
   */
  lookupRecords?: (ids: readonly string[]) => Promise<readonly MessageRecordWire[]>
  /** When the device is back online, it catches up again. */
  connection?: ConversationConnection
  outbox?: ConversationOutbox
  initialDraft?: string
  initialPending?: readonly ConversationPendingTurn[]
  initialJustSent?: boolean
  onDraftChange?: (text: string) => void
  createDeliveryId(): string
  deliver(turn: ConversationPendingTurn): Promise<ConversationDeliveryResult | void>
  /** Ask the server to take back a message, by its id; answers the status it
   *  had after the request (POD-4776). */
  retract?: (messageId: string) => Promise<MessageRecordWire['status'] | undefined>
  /** Let a failed send go, by its delivery id — the sender's durable copy is
   *  dropped with the bubble, so nothing sends it later (POD-4762). */
  discard?: (deliveryId: string) => Promise<void>
  /** Dismiss the notice of a message the server says did not (or may not
   *  have) arrived, by its id (POD-4764). */
  dismissNotice?: (messageId: string) => Promise<void>
  dismissOffer?: (offerCreatedAt: string) => Promise<void>
  /** False when the adapter's durable outbox already projects the dismissal. */
  optimisticDismissOffer?: boolean
  interrupt?: (messageId?: string) => Promise<void>
  /** How new turns learn the agent has them; see
   *  {@link ConversationPendingTurn.reconcile}. Defaults to `record`. */
  reconcile?: 'record' | 'next-user-item'
  optimisticSendCeilingMs?: number
  clock?: ConversationClock
}

export interface ConversationState {
  sessionId: SessionId
  draft: string
  /** This device's own sends, until their records take over. */
  pending: ConversationPendingTurn[]
  /** What the chat shows below the transcript, oldest first. */
  bubbles: ConversationBubble[]
  offer: SessionOffer | null
  dismissedOfferAt: string | null
  justSent: boolean
  canInterrupt: boolean
  interruptError: string | null
  interruptMessageId: string | null
}

/** Conversation changes observed by the transcript shell; the addressed composer owns drafts. */
export type ConversationSurfaceState = Omit<ConversationState, 'draft'>

export function nativeSessionCanInterrupt(status: string | undefined): boolean {
  return status === 'live' || status === 'starting'
}

export function headlessConversationCanInterrupt(
  hasThread: boolean,
  turnRunning: boolean,
): boolean {
  return hasThread && turnRunning
}
