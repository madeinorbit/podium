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
import { comesWithHolderOf, pointerTargetOf } from '../replica/disk-index'
import { CollectionLoader } from '../replica/loader'
import type { CacheMutation, ReplicaCacheStore } from '../replica/ports'
import { Replica } from '../replica/replica'
import {
  type CachePolicy,
  type Cursor,
  type EntityRecord,
  type InstanceRecord,
  type InstanceSpec,
  type ReplicaEvent,
  rowAsOf,
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

/**
 * The storage's unit of work whose durable wait is held while a hold is armed:
 * a large first download's chunks still being written, as IndexedDB's lanes
 * are on a busy device (POD-7168). `hold` returns the release.
 */
function heldWhileArmed(storage: ConformanceStorage): {
  readonly unitOfWork: SyncUnitOfWork
  hold(): () => void
} {
  let gate: Promise<void> | undefined
  return {
    unitOfWork: {
      transact: (body) => storage.unitOfWork.transact(body),
      durable: async () => {
        if (gate !== undefined) await gate
        await storage.unitOfWork.durable?.()
      },
    },
    hold() {
      const held = barrier()
      gate = held.promise
      return () => {
        gate = undefined
        held.release()
      }
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

/**
 * POD-7159 — what a record comes with is recorded on the record, not as a
 * marker: the holder's comes-with complete via, or, for a pointer (a parent,
 * a session's issue), the record it names whole on the device.
 */
function comesWithHeld(cache: ReplicaCacheStore, spec: InstanceSpec): boolean {
  const index = cache.readDiskIndex()
  const target = pointerTargetOf(spec)
  if (target !== undefined) return index.record(target)?.level === 'main'
  const holder = comesWithHolderOf(spec)
  return holder !== undefined && index.record(holder)?.cw.includes(spec.via as string) === true
}

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

const keyOf = (entity: string, id: string): string => `${entity}\u0000${id}`

/**
 * POD-7159 — the disk index agrees with the rows the device holds: every row
 * has its entry at its feed number and level, nothing else has one, and every
 * main-part marker lists (at least) the records the server puts in it.
 */
function expectIndexTrue(cache: ReplicaCacheStore, server: CollectionServer, label = ''): void {
  const index = cache.readDiskIndex()
  const rows = [...cache.readEntities(), ...cache.readStubs()]
  for (const row of rows) {
    const entry = index.record(keyOf(row.entity, row.entityId))
    expect(entry, `${label} ${row.entityId} has an entry`).toBeDefined()
    expect(entry?.seq, `${label} ${row.entityId} feed number`).toBe(rowAsOf(row))
    expect(entry?.level, `${label} ${row.entityId} level`).toBe(
      row.part === 'stub' ? 'stub' : 'main',
    )
  }
  expect(index.recordCount, `${label} one entry per row`).toBe(rows.length)
  for (const instance of cache.readInstances().values()) {
    if (instance.part !== 'main') continue
    expect(index.instance(instance.key)?.indexed, `${label} ${instance.key} indexed`).toBe(true)
    for (const row of server.members(instance))
      expect(
        index.membersOf(instance.key).has(keyOf(row.entity, row.id)),
        `${label} ${instance.key} lists ${row.id}`,
      ).toBe(true)
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
          comesWithHeld(cache, {
            collection: 'session.ofIssue',
            args: { issueId: 'A1' },
            part: 'main',
            via: 'issueProjection.sidebar',
          }),
        ).toBe(true)
        expect(
          comesWithHeld(cache, {
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
          comesWithHeld(cache, {
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

      // POD-7168: the deck's tree waited for a large first download to be
      // durable. A fetch made while the load's last commit waits installs at
      // once; what it named stays out of the load's sweep.
      describe('a fetch while the load commits (POD-7168)', () => {
        const ONE_S2: InstanceSpec = { collection: 'session.one', args: { id: 'S2' }, part: 'main' }
        /** seedWorld, plus a session only the tree brings (it comes with D1). */
        const world = (): CollectionServer => {
          const server = new CollectionServer()
          seedWorld(server)
          server.put(SESSION, 'S9', session('S9', { issueId: 'D1', status: 'ended' }))
          // The server answers what records come with in the same answer, as its route does.
          server.answerComesWith = true
          return server
        }
        const loadsInstalled = (events: readonly ReplicaEvent[]): number =>
          events.filter((event) => event.type === 'load-installed').length

        /** A device that held the tree of A1 and the session S2, reloading after a gap the feed cannot bridge, its last commit held. */
        async function reloading(storage: ConformanceStorage, server: CollectionServer) {
          const commits = heldWhileArmed(storage)
          const booted = kernelOver(storage, server, undefined, { unitOfWork: commits.unitOfWork })
          const { cache, replica, events } = booted
          replica.connect()
          await replica.settled()
          await ticks()
          await replica.settled()
          await replica.load([tree('A1'), ONE_S2])
          await replica.settled()
          expect(cache.read(SESSION, 'S9')).toBeDefined()
          expect(cache.read(SESSION, 'S2')).toBeDefined()
          replica.disconnect()
          server.put(ISSUE, 'A3', issue('A3', { stage: 'planning' }))
          server.minAvailableSeq = server.head
          const before = loadsInstalled(events)
          const release = commits.hold()
          replica.connect()
          await until(() => loadsInstalled(events) > before)
          expect(loadsInstalled(events)).toBeGreaterThan(before)
          expect(replica.posture).toBe('bootstrapping')
          // The reload withdrew the tree's marker; its rows stay readable.
          expect(marked(cache, tree('A1'))).toBe(false)
          return { ...booted, release }
        }

        it('installs a tree while a first download commits: the deck is complete before the commit lands', async () => {
          const server = world()
          const storage = await instantiation.open()
          const commits = heldWhileArmed(storage)
          const release = commits.hold()
          const { cache, replica, events } = kernelOver(storage, server, undefined, {
            unitOfWork: commits.unitOfWork,
          })
          try {
            replica.connect()
            await until(() => loadsInstalled(events) > 0)
            expect(replica.posture).toBe('bootstrapping')
            const fetching = replica.load([tree('A1')])
            await until(() => marked(cache, tree('A1')))
            // Before the gate: the tree, and what it comes with, are on the device.
            expect(marked(cache, tree('A1'))).toBe(true)
            expect(cache.read(ISSUE, 'D1')).toBeDefined()
            expect(cache.read(SESSION, 'S9')).toBeDefined()
            expect(replica.posture).toBe('bootstrapping')
            expect(cache.readLoadingSince()).not.toBeNull()
            release()
            await fetching
            await until(() => replica.posture === 'live')
            await replica.settled()
            expect(replica.posture).toBe('live')
            expect(cache.readLoadingSince()).toBeNull()
            expect(marked(cache, tree('A1'))).toBe(true)
            expect(cache.read(ISSUE, 'D1')).toBeDefined()
            expect(cache.read(SESSION, 'S9')).toBeDefined()
            expectMarkersTrue(cache, server)
          } finally {
            release()
          }
        })

        it('keeps what the tree re-confirmed, unchanged, and still sweeps what nothing named', async () => {
          const server = world()
          const { cache, replica, release } = await reloading(await instantiation.open(), server)
          try {
            const fetching = replica.load([tree('A1')])
            await until(() => marked(cache, tree('A1')))
            expect(marked(cache, tree('A1'))).toBe(true)
            expect(cache.read(SESSION, 'S9')).toBeDefined()
            release()
            await fetching
            await until(() => replica.posture === 'live')
            await replica.settled()
            await ticks()
            await replica.settled()
            expect(replica.posture).toBe('live')
            // Re-confirmed by the tree, unchanged: it survives the load's sweep.
            expect(cache.read(SESSION, 'S9')).toBeDefined()
            expect(cache.read(ISSUE, 'D1')).toBeDefined()
            expect(marked(cache, tree('A1'))).toBe(true)
            // The reload no longer holds S2 and no fetch named it: swept.
            expect(cache.readRow(SESSION, 'S2')).toBeUndefined()
            expect(cache.read(ISSUE, 'A3')).toBeDefined()
            expectMarkersTrue(cache, server)
          } finally {
            release()
          }
        })

        it('a crash before the commit lands resumes the load: the tree stays whole, the rest is swept', async () => {
          const server = world()
          const storage = await instantiation.open()
          const dying = await reloading(storage, server)
          // Its commit is never released: the kernel dies with it pending.
          void dying.replica.load([tree('A1')]).catch(() => undefined)
          await until(() => marked(dying.cache, tree('A1')))
          expect(marked(dying.cache, tree('A1'))).toBe(true)
          await ticks()
          // THE KILL: the kernel is gone before its commit; the store stays.
          const second = await boot(instantiation, server, storage)
          expect(second.replica.posture).toBe('live')
          expect(second.cache.readLoadingSince()).toBeNull()
          expect(second.cache.readRow(SESSION, 'S2')).toBeUndefined()
          expect(second.cache.read(ISSUE, 'A3')).toBeDefined()
          if (marked(second.cache, tree('A1'))) {
            expect(second.cache.read(ISSUE, 'D1')).toBeDefined()
            expect(second.cache.read(SESSION, 'S9')).toBeDefined()
          }
          expectMarkersTrue(second.cache, server)
        })
      })

      it('a second fetch of an instance in flight resolves with that answer, not without one (POD-7169)', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        const { cache, replica } = await boot(instantiation, server)
        const gate = barrier()
        server.gate = gate.promise
        const first = replica.load([tree('D2')])
        let answered = false
        const second = replica.load([tree('D2')]).then(() => {
          answered = true
        })
        await ticks()
        expect(answered).toBe(false)
        gate.release()
        await second
        expect(marked(cache, tree('D2'))).toBe(true)
        await first
      })

      it('a fetch a reload cuts off rejects, so the loader asks again (POD-7169)', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        const { replica } = await boot(instantiation, server)
        const gate = barrier()
        server.gate = gate.promise
        const outcome = replica.load([tree('D2')]).then(
          () => 'resolved',
          () => 'rejected',
        )
        await replica.receive({ kind: 'rescope', feedId: server.feedId, epoch: server.epoch })
        gate.release()
        expect(await outcome).toBe('rejected')
        await replica.settled()
        await ticks()
        await replica.settled()
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
        const sessionsSpec: InstanceSpec = {
          collection: 'session.ofIssue',
          args: { issueId: 'D2' },
          part: 'main',
          via: 'issueProjection.sidebar',
        }
        expect(asked).toContain(instanceKey(sessionsSpec))
        expect(comesWithHeld(booted.cache, sessionsSpec)).toBe(true)
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
          comesWithHeld(booted.cache, {
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

    // ─── The disk layer (POD-7159) ────────────────────────────────────────────

    describe('the disk index and reads from disk (POD-7159)', () => {
      /** seedWorld, with what each record comes with answered in the same answer. */
      const world = (): CollectionServer => {
        const server = new CollectionServer()
        seedWorld(server)
        server.put(SESSION, 'S9', session('S9', { issueId: 'D1', status: 'ended' }))
        server.answerComesWith = true
        return server
      }
      /** The instances a screen read: the tree of A1 and what its records come with. */
      const deckKeys = (cache: ReplicaCacheStore): string[] => {
        const policy = new Set([LIVE, SIDEBAR, STUBS].map((spec) => instanceKey(spec)))
        return [...cache.readInstances().keys()].filter(
          (key) => !policy.has(key) && cache.readDiskIndex().inMemory(key),
        )
      }
      /** The server refuses every fetch: the device is offline. */
      const offline = (server: CollectionServer): void => {
        server.collections = () => {
          throw new Error('offline: no fetch may reach the server')
        }
      }

      it('is written with the rows it describes: an entry per row, each instance with its members', async () => {
        const server = world()
        const booted = await boot(instantiation, server)
        expectIndexTrue(booted.cache, server, 'after the first download')
        await booted.replica.load([tree('A1')])
        await booted.replica.settled()
        expectIndexTrue(booted.cache, server, 'after the tree')
        // A feed change moves its record's entry with it.
        server.put(ISSUE, 'A2', issue('A2', { stage: 'review', parentId: 'A1', title: 'moved' }))
        await feed(booted, server)
        expectIndexTrue(booted.cache, server, 'after the feed')
        const entry = booted.cache.readDiskIndex().record(keyOf(ISSUE, 'A2'))
        expect(entry?.seq).toBe(server.head)
      })

      it('leaves the index as it was when the batch that would change it aborts', async () => {
        const storage = await instantiation.open()
        const { cache } = storage.viewFor(PRINCIPAL)
        const cursor: Cursor = { feedId: 'feed', epoch: 'epoch', seq: 1 }
        const marker: InstanceRecord = { ...SIDEBAR, key: instanceKey(SIDEBAR), completeAt: cursor }
        await storage.unitOfWork.transact(async (span) =>
          cache.applyAtomic(
            {
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
              instances: [{ kind: 'mark', instance: marker, members: [keyOf(ISSUE, 'A1')] }],
            },
            span,
          ),
        )
        storage.failNextCommit(new Error('power loss'))
        await expect(
          storage.unitOfWork.transact(async (span) =>
            cache.applyAtomic(
              {
                operations: [{ kind: 'remove', entity: ISSUE, entityId: 'A1' }],
                instances: [{ kind: 'drop', key: marker.key }],
              },
              span,
            ),
          ),
        ).rejects.toThrow('power loss')
        const index = cache.readDiskIndex()
        expect(index.record(keyOf(ISSUE, 'A1'))).toMatchObject({ seq: 1, level: 'main' })
        expect([...index.membersOf(marker.key)]).toEqual([keyOf(ISSUE, 'A1')])
        expect(index.inMemory(marker.key)).toBe(true)
      })

      it('stays true to its rows after a kill at every chunk boundary', async () => {
        const reference = world()
        await boot(instantiation, reference)
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
          expectIndexTrue(first.cache, dying, `killed at boundary ${k}`)
          const restarted = world()
          const second = await boot(instantiation, restarted, storage)
          expectIndexTrue(second.cache, restarted, `restarted after boundary ${k}`)
        }
      })

      it('reopens an unloaded screen from disk: complete again, with no server request, offline', async () => {
        const server = world()
        const booted = await boot(instantiation, server)
        const { cache, replica, events } = booted
        await replica.load([tree('A1')])
        await replica.settled()
        await ticks()
        await replica.settled()
        const keys = deckKeys(cache)
        expect(keys).toContain(instanceKey(tree('A1')))
        const before = contents(cache)
        await replica.unload(keys)
        // Out of memory, on the device: not complete, not removed, still on disk.
        expect(replica.isComplete(tree('A1'))).toBeUndefined()
        expect(cache.readInstances().has(instanceKey(tree('A1')))).toBe(true)
        expect(cache.read(ISSUE, 'D1')).toBeUndefined()
        expect(replica.isUnloaded(ISSUE, 'D1')).toBe(true)
        expect(replica.exitKind(ISSUE, 'D1')).toBeUndefined()
        expect(replica.stubOf(ISSUE, 'D1')).toMatchObject({ stage: 'done' })
        expect(cache.readDiskIndex().record(keyOf(ISSUE, 'D1'))?.level).toBe('main')
        expect(events.some((event) => event.type === 'unloaded')).toBe(true)
        expect(events.some((event) => event.type === 'removed' || event.type === 'evicted')).toBe(
          false,
        )
        // The policy collections stayed in memory.
        for (const spec of [LIVE, SIDEBAR, STUBS]) expect(replica.isComplete(spec)).toBeDefined()
        expect(cache.read(ISSUE, 'A1')).toBeDefined()
        // Offline: reading the screen again through the loader reads it from disk.
        replica.disconnect()
        offline(server)
        const fetched = server.fetches.length
        const loader = new CollectionLoader({ replica, schedule: () => () => {} })
        expect(loader.status(tree('A1'))).toBe('loading')
        loader.request(
          keys.map((key) => {
            const marker = cache.readInstances().get(key) as InstanceRecord
            return {
              collection: marker.collection,
              part: marker.part,
              ...(marker.args === undefined ? {} : { args: marker.args }),
              ...(marker.via === undefined ? {} : { via: marker.via }),
            }
          }),
          'visible',
        )
        await loader.flush()
        await replica.settled()
        await ticks()
        await replica.settled()
        expect(server.fetches.length, 'no server request').toBe(fetched)
        for (const key of keys) expect(cache.readDiskIndex().inMemory(key), key).toBe(true)
        expect(loader.status(tree('A1'))).toBe('complete')
        expect(contents(cache)).toEqual(before)
        expectMarkersTrue(cache, server)
      })

      it('reads a single unloaded record back from disk by key, never from the server', async () => {
        const server = world()
        const booted = await boot(instantiation, server)
        await booted.replica.load([tree('A1')])
        await booted.replica.settled()
        await booted.replica.unload(deckKeys(booted.cache))
        expect(booted.replica.isUnloaded(ISSUE, 'D1')).toBe(true)
        offline(server)
        await booted.replica.loadRecords(ISSUE, ['D1', 'missing'])
        expect(booted.cache.read(ISSUE, 'D1')?.value).toEqual(
          server.members(tree('A1')).find((row) => row.id === 'D1')?.value,
        )
        expect(booted.replica.isUnloaded(ISSUE, 'D1')).toBe(false)
      })

      it('answers a one-record instance from a record whole on the device, with no fetch', async () => {
        const server = world()
        const booted = await boot(instantiation, server)
        const one: InstanceSpec = {
          collection: 'issueProjection.one',
          args: { id: 'A1' },
          part: 'main',
        }
        const fetched = server.fetches.length
        await booted.replica.load([one])
        expect(server.fetches.length).toBe(fetched)
        expect(booted.replica.isComplete(one)).toBeDefined()
        expect([...booted.cache.readDiskIndex().membersOf(instanceKey(one))]).toEqual([
          keyOf(ISSUE, 'A1'),
        ])
      })
    })

    // ─── The feed to records only on disk, and gaps (POD-7160) ────────────────

    describe('the feed to records only on disk, and gaps (POD-7160)', () => {
      /**
       * seedWorld plus D3 (done, under A1): A1's tree holds D1 and D3 only,
       * the sidebar holds A1 and A2. What each record comes with is answered
       * with it.
       */
      const world = (): CollectionServer => {
        const server = new CollectionServer()
        seedWorld(server)
        server.put(
          ISSUE,
          'D3',
          issue('D3', { stage: 'done', closedReason: 'completed', parentId: 'A1' }),
        )
        server.answerComesWith = true
        return server
      }
      const POLICY_KEYS = new Set([LIVE, SIDEBAR, STUBS].map((spec) => instanceKey(spec)))
      /** The instances in memory that are not the policy's. */
      const viewKeys = (cache: ReplicaCacheStore): string[] =>
        [...cache.readInstances().keys()].filter(
          (key) => !POLICY_KEYS.has(key) && cache.readDiskIndex().inMemory(key),
        )
      /** A1's tree read, then out of memory: on disk only. */
      const treeOnDisk = async (booted: Booted): Promise<void> => {
        await booted.replica.load([tree('A1')])
        await booted.replica.settled()
        await ticks()
        await booted.replica.settled()
        await booted.replica.unload(viewKeys(booted.cache))
        expect(booted.cache.read(ISSUE, 'D1')).toBeUndefined()
        expect(booted.replica.isUnloaded(ISSUE, 'D1')).toBe(true)
      }
      /** Count the disk reads a store makes. */
      const countDiskReads = (cache: ReplicaCacheStore): { reads: number } => {
        const counter = { reads: 0 }
        const read = cache.readDiskRows.bind(cache)
        ;(cache as { readDiskRows: ReplicaCacheStore['readDiskRows'] }).readDiskRows = (keys) => {
          counter.reads += 1
          return read(keys)
        }
        return counter
      }
      const titleOf = (cache: ReplicaCacheStore, id: string): unknown =>
        (cache.read(ISSUE, id)?.value as { title?: unknown } | undefined)?.title
      const onDiskTitle = async (cache: ReplicaCacheStore, id: string): Promise<unknown> => {
        const [row] = await cache.readDiskRows([keyOf(ISSUE, id)])
        return (row?.value as { title?: unknown } | undefined)?.title
      }

      it('a change to a record held only on disk is written to disk, with no disk read, and a disk load shows it', async () => {
        const server = world()
        const booted = await boot(instantiation, server)
        await treeOnDisk(booted)
        const { cache, replica, events } = booted
        const counter = countDiskReads(cache)
        const told = events.length
        server.put(
          ISSUE,
          'D1',
          issue('D1', {
            stage: 'done',
            closedReason: 'completed',
            parentId: 'A1',
            title: 'renamed',
          }),
        )
        await feed(booted, server)
        expect(counter.reads, 'no disk read during feed apply').toBe(0)
        // On disk, current as of the change; memory did not take it.
        expect(cache.read(ISSUE, 'D1')).toBeUndefined()
        expect(cache.readDiskIndex().record(keyOf(ISSUE, 'D1'))).toMatchObject({
          seq: server.head,
          level: 'main',
        })
        expect(
          cache
            .readDiskIndex()
            .membersOf(instanceKey(tree('A1')))
            .has(keyOf(ISSUE, 'D1')),
        ).toBe(true)
        // A reader is told it is on disk, never that it changed in memory.
        const after = events.slice(told)
        expect(
          after.some((event) => event.type === 'upserted' && event.record.entityId === 'D1'),
        ).toBe(false)
        expect(after.some((event) => event.type === 'unloaded' && event.entityId === 'D1')).toBe(
          true,
        )
        expect(await onDiskTitle(cache, 'D1')).toBe('renamed')
        // A disk load shows the new value, with no server request.
        const fetched = server.fetches.length
        await replica.load([tree('A1')])
        await replica.settled()
        expect(server.fetches.length).toBe(fetched)
        expect(replica.isComplete(tree('A1'))).toBeDefined()
        expect(titleOf(cache, 'D1')).toBe('renamed')
        expectIndexTrue(cache, server, 'after the disk load')
      })

      describe('newest wins for a record only on disk', () => {
        const key = keyOf(ISSUE, 'R1')
        const X: InstanceSpec = tree('R1')
        const xKey = instanceKey(X)
        const upsert = (asOf: number, title: string, diskOnly: boolean) => ({
          kind: 'upsert' as const,
          entity: ISSUE,
          entityId: 'R1',
          value: issue('R1', { stage: 'done', closedReason: 'completed', title }),
          provenance: { seq: asOf },
          asOf,
          holders: [xKey],
          ...(diskOnly ? { diskOnly: true as const } : {}),
        })
        /** R1 at feed number 5, its instance marked, then out of memory. */
        const onDisk = async () => {
          const storage = await instantiation.open()
          const { cache } = storage.viewFor(PRINCIPAL)
          const cursor: Cursor = { feedId: 'feed', epoch: 'epoch', seq: 5 }
          cache.applyAtomic({
            operations: [upsert(5, 'five', false)],
            cursor,
            instances: [
              {
                kind: 'mark',
                instance: { ...X, key: xKey, completeAt: cursor },
                members: [key],
              },
            ],
          })
          cache.unload([xKey])
          expect(cache.read(ISSUE, 'R1')).toBeUndefined()
          expect(cache.readDiskIndex().record(key)?.seq).toBe(5)
          return { storage, cache }
        }

        it('the feed first, then an older fetch answer: the answer is skipped', async () => {
          const { cache } = await onDisk()
          cache.applyAtomic({ operations: [upsert(10, 'ten', true)] })
          expect(cache.read(ISSUE, 'R1'), 'disk only').toBeUndefined()
          expect(cache.readDiskIndex().record(key)?.seq).toBe(10)
          // An answer read as of 8 arrives after the feed's change at 10.
          cache.applyAtomic({ operations: [upsert(8, 'eight', false)] })
          expect(cache.readDiskIndex().record(key)?.seq).toBe(10)
          expect(cache.read(ISSUE, 'R1')).toBeUndefined()
          expect(await onDiskTitle(cache, 'R1')).toBe('ten')
          // An older feed change is skipped too; a newer one applies.
          cache.applyAtomic({ operations: [upsert(9, 'nine', true)] })
          expect(await onDiskTitle(cache, 'R1')).toBe('ten')
          cache.applyAtomic({ operations: [upsert(11, 'eleven', true)] })
          expect(await onDiskTitle(cache, 'R1')).toBe('eleven')
          expect(cache.readDiskIndex().record(key)?.seq).toBe(11)
        })

        it('the fetch answer first, then the feed: the newer change applies, an older one does not', async () => {
          const { cache } = await onDisk()
          cache.applyAtomic({ operations: [upsert(8, 'eight', false)] })
          expect(titleOf(cache, 'R1'), 'the answer is in memory').toBe('eight')
          // Memory holds it now: a change for the disk only replaces it in memory too.
          cache.applyAtomic({ operations: [upsert(10, 'ten', true)] })
          expect(titleOf(cache, 'R1')).toBe('ten')
          cache.applyAtomic({ operations: [upsert(7, 'seven', true)] })
          expect(titleOf(cache, 'R1')).toBe('ten')
          expect(await onDiskTitle(cache, 'R1')).toBe('ten')
          expect(cache.readDiskIndex().record(key)?.seq).toBe(10)
        })

        it('a removal of a record only on disk takes it off the disk', async () => {
          const { cache } = await onDisk()
          cache.applyAtomic({
            operations: [{ kind: 'remove', entity: ISSUE, entityId: 'R1', asOf: 6 }],
          })
          expect(cache.readDiskIndex().record(key)).toBeUndefined()
          expect(await cache.readDiskRows([key])).toEqual([])
        })

        it('a write to disk only that a disk load put in memory meanwhile replaces it in memory', async () => {
          const { storage, cache } = await onDisk()
          const [row] = await cache.readDiskRows([key])
          await storage.unitOfWork.transact(async (span) => {
            cache.applyAtomic({ operations: [upsert(10, 'ten', true)] }, span)
            // The disk load installs the row it read before the write publishes.
            cache.installResident([row as EntityRecord])
          })
          expect(titleOf(cache, 'R1')).toBe('ten')
        })
      })

      it('a record that leaves an instance on disk leaves it there, and falls back to its stub when nothing else holds it', async () => {
        const server = world()
        const booted = await boot(instantiation, server)
        const { cache, replica } = booted
        // D3 is in A1's tree and its own; D1 only in A1's.
        await replica.load([tree('A1'), tree('D3')])
        await replica.settled()
        await ticks()
        await replica.settled()
        await replica.unload(viewKeys(cache))
        const a1 = instanceKey(tree('A1'))
        const d3 = instanceKey(tree('D3'))
        expect(cache.read(ISSUE, 'D1')).toBeUndefined()
        expect(cache.read(ISSUE, 'D3')).toBeUndefined()
        // Both move to the top level: their rule for A1's tree no longer matches.
        server.put(ISSUE, 'D1', issue('D1', { stage: 'done', closedReason: 'completed' }))
        server.put(ISSUE, 'D3', issue('D3', { stage: 'done', closedReason: 'completed' }))
        const counter = countDiskReads(cache)
        await feed(booted, server)
        expect(counter.reads).toBe(0)
        const index = cache.readDiskIndex()
        expect(index.membersOf(a1).has(keyOf(ISSUE, 'D1'))).toBe(false)
        expect(index.membersOf(a1).has(keyOf(ISSUE, 'D3'))).toBe(false)
        // D3 stays whole on disk for its own tree.
        expect(index.record(keyOf(ISSUE, 'D3'))).toMatchObject({ level: 'main', seq: server.head })
        expect(index.membersOf(d3).has(keyOf(ISSUE, 'D3'))).toBe(true)
        // Nothing else holds D1: its stub, current.
        expect(index.record(keyOf(ISSUE, 'D1'))?.level).toBe('stub')
        expect(partOf(cache, ISSUE, 'D1')).toBe('stub')
        expect(replica.stubOf(ISSUE, 'D1')).toMatchObject({ parentId: null })
        expect(replica.stubsByParent('A1')).not.toContain('D1')
        // Read again from disk, both trees are right: A1's holds neither.
        await replica.load([tree('A1'), tree('D3')])
        await replica.settled()
        expect(replica.isComplete(tree('A1'))).toBeDefined()
        expect(cache.read(ISSUE, 'D1')).toBeUndefined()
        expectMarkersTrue(cache, server)
      })

      it('a gap keeps an instance only on disk readable and stale; a read shows it at once, then reloads it in place', async () => {
        const server = world()
        server.chunkRows = 1
        const booted = await boot(instantiation, server)
        const { cache, replica } = booted
        await treeOnDisk(booted)
        const key = instanceKey(tree('A1'))
        // Offline, D1 and D3 are renamed; the feed cannot bridge the gap.
        replica.disconnect()
        const rename = (id: string, title: string) =>
          server.put(
            ISSUE,
            id,
            issue(id, { stage: 'done', closedReason: 'completed', parentId: 'A1', title }),
          )
        rename('D1', 'new D1')
        rename('D3', 'new D3')
        server.minAvailableSeq = server.head
        const gate = barrier()
        const entered = barrier()
        server.gate = gate.promise
        const original = server.bootstrap.bind(server)
        server.bootstrap = (...args) => {
          entered.release()
          return original(...args)
        }
        replica.connect()
        await entered.promise
        await ticks()
        // During the reload: the policy's markers withdrawn, the tree's kept, stale.
        for (const spec of [LIVE, SIDEBAR, STUBS]) expect(marked(cache, spec)).toBe(false)
        expect(cache.readInstances().has(key)).toBe(true)
        expect(replica.instanceStale(tree('A1'))).toBe(true)
        server.gate = undefined
        gate.release()
        await replica.settled()
        await ticks()
        await replica.settled()
        // After it: the tree's rows are still on disk, old, and it is still stale.
        expect(replica.posture).toBe('live')
        expect(cache.readLoadingSince()).toBeNull()
        expect(replica.instanceStale(tree('A1'))).toBe(true)
        expect(cache.readDiskIndex().record(keyOf(ISSUE, 'D1'))?.level).toBe('main')
        expect(await onDiskTitle(cache, 'D1')).toBe('Issue D1')
        for (const spec of [LIVE, SIDEBAR, STUBS]) expect(marked(cache, spec)).toBe(true)
        // A reader sees the instance whole, as before the gap or as after it, never mixed.
        const mixed: string[] = []
        const versions = (): string => {
          const titles = ['D1', 'D3'].map((id) => String(titleOf(cache, id) ?? ''))
          return titles.every((title) => title.startsWith('new')) ? 'new' : titles.join('|')
        }
        const seen = new Set<string>()
        const check = (): void => {
          if (replica.isComplete(tree('A1')) === undefined) return
          const now = versions()
          seen.add(now)
          if (now !== 'new' && now !== 'Issue D1|Issue D3') mixed.push(now)
        }
        const loading = replica.load([tree('A1')])
        const poll = (async () => {
          for (let i = 0; i < 200 && replica.instanceStale(tree('A1')); i += 1) {
            check()
            await ticks(1)
          }
        })()
        await loading
        // Read at once from disk: complete, stale, the rows it had.
        expect(replica.isComplete(tree('A1'))).toBeDefined()
        check()
        await poll
        await replica.settled()
        await ticks()
        await replica.settled()
        check()
        expect(mixed).toEqual([])
        expect(seen.has('Issue D1|Issue D3')).toBe(true)
        // Replaced in place by the reload.
        expect(replica.instanceStale(tree('A1'))).toBe(false)
        expect(titleOf(cache, 'D1')).toBe('new D1')
        expect(titleOf(cache, 'D3')).toBe('new D3')
        expectMarkersTrue(cache, server)
        expectIndexTrue(cache, server, 'after the stale reload')
      })

      it('a gap removes a row of an instance only on disk that the reload confirms is gone, and the reload drops what left it', async () => {
        const server = world()
        const booted = await boot(instantiation, server)
        const { cache, replica } = booted
        await treeOnDisk(booted)
        replica.disconnect()
        // D3 is deleted while the device is offline; D1 moves out of A1's tree.
        server.drop(ISSUE, 'D3')
        server.put(ISSUE, 'D1', issue('D1', { stage: 'done', closedReason: 'completed' }))
        server.minAvailableSeq = server.head
        replica.connect()
        await replica.settled()
        await ticks()
        await replica.settled()
        // The load after the gap named no stub of D3: gone. D1's stub changed: newer, it wins.
        expect(cache.readRow(ISSUE, 'D3')).toBeUndefined()
        expect(cache.readDiskIndex().record(keyOf(ISSUE, 'D3'))).toBeUndefined()
        expect(partOf(cache, ISSUE, 'D1')).toBe('stub')
        expect(replica.instanceStale(tree('A1'))).toBe(true)
        await replica.load([tree('A1')])
        await replica.settled()
        await ticks()
        await replica.settled()
        expect(replica.instanceStale(tree('A1'))).toBe(false)
        expect(replica.isComplete(tree('A1'))).toBeDefined()
        expectMarkersTrue(cache, server)
        expectIndexTrue(cache, server, 'after the reload')
      })

      it('a stale instance the reload refuses leaves memory and disk', async () => {
        const server = world()
        const booted = await boot(instantiation, server)
        const { cache, replica, events } = booted
        await treeOnDisk(booted)
        const key = instanceKey(tree('A1'))
        replica.requestRebootstrap()
        await replica.settled()
        await ticks()
        await replica.settled()
        expect(replica.instanceStale(tree('A1'))).toBe(true)
        // The viewer lost the tree: its answer comes back without it.
        const original = server.collections.bind(server)
        server.collections = (instances) =>
          (async function* () {
            for await (const chunk of original(instances))
              yield {
                ...chunk,
                changes: [],
                complete: (chunk.complete ?? []).filter((marker) => instanceKey(marker) !== key),
              }
          })()
        const told = events.length
        await replica.load([tree('A1')])
        await replica.settled()
        await ticks()
        await replica.settled()
        expect(cache.readInstances().has(key)).toBe(false)
        expect(replica.isComplete(tree('A1'))).toBeUndefined()
        expect(replica.instanceStale(tree('A1'))).toBe(false)
        // Its rows nothing else holds left memory and disk; an issue keeps its stub.
        for (const id of ['D1', 'D3']) {
          expect(cache.read(ISSUE, id), id).toBeUndefined()
          expect(cache.readDiskIndex().record(keyOf(ISSUE, id))?.level, id).toBe('stub')
        }
        expect(
          events.slice(told).some((event) => event.type === 'released' && event.entityId === 'D1'),
        ).toBe(true)
      })

      it('offline, every instance on disk reads from disk; a stale one stays readable, stale, and reloads when the connection returns', async () => {
        const server = world()
        const booted = await boot(instantiation, server)
        const { cache, replica } = booted
        await replica.load([tree('A1'), tree('D3')])
        await replica.settled()
        await ticks()
        await replica.settled()
        await replica.unload(viewKeys(cache))
        // A gap leaves both trees stale; then the connection drops.
        replica.requestRebootstrap()
        await replica.settled()
        await ticks()
        await replica.settled()
        replica.disconnect()
        const collections = server.collections.bind(server)
        server.collections = () => {
          throw new Error('offline: no fetch may reach the server')
        }
        const loader = new CollectionLoader({ replica, schedule: () => () => {} })
        expect(loader.isStale(tree('A1'))).toBe(true)
        expect(loader.status(tree('A1'))).toBe('loading')
        loader.request([tree('A1'), tree('D3')], 'visible')
        await loader.flush()
        await replica.settled()
        await ticks()
        await replica.settled()
        for (const spec of [tree('A1'), tree('D3')]) {
          expect(loader.status(spec)).toBe('complete')
          expect(loader.isStale(spec)).toBe(true)
        }
        expect(titleOf(cache, 'D1')).toBe('Issue D1')
        // Back online, the read reloads them.
        server.collections = collections
        replica.connect()
        await replica.settled()
        await ticks()
        await loader.flush()
        await replica.settled()
        await ticks()
        await replica.settled()
        for (const spec of [tree('A1'), tree('D3')]) expect(loader.isStale(spec)).toBe(false)
        expectMarkersTrue(cache, server)
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
