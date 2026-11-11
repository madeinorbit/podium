import { CHANGE_LOG_OBSERVER } from '@podium/sync'
import type { SessionRegistry } from '../relay'
import { snapshotFromBootstrap } from './bootstrap-snapshot'

/** Internal write-seam fixtures need the named system observer, which is an
 * in-process identity rather than an authenticated client principal. */
export async function authoritySnapshot(registry: SessionRegistry) {
  const world = await registry.changeLedger.authority.bootstrap(CHANGE_LOG_OBSERVER)
  const identity = await registry.syncDelta.serving.identity()
  const snapshot = await snapshotFromBootstrap(
    (async function* () {
      yield {
        ...identity,
        snapshotSeq: world.throughSeq,
        kindTokens: {},
        changes: world.changes.flatMap((change) =>
          change.op === 'upsert' ? [{ ...change, payload: change.value }] : [],
        ),
        last: true,
      }
    })(),
  )
  return { ...snapshot, minAvailableSeq: await registry.syncDelta.serving.retentionFloor() }
}
