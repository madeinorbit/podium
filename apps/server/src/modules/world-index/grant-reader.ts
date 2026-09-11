import type { GrantsRepository } from '../../store/grants'
import { spanOpen } from '../../store/executor/executor'
import type { WorldIndexReader } from './index'

export type GrantReadPort = Pick<GrantsRepository, 'listForResource' | 'listForResources'>

// Key by repository identity: never share facts across stores/instances. Boot
// binds only after the snapshot and its subscription have committed. Standalone
// repositories (including pre-index boot and small test ports) stay live.
const committedReaders = new WeakMap<GrantReadPort, Pick<WorldIndexReader, 'grantsFor'>>()
export function bindCommittedGrantReader(repository: GrantReadPort, reader: Pick<WorldIndexReader, 'grantsFor'>): void {
  committedReaders.set(repository, reader)
}

/** Read-your-writes takes priority over the committed snapshot. In particular,
 * a revocation inside authorization/apply or projection spans must deny now,
 * even though WorldIndex correctly retains the old edge until commit. */
export async function readResourceGrants(repository: GrantReadPort, kind: string, id: string) {
  const reader = !spanOpen() && committedReaders.get(repository)
  return reader ? [...reader.grantsFor(kind, id)] : await repository.listForResource(kind, id)
}

export async function readResourcesGrants(repository: GrantReadPort, kind: string, ids: readonly string[]) {
  const reader = !spanOpen() && committedReaders.get(repository)
  if (!reader) return await repository.listForResources(kind, ids)
  const result = new Map<string, ReturnType<typeof reader.grantsFor>>()
  for (const id of ids) {
    const rows = reader.grantsFor(kind, id)
    if (rows.length) result.set(id, rows)
  }
  return result
}
