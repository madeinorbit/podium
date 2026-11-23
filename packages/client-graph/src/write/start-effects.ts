/**
 * THE STARTS AMONG THE POOL'S EFFECTS (POD-6411): the `session.launch` and
 * `issue.start` records the launch paint reads, as the pool's own effect
 * models, so each record has one copy on the client.
 *
 * One computed per pool. It lists the starts once per change of the effect
 * set (a model's `isStart` is its own boundary, so a Stop's progress does not
 * re-list), and a reconcile reads only those few, never every effect.
 */

import { compareShallow, computed, type IComputedValue } from 'mobx'
import { here } from '../lookup'
import type { EffectModel } from '../models'
import type { MobxPool } from '../pool'

const starts = new WeakMap<MobxPool, IComputedValue<readonly EffectModel[]>>()

/** TRACKED: the pool's start effects, in table order. */
export function startEffects(pool: MobxPool): readonly EffectModel[] {
  let list = starts.get(pool)
  if (list === undefined) {
    list = computed(
      () => {
        const out: EffectModel[] = []
        for (const id of pool.tables.effect.keys()) {
          const effect = here(pool.model('effect', id))
          if (effect?.isStart) out.push(effect)
        }
        return out
      },
      { equals: compareShallow },
    )
    starts.set(pool, list)
  }
  return list.get()
}
