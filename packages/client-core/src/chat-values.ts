/** Pure readings of the single durable chat queue, shared by runtime and pool. */
import type { MutationId, SessionId } from '@podium/model'
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'
import type { OutboxSettlement } from './outbox'
import type { EngineOutbox, OutboxKinds } from './engine/wiring'

const CHAT_KINDS = new Set<string>(['sendText', 'resumeAndSend'])

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

/** Why a message the server never refused did not go: it could not get there
 *  inside `CHAT_SEND_MAX_AGE_MS`. */
const GAVE_UP = "couldn't reach the server"

export function chatNotSent(
  settlement: Extract<OutboxSettlement, { kind: 'not-sent' }>,
): ChatNotSentError {
  if (settlement.reason.code === 'max-age') {
    return new ChatNotSentError(`not sent — ${GAVE_UP}`, true)
  }
  const cause = settlement.cause
  const said = cause instanceof Error && cause.message !== '' ? cause.message : undefined
  return new ChatNotSentError(said ? `not sent — ${said}` : 'not sent', false)
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
      chatNotSent({ kind: 'not-sent', reason: parked.reason, cause: undefined }),
    )
  }
  return sends.sort((a, b) => a.queuedAt - b.queuedAt)
}
