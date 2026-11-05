/**
 * A GENERIC RECORD WRITE THROUGH THE KERNEL QUEUE (ADR 12 D3, POD-6392): it is
 * sent as `records.<kind>.<op>` on `sync.submit`, and it is confirmed like every
 * other write: by its receipt, not by its reply.
 */

import { asMutationId, asSessionId, asUserId, sessionUserStateRowId } from '@podium/model'
import type { SyncSubmitInput, SyncSubmitReply } from '@podium/protocol'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import type { Cursor } from '@podium/sync/replica'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import { overlaysForOutboxEntry } from '../command-reducers'
import type { OutboxEntry, OutboxStorage } from '../outbox'
import type { Replica } from '../replica/contract'
import { openKernelEngineOutbox } from './kernel-outbox'
import type { StoreNotices } from './types'
import type { EngineOutboxCallbacks } from './wiring'

const FEED = { feedId: 'feed-1', epoch: 'epoch-1' }
const at = (seq: number): Cursor => ({ ...FEED, seq })
const M1 = asMutationId('mut-1')
const M2 = asMutationId('mut-2')
const M3 = asMutationId('mut-3')
const ISSUE = 'iss_00000000-0000-4000-8000-000000000001'
const READ_ROW = sessionUserStateRowId(
  asUserId('user-1'),
  asSessionId('00000000-0000-4000-8000-0000000000aa'),
)

function memoryStorage(): OutboxStorage {
  let entries: OutboxEntry[] = []
  return {
    load: () => entries,
    save: (next) => {
      entries = [...next]
    },
  }
}

async function open(reply: (envelope: SyncSubmitInput) => SyncSubmitReply) {
  return await openOn(reply)
}

/** An older server: no `sync.submit` procedure at all. */
const missingProcedure = (): Error =>
  Object.assign(new Error('No procedure found on path "sync.submit"'), {
    data: { code: 'NOT_FOUND', httpStatus: 404, path: 'sync.submit' },
  })

