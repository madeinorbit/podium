import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
// @vitest-environment happy-dom
import { sessionValues, sessionViews } from '@podium/client-core/session-values'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { sessionUserStateRowId } from '@podium/model'
import { createWorklistPool } from '@podium/client-graph/create'
import { createRowSource } from '../../../shared/src/row-source'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { poolSidebarSnapshot } from '../../../diagnostics/sidebar-check'
import { runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { seedCacheFromCorpus } from '../../../shared/src/scenarios'
import { buildCorpus } from '../fixture'
import { fixtureSessionHomes, stripSessionLegacy } from '../fixture/session-homes'
import { sidebarReplayStore } from './sidebar-replay'
import { snapshotFromStore } from './oracle'


function replay(stripped: boolean) {
  const corpus = buildCorpus(1)
  const homes = fixtureSessionHomes(corpus)
  const sessions = stripped ? homes.sessions.map(stripSessionLegacy) : homes.sessions
  const cache = seedCacheFromCorpus({ ...corpus, sessions })
  for (const state of homes.userStates)
    cache.put('sessionUserState', sessionUserStateRowId(state.userId, state.sessionId), state)
  for (const machine of homes.machines) cache.put('machine', machine.id, machine)
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const store = {
    ...sidebarReplayStore(corpus, replica),
    sessions: sessionViews(replica.rows('sessions'), homes),
  }
  const runtime = withKeyedInputs({
    principal: { userId: homes.userId },
    getSnapshot: () => store,
    subscribe: () => () => {},
    pendingOverlaysByRow: () => new Map(),
  })
  const source = createRowSource(runtime, replica, { mode: 'pooled' })
  const locals = createEngineLocals(runtime)
  const pool = createWorklistPool(source.source, locals.source)
  try {
    let sidebar: ReturnType<typeof poolSidebarSnapshot> | undefined
    for (let round = 0; round < 64; round++) {
      sidebar = runInAction(() => poolSidebarSnapshot(pool.pool))
      if (!pool.pool.hydrate()) break
    }
    return {
      values: store.sessions.map((session) => ({
        id: session.sessionId,
        ...sessionValues(session),
      })),
      graph: source.source
        .snapshot('session')
        .map((record) => ({ id: record.id, ...sessionValues(record.value as never) })),
      models: snapshotFromStore(store, { selectedIssueId: null, coarseNow: corpus.fixedNow }),
      sidebar,
    }
  } finally {
    pool.dispose()
    source.dispose()
    locals.dispose()
  }
}

describe('session legacy-field stripping on the corpus', () => {
  it('shared models, graph cells and the web sidebar are identical with every legacy cell removed', () => {
    const before = replay(false)
    const after = replay(true)
    expect(before.values).toHaveLength(4304)
    expect(after.values).toEqual(before.values)
    expect(after.graph).toEqual(before.graph)
    expect(after.models).toEqual(before.models)
    expect(after.sidebar).toEqual(before.sidebar)
  }, 120000)
})
