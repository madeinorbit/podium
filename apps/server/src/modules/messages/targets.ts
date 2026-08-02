/**
 * The vocabulary the delivery owners share (POD-1397).
 *
 * A delivery target is the DURABLE recipient principal — an issue or a session
 * — as opposed to whichever live session a message happens to reach. Three
 * owners speak it: the scheduler queues work per target, the containment brakes
 * hold the targets whose wake is cooling down, and the service resolves a row
 * to one.
 *
 * They share the vocabulary and nothing else. This file holds types and two
 * pure functions on purpose: it exists so the three owners can talk about the
 * same nouns WITHOUT any of them handing a live map or timer to another, which
 * is the shape `docs/architecture/god-object-audit.md` names as the coupling a
 * decomposition can hide (`observationLeases`, POD-1396).
 */

import type { MessageRow } from '../../store'
import type { MessagePageCursor } from '../../store/messages'

/** The durable recipient principal a queued message is addressed to. */
export type DeliveryTarget = { kind: 'session' | 'issue'; id: string }

/** Coalescing key. Every map keyed by a target uses this and only this, so two
 *  owners naming the same target always produce the same string. */
export const deliveryTargetKey = (target: DeliveryTarget): string => `${target.kind}:${target.id}`

/** One page of a target's pending rows. Shared because the scheduler's drain
 *  and the service's turn-boundary confirm loop page the same repository, and a
 *  boundary that walked a different page size than the drain it precedes would
 *  confirm a different set than it delivered. */
export const DELIVERY_TARGET_PAGE_LIMIT = 200

/** The (createdAt, id) pair that orders and pages the queue. */
export function cursorOf(message: MessageRow): MessagePageCursor {
  return {
    createdAt: message.createdAt,
    id: message.id,
  }
}

/** Total order on cursors — createdAt first, id as the tiebreak, matching the
 *  repository's own page ordering. */
export function compareCursor(a: MessagePageCursor, b: MessagePageCursor): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}
