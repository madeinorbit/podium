/**
 * EVERY CHAT SEND GOES THROUGH THE OUTBOX (POD-4762).
 *
 * There used to be two ways a message left the app. A live session got one
 * direct `sessions.sendText` request held only in memory: a reload lost it, a
 * dropped answer was never retried, and the web's "Retry" minted a new id — a
 * second message. A parked session went through the durable outbox. Now both go
 * through the outbox, keyed by the message id the composer minted, so ONE
 * mechanism keeps the send on the device, retries it with growing pauses under
 * the same id (the server answers a repeat with its first answer), and gives up
 * after `CHAT_SEND_MAX_AGE_MS` with "not sent". The user's retry re-issues that
 * same entry — the same id — rather than sending anything new.
 *
 * `sendChatThroughOutbox` is idempotent BY ID, which is what lets a reloaded
 * conversation simply call it again for every message the queue still holds:
 * an entry already on its way is waited on, a parked one is re-issued, and one
 * that already landed is sent again under its id and answered from the server's
 * record of the first time.
 */

import type { MutationId, SessionId } from '@podium/model'
import { asMutationId } from '@podium/model'
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'
import { randomUUID } from '../id'
import type { OutboxSettlement } from '../outbox'
import type { EngineOutbox, OutboxKinds } from './wiring'

export interface ChatSendInput {
  readonly sessionId: SessionId
  readonly text: string
  readonly attachments?: readonly RuntimeAttachmentRef[]
  /** The session is parked: the send wakes it first (`sessions.resumeAndSend`). */
  readonly wake: boolean
}

/** What the server said it did with the message. */
export interface ChatSendOutcome {
  /** `queued` — waiting behind a turn or for a wake; `sent` — handed to the agent. */
  readonly state: 'queued' | 'sent'
  /** The server's 1-based FIFO position, when it returned one. */
  readonly position?: number
}

/**
 * The send gave up: the outbox parked it. `retryable` is false when the server
 * REFUSED the message — sending the same bytes again would be refused the same
 * way — and true when it simply never got through in time.
 */
export class ChatNotSentError extends Error {
  readonly retryable: boolean
  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'ChatNotSentError'
    this.retryable = retryable
  }
}

/** One message the outbox still holds for a session — how a conversation that
 *  was reloaded finds its unconfirmed bubbles again. */
export interface OutboxChatSend {
  readonly mutationId: MutationId
  readonly sessionId: SessionId
  readonly text: string
  readonly attachments?: readonly RuntimeAttachmentRef[]
  readonly wake: boolean
  readonly queuedAt: number
  /** `sending` — still trying; `failed` — gave up (parked for the user). */
  readonly state: 'sending' | 'failed'
  readonly failure?: ChatNotSentError
}

/**
 * Waiters keyed by entry id, released by the queue's settlement callback.
 * Registered BEFORE the enqueue or re-issue that causes the settlement: the
 * drain may resolve an entry before the call that queued it returns.
 */
export class OutboxSettlements {
  private readonly waiters = new Map<string, Set<(settlement: OutboxSettlement) => void>>()

  /** Wait for the next settlement of `mutationId`. `cancel` withdraws the wait
   *  when the call that was to cause it never happened. */
  next(mutationId: MutationId): { settled: Promise<OutboxSettlement>; cancel(): void } {
    let waiter!: (settlement: OutboxSettlement) => void
    const settled = new Promise<OutboxSettlement>((resolve) => {
      waiter = resolve
    })
    const waiting = this.waiters.get(mutationId) ?? new Set()
    waiting.add(waiter)
    this.waiters.set(mutationId, waiting)
    return {
      settled,
      cancel: () => {
        waiting.delete(waiter)
        if (waiting.size === 0 && this.waiters.get(mutationId) === waiting) {
          this.waiters.delete(mutationId)
        }
      },
    }
  }

  settle(mutationId: MutationId, settlement: OutboxSettlement): void {
    const waiting = this.waiters.get(mutationId)
    if (waiting === undefined) return
    this.waiters.delete(mutationId)
    for (const resolve of waiting) resolve(settlement)
  }
}

const CHAT_KINDS = new Set<string>(['sendText', 'resumeAndSend'])

/** Why a message the server never refused did not go: it could not get there
 *  inside `CHAT_SEND_MAX_AGE_MS`. */
const GAVE_UP = "couldn't reach the server"

function notSent(settlement: Extract<OutboxSettlement, { kind: 'not-sent' }>): ChatNotSentError {
  if (settlement.reason.code === 'max-age') {
    return new ChatNotSentError(`not sent — ${GAVE_UP}`, true)
  }
  const cause = settlement.cause
  const said = cause instanceof Error && cause.message !== '' ? cause.message : undefined
  return new ChatNotSentError(said ? `not sent — ${said}` : 'not sent', false)
}

