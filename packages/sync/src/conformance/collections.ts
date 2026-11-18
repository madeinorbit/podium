/**
 * COLLECTIONS IN THE DEVICE STORE (POD-7086, design POD-7059 "The feed",
 * "Memory, cache and leaving", "One loader, one route"): the SAME obligations
 * on every cache adapter.
 *
 * The Replica decides what a change means and what a trim drops; the adapter
 * stores rows, markers, the policy and the load state, and must commit them
 * together. So every case here runs the one kernel over the instantiation's
 * store, against a small server (`collection-server.ts`), and reads the result
 * back through the store port. A crash is the harness's crash: the kernels are
 * discarded and rebuilt over the same physical store.
 */

import { describe, expect, it } from 'vitest'
import { instanceKey } from '../replica/cache-state'
import { CollectionLoader } from '../replica/loader'
import type { CacheMutation, ReplicaCacheStore } from '../replica/ports'
import { Replica } from '../replica/replica'
import type {
  CachePolicy,
  Cursor,
  InstanceRecord,
  InstanceSpec,
  ReplicaEvent,
} from '../replica/types'
import type { SyncUnitOfWork } from '../span'
import {
  CollectionServer,
  issue,
  RECENTLY,
  session,
  WORLD_NOW,
  WORLD_POLICY,
} from './collection-server'
import type { ConformanceStorage, SyncInstantiation } from './instantiation'

const PRINCIPAL = 'u-ada'
const ISSUE = 'issueProjection'
const SESSION = 'session'

const SIDEBAR: InstanceSpec = { collection: 'issueProjection.sidebar', part: 'main' }
const STUBS: InstanceSpec = { collection: 'issueProjection.stubs', part: 'stub' }
const LIVE: InstanceSpec = { collection: 'session.live', part: 'main' }
const tree = (root: string): InstanceSpec => ({
  collection: 'issueProjection.tree',
  args: { root },
  part: 'main',
})

const barrier = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

/** Let queued microtasks and timers run (a fetch batched for the next tick). */
const ticks = async (count = 5): Promise<void> => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * The world most cases start from:
 *  - A1 (in progress) and its child A2 (review): the sidebar.
 *  - D1 (done, under A1) and D2 (done, top level): history, held as stubs.
 *  - S1, live on A1; S2, ended long ago on D2 (no policy collection holds it).
 */
function seedWorld(server: CollectionServer): void {
  server.put(ISSUE, 'A1', issue('A1'))
  server.put(ISSUE, 'A2', issue('A2', { stage: 'review', parentId: 'A1' }))
  server.put(ISSUE, 'D1', issue('D1', { stage: 'done', closedReason: 'completed', parentId: 'A1' }))
  server.put(ISSUE, 'D2', issue('D2', { stage: 'done', closedReason: 'completed' }))
  server.put(SESSION, 'S1', session('S1', { issueId: 'A1' }))
  server.put(SESSION, 'S2', session('S2', { issueId: 'D2', status: 'ended' }))
}

interface Booted {
  readonly storage: ConformanceStorage
  readonly cache: ReplicaCacheStore
  readonly replica: Replica
  readonly events: ReplicaEvent[]
  readonly clock: { now: number }
}

function kernelOver(
  storage: ConformanceStorage,
  server: CollectionServer,
  clock = { now: WORLD_NOW },
  options: {
    readonly unitOfWork?: SyncUnitOfWork
    readonly onEvent?: (event: ReplicaEvent) => void
  } = {},
): Booted {
  const { cache } = storage.viewFor(PRINCIPAL)
  const events: ReplicaEvent[] = []
  const replica = new Replica({
    store: cache,
    authority: server,
    now: () => clock.now,
    onEvent: (event) => {
      events.push(event)
      options.onEvent?.(event)
    },
    ...(options.unitOfWork === undefined ? {} : { unitOfWork: options.unitOfWork }),
  })
  return { storage, cache, replica, events, clock }
}

/** The storage's unit of work, each transaction held until `gate` opens: a durable commit that has not landed. */
function heldCommits(storage: ConformanceStorage, gate: Promise<void>): SyncUnitOfWork {
  return {
    transact: async (body) => {
      await gate
      return await storage.unitOfWork.transact(body)
    },
  }
}

