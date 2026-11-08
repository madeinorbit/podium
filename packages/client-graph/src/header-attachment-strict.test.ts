import type { ClientRuntime } from '@podium/client-core/engine'
import { runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { installMobxWarnTrap } from '../../../tests/worklist/harness/src/mobx-trap'
import { headerEntities } from './header-entities'
import type { HeaderRows } from './header-schema'
import { attachHeaderSource } from './header-source'
import { MobxPool } from './pool'

// POD-5699: attaching the header source iterated pool table keys() outside an
// action, which the strict diagnostic trap reports as an untracked read and
// which kept the screen work meter from starting under that configuration.
// The attachment stays imperative; the reconciliation read belongs inside
// its action. ENFORCEMENT is unchanged (the trap asserts it).
installMobxWarnTrap({ errors: true })

function stubRuntime() {
  const runtime = {
    listIds: () => [],
    listRow: () => undefined,
    onList: () => () => {},
    readLocal: () => undefined,
    onLocals: () => () => {},
    access: { trpc: { settings: { get: { query: async () => ({}) } } } },
    replica: { rows: () => [], subscribeAddressedBatch: () => () => {} },
  } as unknown as ClientRuntime
  return { runtime }
}

it('attaches the header source without untracked observable reads', () => {
  const { runtime } = stubRuntime()
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  try {
    // The attachment's reconciliation read runs against a populated table
    // here too: the stale row must be removed without tripping the trap.
    headerEntities(pool).apply([
      { kind: 'shipOrder', id: 'stale', value: { id: 'stale' } as HeaderRows['shipOrder'] },
    ])
    const stop = attachHeaderSource(pool, runtime)
    try {
      runInAction(() => {
        expect(headerEntities(pool).get('shipOrder', 'stale')).toBeUndefined()
        expect(headerEntities(pool).get('window', 'window')).toBeDefined()
      })
    } finally {
      stop()
    }
  } finally {
    pool.dispose()
  }
})
