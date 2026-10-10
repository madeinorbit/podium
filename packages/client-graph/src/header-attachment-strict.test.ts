import type { ClientRuntime } from '@podium/client-core/engine'
import { runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { installMobxWarnTrap } from '../../../tests/worklist/harness/src/mobx-trap'
import { headerEntities } from './header-entities'
import { attachHeaderSource } from './header-source'
import type { HeaderRows } from './header-schema'
import { MobxPool } from './pool'

// POD-5699: attaching the header source iterated pool table keys() outside an
// action, which the strict diagnostic trap reports as an untracked read and
// which kept the screen work meter from starting under that configuration.
// The attachment stays imperative; the reconciliation read belongs inside
// its action. ENFORCEMENT is unchanged (the trap asserts it).
installMobxWarnTrap({ errors: true })

function stubRuntime() {
  let health: ((health: object) => void) | undefined
  const runtime = {
    listIds: () => [],
    listRow: () => undefined,
    onList: () => () => {},
    readLocal: () => undefined,
    onLocals: () => () => {},
    hostMetrics: { getSnapshot: () => [], subscribe: () => () => {} },
    hub: {
      connectionHealth: () => ({ status: 'ok' }),
      onConnectionHealth(next: (health: object) => void) {
        health = next
        return () => {
          health = undefined
        }
      },
    },
    replica: { rows: () => [], subscribeAddressedBatch: () => () => {} },
    headerInputs: { read: () => undefined, onInput: () => () => {}, retain: () => () => {} },
  } as unknown as ClientRuntime
  return {
    runtime,
    emitHealth: (value: object) => health?.(value),
  }
}

it('attaches the header source without untracked observable reads', () => {
  const { runtime, emitHealth } = stubRuntime()
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  try {
    const stop = attachHeaderSource(pool, runtime)
    try {
      // The attachment's reconciliation read runs against a populated table
      // here too: the stale row must be removed without tripping the trap.
      headerEntities(pool).apply([
        { kind: 'connection', id: 'stale', value: { status: 'ok' } as HeaderRows['connection'] },
      ])
      emitHealth({ status: 'ok' })
      runInAction(() => {
        expect(headerEntities(pool).get('connection', 'stale')).toBeUndefined()
        expect(headerEntities(pool).get('connection', 'server')).toBeDefined()
        expect(headerEntities(pool).get('window', 'window')).toBeDefined()
      })
    } finally {
      stop()
    }
  } finally {
    pool.dispose()
  }
})
