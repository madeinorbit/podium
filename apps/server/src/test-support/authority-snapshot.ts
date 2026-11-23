import { CHANGE_LOG_OBSERVER } from '@podium/sync'
import type { SessionRegistry } from '../relay'
import { worldSnapshot } from './bootstrap-snapshot'

/** Internal write-seam fixtures need the named system observer, which is an
 * in-process identity rather than an authenticated client principal. */
export async function authoritySnapshot(registry: SessionRegistry) {
  return await worldSnapshot(registry, CHANGE_LOG_OBSERVER)
}
