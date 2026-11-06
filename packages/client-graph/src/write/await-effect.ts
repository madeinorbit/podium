/**
 * WAIT FOR AN EFFECT RECORD TO END (POD-6523; reused by POD-6526).
 *
 * An action written as an effect record (ADR 12 D5 E2) answers on the record,
 * not on the write: the device queues `effects.create` under an id it minted,
 * and the server moves the record's status as it runs. A caller that has to
 * say how it ended (a toast on the device that asked) waits here for the
 * pool's own `EffectModel` of that id to reach a terminal status.
 *
 *  - It reads the pool, the one copy of the record on the client, and only
 *    the effects the pool already holds: an id it does not hold is waited for,
 *    never fetched.
 *  - Data only, no timer of its own. A record that never arrives (its create
 *    was refused, or the device went away) waits until the caller's `signal`
 *    aborts; the write's own rejection is the caller's to handle.
 *  - Resolves with the model itself, so the caller reads `status`, `result`
 *    and `error` from the same object every other reader does.
 */

import { when } from 'mobx'
import { here } from '../lookup'
import type { EffectModel } from '../models'
import type { MobxPool } from '../pool'

/** The pool as this reads it: its effect table, and the addressed model. */
export type EffectPool = Pick<MobxPool, 'tables' | 'model'>

/** TRACKED: the pool's effect model of `id`, once the pool holds the record. */
export function heldEffect(pool: EffectPool, id: string): EffectModel | undefined {
  if (!pool.tables.effect.has(id)) return undefined
  return here(pool.model('effect', id))
}

/**
 * Resolves with the effect's model once it has ended (`succeeded`, `failed`,
 * `expired`, `cancelled` or `unknown`); rejects with the signal's reason if it
 * aborts first.
 */
export async function awaitEffect(
  pool: EffectPool,
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<EffectModel> {
  let ended: EffectModel | undefined
  await when(
    () => {
      const effect = heldEffect(pool, id)
      if (effect === undefined || effect.inFlight) return false
      ended = effect
      return true
    },
    options.signal ? { signal: options.signal } : {},
  )
  return ended!
}
