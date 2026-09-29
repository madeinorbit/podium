import { deadLetterDeliveryLine, MessageDelivery } from '@podium/model'
import type { MessageRecordWire, TranscriptItem, TranscriptTag } from '@podium/model'
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'

/**
 * A message this device is sending, from the composer until the server's
 * record of it arrives (POD-4764). After that the record says where it stands.
 */
export interface ConversationPendingTurn {
  id: string
  /** The message id the composer minted: the outbox entry, the server row and
   *  the synced record all carry it. */
  deliveryId: string
  text: string
  /** Exact payload delivered to the agent. Retry never reconstructs it from `text`. */
  wire: string
  at: number
  state: 'sending' | 'queued' | 'sent' | 'failed' | 'interrupted' | 'retracted'
  kind: 'message' | 'offer'
  error?: string
  /** False when a failed turn cannot succeed by being sent again as it is — the
   *  server refused these words, rather than never receiving them (POD-4762).
   *  Absent means a retry may work. */
  retryable?: boolean
  /** Out-of-band staged attachment refs delivered with this turn (POD-2408).
   *  Opaque here: the adapter's `deliver` is what puts them on the wire. */
  attachments?: readonly RuntimeAttachmentRef[]
  /** 1-based position the authority returned when this send entered its FIFO. */
  queuePosition?: number
  tags?: TranscriptTag[]
  toolPaths?: string[]
  files?: readonly { path: string }[]
  /**
   * How the bubble learns the agent has the message. By default (`record`) from
   * the server's synced record: the bubble leaves when the history entry the
   * record names is on screen. A send that makes no message record — a
   * headless thread turn, a session's first prompt — leaves when the agent's
   * next user entry appears (`next-user-item`), whatever its text.
   */
  reconcile?: 'record' | 'next-user-item'
}

/** What a bubble says about delivery. */
export type ConversationBubbleState =
  /** Leaving this device. */
  | 'sending'
  /** The server holds it: waiting its turn, or for the session to wake. */
  | 'queued'
  /** Handed on toward the agent, or confirmed and about to show in the history. */
  | 'sent'
  /** Did not go (this device gave up) or will not arrive (the server says so). */
  | 'failed'
  /** Nobody can say whether it arrived. */
  | 'unknown'
  | 'interrupted'
  /** Taken back before the agent's machine started typing it (POD-4776). */
  | 'retracted'

/** One bubble below the transcript. */
export interface ConversationBubble extends Omit<ConversationPendingTurn, 'state'> {
  state: ConversationBubbleState
  /** The server's record of the message, once the feed carries it. */
  record?: MessageRecordWire
  /** The sender may still take it back: its status still allows a retract to
   *  win, and none was asked for yet (POD-4776). */
  retractable: boolean
  /**
   * Where a retract of it stands (POD-4776): asked and still on its way to the
   * agent's machine (`requested`), or answered too late — the machine had
   * already started typing it (`too-late`). A retract that won is the
   * `retracted` state. Absent when nobody asked.
   */
  retract?: 'requested' | 'too-late'
  /** Why this device's retract of it did not go through. */
  retractError?: string
  /** A failed or unknown message the SERVER holds: the way on is "send again"
   *  (a new message, by the user's choice) or dismissing the notice — never a
   *  resend of this one. Absent for a send this device never got through. */
  notice?: 'failed' | 'unknown'
}

export interface ConversationProjectionInput {
  readonly turns: readonly ConversationPendingTurn[]
  /** This session's records, as the feed carries them. */
  readonly records: readonly MessageRecordWire[]
  readonly transcript: readonly TranscriptItem[]
  /** Records this view saw before they were confirmed: only those may show a
   *  bubble once confirmed (an older confirmed record is history). */
  readonly seenOpen: ReadonlySet<string>
  /** Message ids being dismissed right now: hidden meanwhile. */
  readonly hidden: ReadonlySet<string>
  /** This device's retracts still waiting for their answer to reach the record,
   *  and the ones that failed with why (POD-4776). */
  readonly retracting?: ReadonlyMap<string, { error?: string }>
}

/** A retract can still win: the lifecycle lets the status move to `cancelled`. */
const statusAllowsRetract = (status: MessageRecordWire['status']): boolean =>
  MessageDelivery.canMove(status, 'cancelled')

/** A local send the server may hold and has not confirmed. */
const LOCAL_RETRACTABLE = new Set<ConversationPendingTurn['state']>(['sending', 'queued', 'sent'])

function retractOf(record: MessageRecordWire): ConversationBubble['retract'] {
  if (!record.retractRequestedAt || record.status === 'cancelled') return undefined
  if (statusAllowsRetract(record.status)) return 'requested'
  if (record.status === 'typing' || record.status === 'typed' || record.status === 'confirmed') {
    return 'too-late'
  }
  // Failed or expired: its notice already says what happened.
  return undefined
}

