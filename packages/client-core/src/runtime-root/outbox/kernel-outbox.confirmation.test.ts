/**
 * WRITES ARE CONFIRMED BY THE REPLICA'S TRUTH, NOT BY THE REPLY (ADR 12, POD-6277).
 *
 * The outbox sends every queued command to the one write entry point,
 * `sync.submit`, and the reply carries a RECEIPT: the change-log position that
 * holds the write. The entry then stays `applied` (still painting) until the
 * replica commits a cursor at or past that receipt, or a row naming the entry's
 * own id. Retiring on the reply alone is what stranded the nulldisk folder: the
 * entry left, the replica had not caught up, and the old value showed again.
 *
 * Older servers have no `sync.submit`. Their replies carry no receipt, so the
 * entry retires on the reply as it always did (plan Decision 4).
 */

import type { MutationId } from '@podium/model'
import {
  asMutationId,
  asSessionId,
  asUserId,
  layoutRowId,
  UNADDRESSABLE_SEND_REASON,
} from '@podium/model'
import type { SyncSubmitInput, SyncSubmitReply } from '@podium/protocol'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import type { Cursor } from '@podium/sync/replica'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../../api'
import type { NoticeSink } from '../../notices'
import type { OutboxEntry, OutboxStorage } from '../../outbox'
import type { Replica } from '../../replica/contract'
import { openKernelEngineOutbox } from './kernel-outbox'
import type { EngineOutbox, EngineOutboxCallbacks } from './wiring'

const PRINCIPAL = 'user-1'
const FEED = { feedId: 'feed-1', epoch: 'epoch-1' }
const at = (seq: number): Cursor => ({ ...FEED, seq })
const M1 = asMutationId('mut-1')
const M2 = asMutationId('mut-2')

function memoryStorage(): OutboxStorage {
  let entries: OutboxEntry[] = []
  return {
    load: () => entries,
    save: (next) => {
      entries = [...next]
    },
  }
}

const applied = (seq: number, result: unknown = { ok: true }): SyncSubmitReply => ({
  outcome: 'applied',
  result,
  receipt: at(seq),
  replayed: false,
})

const missingProcedure = (): Error =>
  Object.assign(new Error('No procedure found on path "sync.submit"'), {
    data: { code: 'NOT_FOUND', httpStatus: 404, path: 'sync.submit' },
  })

interface Server {
  readonly api: PodiumClientApi
  /** Every envelope `sync.submit` received. */
  readonly submits: SyncSubmitInput[]
  /** Every call to an old per-command route. */
  readonly legacy: { route: string; input: unknown }[]
}

/** A server whose `sync.submit` answers with `reply`; `undefined` means the
 *  procedure does not exist on it (an older server). */
function server(
  reply: ((envelope: SyncSubmitInput) => Promise<SyncSubmitReply>) | undefined,
  options: { readonly noSyncSubmit?: boolean } = {},
): Server {
  const submits: SyncSubmitInput[] = []
  const legacy: { route: string; input: unknown }[] = []
  const route = (name: string, result: unknown) => ({
    mutate: async (input: unknown) => {
      legacy.push({ route: name, input })
      return result
    },
  })
  const api = {
    sync: options.noSyncSubmit
      ? {}
      : {
          submit: {
            mutate: async (envelope: SyncSubmitInput) => {
              submits.push(envelope)
              if (reply === undefined) throw missingProcedure()
              return await reply(envelope)
            },
          },
        },
    layout: { clear: route('layout.clear', { values: {} }) },
    sessions: { resumeAndSend: route('sessions.resumeAndSend', { ok: true }) },
  }
  return { api: api as unknown as PodiumClientApi, submits, legacy }
}

interface Opened {
  readonly outbox: EngineOutbox
  readonly create: Awaited<ReturnType<typeof openKernelEngineOutbox>>
  readonly errors: string[]
  readonly degraded: unknown[]
  readonly onApplied: ReturnType<typeof vi.fn>
  readonly onDropped: ReturnType<typeof vi.fn>
  goOnline(): void
}

