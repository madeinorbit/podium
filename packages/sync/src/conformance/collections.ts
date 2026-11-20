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
import {
  approxBytes,
  comesWithHolderKey,
  comesWithHolderOf,
  heldByNothing,
  pointerTargetOf,
  splitRowKey,
} from '../replica/disk-index'
import { CollectionLoader } from '../replica/loader'
import { manualMemorySignals, WARM_GRACE_MS } from '../replica/memory'
import type { CacheMutation, ReplicaCacheStore } from '../replica/ports'
import { Replica } from '../replica/replica'
import {
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
  /** The platform's memory signals, driven by hand (POD-7161). */
  readonly memory: ReturnType<typeof manualMemorySignals>
}

function kernelOver(
  storage: ConformanceStorage,
  server: CollectionServer,
  clock = { now: WORLD_NOW },
  options: {
    readonly unitOfWork?: SyncUnitOfWork
    readonly onEvent?: (event: ReplicaEvent) => void
    /** The warm set's budget in instances (POD-7161's test hook); default the policy's MB. */
    readonly warmInstances?: number
    /** POD-7162's test hooks: the disk budget in bytes, and records per prune slice. */
    readonly diskBytes?: () => number
    readonly pruneSliceRows?: number
  } = {},
): Booted {
  const { cache } = storage.viewFor(PRINCIPAL)
  const events: ReplicaEvent[] = []
  const memory = manualMemorySignals()
  const replica = new Replica({
    store: cache,
    authority: server,
    now: () => clock.now,
    memory: {
      signals: memory,
      ...(options.warmInstances === undefined ? {} : { warmInstances: options.warmInstances }),
      ...(options.diskBytes === undefined ? {} : { diskBytes: options.diskBytes }),
      ...(options.pruneSliceRows === undefined ? {} : { pruneSliceRows: options.pruneSliceRows }),
    },
    onEvent: (event) => {
      events.push(event)
      options.onEvent?.(event)
    },
    ...(options.unitOfWork === undefined ? {} : { unitOfWork: options.unitOfWork }),
  })
  return { storage, cache, replica, events, clock, memory }
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
  options: { readonly warmInstances?: number } = {},
): Promise<Booted> {
  const booted = kernelOver(storage ?? (await instantiation.open()), server, undefined, options)
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
      // A record whole on disk and out of memory (POD-7159) keeps its stub in the stub table.
      for (const row of server.members(instance))
        expect(
          cache.readRow(row.entity, row.id) ?? cache.readStubTable(row.entity)?.stubOf(row.id),
          `${instance.key} holds ${row.id}`,
        ).toBeDefined()
      continue
    }
    // Whole in memory, or whole on disk and out of memory (POD-7159, POD-7161).
    const index = cache.readDiskIndex()
    for (const row of server.members(instance))
      expect(
        cache.read(row.entity, row.id) ??
          (index.record(keyOf(row.entity, row.id))?.level === 'main' ? 'on disk' : undefined),
        `${instance.key} holds ${row.id}`,
      ).toBeDefined()
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
      function deviceServer(): CollectionServer {
        const server = new CollectionServer()
        seedWorld(server)
        server.answerComesWith = true
        server.policy = {
          ...WORLD_POLICY,
          steps: [
            { step: 'always', collections: ['machine.all', 'machineAccess.all'] },
            ...WORLD_POLICY.steps,
          ],
        }
        server.kindTokens = {
          machine: 'v1',
          machineAccess: 'v1',
          session: 'v1',
          sessionUserState: 'v1',
          issueProjection: 'v1',
        }
        for (const id of ['M1', 'M2']) {
          server.put('machine', id, { id, name: id, loggedOutHarnesses: [] })
          server.put('machineAccess', `${PRINCIPAL}\n${id}`, {
            userId: PRINCIPAL,
            machineId: id,
            hostname: id,
            use: { allowed: true },
            owned: true,
            serviceAssignment: { agentExecution: true },
          })
        }
        // A sleeping session on a visible task comes with the task, rather
        // than belonging to session.live. Its own read state comes with it.
        server.put(SESSION, 'S2', session('S2', { issueId: 'A1', status: 'hibernated' }))
        for (const id of ['S1', 'S2'])
          server.put('sessionUserState', `${PRINCIPAL}\n${id}`, {
            userId: PRINCIPAL,
            sessionId: id,
            readAt: RECENTLY,
          })
        return server
      }

      function expectDeviceWhole(cache: ReplicaCacheStore): void {
        for (const id of ['M1', 'M2']) {
          expect.soft(cache.read('machine', id)?.value).toMatchObject({ id, name: id })
          expect.soft(cache.read('machineAccess', `${PRINCIPAL}\n${id}`)?.value).toMatchObject({
            owned: true,
            serviceAssignment: { agentExecution: true },
          })
        }
        for (const id of ['S1', 'S2']) {
          expect.soft(cache.read(SESSION, id)?.value).toMatchObject({ sessionId: id })
          expect.soft(cache.read('sessionUserState', `${PRINCIPAL}\n${id}`)?.value).toMatchObject({
            sessionId: id,
            readAt: RECENTLY,
          })
        }
      }

      it('keeps a populated device whole when machine access and session kind tokens change after the feed advances', async () => {
        const server = deviceServer()
        const booted = await boot(instantiation, server)
        const { cache, replica } = booted
        expectDeviceWhole(cache)
        // No machine or session changed: an unrelated feed write makes the
        // cursor newer than their last stored write before the update arrives.
        server.put(ISSUE, 'A2', issue('A2', { stage: 'review', parentId: 'A1', title: 'renamed' }))
        await feed(booted, server)
        const fetchesBefore = server.fetches.length
        server.kindTokens = {
          ...server.kindTokens,
          machine: 'v1',
          machineAccess: 'v2',
          session: 'v2',
          sessionUserState: 'v2',
        }
        replica.observeKindTokens(server.kindTokens)
        await ticks()
        await replica.settled()
        expectDeviceWhole(cache)
        expect(server.bootstraps).toBe(1)
        expect(
          server.fetches
            .slice(fetchesBefore)
            .flat()
            .map((spec) => spec.collection),
        ).toContain('machineAccess.all')
        expect(cache.readKindTokens()).toEqual(server.kindTokens)
        expectMarkersTrue(cache, server)
        expectIndexTrue(cache, server)
      })

      it('replaces an old projection at the same feed number, including a companion-only kind change', async () => {
        const server = deviceServer()
        const { cache, replica } = await boot(instantiation, server)
        // Projections saved by the old release. The new server computes new
        // fields from the same source rows, without writing to the feed.
        for (const [entity, id] of [
          ['machineAccess', `${PRINCIPAL}\nM1`],
          ['sessionUserState', `${PRINCIPAL}\nS2`],
        ] as const) {
          const row = cache.read(entity, id) as EntityRecord
          cache.applyAtomic({
            operations: [
              {
                kind: 'upsert',
                entity,
                entityId: id,
                value: { ...(row.value as object), serviceAssignment: undefined, readAt: null },
                provenance: row.provenance,
                asOf: rowAsOf(row),
                force: true,
              },
            ],
          })
        }
        const fetchesBefore = server.fetches.length
        server.kindTokens = { ...server.kindTokens, sessionUserState: 'v2' }
        replica.observeKindTokens(server.kindTokens)
        await replica.settled()
        expect(cache.read('sessionUserState', `${PRINCIPAL}\nS2`)?.value).toMatchObject({
          readAt: RECENTLY,
        })
        const asked = server.fetches.slice(fetchesBefore).flat()
        expect(asked.length).toBeGreaterThan(0)
        expect(asked.every((spec) => spec.collection === 'sessionUserState.ofSession')).toBe(true)
        server.kindTokens = { ...server.kindTokens, machineAccess: 'v2' }
        replica.observeKindTokens(server.kindTokens)
        await replica.settled()
        expectDeviceWhole(cache)
        expect(server.bootstraps).toBe(1)
        expectIndexTrue(cache, server)
      })

      it('repairs an already damaged saved copy with matching tokens once, without another bootstrap', async () => {
        const server = deviceServer()
        const { cache, storage, replica } = await boot(instantiation, server)
        replica.disconnect()
        server.kindTokens = {
          ...server.kindTokens,
          machine: 'v1',
          machineAccess: 'v2',
          session: 'v2',
          sessionUserState: 'v2',
        }
        // The old algorithm saved the new tokens and complete markers after
        // deleting the rows. Rebuild the kernel over that saved state.
        cache.applyAtomic({
          operations: cache
            .readEntities()
            .filter((row) => ['machineAccess', SESSION, 'sessionUserState'].includes(row.entity))
            .map((row) => ({
              kind: 'remove' as const,
              entity: row.entity,
              entityId: row.entityId,
            })),
          cursor: cache.readCursor() as Cursor,
          kindTokens: server.kindTokens,
          kindReloadVersion: 0,
        })
        expect(cache.readKindTokens()).toEqual(server.kindTokens)
        expect(marked(cache, LIVE)).toBe(true)
        expect(cache.read('machineAccess', `${PRINCIPAL}\nM1`)).toBeUndefined()
        const fetchesBefore = server.fetches.length
        const healed = kernelOver(storage, server)
        healed.replica.connect()
        healed.replica.observeKindTokens(server.kindTokens)
        await healed.replica.settled()
        expectDeviceWhole(cache)
        expect(cache.readKindReloadVersion()).toBe(1)
        const asked = server.fetches
          .slice(fetchesBefore)
          .flat()
          .map((spec) => spec.collection)
        expect(asked).toContain('machineAccess.all')
        expect(asked).toContain('session.ofIssue')
        expect(asked).toContain('machine.all')
        expect(asked).toContain('issueProjection.sidebar')
        expectMarkersTrue(cache, server)
        expectIndexTrue(cache, server)
        healed.replica.disconnect()
        const fetchesAfter = server.fetches.length
        const restarted = kernelOver(storage, server)
        restarted.replica.connect()
        restarted.replica.observeKindTokens(server.kindTokens)
        await restarted.replica.settled()
        expectDeviceWhole(cache)
        expect(server.bootstraps).toBe(1)
        expect(server.fetches).toHaveLength(fetchesAfter)
      })

      it('does not certify an interrupted repair; the next connection retries it', async () => {
        const server = deviceServer()
        const { cache, storage, replica } = await boot(instantiation, server)
        await replica.load([tree('D2')])
        await replica.settled()
        expect(cache.read(ISSUE, 'D2')).toBeDefined()
        cache.applyAtomic({
          operations: [],
          cursor: cache.readCursor() as Cursor,
          kindReloadVersion: 0,
        })
        const collections = server.collections.bind(server)
        server.collections = async function* (requests) {
          for await (const chunk of collections(requests)) {
            yield chunk
            return // HTTP ended cleanly without its final chunk.
          }
        }
        replica.observeKindTokens(server.kindTokens)
        await expect(replica.settled()).rejects.toThrow('kind reload ended before the last chunk')
        expect(cache.readKindReloadVersion()).toBe(0)
        expectDeviceWhole(cache)
        expect(marked(cache, tree('D2'))).toBe(true)
        expect(replica.instanceStale(tree('D2'))).toBe(true)
        replica.disconnect()
        server.collections = collections
        const retry = kernelOver(storage, server)
        retry.replica.connect()
        retry.replica.observeKindTokens(server.kindTokens)
        await retry.replica.settled()
        expect(cache.readKindReloadVersion()).toBe(1)
        expectDeviceWhole(cache)
        expect(cache.read(ISSUE, 'D2')).toBeDefined()
        expect(retry.replica.instanceStale(tree('D2'))).toBe(false)
        expect(server.bootstraps).toBe(1)
        expectIndexTrue(cache, server)
      })

      it('reconfirms an undamaged older device once and preserves its whole rows and stubs', async () => {
        const server = deviceServer()
        const { cache, replica } = await boot(instantiation, server)
        const before = contents(cache)
        cache.applyAtomic({
          operations: [],
          cursor: cache.readCursor() as Cursor,
          kindReloadVersion: 0,
        })
        replica.observeKindTokens(server.kindTokens)
        await replica.settled()
        expect(contents(cache)).toEqual(before)
        expectDeviceWhole(cache)
        expect(cache.readKindReloadVersion()).toBe(1)
        expect(server.bootstraps).toBe(1)
        expectMarkersTrue(cache, server)
        expectIndexTrue(cache, server)
      })

      it('keeps a newer feed edit or removal while an older kind reload answer is held', async () => {
        const server = deviceServer()
        const { cache, replica } = await boot(instantiation, server)
        const gate = barrier()
        server.gate = gate.promise
        server.kindTokens = {
          ...server.kindTokens,
          machine: 'v1',
          machineAccess: 'v2',
          session: 'v2',
          sessionUserState: 'v2',
        }
        const fetched = server.fetches.length
        replica.observeKindTokens(server.kindTokens)
        await until(() => server.fetches.length > fetched)
        const before = replica.cursor as Cursor
        server.put(SESSION, 'S1', session('S1', { issueId: 'A1', name: 'newer' }))
        server.drop(SESSION, 'S2')
        server.drop('machineAccess', `${PRINCIPAL}\nM2`, 'evict')
        await replica.receive(server.frameSince(before.seq))
        // A second advertisement joins the reload already answering it.
        replica.observeKindTokens(server.kindTokens)
        gate.release()
        await replica.settled()
        expect(cache.read(SESSION, 'S1')?.value).toMatchObject({ name: 'newer' })
        expect(cache.readRow(SESSION, 'S2')).toBeUndefined()
        expect(cache.readRow('machineAccess', `${PRINCIPAL}\nM2`)).toBeUndefined()
        expect(server.bootstraps).toBe(1)
        expect(cache.readKindTokens()).toEqual(server.kindTokens)
      })

      it('reloads a changed companion kind whose holder is only on disk', async () => {
        const server = new CollectionServer()
        seedWorld(server)
        server.answerComesWith = true
        server.kindTokens = { sessionUserState: 'v1' }
        const stateId = `${PRINCIPAL}\nS2`
        server.put('sessionUserState', stateId, {
          userId: PRINCIPAL,
          sessionId: 'S2',
          readAt: RECENTLY,
        })
        const { cache, replica } = await boot(instantiation, server)
        await replica.load([tree('D2')])
        await replica.settled()
        await replica.unload(instanceKey(tree('D2')))
        expect(cache.read(SESSION, 'S2')).toBeUndefined()
        expect(cache.readDiskIndex().record(keyOf(SESSION, 'S2'))?.level).toBe('main')
        server.kindTokens = { sessionUserState: 'v2' }
        const fetched = server.fetches.length
        replica.observeKindTokens(server.kindTokens)
        await replica.settled()
        expect(server.fetches.slice(fetched).flat()).toContainEqual({
          collection: 'sessionUserState.ofSession',
          args: { sessionId: 'S2' },
          part: 'main',
          via: SESSION,
        })
        const rows = await cache.readDiskRows([keyOf('sessionUserState', stateId)])
        expect(rows[0]?.value).toMatchObject({ readAt: RECENTLY })
        expect(server.bootstraps).toBe(1)
        expectMarkersTrue(cache, server)
      })

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
        // Stale while the reload is in flight; its identity and rows survive
        // a crash so the next device connection can finish the same reload.
        expect(replica.instanceStale(SIDEBAR)).toBe(true)
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

    // ─── The warm set (POD-7161) ──────────────────────────────────────────────

    describe('the warm set: leaving memory is not leaving the device (POD-7161)', () => {
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
      const inMemory = (booted: Booted, spec: InstanceSpec) =>
        booted.cache.readDiskIndex().inMemory(instanceKey(spec))
      const onDisk = (booted: Booted, id: string) =>
        booted.cache.readDiskIndex().record(`${ISSUE}\u0000${id}`)?.level === 'main'
      const idle = async (booted: Booted) => {
        if (booted.memory.idle() === 0) await booted.replica.shrinkMemory('idle')
        await booted.replica.settled()
      }

      it('an idle tick unloads the warm instances released longest ago; markers and rows stay on the device', async () => {
        const server = new CollectionServer()
        withTrees(server)
        const booted = await boot(instantiation, server, undefined, { warmInstances: 1 })
        await openAndRelease(booted, 'T1', WORLD_NOW + 1)
        await openAndRelease(booted, 'U1', WORLD_NOW + 2)
        booted.clock.now = WORLD_NOW + 2 + WARM_GRACE_MS
        await idle(booted)
        // U1 (released last) stays warm; T1 leaves memory, not the device.
        expect(inMemory(booted, tree('U1'))).toBe(true)
        expect(inMemory(booted, tree('T1'))).toBe(false)
        expect(marked(booted.cache, tree('T1'))).toBe(true)
        for (const id of ['T1', 'T2']) {
          expect(onDisk(booted, id), id).toBe(true)
          expect(booted.replica.isUnloaded(ISSUE, id), id).toBe(true)
        }
        // The policy's collections are always resident.
        for (const spec of [LIVE, SIDEBAR, STUBS]) expect(inMemory(booted, spec)).toBe(true)
        expectMarkersTrue(booted.cache, server)
      })

      it('never unloads an instance an open view holds, at budget 0, on a memory warning', async () => {
        const server = new CollectionServer()
        withTrees(server)
        const booted = await boot(instantiation, server, undefined, { warmInstances: 0 })
        booted.replica.hold(tree('T1'))
        await booted.replica.load([tree('T1')])
        await booted.replica.settled()
        booted.memory.memoryWarning()
        await booted.replica.settled()
        expect(partOf(booted.cache, ISSUE, 'T1')).toBe('main')
        expect(partOf(booted.cache, ISSUE, 'T2')).toBe('main')
        expect(booted.replica.isComplete(tree('T1'))).toBeDefined()
      })

      it('keeps a record a held record comes with, and never takes an issue off the device', async () => {
        const server = new CollectionServer()
        withTrees(server)
        // A live session on a closed issue: the session comes with its issue.
        server.put(SESSION, 'S5', session('S5', { issueId: 'D1', lastActiveAt: RECENTLY }))
        const booted = await boot(instantiation, server, undefined, { warmInstances: 0 })
        await openAndRelease(booted, 'T1', WORLD_NOW + 1)
        booted.memory.memoryWarning()
        await booted.replica.settled()
        expect(partOf(booted.cache, ISSUE, 'D1')).toBe('main')
        expect(
          comesWithHeld(booted.cache, {
            collection: 'issueProjection.one',
            args: { id: 'D1' },
            part: 'main',
            via: SESSION,
          }),
        ).toBe(true)
        // Every issue keeps its stub in memory; what left memory is whole on disk.
        for (const id of ['A1', 'A2', 'D1', 'D2', 'T1', 'T2', 'U1'])
          expect(booted.replica.stubOf(ISSUE, id), id).toBeDefined()
        for (const id of ['T1', 'T2']) {
          expect(onDisk(booted, id), id).toBe(true)
          expect(booted.replica.isUnloaded(ISSUE, id), id).toBe(true)
        }
        expectMarkersTrue(booted.cache, server)
      })

      it('the grace: released 10 s ago survives an over-budget idle tick, and leaves on a memory warning', async () => {
        const server = new CollectionServer()
        withTrees(server)
        const booted = await boot(instantiation, server, undefined, { warmInstances: 0 })
        await openAndRelease(booted, 'T1', WORLD_NOW + 1)
        booted.clock.now = WORLD_NOW + 1 + 10_000
        await idle(booted)
        expect(inMemory(booted, tree('T1'))).toBe(true)
        booted.memory.background()
        await booted.replica.settled()
        expect(inMemory(booted, tree('T1')), 'the background keeps the grace too').toBe(true)
        booted.memory.memoryWarning()
        await booted.replica.settled()
        expect(inMemory(booted, tree('T1'))).toBe(false)
        expect(marked(booted.cache, tree('T1'))).toBe(true)
      })

      it('without an idle tick, a background or a warning, nothing leaves memory, far over budget', async () => {
        const server = new CollectionServer()
        withTrees(server)
        const booted = await boot(instantiation, server, undefined, { warmInstances: 0 })
        await openAndRelease(booted, 'T1', WORLD_NOW + 1)
        await openAndRelease(booted, 'U1', WORLD_NOW + 2)
        booted.clock.now = WORLD_NOW + 10 * WARM_GRACE_MS
        // Fetches, feed frames and releases go by; memory only asks for an idle moment.
        server.put(
          ISSUE,
          'T2',
          issue('T2', { stage: 'done', closedReason: 'completed', parentId: 'T1', title: 'moved' }),
        )
        await feed(booted, server)
        await booted.replica.load([tree('D1')])
        await booted.replica.settled()
        await ticks()
        for (const root of ['T1', 'U1']) expect(inMemory(booted, tree(root)), root).toBe(true)
        expect(booted.replica.stats().shrinks).toBe(0)
        expect(booted.memory.pendingIdle).toBeGreaterThan(0)
        // The page goes to the background: past the grace, both leave memory.
        booted.memory.background()
        await booted.replica.settled()
        for (const root of ['T1', 'U1']) expect(inMemory(booted, tree(root)), root).toBe(false)
      })

      it('an unloaded warm instance is read again from disk with zero server requests', async () => {
        const server = new CollectionServer()
        withTrees(server)
        const booted = await boot(instantiation, server, undefined, { warmInstances: 0 })
        await openAndRelease(booted, 'T1', WORLD_NOW + 1)
        booted.clock.now = WORLD_NOW + 1 + WARM_GRACE_MS
        await idle(booted)
        expect(inMemory(booted, tree('T1'))).toBe(false)
        const fetched = server.fetches.length
        const bootstraps = server.bootstraps
        server.collections = () => {
          throw new Error('offline: no fetch may reach the server')
        }
        await booted.replica.load([tree('T1')])
        await booted.replica.settled()
        expect(server.fetches.length, 'no server request').toBe(fetched)
        expect(server.bootstraps).toBe(bootstraps)
        expect(booted.replica.isComplete(tree('T1'))).toBeDefined()
        for (const id of ['T1', 'T2']) expect(partOf(booted.cache, ISSUE, id), id).toBe('main')
      })
    })

    // ─── Disk pruning (POD-7162) ──────────────────────────────────────────────

    describe('disk pruning: within the size budget, only while idle (POD-7162)', () => {
      const ROOTS = ['P10', 'P20', 'P30', 'P40']
      const withTrees = (server: CollectionServer) => {
        seedWorld(server)
        for (const root of ROOTS) {
          server.put(ISSUE, root, issue(root, { stage: 'done', closedReason: 'completed' }))
          for (const n of [1, 2]) {
            const id = root.replace('0', String(n))
            server.put(
              ISSUE,
              id,
              issue(id, { stage: 'done', closedReason: 'completed', parentId: root }),
            )
          }
        }
      }
      const idsOf = (root: string) => [root, ...[1, 2].map((n) => root.replace('0', String(n)))]
      /** Open a tree, leave it at `at`, and let memory unload it: it stays on the device. */
      const visit = async (booted: Booted, root: string, at: number) => {
        booted.clock.now = at
        const release = booted.replica.hold(tree(root))
        await booted.replica.load([tree(root)])
        await booted.replica.settled()
        release()
        await booted.replica.settled()
        await booted.replica.unload(instanceKey(tree(root)))
      }
      const whole = (booted: Booted, id: string) =>
        booted.cache.readDiskIndex().record(keyOf(ISSUE, id))?.level === 'main'
      /** What a tree frees on the device when its issues fall back to their stubs. */
      const frees = (booted: Booted, root: string) =>
        idsOf(root).reduce((sum, id) => {
          const bytes = booted.cache.readDiskIndex().record(keyOf(ISSUE, id))?.bytes ?? 0
          return sum + bytes - approxBytes({ value: booted.replica.stubOf(ISSUE, id) })
        }, 0)
      const idle = async (booted: Booted) => {
        if (booted.memory.idle() === 0) await booted.replica.pruneDisk()
        await booted.replica.settled()
        await ticks()
        await booted.replica.settled()
      }
      /**
       * The index agrees with the rows the store holds on DISK: every entry
       * has its row at its feed number and level, and every row the server
       * could have sent that is on disk has its entry.
       */
      const expectDiskAgrees = async (
        cache: ReplicaCacheStore,
        server: CollectionServer,
        label: string,
      ) => {
        const index = cache.readDiskIndex()
        const keys = new Set([...index.records()].map(([key]) => key))
        for (const entity of [ISSUE, SESSION])
          for (const id of server.idsOf(entity)) keys.add(keyOf(entity, id))
        const rows = await cache.readDiskRows([...keys])
        const byKey = new Map(rows.map((row) => [keyOf(row.entity, row.entityId), row]))
        for (const row of rows)
          expect(
            index.record(keyOf(row.entity, row.entityId)),
            `${label}: ${row.entityId} has an entry`,
          ).toBeDefined()
        for (const [key, entry] of index.records()) {
          const row = byKey.get(key)
          const { entity, entityId } = splitRowKey(key)
          if (entry.level === 'main') {
            expect(
              row?.part ?? (row === undefined ? 'absent' : 'main'),
              `${label}: ${entityId} whole on disk`,
            ).toBe('main')
            expect(
              row === undefined ? undefined : rowAsOf(row),
              `${label}: ${entityId} feed number`,
            ).toBe(entry.seq)
            continue
          }
          // POD-7170: a durable store keeps a stub-level record in its index entry, not as a row.
          expect(
            row === undefined || row.part === 'stub',
            `${label}: ${entityId} no whole row`,
          ).toBe(true)
          if (row !== undefined)
            expect(rowAsOf(row), `${label}: ${entityId} feed number`).toBe(entry.seq)
          expect(
            cache.readStubTable(entity)?.stubOf(entityId),
            `${label}: ${entityId} stub`,
          ).toBeDefined()
        }
        // A marker's members are records on the device.
        for (const key of cache.readInstances().keys())
          for (const member of index.membersOf(key))
            expect(index.record(member), `${label}: ${key} member ${member}`).toBeDefined()
      }
      /** Four trees read in order, left; a budget that only the oldest two must leave for. */
      const fourTrees = async (
        storage?: ConformanceStorage,
        options: {
          readonly pruneSliceRows?: number
          /** More records on the server before the first download (POD-7186). */
          readonly seed?: (server: CollectionServer) => void
        } = {},
      ) => {
        const server = new CollectionServer()
        withTrees(server)
        options.seed?.(server)
        const budget = { bytes: Number.MAX_SAFE_INTEGER }
        const booted = kernelOver(storage ?? (await instantiation.open()), server, undefined, {
          warmInstances: 0,
          diskBytes: () => budget.bytes,
          ...(options.pruneSliceRows === undefined
            ? {}
            : { pruneSliceRows: options.pruneSliceRows }),
        })
        booted.replica.connect()
        await booted.replica.settled()
        await ticks()
        await booted.replica.settled()
        for (const [n, root] of ROOTS.entries()) await visit(booted, root, WORLD_NOW + n * 1_000)
        const index = booted.cache.readDiskIndex()
        budget.bytes =
          index.bytes -
          frees(booted, 'P10') -
          frees(booted, 'P20') +
          Math.floor(frees(booted, 'P30') / 2)
        return { server, booted, budget }
      }
      const expectOldestTwoGone = (booted: Booted, server: CollectionServer) => {
        for (const root of ['P10', 'P20']) {
          expect(marked(booted.cache, tree(root)), root).toBe(false)
          for (const id of idsOf(root)) {
            expect(whole(booted, id), id).toBe(false)
            expect(booted.replica.stubOf(ISSUE, id), `${id} keeps its stub`).toBeDefined()
            expect(booted.replica.exitKind(ISSUE, id), `${id} is not REMOVED`).toBeUndefined()
          }
        }
        for (const root of ['P30', 'P40']) {
          expect(marked(booted.cache, tree(root)), root).toBe(true)
          for (const id of idsOf(root)) expect(whole(booted, id), id).toBe(true)
        }
        for (const spec of [LIVE, SIDEBAR, STUBS]) expect(marked(booted.cache, spec)).toBe(true)
        expectMarkersTrue(booted.cache, server)
      }

      it('over budget, idle slices remove the least recently read trees until within it; the index agrees after every slice', async () => {
        const { server, booted, budget } = await fourTrees(undefined, { pruneSliceRows: 1 })
        expect(booted.cache.readDiskIndex().bytes).toBeGreaterThan(budget.bytes)
        // Leaving and unloading pruned nothing: only an idle moment does.
        expect(booted.replica.stats().prunes).toBe(0)
        let slices = 0
        for (let i = 0; i < 40; i += 1) {
          const before = booted.replica.stats().prunes
          await idle(booted)
          if (booted.replica.stats().prunes === before) break
          slices += 1
          await expectDiskAgrees(booted.cache, server, `after slice ${slices}`)
        }
        expect(slices, 'several slices').toBeGreaterThan(1)
        expect(booted.cache.readDiskIndex().bytes).toBeLessThanOrEqual(budget.bytes)
        expectOldestTwoGone(booted, server)
        expect(booted.events.some((e) => e.type === 'released' && e.entityId === 'P11')).toBe(true)
        expect(booted.events.some((e) => e.type === 'removed' || e.type === 'evicted')).toBe(false)
      })

      it('a prune killed between two slices: after the restart the store and the index agree, and idle moments finish it', async () => {
        const storage = await instantiation.open()
        const { server, booted, budget } = await fourTrees(storage, { pruneSliceRows: 1 })
        await idle(booted)
        expect(booted.replica.stats().prunes).toBe(1)
        await expectDiskAgrees(booted.cache, server, 'after the first slice')
        // The power goes in the second slice: its transaction never lands.
        const index = booted.cache.readDiskIndex()
        const before = { bytes: index.bytes, records: index.recordCount, version: index.version }
        storage.setWritesDenied(true, new Error('power loss'))
        await expect(booted.replica.pruneDisk()).rejects.toThrow()
        expect(booted.cache.readDiskIndex().bytes).toBe(before.bytes)
        expect(booted.cache.readDiskIndex().recordCount).toBe(before.records)
        await expectDiskAgrees(booted.cache, server, 'after the kill')
        storage.setWritesDenied(false)
        // The restart: new kernels over the same physical store.
        const restarted = kernelOver(storage, server, booted.clock, {
          warmInstances: 0,
          diskBytes: () => budget.bytes,
          pruneSliceRows: 1,
        })
        restarted.replica.connect()
        await restarted.replica.settled()
        await ticks()
        await restarted.replica.settled()
        await expectDiskAgrees(restarted.cache, server, 'after the restart')
        for (let i = 0; i < 40; i += 1) {
          const prunes = restarted.replica.stats().prunes
          await idle(restarted)
          if (restarted.replica.stats().prunes === prunes) break
          await expectDiskAgrees(restarted.cache, server, `after restarted slice ${i + 1}`)
        }
        expect(restarted.cache.readDiskIndex().bytes).toBeLessThanOrEqual(budget.bytes)
        expectOldestTwoGone(restarted, server)
      })

      it('a pruned tree read again is fetched from the server as a new instance, and marked again', async () => {
        const { server, booted } = await fourTrees()
        await idle(booted)
        expect(marked(booted.cache, tree('P10'))).toBe(false)
        const fetched = server.fetches.length
        booted.replica.hold(tree('P10'))
        await booted.replica.load([tree('P10')])
        await booted.replica.settled()
        // Asked of the server (with what its records come with next), never read from disk.
        expect(
          server.fetches
            .slice(fetched)[0]
            ?.some((request) => instanceKey(request) === instanceKey(tree('P10'))),
        ).toBe(true)
        expect(marked(booted.cache, tree('P10'))).toBe(true)
        expect(booted.replica.isComplete(tree('P10'))).toBeDefined()
        for (const id of idsOf('P10')) expect(whole(booted, id), id).toBe(true)
        expectMarkersTrue(booted.cache, server)
      })

      // ─── Pointer edges (POD-7186) ───────────────────────────────────────────

      const ONE_S5: InstanceSpec = { collection: 'session.one', args: { id: 'S5' }, part: 'main' }
      /** Open an instance, read it, leave it at `at`, and let memory unload it. */
      const visitSpec = async (booted: Booted, spec: InstanceSpec, at: number) => {
        booted.clock.now = at
        const release = booted.replica.hold(spec)
        await booted.replica.load([spec])
        await booted.replica.settled()
        release()
        await booted.replica.settled()
        await booted.replica.unload(instanceKey(spec))
      }
      const settle = async (booted: Booted) => {
        await booted.replica.settled()
        await ticks()
        await booted.replica.settled()
      }

      it('a pruned instance never takes what a kept record only on disk points to; offline, its screen reopens from disk with it', async () => {
        const storage = await instantiation.open()
        const server = new CollectionServer()
        withTrees(server)
        // A headless session on P11: no deck shows it, so only its own view holds it.
        server.put(
          SESSION,
          'S5',
          session('S5', { issueId: 'P11', status: 'ended', headless: true }),
        )
        const budget = { bytes: Number.MAX_SAFE_INTEGER }
        const options = { warmInstances: 0, diskBytes: () => budget.bytes }
        const first = kernelOver(storage, server, undefined, options)
        first.replica.connect()
        await settle(first)
        // The tree of P10 is read first, the session's screen after it: the tree is older.
        await visit(first, 'P10', WORLD_NOW)
        await visitSpec(first, ONE_S5, WORLD_NOW + 1_000)
        // The restart: the pointer edges come back with the index, no row read.
        const booted = kernelOver(storage, server, first.clock, options)
        booted.replica.connect()
        await settle(booted)
        const { cache, replica } = booted
        const index = cache.readDiskIndex()
        const S5 = keyOf(SESSION, 'S5')
        const P10 = keyOf(ISSUE, 'P10')
        const P11 = keyOf(ISSUE, 'P11')
        // Only on disk: the session, its issue, that issue's parent.
        for (const id of ['P10', 'P11', 'P12']) expect(cache.read(ISSUE, id), id).toBeUndefined()
        expect(cache.read(SESSION, 'S5')).toBeUndefined()
        expect(index.record(S5)?.level).toBe('main')
        expect(index.record(S5)?.pt).toEqual([P11])
        expect(index.record(P11)?.pt).toEqual([P10])
        expect([...index.pointedBy(P11)]).toEqual([S5])
        expect([...index.pointedBy(P10)].sort()).toEqual([P11, keyOf(ISSUE, 'P12')].sort())
        expect(index.record(P11)?.holders).toEqual([instanceKey(tree('P10'))])
        // One byte over budget: the least recently read instance, the tree, leaves.
        budget.bytes = index.bytes - 1
        await idle(booted)
        expect(replica.stats().prunes).toBeGreaterThan(0)
        expect(marked(cache, tree('P10'))).toBe(false)
        expect(marked(cache, ONE_S5)).toBe(true)
        expect(cache.readDiskIndex().bytes).toBeLessThanOrEqual(budget.bytes)
        // The session keeps its issue whole, and the issue its parent; the rest falls to its stub.
        expect(whole(booted, 'P11'), 'P11, the session points to it').toBe(true)
        expect(whole(booted, 'P10'), "P10, P11's parent").toBe(true)
        expect(whole(booted, 'P12')).toBe(false)
        expect(replica.stubOf(ISSUE, 'P12')).toBeDefined()
        expect(cache.readDiskIndex().record(S5)?.level).toBe('main')
        await expectDiskAgrees(cache, server, 'after the prune')
        // Offline: the session's screen reopens from disk, with what it points to.
        replica.disconnect()
        server.collections = () => {
          throw new Error('offline: no fetch may reach the server')
        }
        const fetched = server.fetches.length
        const loader = new CollectionLoader({ replica, schedule: () => () => {} })
        loader.request([ONE_S5], 'visible')
        await loader.flush()
        await settle(booted)
        expect(server.fetches.length, 'no server request').toBe(fetched)
        expect(loader.status(ONE_S5)).toBe('complete')
        expect(cache.read(SESSION, 'S5')).toBeDefined()
        expect(cache.read(ISSUE, 'P11'), 'its issue, whole').toBeDefined()
        expect(cache.read(ISSUE, 'P10'), "the issue's parent, whole").toBeDefined()
      })

      it('a gap while an instance is half pruned keeps its marker, stale: nothing it held is left held by nothing, and idle slices finish it', async () => {
        const storage = await instantiation.open()
        const { server, booted, budget } = await fourTrees(storage, {
          pruneSliceRows: 1,
          // A deck session of P11: the tree brings it (its holder is P11).
          seed: (world) =>
            world.put(SESSION, 'S6', session('S6', { issueId: 'P11', status: 'ended' })),
        })
        const key = instanceKey(tree('P10'))
        const S6 = keyOf(SESSION, 'S6')
        expect(booted.cache.readDiskIndex().record(S6)?.holders).toContain(
          comesWithHolderKey(keyOf(ISSUE, 'P11')),
        )
        // One slice: the tree is half pruned, its marker kept for the rest.
        await idle(booted)
        const index = booted.cache.readDiskIndex()
        expect(index.instance(key)?.indexed).toBe(false)
        const left = [...index.membersOf(key)].filter(
          (member) => index.record(member)?.level === 'main',
        )
        expect(left.length).toBeGreaterThan(0)
        // Offline, the server moves on; back online, the feed cannot bridge the gap.
        booted.replica.disconnect()
        server.put(ISSUE, 'Z1', issue('Z1'))
        server.minAvailableSeq = server.head
        booted.replica.connect()
        await settle(booted)
        expect(booted.replica.posture).toBe('live')
        const after = booted.cache.readDiskIndex()
        expect(marked(booted.cache, tree('P10')), 'the half-pruned marker stays').toBe(true)
        expect(after.instance(key)).toMatchObject({ indexed: false, stale: true })
        // Everything the tree still held, and what that brings, is held by something on the device.
        const markers = booted.cache.readInstances()
        for (const member of [...left, S6]) {
          const entry = after.record(member)
          if (entry?.level !== 'main') continue
          expect(heldByNothing(entry, markers, after), `${member} held by something`).toBe(false)
        }
        // A restart loads none of it into memory.
        const restarted = kernelOver(storage, server, booted.clock, {
          warmInstances: 0,
          diskBytes: () => budget.bytes,
          pruneSliceRows: 1,
        })
        restarted.replica.connect()
        await settle(restarted)
        for (const member of [...left, S6]) {
          const { entity, entityId } = splitRowKey(member)
          expect(
            restarted.cache.read(entity, entityId),
            `${entityId} not in memory`,
          ).toBeUndefined()
        }
        // Idle slices finish it: the marker goes with the last member, the session leaves with its issue.
        for (let i = 0; i < 40; i += 1) {
          const prunes = restarted.replica.stats().prunes
          await idle(restarted)
          if (restarted.replica.stats().prunes === prunes) break
        }
        expect(marked(restarted.cache, tree('P10'))).toBe(false)
        for (const id of idsOf('P10')) {
          expect(whole(restarted, id), id).toBe(false)
          expect(restarted.replica.stubOf(ISSUE, id), `${id} keeps its stub`).toBeDefined()
        }
        expect(restarted.cache.readDiskIndex().record(S6)).toBeUndefined()
        await expectDiskAgrees(restarted.cache, server, 'after the prune finished')
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
