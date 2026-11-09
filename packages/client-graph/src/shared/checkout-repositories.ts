/**
 * The registered repositories, derived from `checkout` records (POD-6644). The
 * derivation is the model's (`repositoriesFromCheckouts`), shared with the
 * client store's navigation reactions.
 */
export {
  type CheckoutRepository,
  checkoutRepositoryId,
  repositoriesFromCheckouts,
} from '@podium/model'

import type { CheckoutWire } from '@podium/model'
import type { MobxPool } from '../pool'

/** All optional sources borrow this pool's one checkout read port. Their
 * existing addressed subscriptions invalidate it; no extra feed is installed. */
export function bindCheckoutRecords(pool: MobxPool, replica: { rows(kind: 'checkouts'): readonly CheckoutWire[] }): void {
  pool.sources.view('checkouts.records', () => ({
    dispose: pool.bindCheckouts(() => replica.rows('checkouts')),
  }))
}
