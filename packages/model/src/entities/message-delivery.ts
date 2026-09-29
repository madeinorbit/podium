/**
 * THE MESSAGE DELIVERY LIFECYCLE (POD-4765; POD-4720 §4 rule 3, §5.2, §6.4).
 *
 * One status per message, owned by the server row, that only moves forward:
 *
 *   stored → dispatched → reached-machine → typing → typed → accepted → confirmed
 *
 * with `cancelled`, `failed` and `expired` as the other ways out, and `unknown`
 * as the one explicit "we lost track" state. A move may skip ahead (an inbox
 * read confirms a message that was never pushed), never back. A repeated or late
 * report finds the row already there or past it and changes nothing, so replays,
 * restarts and duplicate reports are harmless by construction.
 *
 * WHAT EACH STATE CLAIMS, AND ONLY THAT
 *
 *  - `stored`          the server holds it and has not handed it on.
 *  - `dispatched`      the server handed it to one session's delivery path (that
 *                      session's durable queue, or a direct push toward its
 *                      machine), named in `delivered_to`. Nothing has confirmed
 *                      it yet; the server never pushes it again on its own.
 *  - `reached-machine` the recipient's machine reported that it holds it.
 *  - `typing`          the machine noted it is about to type it.
 *  - `typed`           its bytes crossed into the agent's input; the agent has
 *                      not yet shown that it took them.
 *  - `accepted`        the agent program took it, but it is not yet in the
 *                      program's history (POD-4885, POD-4819 §4): a protocol
 *                      reply, or a place in the program's own queue. At most
 *                      this from a protocol reply; only the history says
 *                      `confirmed`. `held` says how the program holds it:
 *                      `memory` (lost if the program exits) or `durable`
 *                      (survives a restart and may still run on its own).
 *  - `confirmed`       the recipient has it: its own transcript echoed it, a
 *                      clean turn consumed it, the driver accepted the turn, it
 *                      was read from an inbox, or an ack answered it.
 *  - `cancelled`       withdrawn before it was typed.
 *  - `failed`          it will not be delivered; the row's
 *                      `delivery_deferred_reason` says why (none = the target
 *                      was gone).
 *  - `expired`         the server let its time run out while still holding it.
 *  - `unknown`         it was handed on and nobody can say any more whether it
 *                      arrived (a crash between typing and proof, a timeout on a
 *                      handed-on message). Only a later machine report or a
 *                      person moves it.
 *
 * THE SERVER NEVER GUESSES AN OUTCOME ON A TIMER. A time limit may end a message
 * the server still holds (`stored → expired`); for one it handed on it may only
 * say `unknown`, never `failed` or `expired`, because the machine may still type
 * it. And never even `unknown` for a message the program holds durably
 * (`held: 'durable'`): that one is still in the program's own queue, and only
 * the program's history or a direct report settles it.
 *
 * `failed` STAYS FINAL. A failed message later found in the history by its id
 * keeps its status; the contradiction goes to the self-check alarm (POD-4894),
 * never back into the row (decided 2026-09-29).
 *
 * `created` (the sender has it, the server does not yet) is not a server status:
 * before the row exists there is nothing to hold one, and the sender's own
 * outbox tracks that leg.
 *
 * `reached-machine` and `typing` are declared now so the table is the whole
 * lifecycle; their producers arrive with the daemon's delivery journal (POD-4777).
 * `unknown` is produced by the server since POD-4775: a forward or push that
 * timed out, and a machine report that says it cannot prove the text landed.
 */

import { z } from 'zod'
import { defineMachine } from '../state-machine'

export const MESSAGE_DELIVERY_STATUSES = [
  'stored',
  'dispatched',
  'reached-machine',
  'typing',
  'typed',
  'accepted',
  'confirmed',
  'cancelled',
  'failed',
  'expired',
  'unknown',
] as const
export const MessageDeliveryStatus = z.enum(MESSAGE_DELIVERY_STATUSES)
export type MessageDeliveryStatus = z.infer<typeof MessageDeliveryStatus>

/**
 * A STATUS AS A CLIENT READS IT OFF THE WIRE (POD-4885).
 *
 * The list above grows (`accepted` did), and a client built before a new status
 * must not refuse the row that carries it: on the sync feed a row that fails to
 * parse is dropped and fetched again, forever. So a client reads any status it
 * does not know as `typed` — still on its way, the agent not yet shown to have
 * it — which claims nothing the server did not say: not delivered, not failed.
 * Producers keep the strict {@link MessageDeliveryStatus}. {@link readDeliveryStatus}
 * is the same reading for a value that arrived without a schema (a tRPC reply).
 */
