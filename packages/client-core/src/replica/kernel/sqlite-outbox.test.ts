/**
 * The mobile outbox binding, against a REAL SQLite engine on a REAL file.
 *
 * WHY NOT A DOUBLE. This module rests on exactly one fact that is a property of the
 * SQLite adapter's implementation rather than of any port contract: the record is
 * stored with `JSON.stringify` and read back with `JSON.parse`, verbatim, so a
 * record carrying client-only fields round-trips intact. A stub outbox port would
 * "prove" that by construction and prove nothing — the same shape POD-1228's
 * `facade.test.ts` has, where a `memoryStorage()` that can never deny a quota made
 * the empty catch unreachable and any case written against it would have passed
 * before the fix existed.
 *
 * So the round-trip cases open a real store, write through the binding, CLOSE it,
 * and re-open a second store over the same file. Nothing is read back through the
 * object that wrote it.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actorUser, asUserId } from '@podium/model'
import { asMutationId } from '@podium/protocol'
import type { SqlDatabaseLike } from '@podium/sync/adapters/mobile-sqlite'
import { SqliteSyncStore } from '@podium/sync/adapters/mobile-sqlite'
import type { OutboxAttribution, OutboxCommand } from '@podium/sync/outbox'
import { afterEach, describe, expect, it } from 'vitest'
import type { OutboxEntry } from '../../outbox'
import { createKernelOutboxStorage, type KernelOutboxStorages } from './sqlite-outbox'

const PRINCIPAL = asUserId('operator')
const ATTRIBUTION: OutboxAttribution = {
  actor: actorUser(PRINCIPAL),
  onBehalfOf: PRINCIPAL,
}
const COMMANDS: Record<string, OutboxCommand> = {
  'sessions.rename': { name: 'sessions.rename', version: 3, delivery: 'offline-eligible' },
}
const resolveCommand = (kind: string): OutboxCommand | undefined => COMMANDS[kind]

/**
 * The runtime's real SQLite, whichever it ships. `bun:sqlite` under the repo's Bun
 * lane and `node:sqlite` under Node — the same two `packages/sync`'s own test
 * support resolves between, and for the same reason: refusing is the load-bearing
 * half. A resolver that quietly returned a Map-backed imitation would leave every
 * assertion here green while proving nothing about durability.
 */
const openDatabase = await (async (): Promise<(file: string) => SqlDatabaseLike> => {
  for (const [specifier, exportName] of [
    ['bun:sqlite', 'Database'],
    ['node:sqlite', 'DatabaseSync'],
  ] as const) {
    try {
      const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>
      const Ctor = mod[exportName] as (new (file: string) => SqlDatabaseLike) | undefined
      if (Ctor) return (file: string) => new Ctor(file)
    } catch {
      // try the next one
    }
  }
  throw new Error('no real SQLite engine available — refusing to test against a stand-in')
})()

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c()
    } catch {
      // teardown must not fail a passing test
    }
  }
})

function newFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-outbox-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'replica.db')
}

async function openBinding(
  file: string,
  onDegraded: (e: unknown) => void = () => {},
): Promise<{ storages: KernelOutboxStorages; close: () => void }> {
  const store = await SqliteSyncStore.open({
    openDatabase: () => openDatabase(file),
    deleteDatabase: () => rmSync(file, { force: true }),
    onDegraded: () => {},
  })
  cleanups.push(() => store.close())
  const storages = await createKernelOutboxStorage({
    outbox: store.viewFor(PRINCIPAL).outbox,
    resolveCommand,
    attribution: ATTRIBUTION,
    onDegraded,
  })
  return { storages, close: () => store.close() }
}

const entry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  mutationId: 'mut_1',
  kind: 'sessions.rename',
  input: { title: 'renamed' },
  queuedAt: 10,
  ...over,
})

