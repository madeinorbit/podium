/**
 * POD-7087 — lookups through the one loader, over the real kernel Replica,
 * client facade, row source and pool, against the small collection server.
 *
 * Acceptance 3: a reader of stub fields never triggers a fetch; a reader of
 * other fields triggers exactly one.
 * Acceptance 4: offline, a lookup of an absent record reads "not available
 * offline" and recovers when the connection returns.
 * Item 6: a command on a record the device does not hold makes no
 * optimistic change.
 */
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { autorun } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import { CollectionServer, issue, WORLD_NOW } from '../../sync/src/conformance/collection-server'
import { inMemoryInstantiation } from '../../sync/src/conformance/in-memory'
import { instanceKey } from '../../sync/src/replica/cache-state'
import { CollectionLoader, type LoaderSchedule } from '../../sync/src/replica/loader'
import { Replica } from '../../sync/src/replica/replica'
import type { CachePolicy, InstanceSpec } from '../../sync/src/replica/types'
import { oneRecordOf } from './collections'
import { createWorklistPool } from './create'
import { LOADING } from './loading'
import { fixedLocals } from './shared/locals-source'
import { createRowSource } from './shared/row-source'

const ISSUE = 'issueProjection'
const POLICY: CachePolicy = {
  clientType: 'browser',
  steps: [
    { step: 'always', collections: ['session.live'] },
    { step: 'view', collections: [] },
    { step: 'sidebar', collections: ['issueProjection.sidebar'] },
    { step: 'stubs', collections: ['issueProjection.stubs'] },
  ],
  recentDays: 30,
  cacheCap: 1_000,
}

const ticks = async (count = 8): Promise<void> => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function manualSchedule(): { schedule: LoaderSchedule; due: () => void } {
  let run: (() => void) | null = null
  return {
    schedule: (fn) => {
      run = fn
      return () => {
        run = null
      }
    },
    due: () => {
      const fn = run
      run = null
      fn?.()
    },
  }
}

const value = (id: string, fields: Record<string, unknown> = {}) =>
  issue(id, { repoPath: '/synthetic', createdAt: '2025-01-01T00:00:00Z', ...fields })

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
})

async function boot() {
  const server = new CollectionServer()
  server.policy = POLICY
  server.chunkRows = 50
  server.put(ISSUE, 'OPEN', value('OPEN', { stage: 'in_progress' }))
  server.put(ISSUE, 'OLD', value('OLD', { stage: 'done', closedReason: 'completed' }))
  const storage = await inMemoryInstantiation.open()
  const { cache } = storage.viewFor('u-ada')
  const timer = manualSchedule()
  let loader: CollectionLoader | undefined
  let replica: Replica | undefined
  const facade = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    exits: (entity, id) => replica?.exitKind(entity, id),
    collections: () => replica,
    loader: () => loader,
  })
  replica = new Replica({
    store: cache,
    authority: server,
    now: () => WORLD_NOW,
    view: () => loader?.takeView() ?? [],
    request: (specs) => loader?.request(specs),
    onEvent: (event) => {
      facade.onKernelEvent(event)
      loader?.onEvent(event)
    },
    batchEvents: (emit) => facade.batch(emit),
  })
  loader = new CollectionLoader({ replica, schedule: timer.schedule })
  const rows = createRowSource({ principal: { userId: 'u-ada' } }, facade, {
    pending: { byRow: () => new Map() },
  })
  const locals = fixedLocals({ selectedIssueId: null, coarseNow: WORLD_NOW })
  const handle = createWorklistPool(rows.source, locals.source, { schedule: () => () => {} })
  disposers.push(
    () => replica?.disconnect(),
    () => rows.dispose(),
    () => locals.dispose(),
    () => handle.dispose(),
  )
  const kernel = replica
  const settle = async () => {
    for (let round = 0; round < 10; round += 1) {
      await kernel.settled()
      await ticks()
      timer.due()
      await loader!.flush()
      await kernel.settled()
      await ticks()
      rows.flush()
      handle.pool.hydrate()
    }
  }
  kernel.connect()
  await settle()
  const naming = (spec: InstanceSpec) =>
    server.fetches.filter((batch) => batch.some((r) => instanceKey(r) === instanceKey(spec))).length
  return { server, replica: kernel, loader: loader!, pool: handle.pool, settle, naming }
}

describe('a lookup through the one loader', () => {
  it('a reader of stub fields never fetches; a reader of other fields fetches exactly once', async () => {
    const { pool, replica, settle, naming } = await boot()
    // The first download left OLD on the device as a stub only.
    expect(replica.stubOf(ISSUE, 'OLD')).toBeDefined()
    expect(replica.view(ISSUE, 'OLD')).toBeUndefined()
    const one = oneRecordOf('issue', 'OLD') as InstanceSpec

    for (let i = 0; i < 5; i += 1) {
      const stub = pool.stub('OLD')
      expect(stub).toMatchObject({ id: 'OLD', stage: 'done', parentId: null })
    }
    await settle()
    expect(naming(one)).toBe(0)

    // A reader of the title needs the whole record: on its way, one request.
    for (let i = 0; i < 5; i += 1) expect(pool.row('issue', 'OLD')).toBe(LOADING)
    await settle()
    expect(naming(one)).toBe(1)
    const row = pool.row('issue', 'OLD') as { title?: string }
    expect(row).not.toBe(LOADING)
    expect(row.title).toBe('Issue OLD')
    // Read again: here, nothing more is fetched; the stub reader is still served.
    pool.row('issue', 'OLD')
    expect(pool.stub('OLD')).toMatchObject({ stage: 'done' })
    await settle()
    expect(naming(one)).toBe(1)
  })

  it('a record the server does not show is gone after one request', async () => {
    const { pool, settle, naming } = await boot()
    expect(pool.row('issue', 'NOWHERE')).toBe(LOADING)
    await settle()
    expect(pool.row('issue', 'NOWHERE')).toEqual({ kind: 'gone', reason: 'not-visible' })
    expect(naming(oneRecordOf('issue', 'NOWHERE') as InstanceSpec)).toBe(1)
  })

  it('offline, an absent record reads "not available offline" and recovers when the connection returns', async () => {
    const { pool, replica, server, settle, naming } = await boot()
    server.put(ISSUE, 'LATE', value('LATE', { stage: 'done', closedReason: 'completed' }))
    replica.disconnect()
    await settle()
    const readings: string[] = []
    const stop = autorun(() => {
      readings.push(pool.collections.reading(pool.row('issue', 'LATE')))
    })
    try {
      expect(readings.at(-1)).toBe('offline')
      await settle()
      // Nothing starts without a connection, and the view says so, not "loading".
      expect(naming(oneRecordOf('issue', 'LATE') as InstanceSpec)).toBe(0)
      expect(readings.at(-1)).toBe('offline')
      replica.connect()
      await settle()
      expect(readings.at(-1)).toBe('here')
      expect(naming(oneRecordOf('issue', 'LATE') as InstanceSpec)).toBe(1)
      expect(readings).not.toContain('gone')
    } finally {
      stop()
    }
  })
})
