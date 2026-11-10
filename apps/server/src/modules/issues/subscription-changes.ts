/**
 * A SUBSCRIPTION'S RECORD ON THE FEED (POD-6676): under its feed id,
 * `subscriptionRowId(subscriberKind, subscriberId, id)`, so the feed scopes a
 * removal like the row it removes. Every subscription write names it, and the
 * Authority builds it before and after the write (compare at save, POD-6769).
 */

import { type SubscriptionWire, subscriptionRowIdOf } from '@podium/model'
import type { AffectedRecordSpec } from '@podium/sync'

/** The record a write of this subscription may affect. */
export function subscriptionRecord(
  sub: Pick<SubscriptionWire, 'subscriberKind' | 'subscriberId' | 'id'>,
): AffectedRecordSpec {
  return { entity: 'subscription', id: subscriptionRowIdOf(sub) }
}