describe('the queue is durable in SQLite, and the client bookkeeping survives it', () => {
  it('round-trips baseline / chained / resolvedAt through a SECOND store over the same file', async () => {
    // The single fact this module rests on. If the adapter ever stopped storing the
    // record verbatim, the optimistic overlay would break on every reload — and it
    // would break silently, because every field the kernel knows about still
    // survives.
    const file = newFile()
    const first = await openBinding(file)
    first.storages.queued.save([
      entry({ baseline: 'fingerprint-abc', chained: true }),
      entry({ mutationId: 'mut_2', queuedAt: 20 }),
    ])
    first.close()

    const second = await openBinding(file)
    const loaded = second.storages.queued.load()
    expect(loaded.map((e) => e.mutationId)).toEqual(['mut_1', 'mut_2'])
    expect(loaded[0]?.baseline).toBe('fingerprint-abc')
    expect(loaded[0]?.chained).toBe(true)
    // And the entry that never had them does not acquire them.
    expect(loaded[1]?.baseline).toBeUndefined()
    expect(loaded[1]?.chained).toBeUndefined()
  })

  it('keeps FIFO by authored time, not by mutation id', async () => {
    // SQLite returns PRIMARY KEY order when a query asks for none, which here is
    // mutation_id order. An entry queued later but named earlier would jump the
    // queue, and ADR 3 D12's FIFO would hold in memory and break on every cold
    // start — which on mobile is every time the OS reclaims the process.
    const file = newFile()
    const first = await openBinding(file)
    first.storages.queued.save([
      entry({ mutationId: 'zzz_first', queuedAt: 1 }),
      entry({ mutationId: 'aaa_second', queuedAt: 2 }),
    ])
    first.close()

    const second = await openBinding(file)
    expect(second.storages.queued.load().map((e) => e.mutationId)).toEqual([
      'zzz_first',
      'aaa_second',
    ])
  })
})

describe('the two homes are views over one store and must not clobber each other', () => {
  it('an awaiting-truth entry reads back as awaiting, not as queued', async () => {
    // The counterfactual that matters: read back as `queued` and the client
    // RE-SENDS a mutation the Authority already accepted. That is why the legacy
    // path kept two separate stores.
    const file = newFile()
    const first = await openBinding(file)
    first.storages.awaiting.save([entry({ state: 'awaiting-truth', resolvedAt: 99 })])
    first.close()

    const second = await openBinding(file)
    expect(second.storages.queued.load()).toEqual([])
    const held = second.storages.awaiting.load()
    expect(held).toHaveLength(1)
    expect(held[0]?.state).toBe('awaiting-truth')
    expect(held[0]?.resolvedAt).toBe(99)
  })

  it('saving one home leaves the other home untouched', async () => {
    // A whole-store write from one view would delete the other's rows — the
    // clobbering OutboxStorePort.apply's record-level contract exists to prevent.
    const file = newFile()
    const { storages } = await openBinding(file)
    storages.awaiting.save([entry({ mutationId: 'mut_held', state: 'awaiting-truth' })])
    storages.queued.save([entry({ mutationId: 'mut_queued' })])

    expect(storages.awaiting.load().map((e) => e.mutationId)).toEqual(['mut_held'])
    expect(storages.queued.load().map((e) => e.mutationId)).toEqual(['mut_queued'])

    // And removing from one still does not reach the other.
    storages.queued.save([])
    expect(storages.queued.load()).toEqual([])
    expect(storages.awaiting.load().map((e) => e.mutationId)).toEqual(['mut_held'])
  })
})

describe('a write that cannot be persisted is LOUD, never swallowed', () => {
  it('rethrows and reports when no contract resolves the entry kind', async () => {
    const file = newFile()
    const degraded: unknown[] = []
    const { storages } = await openBinding(file, (e) => degraded.push(e))

    expect(() => storages.queued.save([entry({ kind: 'sessions.unknownCommand' })])).toThrow(
      /no contract resolves/,
    )
    expect(degraded).toHaveLength(1)
    // Nothing was written: a refused save must not half-apply.
    expect(storages.queued.load()).toEqual([])
  })

  it('the write is DURABLE by the time save() returns, with nothing awaited in between', async () => {
    // THE PROPERTY THIS WHOLE BINDING RESTS ON, and the only place it is checkable.
    // `apply` is an async function, so a correct adapter's promise still settles on
    // a later microtask — an earlier draft guarded on that and produced an
    // instrument that fired against real SQLite and could never say yes. What
    // matters is not when the promise settles but whether the bytes are on disk, so
    // this opens a SECOND connection over the same file immediately after `save()`
    // returns, with no await between the two, and requires the row to be there.
    // An adapter whose commit is merely scheduled — IndexedDB — fails this.
    const file = newFile()
    const { storages } = await openBinding(file)

    storages.queued.save([entry({ mutationId: 'mut_durable' })])

    const second = openDatabase(file)
    try {
      const rows = second
        .prepare('SELECT mutation_id FROM outbox WHERE principal = ?')
        .all(PRINCIPAL) as { mutation_id: string }[]
      expect(rows.map((r) => r.mutation_id)).toEqual(['mut_durable'])
    } finally {
      second.close()
    }
  })

  it('reports a rejected write through onDegraded rather than swallowing it', async () => {
    // The reporting D4.4 clause 3 requires, on the path that CAN fail. It arrives
    // asynchronously because `apply` does; the alternative was a synchronous rethrow
    // that no async port can honestly provide.
    const degraded: unknown[] = []
    const storages = await createKernelOutboxStorage({
      outbox: {
        read: async () => [],
        apply: async () => {
          throw new Error('disk is full')
        },
      },
      resolveCommand,
      attribution: ATTRIBUTION,
      onDegraded: (e) => degraded.push(e),
    })

    storages.queued.save([entry()])
    await Promise.resolve()
    await Promise.resolve()
    expect(degraded).toHaveLength(1)
    expect((degraded[0] as Error).message).toMatch(/disk is full/)
  })

  it('stays SILENT on a healthy write — the reporting can say no as well as yes', async () => {
    // Without this, the case above is satisfied by a binding that reports every
    // write as degraded.
    const degraded: unknown[] = []
    const { storages } = await openBinding(newFile(), (e) => degraded.push(e))
    storages.queued.save([entry()])
    await Promise.resolve()
    await Promise.resolve()
    expect(degraded).toEqual([])
  })
})

