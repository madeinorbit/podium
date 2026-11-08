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

/**
 * Why an ended effect did not do its work, for a person (POD-6526), or
 * undefined when it succeeded or was cancelled (a cancel is the person's own
 * choice). The record's own words where it has them.
 */
export function effectShortfall(effect: Pick<EffectModel, 'status' | 'error'>): string | undefined {
  switch (effect.status) {
    case 'succeeded':
    case 'cancelled':
    case 'pending':
    case 'running':
      return undefined
    case 'expired':
      return effect.error?.message ?? 'its machine did not take it in time'
    case 'unknown':
      return effect.error?.message ?? 'the server lost track of it; check before trying again'
    default:
      return effect.error?.message ?? 'it did not run'
  }
}

/** How long a device waits for an answer: past the record's own one-minute deadline. */
export const ANSWER_WAIT_MS = 90_000

/**
 * A `session.answer` record's answer once it ended (POD-6415): the delivery's
 * own reply (its `result`, `{ ok, reason? }`) when it has one, else why it did
 * not run. Gives up after {@link ANSWER_WAIT_MS}, saying so.
 */
export async function awaitAnswer(
  pool: EffectPool,
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ ok: boolean; reason?: string }> {
  const signal = options.signal ?? AbortSignal.timeout(ANSWER_WAIT_MS)
  let effect: EffectModel
  try {
    effect = await awaitEffect(pool, id, { signal })
  } catch {
    return { ok: false, reason: 'No word yet on whether the answer arrived; check the session.' }
  }
  const reply = effect.result as { ok?: unknown; reason?: unknown; detail?: unknown } | undefined
  if (reply !== null && typeof reply === 'object' && typeof reply.ok === 'boolean') {
    if (reply.ok) return { ok: true }
    const reason =
      typeof reply.detail === 'string'
        ? reply.detail
        : typeof reply.reason === 'string'
          ? reply.reason
          : undefined
    return reason === undefined ? { ok: false } : { ok: false, reason }
  }
  const why = effectShortfall(effect)
  return why === undefined ? { ok: effect.status === 'succeeded' } : { ok: false, reason: why }
}
