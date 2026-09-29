/**
 * WHAT A PHONE BUBBLE SAYS ABOUT ITS DELIVERY (POD-4764, POD-4776, POD-4885).
 *
 * The shared conversation controller decides where a message stands (its
 * bubble state); this turns that into the row the transcript list draws and
 * the one line under it. Kept apart from the components so the words can be
 * held by a test without rendering a transcript.
 */

import type { ConversationBubble } from '@podium/client-core/conversation'
import { MESSAGE_ACCEPTED_LINE } from '@podium/model'
import type { PendingTurn } from './TranscriptList'
import type { SentAttachment } from './useComposerAttachments'

export type LocalPendingTurn = PendingTurn & { wire: string }

/** The transcript list's row for one bubble. */
export function pendingTurnOf(bubble: ConversationBubble): LocalPendingTurn {
  return {
    id: bubble.id,
    text: bubble.text,
    wire: bubble.wire,
    ...(bubble.files ? { files: bubble.files as readonly SentAttachment[] } : {}),
    ...(bubble.state === 'failed'
      ? { failed: bubble.error ?? (bubble.notice ? 'not delivered' : 'not sent') }
      : {}),
    ...(bubble.retryable === false ? { retryable: false } : {}),
    ...(bubble.state === 'interrupted' ? { interrupted: true } : {}),
    ...(bubble.state === 'queued' ? { queued: true } : {}),
    ...(bubble.state === 'sent' || bubble.state === 'accepted' || bubble.state === 'unknown'
      ? { delivery: bubble.state }
      : {}),
    ...(bubble.notice ? { notice: bubble.notice } : {}),
    ...(bubble.retractable ? { retractable: true } : {}),
    ...(bubble.state === 'retracted' ? { retracted: true } : {}),
    ...(bubble.retract ? { retract: bubble.retract } : {}),
    ...(bubble.retractError ? { retractError: bubble.retractError } : {}),
  }
}

/** What the line under a bubble says about a retract of it (POD-4776). */
export function retractLine(turn: Pick<PendingTurn, 'retracted' | 'retract'>): string | undefined {
  if (turn.retracted) return 'retracted'
  if (turn.retract === 'requested') return 'retracting…'
  if (turn.retract === 'too-late') return 'too late to retract — already typed'
  return undefined
}

/** Why the bubble is drawn as not arriving, or undefined when it is not. */
export function pendingFailure(turn: PendingTurn): string | undefined {
  return (
    turn.failed ??
    (turn.delivery === 'unknown' ? 'not confirmed — it may or may not have arrived' : undefined)
  )
}

/** The one line under a bubble. */
export function pendingMetaLine(turn: PendingTurn): string {
  if (pendingFailure(turn)) {
    if (turn.delivery === 'unknown') return 'not confirmed'
    return turn.notice !== undefined ? 'not delivered' : 'not sent'
  }
  return (
    retractLine(turn) ??
    (turn.interrupted
      ? 'interrupted'
      : turn.queued
        ? 'waiting its turn'
        : turn.delivery === 'accepted'
          ? MESSAGE_ACCEPTED_LINE
          : turn.delivery === 'sent'
            ? 'sent'
            : 'sending…')
  )
}
