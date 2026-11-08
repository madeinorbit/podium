/**
 * THE AGENT REQUESTS WAITING FOR THIS PERSON (POD-6674): the `approval` effect
 * records among the pool's effects that nobody has decided yet, oldest first,
 * as the pool's own effect models.
 *
 * They arrive on the feed like every effect record, so they show after a
 * restart, offline from the saved copy and on every device the person uses.
 * The server sends a person the requests they may see: their own, and those of
 * the issues they may read, and those routed to them. A request is routed to
 * its owner when they may run its operation, else to the admins who may; only
 * those are listed here, and the server checks again on the decision.
 *
 * One computed per pool; it re-lists when the effect set or a listed record's
 * decision or status changes.
 */

import { compareShallow, computed, type IComputedValue } from 'mobx'
import { here } from './lookup'
import type { EffectModel } from './models'
import type { MobxPool } from './pool'

const lists = new WeakMap<MobxPool, IComputedValue<readonly EffectModel[]>>()

/** TRACKED: the undecided approval requests routed to the viewer, oldest first. */
export function pendingApprovals(pool: MobxPool): readonly EffectModel[] {
  let list = lists.get(pool)
  if (list === undefined) {
    list = computed(
      () => {
        const out: EffectModel[] = []
        for (const id of pool.tables.effect.keys()) {
          const effect = here(pool.model('effect', id))
          if (effect?.isApproval && effect.awaitingDecision && effect.forViewer) out.push(effect)
        }
        return out.sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        )
      },
      { equals: compareShallow },
    )
    lists.set(pool, list)
  }
  return list.get()
}
