/**
 * A GENERIC RECORD WRITE THROUGH THE KERNEL QUEUE (ADR 12 D3, POD-6392): it is
 * sent as `records.<kind>.<op>` on `sync.submit`, and it is confirmed like every
 * other write: by its receipt, not by its reply.
 */

import { asMutationId } from '@podium/model'
import type { SyncSubmitInput, SyncSubmitReply } from '@podium/protocol'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import type { Cursor } from '@podium/sync/replica'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry, OutboxStorage } from '../outbox'
import type { Replica } from '../replica/contract'
import { openKernelEngineOutbox } from './kernel-outbox'
import type { StoreNotices } from './types'
import type { EngineOutboxCallbacks } from './wiring'

const FEED = { feedId: 'feed-1', epoch: 'epoch-1' }
const at = (seq: number): Cursor => ({ ...FEED, seq })
const M1 = asMutationId('mut-1')
const ISSUE = 'iss_00000000-0000-4000-8000-000000000001'

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

async function openOn(reply: (envelope: SyncSubmitInput) => SyncSubmitReply) {
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
    store: new InMemoryOutboxStore([]),
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

  it('on a server without sync.submit it is refused, never left painting', async () => {
    const { outbox, submits, onDropped, goOnline } = await openOn(() => {
      throw missingProcedure()
    })
    await outbox.enqueue('recordEdit', EDIT, { mutationId: M1 })
    goOnline()
    await outbox.drain()
    await settle()

    // The entry point first, then the per-kind fallback, which has no other
    // route for a record command and names it from the whole entry.
    expect(submits.map((s) => s.command)).toEqual([
      'records.issueProjection.edit',
      'records.issueProjection.edit',
    ])
    expect(outbox.pending()).toEqual([])
    expect(outbox.awaiting()).toEqual([])
    expect(onDropped).toHaveBeenCalledWith(
      expect.objectContaining({ mutationId: M1 }),
      { code: 'invalid' },
    )
    outbox.dispose()
  })
})
