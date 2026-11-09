/**
 * A SUBSCRIPTION'S CHANGE ENTRIES (POD-6676): under its feed id,
 * `subscriptionRowId(subscriberKind, subscriberId, id)`, so the feed scopes a
 * removal like the row it removes. Committed with every subscription write.
 */

import { type SubscriptionWire, subscriptionRowIdOf } from '@podium/model'
import type { EntityChangeSpec } from '@podium/sync'

/** A subscription's change entry: the row as stored. */
export function subscriptionUpsert(sub: SubscriptionWire): EntityChangeSpec {
  return { entity: 'subscription', id: subscriptionRowIdOf(sub), op: 'upsert', value: sub }
}

/** A removed subscription's change entry, under the id it was published by. */
export function subscriptionRemoval(
  sub: Pick<SubscriptionWire, 'subscriberKind' | 'subscriberId' | 'id'>,
): EntityChangeSpec {
  return { entity: 'subscription', id: subscriptionRowIdOf(sub), op: 'remove' }
}