async function open(
  api: PodiumClientApi,
  cursor: { current: Cursor | null } = { current: null },
): Promise<Opened> {
  let online = false
  const errors: string[] = []
  const degraded: unknown[] = []
  const create = await openKernelEngineOutbox({
    store: new InMemoryOutboxStore([]),
    principal: PRINCIPAL,
    api,
    onDegraded: (detail) => degraded.push(detail),
    now: () => 5_000,
    confirmedThrough: () => cursor.current,
  })
  const onApplied = vi.fn()
  const onDropped = vi.fn()
  const callbacks: EngineOutboxCallbacks = {
    api,
    replica: {
      outboxStorage: memoryStorage,
      outboxAwaitingStorage: memoryStorage,
      outboxDeadLetterStorage: memoryStorage,
    } as unknown as Replica,
    notices: {
      error: (message: string) => errors.push(message),
      info: () => {},
    } as unknown as NoticeSink,
    isOnline: () => online,
    onApplied,
    onDropped,
  }
  const outbox = create(callbacks)
  return {
    outbox,
    create,
    errors,
    degraded,
    onApplied,
    onDropped,
    goOnline: () => {
      online = true
    },
  }
}

/** Let the follow-up work an event schedules (a confirm, a drain) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const ids = (entries: readonly OutboxEntry[]): MutationId[] => entries.map((e) => e.mutationId)

/** Forget one layout key: a remove of my layout row (POD-6404). The stranded
 *  nulldisk write was exactly this. */
const ME = asUserId('user-1')
async function clear(outbox: EngineOutbox, mutationId: MutationId, key = 'folder.nulldisk') {
  await outbox.enqueue(
    'recordRemove',
    { kind: 'userLayout', id: layoutRowId(ME, key) },
    { mutationId },
  )
}

