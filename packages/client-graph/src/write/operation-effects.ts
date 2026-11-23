/**
 * THE UPDATES AND SERVER MOVES AMONG THE POOL'S EFFECTS (POD-6683): the
 * `server.update` and `server.move` records an operation starts from
 * (POD-6358), as the pool's own effect models.
 *
 * The web update-status reader watches them as a trigger only: it reads its
 * plain-HTTP status once when one appears or changes status, and works the
 * same without them. One computed per pool; it re-lists once per change of the
 * effect set (a record's kind never changes), and a status change is read on
 * the listed models alone.
 */

import { compareShallow, computed, type IComputedValue } from 'mobx'
import { here } from '../lookup'
import type { EffectModel } from '../models'
import type { MobxPool } from '../pool'

/** The effect kinds a software update or a server move starts from. */
export const OPERATION_EFFECT_KINDS: ReadonlySet<string> = new Set(['server.update', 'server.move'])

const lists = new WeakMap<MobxPool, IComputedValue<readonly EffectModel[]>>()

/** TRACKED: the pool's update and server-move effects, in table order. */
export function operationEffects(pool: MobxPool): readonly EffectModel[] {
  let list = lists.get(pool)
  if (list === undefined) {
    list = computed(
      () => {
        const out: EffectModel[] = []
        for (const id of pool.tables.effect.keys()) {
          const effect = here(pool.model('effect', id))
          if (effect && OPERATION_EFFECT_KINDS.has(effect.kind)) out.push(effect)
        }
        return out
      },
      { equals: compareShallow },
    )
    lists.set(pool, list)
  }
  return list.get()
}