/** Let the walk run until `done` says so (bounded). */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i += 1) await ticks(1)
}

async function boot(
  instantiation: SyncInstantiation,
  server: CollectionServer,
  storage?: ConformanceStorage,
): Promise<Booted> {
  const booted = kernelOver(storage ?? (await instantiation.open()), server)
  booted.replica.connect()
  await booted.replica.settled()
  await ticks()
  await booted.replica.settled()
  return booted
}

/** A feed frame of everything the server changed since the device's cursor. */
async function feed(booted: Booted, server: CollectionServer): Promise<void> {
  const cursor = booted.replica.cursor as Cursor
  await booted.replica.receive(server.frameSince(cursor.seq))
  await booted.replica.settled()
  await ticks()
  await booted.replica.settled()
}

/** What the store holds, for comparing two stores: rows at their part, and marker keys. */
function contents(cache: ReplicaCacheStore) {
  const rows = [...cache.readEntities(), ...cache.readStubs()]
    .map((row) => ({
      entity: row.entity,
      entityId: row.entityId,
      part: row.part ?? 'main',
      value: row.value,
    }))
    .sort((a, b) => (`${a.entity}\u0000${a.entityId}` < `${b.entity}\u0000${b.entityId}` ? -1 : 1))
  return {
    rows,
    instances: [...cache.readInstances().keys()].sort(),
    cursor: cache.readCursor(),
    loadingSince: cache.readLoadingSince(),
  }
}

const partOf = (cache: ReplicaCacheStore, entity: string, id: string) => {
  const row = cache.readRow(entity, id)
  return row === undefined ? 'absent' : (row.part ?? 'main')
}

const marked = (cache: ReplicaCacheStore, spec: InstanceSpec): boolean =>
  cache.readInstances().has(instanceKey(spec))

/** No instance claims complete while a record the server puts in it is not whole on the device. */
function expectMarkersTrue(cache: ReplicaCacheStore, server: CollectionServer): void {
  for (const instance of cache.readInstances().values()) {
    if (instance.part === 'stub') {
      for (const row of server.members(instance))
        expect(cache.readRow(row.entity, row.id), `${instance.key} holds ${row.id}`).toBeDefined()
      continue
    }
    for (const row of server.members(instance))
      expect(cache.read(row.entity, row.id), `${instance.key} holds ${row.id}`).toBeDefined()
  }
}