describe('client write confirmation through sync.submit', () => {
  it('sends the outbox envelope to sync.submit in one call', async () => {
    const { api, submits, legacy } = server(async () => applied(1))
    const { outbox, goOnline } = await open(api)
    await clear(outbox, M1)
    goOnline()
    await outbox.drain()

    expect(legacy).toEqual([])
    expect(submits).toEqual([
      {
        mutationId: M1,
        command: 'records.userLayout.remove',
        version: 1,
        input: { id: layoutRowId(ME, 'folder.nulldisk'), mutationId: M1 },
      },
    ])
    outbox.dispose()
  })

  it('a receipt keeps the entry awaiting until the replica commits a cursor at its seq; no frame shows neither value', async () => {
    const cursor = { current: at(5) as Cursor | null }
    const { api } = server(async () => applied(7))
    const { outbox, create, onApplied, degraded, goOnline } = await open(api, cursor)
    await clear(outbox, M1)
    goOnline()
    await outbox.drain()
    await settle()

    // Applied, announced, and still painting: the replica is at 5, the write at 7.
    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ mutationId: M1 }))
    expect(ids(outbox.awaiting())).toEqual([M1])

    const below = { matches: [], through: at(6), install: false }
    expect(create.overlay.covers(below)).toBe(false)
    await create.overlay.retire(below)
    expect(ids(outbox.awaiting())).toEqual([M1])

    const reaching = { matches: [], through: at(7), install: false }
    expect(create.overlay.covers(reaching)).toBe(true)
    await create.overlay.retire(reaching)
    expect(outbox.awaiting()).toEqual([])
    expect(outbox.pending()).toEqual([])
    expect(degraded).toEqual([])
    outbox.dispose()
  })

  it('a reply that arrives after its covering frame retires at once', async () => {
    // The WebSocket frame reached the replica first: the cursor is already past
    // the receipt when the slow HTTP reply lands (Review Focus 2).
    const cursor = { current: at(9) as Cursor | null }
    const { api } = server(async () => applied(7))
    const { outbox, degraded, goOnline } = await open(api, cursor)
    await clear(outbox, M1)
    goOnline()
    await outbox.drain()
    await settle()

    expect(outbox.awaiting()).toEqual([])
    expect(outbox.pending()).toEqual([])
    expect(degraded).toEqual([])
    outbox.dispose()
  })

  it('a reply in another epoch than the replica keeps the entry until an install covers it', async () => {
    const cursor = { current: { feedId: 'feed-1', epoch: 'epoch-0', seq: 50 } as Cursor | null }
    const { api } = server(async () => applied(7))
    const { outbox, create, goOnline } = await open(api, cursor)
    await clear(outbox, M1)
    goOnline()
    await outbox.drain()
    await settle()
    // A delta never compares across epochs.
    expect(ids(outbox.awaiting())).toEqual([M1])
    await create.overlay.retire({ matches: [], through: at(3), install: true })
    // Same epoch at 3 < 7: an install in the receipt's own epoch compares by seq.
    expect(ids(outbox.awaiting())).toEqual([M1])
    await create.overlay.retire({
      matches: [],
      through: { feedId: 'feed-1', epoch: 'epoch-2', seq: 1 },
      install: true,
    })
    expect(outbox.awaiting()).toEqual([])
    outbox.dispose()
  })

  it("a frame carrying the entry's own provenance retires it before the reply", async () => {
    let answer: ((reply: SyncSubmitReply) => void) | undefined
    const { api, submits } = server((envelope) =>
      envelope.mutationId === M1
        ? new Promise<SyncSubmitReply>((resolve) => {
            answer = resolve
          })
        : Promise.resolve(applied(9)),
    )
    const { outbox, create, degraded, goOnline } = await open(api, {
      current: at(2),
    })
    await clear(outbox, M1)
    goOnline()
    const draining = outbox.drain()
    await vi.waitFor(() => expect(submits).toHaveLength(1))

    const evidence = {
      matches: [{ entity: 'userLayout', entityId: 'folder.nulldisk', mutationId: M1 }],
      through: at(3),
      install: false,
    }
    expect(create.overlay.covers(evidence)).toBe(true)
    await create.overlay.retire(evidence)
    expect(outbox.pending()).toEqual([])
    expect(outbox.awaiting()).toEqual([])

    // The slow reply neither throws nor stalls the partition.
    answer?.(applied(3))
    await draining
    await clear(outbox, M2, 'folder.other')
    await outbox.drain()
    await settle()
    expect(submits.map((s) => s.mutationId)).toEqual([M1, M2])
    expect(degraded).toEqual([])
    outbox.dispose()
  })

  it('a send reads its result through the per-kind reader: a deleted session resolves "not sent"', async () => {
    const { api } = server(async () =>
      applied(4, { ok: false, reason: UNADDRESSABLE_SEND_REASON, disposition: 'dead_letter' }),
    )
    const { outbox, errors, goOnline } = await open(api, { current: at(1) })
    await outbox.enqueue(
      'resumeAndSend',
      { sessionId: asSessionId('s-gone'), text: 'Write the numbers from 1 to 400' },
      { mutationId: asMutationId('msg_gone') },
    )
    goOnline()
    await outbox.drain()
    await settle()

    expect(outbox.pending()).toEqual([])
    expect(outbox.awaiting()).toEqual([])
    expect(outbox.deadLetters()).toEqual([])
    expect(errors).toEqual([expect.stringMatching(/not sent.*session no longer exists/i)])
    outbox.dispose()
  })

  it('a rejected reply is a definitive refusal, not a retry', async () => {
    const { api, submits } = server(async () => ({
      outcome: 'rejected',
      refusal: { kind: 'conflict' },
    }))
    const { outbox, onDropped, goOnline } = await open(api, { current: at(1) })
    await clear(outbox, M1)
    goOnline()
    await outbox.drain()
    await settle()

    expect(submits).toHaveLength(1)
    expect(outbox.pending()).toEqual([])
    expect(outbox.awaiting()).toEqual([])
    expect(onDropped).toHaveBeenCalledWith(
      expect.objectContaining({ mutationId: M1 }),
      expect.objectContaining({ code: 'conflict' }),
    )
    outbox.dispose()
  })

  it('an older server without sync.submit: per-kind executor, retire on reply', async () => {
    const { api, submits, legacy } = server(undefined)
    const { outbox, degraded, goOnline } = await open(api, { current: null })
    await clear(outbox, M1)
    goOnline()
    await outbox.drain()
    await settle()

    expect(submits).toHaveLength(1)
    expect(legacy).toEqual([
      { route: 'layout.clear', input: { keys: ['folder.nulldisk'], mutationId: M1 } },
    ])
    // No receipt to wait for: the reply retires it (Decision 4), never a dead letter.
    expect(outbox.awaiting()).toEqual([])
    expect(outbox.pending()).toEqual([])
    expect(outbox.deadLetters()).toEqual([])
    expect(degraded).toEqual([])
    outbox.dispose()
  })

  it('a client api without sync.submit uses the per-kind executor', async () => {
    const { api, legacy } = server(async () => applied(1), { noSyncSubmit: true })
    const { outbox, goOnline } = await open(api)
    await clear(outbox, M1)
    goOnline()
    await outbox.drain()
    await settle()
    expect(legacy.map((call) => call.route)).toEqual(['layout.clear'])
    expect(outbox.awaiting()).toEqual([])
    outbox.dispose()
  })
})
