import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { indexedDbInstantiation } from '../../sync/src/adapters/indexeddb/conformance'
import { CollectionServer, issue } from '../../sync/src/conformance/collection-server'
import { inMemoryInstantiation } from '../../sync/src/conformance/in-memory'
import { policyBudgets, TEST_BUDGETS } from '../../sync/src/conformance/test-budgets'
import { instanceKey } from '../../sync/src/replica/cache-state'
import { rowKeyOf } from '../../sync/src/replica/disk-index'
import { CollectionLoader } from '../../sync/src/replica/loader'
import { Replica } from '../../sync/src/replica/replica'
import type { InstanceSpec } from '../../sync/src/replica/types'
import { createIssuePageViews } from './issue-page'
import { issueSearch } from './issue-search'
import { MobxPool } from './pool'

for (const adapter of [inMemoryInstantiation, indexedDbInstantiation])
  describe(`record freshness through ${adapter.name}`, () => {
    it('reading an issue or search hit queues its stale disk-only tree once, at background priority, until replacement', async () => {
      const storage = await adapter.open()
      const { cache } = storage.viewFor('fixture-user')
      const server = new CollectionServer()
      server.policy = {
        clientType: 'phone',
        recentDays: 7,
        ...policyBudgets(TEST_BUDGETS),
        steps: [
          { step: 'always', collections: ['session.live'] },
          { step: 'view', collections: [] },
          { step: 'stubs', collections: ['issueProjection.stubs'] },
        ],
      }
      server.put(
        'issueProjection',
        'root',
        issue('root', { title: 'Cached issue', stage: 'done', closedReason: 'done' }),
      )
      let loader: CollectionLoader | undefined
      const kernel = new Replica({
        store: cache,
        authority: server,
        memory: { warmInstances: TEST_BUDGETS.warmInstances },
        onEvent: (event) => loader?.onEvent(event),
      })
      const settle = async () => {
        for (let n = 0; n < 5; n++) {
          await kernel.settled()
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
      kernel.connect()
      await settle()
      const spec: InstanceSpec = {
        collection: 'issueProjection.tree',
        args: { root: 'root' },
        part: 'main',
      }
      await kernel.load([spec])
      await settle()
      const row = cache.read('issueProjection', 'root')!
      await kernel.unload([instanceKey(spec)])
      cache.applyAtomic({ operations: [], instances: [{ kind: 'stale', key: instanceKey(spec) }] })
      kernel.disconnect()
      loader = new CollectionLoader({ replica: kernel, schedule: () => () => {} })
      const queued: { specs: readonly InstanceSpec[]; priority: string | undefined }[] = []
      const request = loader.request.bind(loader)
      loader.request = (specs, priority) => {
        queued.push({ specs, priority })
        request(specs, priority)
      }
      const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
      pool.apply({
        type: 'replace',
        rows: [{ kind: 'issue', id: 'root', value: row.value as never }],
      })
      pool.collections.attach(() => loader)
      const pages = createIssuePageViews(pool)
      const seen: boolean[] = []
      const stop = autorun(() => seen.push(pages.row('root').refreshing))
      try {
        for (let n = 0; n < 3; n++) {
          expect(issueSearch(pool).read('Cached', ['root']).refreshing).toBe(true)
          expect(pages.row('root').refreshing).toBe(true)
        }
        expect(queued).toEqual([{ specs: [spec], priority: 'background' }])
        const fetches = server.fetches.length
        await loader.flush()
        await settle()
        expect(server.fetches).toHaveLength(fetches)
        expect(loader.recordStale('issueProjection', 'root')).toBe(true)
        expect(queued).toHaveLength(1)
        server.put(
          'issueProjection',
          'root',
          issue('root', { title: 'Updated issue', stage: 'done', closedReason: 'done' }),
        )
        kernel.connect()
        await settle()
        await loader.flush()
        await settle()
        expect(loader.recordStale('issueProjection', 'root')).toBe(false)
        expect(seen).toEqual([true, false])
        expect((cache.read('issueProjection', 'root')?.value as { title: string }).title).toBe(
          'Updated issue',
        )
      } finally {
        stop()
        pages.dispose()
        pool.dispose()
        loader.dispose()
        kernel.disconnect()
      }
    })

    it('tracks all disk-index holders, follows comes-with, and one fresh holder makes the record current', async () => {
      const storage = await adapter.open()
      const { cache } = storage.viewFor('fixture-user')
      const specs: InstanceSpec[] = ['root', 'other'].map((root) => ({
        collection: 'issueProjection.tree',
        args: { root },
        part: 'main',
      }))
      const cursor = { feedId: 'fixture', epoch: '1', seq: 7 }
      const marker = (spec: InstanceSpec) => ({
        ...spec,
        key: instanceKey(spec),
        completeAt: cursor,
      })
      cache.applyAtomic({
        operations: [
          {
            kind: 'upsert',
            entity: 'issueProjection',
            entityId: 'root',
            value: issue('root'),
            provenance: { seq: 7 },
          },
          {
            kind: 'upsert',
            entity: 'issueDep',
            entityId: 'edge',
            value: { id: 'edge', fromId: 'root', toId: 'other', type: 'blocked-by' },
            provenance: { seq: 7 },
          },
        ],
        cursor,
        instances: specs.map((spec) => ({
          kind: 'mark',
          instance: marker(spec),
          members: [rowKeyOf('issueProjection', 'root')],
        })),
        comesWith: [
          {
            kind: 'held',
            member: rowKeyOf('issueDep', 'edge'),
            holder: rowKeyOf('issueProjection', 'root'),
          },
        ],
      })
      const kernel = new Replica({
        store: cache,
        authority: new CollectionServer(),
        memory: { warmInstances: TEST_BUDGETS.warmInstances },
      })
      const loader = new CollectionLoader({ replica: kernel, schedule: () => () => {} })
      const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
      pool.collections.attach(() => loader)
      const seen: boolean[] = []
      const stop = autorun(() => seen.push(pool.collections.recordStale('issue', 'root')))
      const moved = async () => {
        loader.onEvent({ type: 'markers' })
        await Promise.resolve()
      }
      try {
        expect(loader.recordStale('issueProjection', 'root')).toBe(false)
        cache.applyAtomic({
          operations: [],
          instances: [{ kind: 'stale', key: instanceKey(specs[0]!) }],
        })
        await moved()
        expect(seen).toEqual([false])
        expect(loader.recordStale('issueDep', 'edge')).toBe(false)
        cache.applyAtomic({
          operations: [],
          instances: [{ kind: 'stale', key: instanceKey(specs[1]!) }],
        })
        await moved()
        expect(seen).toEqual([false, true])
        expect(loader.recordStale('issueDep', 'edge')).toBe(true)
        expect(pool.collections.reading(3, [{ entity: 'issue', id: 'root' }])).toBe('refreshing')
        cache.applyAtomic({
          operations: [],
          instances: [
            {
              kind: 'mark',
              instance: marker(specs[1]!),
              members: [rowKeyOf('issueProjection', 'root')],
            },
          ],
        })
        await moved()
        expect(seen).toEqual([false, true, false])
        expect(loader.recordStale('issueDep', 'edge')).toBe(false)
        cache.applyAtomic({
          operations: [],
          instances: [{ kind: 'drop', key: instanceKey(specs[1]!) }],
        })
        await moved()
        expect(seen).toEqual([false, true, false, true])
        cache.applyAtomic({
          operations: [],
          instances: [{ kind: 'drop', key: instanceKey(specs[0]!) }],
        })
        await moved()
        expect(seen.at(-1)).toBe(false)
        expect(loader.recordStale('issueProjection', 'absent')).toBe(false)
      } finally {
        stop()
        pool.dispose()
        loader.dispose()
        kernel.disconnect()
      }
    })
  })