async function openOn(
  reply: (envelope: SyncSubmitInput) => SyncSubmitReply,
  store = new InMemoryOutboxStore([]),
) {
  const submits: SyncSubmitInput[] = []
  const api = {
    sync: {
      submit: {
        mutate: async (envelope: SyncSubmitInput) => {
          submits.push(envelope)
          return reply(envelope)
        },
      },
    },
  } as unknown as PodiumClientApi
  let online = false
  const create = await openKernelEngineOutbox({
    store,
    principal: 'user-1',
    api,
    onDegraded: () => {},
    now: () => 5_000,
    confirmedThrough: () => null,
  })
  const onDropped = vi.fn()
  const callbacks: EngineOutboxCallbacks = {
    api,
    replica: {
      outboxStorage: memoryStorage,
      outboxAwaitingStorage: memoryStorage,
      outboxDeadLetterStorage: memoryStorage,
    } as unknown as Replica,
    notices: { error: () => {}, info: () => {} } as unknown as StoreNotices,
    isOnline: () => online,
    onDropped,
  }
  const outbox = create(callbacks)
  return {
    outbox,
    create,
    submits,
    onDropped,
    goOnline: () => {
      online = true
    },
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const EDIT = {
  kind: 'issueProjection' as const,
  id: ISSUE,
  patch: { title: 'Mine' },
  expectedRevision: 3,
}

describe('a generic record write on the kernel queue', () => {
  it('goes out as records.<kind>.<op>, without the entry’s kind, and awaits its receipt', async () => {
    const { outbox, create, submits, goOnline } = await open(() => ({
      outcome: 'applied',
      result: { ok: true },
      receipt: at(7),
      replayed: false,
    }))
    await outbox.enqueue('recordEdit', EDIT, { mutationId: M1 })
    goOnline()
    await outbox.drain()
    await settle()

    expect(submits).toEqual([
      {
        mutationId: M1,
        command: 'records.issueProjection.edit',
        version: 1,
        input: { id: ISSUE, patch: { title: 'Mine' }, expectedRevision: 3, mutationId: M1 },
      },
    ])
    // Applied and still painting until the replica reaches the receipt.
    expect(outbox.awaiting().map((e) => e.mutationId)).toEqual([M1])
    expect(outbox.awaiting()[0]).toMatchObject({ kind: 'recordEdit', input: EDIT })
    await create.overlay.retire({ matches: [], through: at(6), install: false })
    expect(outbox.awaiting()).toHaveLength(1)
    await create.overlay.retire({ matches: [], through: at(7), install: false })
    expect(outbox.awaiting()).toEqual([])
    outbox.dispose()
  })

  it('a refusal drops the entry: nothing awaits, nothing retries', async () => {
    const { outbox, submits, onDropped, goOnline } = await open(() => ({
      outcome: 'rejected',
      refusal: { kind: 'conflict' },
    }))
    await outbox.enqueue('recordEdit', EDIT, { mutationId: M1 })
    goOnline()
    await outbox.drain()
    await settle()

    expect(submits).toHaveLength(1)
    expect(outbox.pending()).toEqual([])
    expect(outbox.awaiting()).toEqual([])
    expect(onDropped).toHaveBeenCalledWith(
      expect.objectContaining({ mutationId: M1, kind: 'recordEdit' }),
      expect.anything(),
    )
    outbox.dispose()
  })

  it('on a server without sync.submit an edit no old command carries is refused, never left painting', async () => {
    const { outbox, submits, onDropped, goOnline } = await openOn(() => {
      throw missingProcedure()
    })
    // Clearing acceptance never had a command of its own (POD-6405).
    await outbox.enqueue(
      'recordEdit',
      { kind: 'issueProjection', id: ISSUE, patch: {}, unset: ['acceptance'] },
      { mutationId: M1 },
    )
    goOnline()
    await outbox.drain()
    await settle()

    // The entry point once: the per-kind fallback knows it is missing and does
    // not probe again (POD-6404), and an issue field edit has no older route.
    expect(submits.map((s) => s.command)).toEqual(['records.issueProjection.edit'])
    expect(outbox.pending()).toEqual([])
    expect(outbox.awaiting()).toEqual([])
    expect(onDropped).toHaveBeenCalledWith(expect.objectContaining({ mutationId: M1 }), {
      code: 'invalid',
    })
    outbox.dispose()
  })
})

describe('one device’s chain of edits on one record (POD-6403)', () => {
  /** A server that numbers each applied edit's revision from 4. */
  function counting() {
    let revision = 3
    return (): SyncSubmitReply => ({
      outcome: 'applied',
      result: { revision: ++revision },
      receipt: at(revision),
      replayed: false,
    })
  }

  it('an edit made against the revision its own applied predecessor was made against goes out against the one it wrote', async () => {
    const { outbox, submits, goOnline } = await open(counting())
    await outbox.enqueue('recordEdit', EDIT, { mutationId: M1 })
    await outbox.enqueue('recordEdit', { ...EDIT, patch: { title: 'Again' } }, { mutationId: M2 })
    await outbox.enqueue('recordEdit', { ...EDIT, patch: { title: 'Third' } }, { mutationId: M3 })
    goOnline()
    await outbox.drain()
    await settle()

    expect(submits.map((s) => (s.input as { expectedRevision?: number }).expectedRevision)).toEqual(
      [3, 4, 5],
    )
    outbox.dispose()
  })

  it('an edit made against another revision goes out as made', async () => {
    const { outbox, submits, goOnline } = await open(counting())
    await outbox.enqueue('recordEdit', EDIT, { mutationId: M1 })
    await outbox.enqueue('recordEdit', { ...EDIT, expectedRevision: 9 }, { mutationId: M2 })
    await outbox.enqueue(
      'recordEdit',
      { ...EDIT, id: 'iss_00000000-0000-4000-8000-000000000002' },
      { mutationId: M3 },
    )
    goOnline()
    await outbox.drain()
    await settle()

    // Two records, two partitions: read each send by its entry.
    const sent = new Map(
      submits.map((s) => [
        s.mutationId,
        (s.input as { expectedRevision?: number }).expectedRevision,
      ]),
    )
    expect([sent.get(M1), sent.get(M2), sent.get(M3)]).toEqual([3, 9, 3])
    outbox.dispose()
  })

  it('a plain-field edit names no revision and starts no chain', async () => {
    const { outbox, submits, goOnline } = await open(counting())
    const { expectedRevision: _r, ...plain } = EDIT
    await outbox.enqueue('recordEdit', plain, { mutationId: M1 })
    await outbox.enqueue('recordEdit', EDIT, { mutationId: M2 })
    goOnline()
    await outbox.drain()
    await settle()

    expect(submits.map((s) => (s.input as { expectedRevision?: number }).expectedRevision)).toEqual(
      [undefined, 3],
    )
    outbox.dispose()
  })

  it('a cleared cell goes out as unset', async () => {
    const { outbox, submits, goOnline } = await open(counting())
    await outbox.enqueue(
      'recordEdit',
      { kind: 'sessionUserState', id: READ_ROW, patch: {}, unset: ['snoozedUntil'] },
      { mutationId: M1 },
    )
    goOnline()
    await outbox.drain()
    await settle()

    expect(submits[0]?.input).toEqual({
      id: READ_ROW,
      patch: {},
      unset: ['snoozedUntil'],
      mutationId: M1,
    })
    outbox.dispose()
  })
})

describe('a converted plain edit across a reload (POD-6404)', () => {
  it('a read mark awaiting its receipt keeps painting after a reopen, and retires at the covering cursor', async () => {
    const store = new InMemoryOutboxStore([])
    const applied = (): SyncSubmitReply => ({
      outcome: 'applied',
      result: { ok: true },
      receipt: at(7),
      replayed: false,
    })
    const read = {
      kind: 'sessionUserState' as const,
      id: READ_ROW,
      patch: { readAt: '2026-11-05T00:00:00.000Z' },
    }
    const first = await openOn(applied, store)
    await first.outbox.enqueue('recordEdit', read, { mutationId: M1 })
    first.goOnline()
    await first.outbox.drain()
    await settle()
    expect(first.outbox.awaiting().map((e) => e.mutationId)).toEqual([M1])
    first.outbox.dispose()

    // The app reloads before the covering frame arrives.
    const second = await openOn(applied, store)
    const [awaiting] = second.outbox.awaiting()
    expect(awaiting?.mutationId).toBe(M1)
    expect(overlaysForOutboxEntry(awaiting!)).toEqual([
      expect.objectContaining({ entity: 'sessionUserStates', patch: read.patch }),
    ])
    await second.create.overlay.retire({ matches: [], through: at(6), install: false })
    expect(second.outbox.awaiting()).toHaveLength(1)
    await second.create.overlay.retire({ matches: [], through: at(7), install: false })
    expect(second.outbox.awaiting()).toEqual([])
    second.outbox.dispose()
  })
})