/**
 * A row in a state the CLIENT Outbox does not know belongs to neither home.
 *
 * Found by POD-1220 giving the attribution gate its first caller. `decideLegacyAdoption`
 * parks the entries of a device it cannot attribute as `dead-letter` records with the
 * payload redacted — deliberately kept, so POD-316 can tell the user work was lost.
 * The split used to be a BOOLEAN ("accepted, or else queued"), so those parked rows
 * came back through `queued.load()` as drainable work and the engine would have
 * replayed, under the current user's name, the mutations the gate had just refused to
 * attribute to them. The gate had a caller and no effect.
 */
describe('a state neither client home owns', () => {
  const PARKED = {
    mutationId: asMutationId('mut_parked'),
    command: COMMANDS['sessions.rename'] as OutboxCommand,
    input: null,
    partitionKey: 'legacy-import',
    attribution: ATTRIBUTION,
    state: 'dead-letter' as const,
    queuedAt: 5,
    attempts: 0,
  }

  it('is invisible to BOTH homes — a parked dead letter is not drainable work', async () => {
    const file = newFile()
    const store = await SqliteSyncStore.open({
      openDatabase: () => openDatabase(file),
      deleteDatabase: () => rmSync(file, { force: true }),
      onDegraded: () => {},
    })
    cleanups.push(() => store.close())
    const view = store.viewFor(PRINCIPAL)
    await view.outbox.apply({
      put: [PARKED],
      expect: [{ mutationId: PARKED.mutationId, expect: 'absent' }],
    })

    const storages = await createKernelOutboxStorage({
      outbox: view.outbox,
      resolveCommand,
      attribution: ATTRIBUTION,
      onDegraded: () => {},
    })

    expect(storages.queued.load()).toEqual([])
    expect(storages.awaiting.load()).toEqual([])
    // And it is genuinely IN the store — otherwise both lines above pass by the
    // fixture having written nothing, which is the same shape as the right answer.
    expect((await view.outbox.read()).map((r) => r.mutationId)).toEqual(['mut_parked'])
  })

  it('is not DELETED by a save from a home that cannot see it', async () => {
    // A view that removed rows outside its own home would turn "the client rewrote
    // its queue" into "the record of the user's lost work disappeared".
    const file = newFile()
    const store = await SqliteSyncStore.open({
      openDatabase: () => openDatabase(file),
      deleteDatabase: () => rmSync(file, { force: true }),
      onDegraded: () => {},
    })
    cleanups.push(() => store.close())
    const view = store.viewFor(PRINCIPAL)
    await view.outbox.apply({
      put: [PARKED],
      expect: [{ mutationId: PARKED.mutationId, expect: 'absent' }],
    })

    const storages = await createKernelOutboxStorage({
      outbox: view.outbox,
      resolveCommand,
      attribution: ATTRIBUTION,
      onDegraded: () => {},
    })
    storages.queued.save([entry()])
    await Promise.resolve()
    await Promise.resolve()

    expect((await view.outbox.read()).map((r) => r.mutationId).sort()).toEqual([
      'mut_1',
      'mut_parked',
    ])
  })
})