export const readDeliveryStatus = (status: string): MessageDeliveryStatus =>
  (MESSAGE_DELIVERY_STATUSES as readonly string[]).includes(status)
    ? (status as MessageDeliveryStatus)
    : 'typed'

export const MessageDeliveryStatusOnWire = z.string().transform(readDeliveryStatus)

/**
 * HOW THE AGENT PROGRAM HOLDS AN `accepted` MESSAGE (POD-4885, POD-4819 §4).
 *
 *  - `memory`  lost when the program exits: Claude's and Grok's terminal
 *              queues, a Codex steer, a line Claude SDK has queued. It goes
 *              `unknown` when its watch closes.
 *  - `durable` survives a restart and may run later on its own: a Codex
 *              `thread/queue` item, an OpenCode v2 admission. It is re-checked
 *              in the program's pending queue and never goes `unknown` by a
 *              timer.
 *
 * Set together with the move to `accepted` and kept after it, so a message
 * that went `unknown` still says the program had taken it.
 */
/** How every surface words `accepted` (POD-4885): the agent has it, and it is
 *  still on its way into the agent's history. `confirmed` stays "delivered". */
export const MESSAGE_ACCEPTED_LINE = 'accepted by the agent'

export const MESSAGE_HELD = ['memory', 'durable'] as const
export const MessageHeld = z.enum(MESSAGE_HELD)
export type MessageHeld = z.infer<typeof MessageHeld>

export const MessageDelivery = defineMachine('message delivery', {
  states: MESSAGE_DELIVERY_STATUSES,
  edges: {
    stored: [
      'dispatched',
      'reached-machine',
      'typing',
      'typed',
      'accepted',
      'confirmed',
      'cancelled',
      'failed',
      'expired',
    ],
    dispatched: [
      'reached-machine',
      'typing',
      'typed',
      'accepted',
      'confirmed',
      'cancelled',
      'failed',
      'unknown',
    ],
    'reached-machine': [
      'typing',
      'typed',
      'accepted',
      'confirmed',
      'cancelled',
      'failed',
      'unknown',
    ],
    typing: ['typed', 'accepted', 'confirmed', 'failed', 'unknown'],
    typed: ['accepted', 'confirmed', 'failed', 'unknown'],
    accepted: ['confirmed', 'failed', 'unknown'],
    unknown: ['confirmed', 'failed', 'cancelled'],
    confirmed: [],
    cancelled: [],
    failed: [],
    expired: [],
  },
  terminal: ['confirmed', 'cancelled', 'failed', 'expired'],
})

/** Handed on toward one session and not yet confirmed: the server has done its
 *  part and waits for the machine or the agent. `accepted` is still on its way:
 *  the program has it, its history does not yet. */
export const MESSAGE_ON_ITS_WAY = [
  'dispatched',
  'reached-machine',
  'typing',
  'typed',
  'accepted',
] as const
export type MessageOnItsWayStatus = (typeof MESSAGE_ON_ITS_WAY)[number]

/** Every status that has not ended: still held, on its way, or lost track of. */
export const MESSAGE_PENDING = MESSAGE_DELIVERY_STATUSES.filter(
  (status) => !MessageDelivery.isTerminal(status),
) as readonly MessageDeliveryStatus[]

export const isMessageOnItsWay = (status: MessageDeliveryStatus): status is MessageOnItsWayStatus =>
  (MESSAGE_ON_ITS_WAY as readonly MessageDeliveryStatus[]).includes(status)

/** Handed on toward one session and not ended: on its way, or lost track of.
 *  Any of these may still be settled by a machine report, a receipt, the echo
 *  or a read — `unknown` included, because the machine may still type it. */
export const MESSAGE_HANDED_ON = [...MESSAGE_ON_ITS_WAY, 'unknown'] as const
export type MessageHandedOnStatus = (typeof MESSAGE_HANDED_ON)[number]

export const isMessageHandedOn = (status: MessageDeliveryStatus): status is MessageHandedOnStatus =>
  (MESSAGE_HANDED_ON as readonly MessageDeliveryStatus[]).includes(status)

export const isMessagePending = (status: MessageDeliveryStatus): boolean =>
  !MessageDelivery.isTerminal(status)
