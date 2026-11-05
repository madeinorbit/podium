/**
 * WAIT FOR AN EFFECT TO SETTLE (ADR 12 D6, POD-6357).
 *
 * For the old per-command routes while they stay as thin adapters (plan Global
 * Constraints): the route creates the effect record through `sync.submit`, then
 * answers its old shape once the record has ended, so an older app, the CLI
 * and MCP see no change. New callers read the record's status from the feed
 * instead and never wait on a request.
 *
 * `unknown` counts as settled: nobody will move it without a person.
 *
 * SUBSCRIBE BEFORE READING. A settlement that commits between the read and the
 * subscription would otherwise be missed until the timeout.
 */

import { type EffectStatus, isEffectFinished } from '@podium/model'
import type { EffectRow, EffectsRepository } from '../../store/effects'

const settled = (status: EffectStatus): boolean => isEffectFinished(status) || status === 'unknown'

/** The record once it has settled, or as it stands when `timeoutMs` runs out. */
export async function awaitEffectSettled(
  repo: Pick<EffectsRepository, 'onCommitted' | 'get'>,
  id: string,
  timeoutMs: number,
): Promise<EffectRow | undefined> {
  return await awaitEffect(repo, id, (row) => settled(row.status), timeoutMs)
}

/**
 * The record once `reached` holds for it (or it has settled), or as it stands
 * when `timeoutMs` runs out. For an adapter that answers before the end, such
 * as an update's start, which answers once the record names its operation
 * (POD-6358).
 */
export async function awaitEffect(
  repo: Pick<EffectsRepository, 'onCommitted' | 'get'>,
  id: string,
  reached: (row: EffectRow) => boolean,
  timeoutMs: number,
): Promise<EffectRow | undefined> {
  const done = (row: EffectRow) => reached(row) || settled(row.status)
  let resolveReached: (row: EffectRow) => void = () => undefined
  const reachedRow = new Promise<EffectRow>((resolve) => {
    resolveReached = resolve
  })
  const unsubscribe = repo.onCommitted((rows) => {
    for (const row of rows) if (row.id === id && done(row)) resolveReached(row)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const now = await repo.get(id)
    if (now === undefined || done(now)) return now
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const first = await Promise.race([reachedRow, timedOut])
    return first === 'timeout' ? await repo.get(id) : first
  } finally {
    unsubscribe()
    if (timer !== undefined) clearTimeout(timer)
  }
}