function outcomeOf(reply: unknown, wake: boolean): ChatSendOutcome {
  // The two refusals the queue settles as DONE rather than parking them (a Stop
  // that got there first, a session that is gone): the entry is finished, and
  // the message still did not go out.
  if (typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === false) {
    const reason = (reply as { reason?: unknown }).reason
    throw new ChatNotSentError(
      typeof reason === 'string' && reason !== '' ? `not sent — ${reason}` : 'not sent',
      false,
    )
  }
  // A wake always waits: the text is typed once the process it starts is ready.
  if (wake) return { state: 'queued' }
  if (typeof reply !== 'object' || reply === null) return { state: 'sent' }
  if ((reply as { disposition?: unknown }).disposition !== 'queued') return { state: 'sent' }
  const position = (reply as { position?: unknown }).position
  return { state: 'queued', ...(typeof position === 'number' ? { position } : {}) }
}

function payloadOf(input: ChatSendInput): {
  kind: 'sendText' | 'resumeAndSend'
  payload: OutboxKinds['sendText'] | OutboxKinds['resumeAndSend']
} {
  if (input.wake) {
    if (input.attachments?.length) {
      throw new Error('file attachments require a live agent session')
    }
    return { kind: 'resumeAndSend', payload: { sessionId: input.sessionId, text: input.text } }
  }
  return {
    kind: 'sendText',
    payload: {
      sessionId: input.sessionId,
      text: input.text,
      ...(input.attachments?.length ? { attachments: [...input.attachments] } : {}),
    },
  }
}

/**
 * Send one chat message by id and wait for the server's answer or the outbox's
 * give-up. Throws `ChatNotSentError` when the entry parks.
 */
export async function sendChatThroughOutbox(
  deps: { readonly outbox: EngineOutbox; readonly settlements: OutboxSettlements },
  input: ChatSendInput,
  mutationId: MutationId,
): Promise<ChatSendOutcome> {
  const { outbox, settlements } = deps
  if (outbox.awaiting().some((entry) => entry.mutationId === mutationId)) {
    // Landed already; the answer went to whoever was waiting then.
    return outcomeOf(undefined, input.wake)
  }
  // Registered BEFORE the call that causes the settlement: the drain can
  // resolve the entry before that call returns.
  const wait = settlements.next(mutationId)
  try {
    if (outbox.deadLetters().some((parked) => parked.entry.mutationId === mutationId)) {
      // The user's retry of a message that gave up: the SAME entry goes out
      // again. The queue keeps its id (see `CHAT_SEND_MAX_AGE_MS`).
      await outbox.retry(mutationId, { reissue: true })
    } else if (!outbox.pending().some((entry) => entry.mutationId === mutationId)) {
      const { kind, payload } = payloadOf(input)
      await outbox.enqueue(kind, payload, { mutationId })
    }
    // Otherwise it is already on its way (a reloaded conversation asking
    // again): wait on it.
  } catch (error) {
    wait.cancel()
    throw error
  }
  const settlement = await wait.settled
  if (settlement.kind === 'not-sent') throw notSent(settlement)
  return outcomeOf(settlement.reply, input.wake)
}

/** Let a message the outbox still holds go — parked or not yet sent — so
 *  nothing sends it later. A message the queue no longer holds is past
 *  discarding: it reached the server. */
export async function discardChatThroughOutbox(
  outbox: EngineOutbox,
  mutationId: MutationId,
): Promise<void> {
  const held =
    outbox.deadLetters().some((parked) => parked.entry.mutationId === mutationId) ||
    outbox.pending().some((entry) => entry.mutationId === mutationId)
  if (held) await outbox.discard(mutationId)
}

/** A fresh message id, in the form the server's message ledger uses. */
export function newChatMessageId(): MutationId {
  return asMutationId(`msg_${randomUUID()}`)
}

/** The chat messages the outbox holds for one session, oldest first. */
export function outboxChatSends(outbox: EngineOutbox, sessionId: SessionId): OutboxChatSend[] {
  const sends: OutboxChatSend[] = []
  const add = (
    entry: { mutationId: MutationId; kind: string; input: unknown; queuedAt: number },
    state: OutboxChatSend['state'],
    failure?: ChatNotSentError,
  ): void => {
    if (!CHAT_KINDS.has(entry.kind)) return
    const payload = entry.input as OutboxKinds['sendText']
    if (payload.sessionId !== sessionId) return
    sends.push({
      mutationId: entry.mutationId,
      sessionId,
      text: payload.text,
      ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
      wake: entry.kind === 'resumeAndSend',
      queuedAt: entry.queuedAt,
      state,
      ...(failure ? { failure } : {}),
    })
  }
  for (const entry of outbox.pending()) add(entry, 'sending')
  for (const parked of outbox.deadLetters()) {
    add(
      parked.entry,
      'failed',
      notSent({ kind: 'not-sent', reason: parked.reason, cause: undefined }),
    )
  }
  return sends.sort((a, b) => a.queuedAt - b.queuedAt)
}
