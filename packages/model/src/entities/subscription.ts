/**
 * AN AUTOMATION TRIGGER SUBSCRIPTION AS A SYNCED RECORD (POD-6676, ADR 12 D1;
 * design POD-5620 §1.11).
 *
 * One `subscriptions` row: who is woken (`subscriber`), by which event, about
 * what (`source`), and how. Its spec field is `enabled`; removing it is the
 * other write. Both are the subscriber's own (a person's own session or task,
 * or an agent's derived subscriber); everything else the server fills in.
 *
 * FEED ROW IDENTITY. The change-log id is `(subscriberKind, subscriberId, id)`,
 * not the bare `sub_…` id, for the reason `interactionRowId` carries its
 * session: the feed decides who may read a row by its subscriber, and a removal
 * carries no value to read the subscriber from. With the subscriber in the id,
 * a bootstrap prefetches every subscriber in one batched read and a removal is
 * scoped like the row it removes. A subscription never changes subscriber.
 */

import { z } from 'zod'

export const SubscriberKind = z.enum(['session', 'issue'])
export type SubscriberKind = z.infer<typeof SubscriberKind>

export const SubscriptionSourceKind = z.enum(['relationship', 'issue', 'session'])
export type SubscriptionSourceKind = z.infer<typeof SubscriptionSourceKind>

export const SubscriptionOrigin = z.enum(['default', 'custom'])
export type SubscriptionOrigin = z.infer<typeof SubscriptionOrigin>

/** A durable event subscription (event-subscriptions design, Phase B). */
export const SubscriptionWire = z.object({
  id: z.string(),
  /** Who is notified: a session (in-session nudge) or an issue (its sessions). */
  subscriberKind: SubscriberKind,
  subscriberId: z.string(),
  /** The subscription-event kind matched (e.g. 'issue.closed', 'session.finished'). */
  event: z.string(),
  /** What is watched: a dynamic relationship, or an explicit issue / session id. */
  sourceKind: SubscriptionSourceKind,
  sourceRef: z.string(),
  deliverNudge: z.boolean(),
  deliverNotify: z.boolean(),
  origin: SubscriptionOrigin,
  enabled: z.boolean(),
  createdAt: z.string(),
})
export type SubscriptionWire = z.infer<typeof SubscriptionWire>

const ROW_SEP = '\n'

const esc = (part: string): string =>
  part.replaceAll('\\', '\\\\').replaceAll(ROW_SEP, `\\${ROW_SEP}`)

/** The change-log entityId for one subscription. */
export function subscriptionRowId(
  subscriberKind: SubscriberKind,
  subscriberId: string,
  id: string,
): string {
  return `${subscriberKind}${ROW_SEP}${esc(subscriberId)}${ROW_SEP}${esc(id)}`
}

/** Inverse of {@link subscriptionRowId}. Throws on a malformed id. */
export function parseSubscriptionRowId(rowId: string): {
  subscriberKind: SubscriberKind
  subscriberId: string
  id: string
} {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < rowId.length; i++) {
    const ch = rowId[i]
    if (ch === '\\') {
      const next = i + 1 < rowId.length ? rowId[i + 1] : undefined
      if (next !== '\\' && next !== ROW_SEP) {
        throw new Error(`malformed subscription row id: ${JSON.stringify(rowId)}`)
      }
      current += next
      i += 1
    } else if (ch === ROW_SEP) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  const kind = SubscriberKind.safeParse(parts[0])
  if (parts.length !== 3 || !kind.success || parts[1] === '' || parts[2] === '') {
    throw new Error(`malformed subscription row id: ${JSON.stringify(rowId)}`)
  }
  return { subscriberKind: kind.data, subscriberId: parts[1]!, id: parts[2]! }
}

/** A subscription's feed id. */
export const subscriptionRowIdOf = (
  sub: Pick<SubscriptionWire, 'subscriberKind' | 'subscriberId' | 'id'>,
): string => subscriptionRowId(sub.subscriberKind, sub.subscriberId, sub.id)