export function describeCollectionStore(instantiation: SyncInstantiation): void {
  describe(`collections in the device store — ${instantiation.name}`, () => {
    // ─── Markers ──────────────────────────────────────────────────────────────

    describe('markers', () => {
      const cursor: Cursor = { feedId: 'feed', epoch: 'epoch', seq: 1 }
      const key = instanceKey(SIDEBAR)
      const marker: InstanceRecord = { ...SIDEBAR, key, completeAt: cursor }
      const withMarker: CacheMutation = {
        operations: [
          {
            kind: 'upsert',
            entity: ISSUE,
            entityId: 'A1',
            value: issue('A1'),
            provenance: { seq: 1 },
          },
        ],
        cursor,
        instances: [{ kind: 'mark', instance: marker }],
      }

      it('commits a marker with the rows it describes, in ONE transaction', async () => {
        const storage = await instantiation.open()
        const { cache } = storage.viewFor(PRINCIPAL)
        const before = storage.unitOfWorkTransactions()
        await storage.unitOfWork.transact(async (span) => {
          cache.applyAtomic(withMarker, span)
          expect(cache.readInstances().size).toBe(0)
          expect(cache.readEntities()).toEqual([])
        })
        expect(storage.unitOfWorkTransactions() - before).toBe(1)
        expect(cache.readInstances().get(key)).toEqual(marker)
        expect(cache.read(ISSUE, 'A1')?.value).toEqual(issue('A1'))
      })

      it('keeps the old rows and markers whole when the batch aborts', async () => {
        const storage = await instantiation.open()
        const { cache } = storage.viewFor(PRINCIPAL)
        await storage.unitOfWork.transact(async (span) => cache.applyAtomic(withMarker, span))
        storage.failNextCommit(new Error('power loss'))
        await expect(
          storage.unitOfWork.transact(async (span) =>
            cache.applyAtomic(
              {
                operations: [{ kind: 'remove', entity: ISSUE, entityId: 'A1' }],
                instances: [{ kind: 'drop', key }],
              },
              span,
            ),
          ),
        ).rejects.toThrow('power loss')
        expect(cache.readInstances().get(key)).toEqual(marker)
        expect(cache.read(ISSUE, 'A1')).toBeDefined()
      })

      it('never shows one principal another principal’s markers; a discard drops them', async () => {
        const storage = await instantiation.open()
        const ada = storage.viewFor(PRINCIPAL).cache
        const bob = storage.viewFor('u-bob').cache
        await storage.unitOfWork.transact(async (span) => ada.applyAtomic(withMarker, span))
        expect(bob.readInstances().size).toBe(0)
        ada.discardCache()
        expect(ada.readInstances().size).toBe(0)
        expect(ada.readPolicy()).toBeNull()
        expect(ada.readLoadingSince()).toBeNull()
      })

      it('keeps stubs out of readEntities and read; readRow and readStubs see them', async () => {
        const storage = await instantiation.open()
        const { cache } = storage.viewFor(PRINCIPAL)
        cache.applyAtomic({
          operations: [
            {
              kind: 'upsert',
              entity: ISSUE,
              entityId: 'D1',
              value: { id: 'D1', stage: 'done' },
              provenance: { seq: 1 },
              part: 'stub',
            },
          ],
        })
        expect(cache.readEntities()).toEqual([])
        expect(cache.read(ISSUE, 'D1')).toBeUndefined()
        expect(cache.readRow(ISSUE, 'D1')?.part).toBe('stub')
        expect(cache.readStubs().map((row) => row.entityId)).toEqual(['D1'])
      })
    })

    // ─── The first download ───────────────────────────────────────────────────

    describe('the first download', () => {
      it('installs each policy collection with its marker, stubs for the rest, and what they come with', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        const { cache, replica } = await boot(instantiation, server)
        expect(replica.posture).toBe('live')
        expect(cache.readPolicy()).toEqual(WORLD_POLICY)
        expect(cache.readLoadingSince()).toBeNull()
        for (const spec of [LIVE, SIDEBAR, STUBS]) expect(marked(cache, spec)).toBe(true)
        expect(
          cache
            .readEntities()
            .map((row) => row.entityId)
            .sort(),
        ).toEqual(['A1', 'A2', 'S1'])
        expect(
          cache
            .readStubs()
            .map((row) => row.entityId)
            .sort(),
        ).toEqual(['D1', 'D2'])
        // What the held records come with arrived inside the load, each with its marker.
        expect(
          marked(cache, {
            collection: 'session.ofIssue',
            args: { issueId: 'A1' },
            part: 'main',
            via: 'issueProjection.sidebar',
          }),
        ).toBe(true)
        expect(
          marked(cache, {
            collection: 'issueUserState.ofIssue',
            args: { issueId: 'A2' },
            part: 'main',
            via: ISSUE,
          }),
        ).toBe(true)
        expectMarkersTrue(cache, server)
      })

      it('survives a kill at every chunk boundary: the same store, re-downloading only the collections without a marker', async () => {
        const world = () => {
          const server = new CollectionServer()
          seedWorld(server)
          return server
        }
        const reference = world()
        const whole = await boot(instantiation, reference)
        const expected = contents(whole.cache)
        const boundaries = reference.served
        expect(boundaries).toBeGreaterThan(4)
        for (let k = 1; k < boundaries; k += 1) {
          const storage = await instantiation.open()
          const dying = world()
          dying.dieAfterChunks = k
          const first = kernelOver(storage, dying)
          first.replica.connect()
          for (let i = 0; i < 200 && dying.served < k; i += 1) await ticks(1)
          await ticks()
          expect(dying.served, `boundary ${k}`).toBe(k)
          // THE KILL: the kernels are gone, the store stays.
          const markedBefore = new Set(first.cache.readInstances().keys())
          const restarted = world()
          const second = await boot(instantiation, restarted, storage)
          expect(contents(second.cache), `boundary ${k}`).toEqual(expected)
          expect(restarted.bootstraps, `boundary ${k}: no second first download`).toBe(0)
          const refetched = restarted.fetches.flat().map((spec) => instanceKey(spec))
          for (const key of refetched)
            expect(markedBefore.has(key), `boundary ${k} fetched ${key} again`).toBe(false)
        }
      })

      it('opens the views on the load before its durable commit; only the commit goes live (POD-7122)', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        const storage = await instantiation.open()
        const gate = barrier()
        let loader: CollectionLoader | undefined
        const booted = kernelOver(storage, server, undefined, {
          unitOfWork: heldCommits(storage, gate.promise),
          onEvent: (event) => loader?.onEvent(event),
        })
        const { cache, replica, events } = booted
        loader = new CollectionLoader({ replica })
        expect(loader.firstDownload).toBe(true)
        replica.connect()
        await until(() => events.some((event) => event.type === 'load-installed'))
        // In memory: every policy collection and what its records come with.
        expect(events.map((event) => event.type)).toContain('load-installed')
        expect(events.map((event) => event.type)).not.toContain('bootstrap-installed')
        for (const spec of [LIVE, SIDEBAR, STUBS]) expect(marked(cache, spec)).toBe(true)
        expect(
          marked(cache, {
            collection: 'session.ofIssue',
            args: { issueId: 'A1' },
            part: 'main',
            via: 'issueProjection.sidebar',
          }),
        ).toBe(true)
        expectMarkersTrue(cache, server)
        // The views open on it: the first download is over for them…
        expect(loader.firstDownload).toBe(false)
        // …while the durable commit has not landed: not live, the load still under way.
        expect(replica.posture).toBe('bootstrapping')
        expect(cache.readLoadingSince()).not.toBeNull()
        gate.release()
        await until(() => replica.posture === 'live')
        await replica.settled()
        expect(replica.posture).toBe('live')
        expect(cache.readLoadingSince()).toBeNull()
        const order = events.map((event) => event.type)
        expect(order.indexOf('load-installed')).toBeLessThan(order.indexOf('bootstrap-installed'))
        loader.dispose()
      })

      it('a crash after the views opened and before the durable commit resumes the load, without a second first download', async () => {
        const world = () => {
          const server = new CollectionServer()
          seedWorld(server)
          return server
        }
        const expected = contents((await boot(instantiation, world())).cache)
        const storage = await instantiation.open()
        const dying = kernelOver(storage, world(), undefined, {
          unitOfWork: heldCommits(storage, new Promise<void>(() => {})),
        })
        dying.replica.connect()
        await until(() => dying.events.some((event) => event.type === 'load-installed'))
        expect(dying.events.map((event) => event.type)).not.toContain('bootstrap-installed')
        await ticks()
        // THE KILL: the kernel is gone before its commit; the store stays.
        const restarted = world()
        const second = await boot(instantiation, restarted, storage)
        expect(second.replica.posture).toBe('live')
        expect(contents(second.cache)).toEqual(expected)
        expect(restarted.bootstraps, 'no second first download').toBe(0)
        expect(restarted.fetches.flat(), 'nothing it already held is fetched again').toEqual([])
      })

      it('a gap the feed cannot bridge drops the markers and reloads; the old rows stay readable meanwhile', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        const booted = await boot(instantiation, server)
        const { cache, replica } = booted
        replica.disconnect()
        server.put(ISSUE, 'A3', issue('A3', { stage: 'planning' }))
        server.drop(ISSUE, 'A2')
        server.minAvailableSeq = server.head
        const gate = barrier()
        const entered = barrier()
        server.gate = gate.promise.then(() => undefined)
        const original = server.bootstrap.bind(server)
        server.bootstrap = () => {
          entered.release()
          return original()
        }
        replica.connect()
        await entered.promise
        await ticks()
        expect(cache.readInstances().size).toBe(0)
        expect(cache.read(ISSUE, 'A2')).toBeDefined()
        expect(cache.read(ISSUE, 'A1')).toBeDefined()
        gate.release()
        await replica.settled()
        await ticks()
        await replica.settled()
        expect(cache.readLoadingSince()).toBeNull()
        expect(cache.read(ISSUE, 'A2')).toBeUndefined()
        expect(cache.readRow(ISSUE, 'A2')).toBeUndefined()
        expect(cache.read(ISSUE, 'A3')).toBeDefined()
        for (const spec of [LIVE, SIDEBAR, STUBS]) expect(marked(cache, spec)).toBe(true)
        expectMarkersTrue(cache, server)
      })

      for (const cause of ['rescope', 'resync-required'] as const) {
        it(`a ${cause} walk withdraws every marker before it starts and marks its replacement`, async () => {
          const server = new CollectionServer()
          seedWorld(server)
          const { cache, replica } = await boot(instantiation, server)
          const gate = barrier()
          const entered = barrier()
          server.gate = gate.promise.then(() => undefined)
          const original = server.bootstrap.bind(server)
          server.bootstrap = () => {
            entered.release()
            return original()
          }
          if (cause === 'rescope')
            await replica.receive({ kind: 'rescope', feedId: server.feedId, epoch: server.epoch })
          else replica.requestRebootstrap()
          await entered.promise
          await ticks()
          expect(cache.readInstances().size).toBe(0)
          expect(cache.read(ISSUE, 'A1')).toBeDefined()
          gate.release()
          await replica.settled()
          await ticks()
          await replica.settled()
          for (const spec of [LIVE, SIDEBAR, STUBS]) expect(marked(cache, spec)).toBe(true)
          expectMarkersTrue(cache, server)
        })
      }
    })

    describe('a changed record shape', () => {
      it('reloads only the collections of that kind through the fetch, the old rows readable meanwhile', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        server.kindTokens = { issueProjection: 'v1', session: 'v1' }
        const booted = await boot(instantiation, server)
        const { cache, replica } = booted
        expect(cache.readKindTokens()).toEqual(server.kindTokens)
        // The issue shape moves; A2 left this viewer's sight in the same deploy.
        server.kindTokens = { issueProjection: 'v2', session: 'v1' }
        server.put(ISSUE, 'A1', issue('A1', { title: 'in the new shape' }))
        server.drop(ISSUE, 'A2', 'evict')
        const gate = barrier()
        server.gate = gate.promise
        const fetchesBefore = server.fetches.length
        replica.observeKindTokens(server.kindTokens)
        await ticks()
        // Withdrawn while the reload is in flight; the rows stay on screen.
        expect(marked(cache, SIDEBAR)).toBe(false)
        expect(marked(cache, LIVE)).toBe(true)
        expect(cache.read(ISSUE, 'A2')).toBeDefined()
        gate.release()
        await replica.settled()
        await ticks()
        await replica.settled()
        expect(server.bootstraps).toBe(1)
        const asked = server.fetches.slice(fetchesBefore).flat()
        expect(asked.map((spec) => spec.collection)).toEqual(
          expect.arrayContaining(['issueProjection.sidebar', 'issueProjection.stubs']),
        )
        expect(asked.some((spec) => spec.collection === 'session.live')).toBe(false)
        expect(cache.readKindTokens()).toEqual(server.kindTokens)
        expect(cache.read(ISSUE, 'A1')?.value).toMatchObject({ title: 'in the new shape' })
        expect(cache.readRow(ISSUE, 'A2')).toBeUndefined()
        for (const spec of [LIVE, SIDEBAR, STUBS]) expect(marked(cache, spec)).toBe(true)
        expectMarkersTrue(cache, server)
      })
    })

    // ─── The feed-apply table, one case per row ───────────────────────────────

    describe('the feed-apply table', () => {
      it('row 1 — a record held with its main part is replaced, even when it leaves every collection', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        const booted = await boot(instantiation, server)
        server.put(
          ISSUE,
          'A2',
          issue('A2', {
            stage: 'done',
            closedReason: 'completed',
            parentId: 'A1',
            title: 'renamed',
          }),
        )
        await feed(booted, server)
        expect(booted.cache.read(ISSUE, 'A2')?.value).toMatchObject({
          title: 'renamed',
          stage: 'done',
        })
        expect(partOf(booted.cache, ISSUE, 'A2')).toBe('main')
      })

      it('row 2 — an issue held as a stub that matches no held collection gets its stub fields only', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        const booted = await boot(instantiation, server)
        server.put(
          ISSUE,
          'D2',
          issue('D2', { stage: 'done', closedReason: 'duplicate', title: 'secret title' }),
        )
        await feed(booted, server)
        const row = booted.cache.readRow(ISSUE, 'D2')
        expect(row?.part).toBe('stub')
        expect(row?.value).toMatchObject({ closedReason: 'duplicate' })
        expect(row?.value).not.toHaveProperty('title')
        expect(booted.cache.read(ISSUE, 'D2')).toBeUndefined()
      })

      it('row 3 — a stub that now matches a held collection is kept whole, and what it comes with is fetched', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        const booted = await boot(instantiation, server)
        server.put(
          SESSION,
          'S3',
          session('S3', { issueId: 'D2', status: 'ended', archived: false }),
        )
        const fetchesBefore = server.fetches.length
        // Reopened: D2 enters the sidebar.
        server.put(ISSUE, 'D2', issue('D2', { stage: 'in_progress' }))
        await feed(booted, server)
        expect(partOf(booted.cache, ISSUE, 'D2')).toBe('main')
        expect(booted.cache.read(ISSUE, 'D2')?.value).toMatchObject({ title: 'Issue D2' })
        const asked = server.fetches
          .slice(fetchesBefore)
          .flat()
          .map((spec) => instanceKey(spec))
        const sessions = instanceKey({
          collection: 'session.ofIssue',
          args: { issueId: 'D2' },
          part: 'main',
          via: 'issueProjection.sidebar',
        })
        expect(asked).toContain(sessions)
        expect(booted.cache.readInstances().has(sessions)).toBe(true)
        // The sidebar issue's sessions that are not archived came with it.
        expect(booted.cache.read(SESSION, 'S3')).toBeDefined()
        expectMarkersTrue(booted.cache, server)
      })

      it('row 4 — a record nothing held matches is ignored; a new issue keeps its stub', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        const booted = await boot(instantiation, server)
        server.put(SESSION, 'S9', session('S9', { status: 'ended' }))
        server.put(ISSUE, 'D9', issue('D9', { stage: 'done', closedReason: 'completed' }))
        await feed(booted, server)
        expect(booted.cache.readRow(SESSION, 'S9')).toBeUndefined()
        expect(partOf(booted.cache, ISSUE, 'D9')).toBe('stub')
        // The stub collection stays complete: every issue is on the device.
        expect(marked(booted.cache, STUBS)).toBe(true)
        expectMarkersTrue(booted.cache, server)
      })

      it('a deletion and a loss of visibility answer gone, for a whole record and for a stub', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        const booted = await boot(instantiation, server)
        server.drop(ISSUE, 'A2', 'remove')
        server.drop(ISSUE, 'D2', 'evict')
        await feed(booted, server)
        expect(booted.cache.readRow(ISSUE, 'A2')).toBeUndefined()
        expect(booted.cache.readRow(ISSUE, 'D2')).toBeUndefined()
        expect(booted.replica.exitKind(ISSUE, 'A2')).toBe('removed')
        expect(booted.replica.exitKind(ISSUE, 'D2')).toBe('evicted')
        expectMarkersTrue(booted.cache, server)
      })
    })

    // ─── The newer one wins, per record ───────────────────────────────────────

    describe('the newer one wins, per record', () => {
      it('a fetch answered as of a later feed number is not overwritten by an older feed change', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        const booted = await boot(instantiation, server)
        server.put(ISSUE, 'T1', issue('T1', { stage: 'done', closedReason: 'completed' }))
        const stale = server.frameSince((booted.replica.cursor as Cursor).seq)
        server.put(
          ISSUE,
          'T1',
          issue('T1', { stage: 'done', closedReason: 'completed', title: 'newer' }),
        )
        // The fetch answers as of the head, ahead of the feed the device applied.
        await booted.replica.load([tree('T1')])
        await booted.replica.settled()
        expect(booted.cache.read(ISSUE, 'T1')?.value).toMatchObject({ title: 'newer' })
        const announced = booted.events.length
        await booted.replica.receive(stale)
        await booted.replica.settled()
        expect(booted.cache.read(ISSUE, 'T1')?.value).toMatchObject({ title: 'newer' })
        // Nor is the older value announced: a client projection would show it.
        expect(
          booted.events
            .slice(announced)
            .some((event) => event.type === 'upserted' && event.record.entityId === 'T1'),
        ).toBe(false)
        // A change newer than the answer still applies.
        await feed(booted, server)
        server.put(
          ISSUE,
          'T1',
          issue('T1', { stage: 'done', closedReason: 'completed', title: 'newest' }),
        )
        await feed(booted, server)
        expect(booted.cache.read(ISSUE, 'T1')?.value).toMatchObject({ title: 'newest' })
      })

      it('a fetch answered as of an earlier number cannot bring back what the feed changed or removed meanwhile', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        server.put(ISSUE, 'T1', issue('T1', { stage: 'done', closedReason: 'completed' }))
        server.put(
          ISSUE,
          'T2',
          issue('T2', { stage: 'done', closedReason: 'completed', parentId: 'T1' }),
        )
        const booted = await boot(instantiation, server)
        const answerAt = server.head
        server.answerSeq = answerAt
        const gate = barrier()
        server.gate = gate.promise
        // The answer is read now, as of `answerAt`, and held back at the gate.
        const loading = booted.replica.load([tree('T1')])
        // While the fetch is in flight the feed renames T1 and deletes T2.
        server.put(
          ISSUE,
          'T1',
          issue('T1', { stage: 'done', closedReason: 'completed', title: 'renamed' }),
        )
        server.drop(ISSUE, 'T2')
        await booted.replica.receive(server.frameSince(answerAt))
        await ticks()
        expect(booted.cache.read(ISSUE, 'T1')?.value).toMatchObject({ title: 'renamed' })
        gate.release()
        await loading
        await booted.replica.settled()
        expect(booted.cache.read(ISSUE, 'T1')?.value).toMatchObject({ title: 'renamed' })
        expect(booted.cache.readRow(ISSUE, 'T2')).toBeUndefined()
      })
    })

    // ─── Tree membership ──────────────────────────────────────────────────────

    describe('tree membership', () => {
      it('a new issue belongs to a complete tree exactly when its parent does', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        server.put(ISSUE, 'T1', issue('T1', { stage: 'done', closedReason: 'completed' }))
        server.put(
          ISSUE,
          'T2',
          issue('T2', { stage: 'done', closedReason: 'completed', parentId: 'T1' }),
        )
        const booted = await boot(instantiation, server)
        booted.replica.hold(tree('T1'))
        await booted.replica.load([tree('T1')])
        await booted.replica.settled()
        expect(marked(booted.cache, tree('T1'))).toBe(true)
        // A grandchild under T2, and an issue under D2, which no held tree contains.
        server.put(
          ISSUE,
          'T3',
          issue('T3', { stage: 'done', closedReason: 'completed', parentId: 'T2' }),
        )
        server.put(
          ISSUE,
          'X1',
          issue('X1', { stage: 'done', closedReason: 'completed', parentId: 'D2' }),
        )
        await feed(booted, server)
        expect(partOf(booted.cache, ISSUE, 'T3')).toBe('main')
        expect(partOf(booted.cache, ISSUE, 'X1')).toBe('stub')
        expect(marked(booted.cache, tree('T1'))).toBe(true)
        expectMarkersTrue(booted.cache, server)
      })
    })

    // ─── The trim ─────────────────────────────────────────────────────────────

    describe('trim by instance', () => {
      const policy = (cacheCap: number): CachePolicy => ({ ...WORLD_POLICY, cacheCap })
      const withTrees = (server: CollectionServer) => {
        seedWorld(server)
        server.put(ISSUE, 'T1', issue('T1', { stage: 'done', closedReason: 'completed' }))
        server.put(
          ISSUE,
          'T2',
          issue('T2', { stage: 'done', closedReason: 'completed', parentId: 'T1' }),
        )
        server.put(ISSUE, 'U1', issue('U1', { stage: 'done', closedReason: 'completed' }))
      }
      const openAndRelease = async (booted: Booted, root: string, at: number) => {
        const release = booted.replica.hold(tree(root))
        await booted.replica.load([tree(root)])
        await booted.replica.settled()
        booted.clock.now = at
        release()
        await booted.replica.settled()
      }

      it('drops the instances released longest ago, whole, with their markers; issues fall back to their stub', async () => {
        const server = new CollectionServer()
        withTrees(server)
        server.policy = policy(2)
        const booted = await boot(instantiation, server)
        await openAndRelease(booted, 'T1', WORLD_NOW + 1)
        expect(marked(booted.cache, tree('T1'))).toBe(true)
        await openAndRelease(booted, 'U1', WORLD_NOW + 2)
        await booted.replica.trim()
        // U1 (released last, one record) fits the cap; T1 (two more) does not.
        expect(marked(booted.cache, tree('U1'))).toBe(true)
        expect(marked(booted.cache, tree('T1'))).toBe(false)
        expect(partOf(booted.cache, ISSUE, 'U1')).toBe('main')
        expect(partOf(booted.cache, ISSUE, 'T1')).toBe('stub')
        expect(partOf(booted.cache, ISSUE, 'T2')).toBe('stub')
        // The policy's collections are never trimmed.
        for (const spec of [LIVE, SIDEBAR, STUBS]) expect(marked(booted.cache, spec)).toBe(true)
        expectMarkersTrue(booted.cache, server)
      })

      it('never drops an instance an open view holds', async () => {
        const server = new CollectionServer()
        withTrees(server)
        server.policy = policy(0)
        const booted = await boot(instantiation, server)
        booted.replica.hold(tree('T1'))
        await booted.replica.load([tree('T1')])
        // The answer fills the stubs it was read at the same feed number as
        // (rowAfter); the trim then keeps what the view holds.
        expect(partOf(booted.cache, ISSUE, 'T1')).toBe('main')
        expect(partOf(booted.cache, ISSUE, 'T2')).toBe('main')
        await booted.replica.trim()
        expect(partOf(booted.cache, ISSUE, 'T1')).toBe('main')
        expect(partOf(booted.cache, ISSUE, 'T2')).toBe('main')
        expect(marked(booted.cache, tree('T1'))).toBe(true)
      })

      it('keeps a record a held record comes with, and never takes an issue below its stub', async () => {
        const server = new CollectionServer()
        withTrees(server)
        // A live session on a closed issue: the session comes with its issue.
        server.put(SESSION, 'S5', session('S5', { issueId: 'D1', lastActiveAt: RECENTLY }))
        server.policy = policy(0)
        const booted = await boot(instantiation, server)
        await openAndRelease(booted, 'T1', WORLD_NOW + 1)
        await booted.replica.trim()
        expect(partOf(booted.cache, ISSUE, 'D1')).toBe('main')
        expect(
          marked(booted.cache, {
            collection: 'issueProjection.one',
            args: { id: 'D1' },
            part: 'main',
            via: SESSION,
          }),
        ).toBe(true)
        for (const id of ['A1', 'A2', 'D1', 'D2', 'T1', 'T2', 'U1'])
          expect(partOf(booted.cache, ISSUE, id), id).not.toBe('absent')
        expectMarkersTrue(booted.cache, server)
      })
    })

    // ─── The read API the screens build on (POD-7088) ─────────────────────────

    describe('reads for the screens', () => {
      it('answers whether an instance is complete, the stub of an issue, and the issues under a parent', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        const { replica } = await boot(instantiation, server)
        expect(replica.isComplete(SIDEBAR)?.key).toBe(instanceKey(SIDEBAR))
        expect(replica.isComplete(tree('A1'))).toBeUndefined()
        expect(replica.stubOf(ISSUE, 'D1')).toEqual({
          id: 'D1',
          repoId: 'repo-1',
          seq: 1,
          stage: 'done',
          closedReason: 'completed',
          archived: false,
          deletedAt: null,
          isDraftVessel: false,
          audience: 'team',
          parentId: 'A1',
        })
        expect(replica.stubOf(ISSUE, 'A1')).toMatchObject({ stage: 'in_progress' })
        expect(replica.stubOf(ISSUE, 'missing')).toBeUndefined()
        expect([...replica.stubsByParent('A1')].sort()).toEqual(['A2', 'D1'])
      })
    })
  })
}