function recordState(record: MessageRecordWire): ConversationBubbleState {
  switch (record.status) {
    case 'stored':
      return 'queued'
    case 'dispatched':
    case 'reached-machine':
    case 'typing':
    case 'typed':
    case 'confirmed':
      return 'sent'
    case 'failed':
    case 'expired':
      return 'failed'
    case 'unknown':
      return 'unknown'
    case 'cancelled':
      return 'retracted'
  }
}

/**
 * Whether a record still needs a bubble: its sender has not dismissed its
 * notice, its history entry is not on screen, and — once confirmed — this view
 * watched it go out and the machine named the entry it became. A confirmed
 * record naming nothing has no id to wait for, so the history shows it without
 * a bubble; no text is ever compared.
 */
function recordShows(
  record: MessageRecordWire,
  onScreen: ReadonlySet<string>,
  seenOpen: ReadonlySet<string>,
): boolean {
  // Only a read by id carries a dismissal (POD-4811): the feed lets one go.
  if (record.noticeDismissedAt !== undefined) return false
  if (record.transcriptItem && onScreen.has(record.transcriptItem.id)) return false
  if (record.status !== 'confirmed') return true
  return record.transcriptItem !== undefined && seenOpen.has(record.id)
}

function failureOf(record: MessageRecordWire): string {
  if (record.status === 'expired') return 'not delivered · it waited too long'
  return deadLetterDeliveryLine(record.reason)
}

function fromRecord(record: MessageRecordWire): ConversationBubble {
  const state = recordState(record)
  return {
    id: record.id,
    deliveryId: record.id,
    text: record.body,
    wire: record.body,
    at: Date.parse(record.createdAt) || 0,
    kind: 'message',
    ...(record.attachments?.length
      ? { files: record.attachments.map((attachment) => ({ path: attachment.filename })) }
      : {}),
    state,
    record,
    retractable: statusAllowsRetract(record.status) && !record.retractRequestedAt,
    ...(retractOf(record) ? { retract: retractOf(record) } : {}),
    ...(state === 'failed' ? { notice: 'failed' as const, error: failureOf(record) } : {}),
    ...(state === 'unknown' ? { notice: 'unknown' as const } : {}),
  }
}

/**
 * THE BUBBLES, BY ID (POD-4764). A local turn until the server's record of it
 * arrives, then the record; a record this device never sent (another device,
 * or a send from before a reload) is a bubble of its own. A bubble leaves when
 * the history entry its record names is on screen. Nothing here reads the text
 * of a transcript item.
 */
export function projectConversation(input: ConversationProjectionInput): ConversationBubble[] {
  const onScreen = new Set(input.transcript.map((item) => item.id))
  const byId = new Map(input.records.map((record) => [record.id, record]))
  const bubbles: ConversationBubble[] = []
  const covered = new Set<string>()
  const retracting = input.retracting ?? new Map<string, { error?: string }>()
  /** This device's retract in flight shows as asked until the record says so. */
  const withLocalRetract = (bubble: ConversationBubble): ConversationBubble => {
    const local = retracting.get(bubble.deliveryId)
    if (local === undefined) return bubble
    if (local.error !== undefined) return { ...bubble, retractError: local.error }
    return { ...bubble, retractable: false, retract: bubble.retract ?? 'requested' }
  }
  for (const turn of input.turns) {
    covered.add(turn.deliveryId)
    if (input.hidden.has(turn.deliveryId)) continue
    const record = byId.get(turn.deliveryId)
    if (turn.state === 'retracted') {
      // Taken back on this device's word: it stays as the answer, whatever
      // the feed does with the record now.
      bubbles.push({ ...turn, retractable: false })
      continue
    }
    if (record === undefined) {
      bubbles.push(withLocalRetract({ ...turn, retractable: LOCAL_RETRACTABLE.has(turn.state) }))
      continue
    }
    if (!recordShows(record, onScreen, input.seenOpen)) continue
    const fromServer = withLocalRetract(fromRecord(record))
    bubbles.push(
      turn.state === 'interrupted'
        ? { ...fromServer, ...turn, state: 'interrupted', record, retractable: false }
        : {
            ...fromServer,
            id: turn.id,
            text: turn.text,
            wire: turn.wire,
            at: turn.at,
            kind: turn.kind,
            ...(turn.tags ? { tags: turn.tags } : {}),
            ...(turn.files ? { files: turn.files } : {}),
            ...(turn.attachments ? { attachments: turn.attachments } : {}),
            ...(turn.queuePosition !== undefined && fromServer.state === 'queued'
              ? { queuePosition: turn.queuePosition }
              : {}),
          },
    )
  }
  for (const record of input.records) {
    if (covered.has(record.id) || input.hidden.has(record.id)) continue
    if (!recordShows(record, onScreen, input.seenOpen)) continue
    bubbles.push(withLocalRetract(fromRecord(record)))
  }
  return bubbles.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
}
