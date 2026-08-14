/**
 * THE ROW THAT WAS ALREADY ON THE PHONE (POD-2073).
 *
 * Mobile's queue has been durable in SQLite since POD-1220, but it was DRIVEN by
 * the compatibility `Outbox` through a pair of `OutboxStorage` views
 * (`replica/kernel/sqlite-outbox.ts`, deleted with this issue). Those views wrote
 * real `OutboxRecord`s: a dotted contract name and version, a delivery class, a
 * partition key, an attribution pair — plus three fields the kernel has no
 * counterpart for (`clientBaseline`, `clientChained`, `clientResolvedAt`), which
 * survived because the adapter stores the record with `JSON.stringify` and reads
 * it back verbatim.
 *
 * Swapping the driver therefore asks a question with a user's work on the other
 * side of it: does `KernelOutbox.open` ADOPT a row the old writer left behind, or
 * park it, or fail to see it at all? Every one of those failure modes is silent —
 * a parked row and a dropped row both read as "the queue is empty" on the screen
 * that matters — and the row in question is someone's rename, typed on a train,
 * still unsent.
 *
 * WHY THE FIXTURES ARE LITERALS AND NOT A CALL TO THE OLD WRITER. The old writer
 * is gone, and rebuilding it here to generate its own input would be a test that
 * only proves this file agrees with itself. What is durable is BYTES: these are
 * the bytes a shipped build wrote, spelled out, and they go through
 * `InMemoryOutboxStore`'s JSON round-trip on the way in — so a field that only
 * survives by object identity fails here exactly as it would on a device.
 */

import { asMutationId, asUserId } from '@podium/model'
import { InMemoryOutboxStore, type OutboxRecord } from '@podium/sync/outbox'
import { describe, expect, it } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry, OutboxStorage } from '../outbox'
import type { Replica } from '../replica/replica'
import { openKernelEngineOutbox } from './kernel-outbox'
import type { StoreNotices } from './types'
import type { EngineOutbox } from './wiring'

const PRINCIPAL = 'user-1'

/** The compatibility queue's three homes, unused on this path and supplied only
 *  because `EngineOutboxCallbacks` asks the engine for a replica. If the kernel
 *  driver ever read one of them, these would be where it read nothing. */
function memoryStorage(): OutboxStorage {
  let entries: OutboxEntry[] = []
  return {
    load: () => entries,
    save: (next) => {
      entries = [...next]
    },
  }
}

/** The client-only overlay bookkeeping the old writer carried alongside the
 *  kernel's own fields. Declared as its own type so the fixtures below cannot
 *  quietly drop one and still typecheck as an `OutboxRecord`. */
type LegacyWrittenRecord = OutboxRecord & {
  readonly clientBaseline?: string
  readonly clientChained?: boolean
  readonly clientResolvedAt?: number
}

/**
 * One row exactly as `createKernelOutboxStorage`'s `toRecord` wrote it.
 *
 * `partitionKey` is the single global `client-outbox` key that writer used for
 * every entry — POD-785 replaced it with a per-target key, and an adopted row
 * keeps the one it was written under, which is over-serialised and correct. The
 * `command` object carries `confirmation` because the old writer stored
 * `OUTBOX_COMMANDS[kind]` whole, and an unknown extra field on a durable record
 * must not be a reason to refuse it.
 */
const legacyRow = (over: Partial<LegacyWrittenRecord>): LegacyWrittenRecord =>
  ({
    mutationId: 'm-rename',
    command: {
      name: 'sessions.rename',
      version: 1,
      delivery: 'offline-eligible',
      confirmation: 'none',
    },
    input: { sessionId: 's1', name: 'renamed on the train' },
    partitionKey: 'client-outbox',
    attribution: { actor: { kind: 'user', id: PRINCIPAL }, onBehalfOf: PRINCIPAL },
    state: 'queued',
    queuedAt: 1_000,
    attempts: 0,
    clientBaseline: 'rev-7',
    clientChained: true,
    ...over,
  }) as LegacyWrittenRecord

/** Now, pinned: D10 measures the age horizon from `queuedAt`, so a real clock
 *  would decide whether these fixtures are adopted or expired by what day it is. */
const NOW = 5_000

function recordingApi(): { api: PodiumClientApi; renames: unknown[] } {
  const renames: unknown[] = []
  const api = {
    sessions: {
      rename: {
        mutate: async (input: unknown) => {
          renames.push(input)
          return {}
        },
      },
    },
  }
  return { api: api as unknown as PodiumClientApi, renames }
}

async function openOver(
  records: readonly LegacyWrittenRecord[],
  api: PodiumClientApi,
): Promise<EngineOutbox> {
  const create = await openKernelEngineOutbox({
    store: new InMemoryOutboxStore(records),
    principal: PRINCIPAL,
    api,
    onDegraded: (detail) => {
      throw detail instanceof Error ? detail : new Error(String(detail))
    },
    now: () => NOW,
  })
  return create({
    api,
    replica: {
      outboxStorage: memoryStorage,
      outboxAwaitingStorage: memoryStorage,
      outboxDeadLetterStorage: memoryStorage,
    } as unknown as Replica,
    notices: { error: () => {}, info: () => {}, warn: () => {} } as unknown as StoreNotices,
    isOnline: () => true,
  })
}

describe('a row written by the OLD mobile driver is adopted by the NEW one', () => {
  it('drains it — the intent reaches the server, with its input intact', async () => {
    const { api, renames } = recordingApi()
    const outbox = await openOver([legacyRow({})], api)

    // Visible BEFORE anything is drained: an adopted row is pending work, not a
    // dead letter and not an absence. Asserting the drain alone would pass on a
    // queue that had parked it and then re-sent it from recovery.
    expect(outbox.pending().map((entry) => entry.mutationId)).toEqual(['m-rename'])
    expect(outbox.deadLetters()).toEqual([])

    await outbox.drain()

    expect(renames).toEqual([
      { sessionId: 's1', name: 'renamed on the train', mutationId: 'm-rename' },
    ])
    expect(outbox.pending()).toEqual([])
    outbox.dispose()
  })

  it('reads its contract from the record, not from a guess', async () => {
    // The kind is recovered by inverting the contract table on the stored dotted
    // NAME. A driver that re-derived it from anything else — the input's shape,
    // an enqueue-time memo — would have nothing to work with here, because this
    // row was authored by a process that exited months ago.
    const { api } = recordingApi()
    const outbox = await openOver([legacyRow({})], api)
    expect(outbox.pending()[0]?.kind).toBe('rename')
    expect(outbox.pending()[0]?.input).toEqual({ sessionId: 's1', name: 'renamed on the train' })
    outbox.dispose()
  })

  it('re-sends a row the old driver had marked awaiting-truth', async () => {
    // `accepted` is what the old views wrote for their `awaiting-truth` stage.
    // On open the kernel returns it to `queued` (D9 invariant 4: a send that
    // never reported back is a transport failure), which is a RE-SEND — safe
    // only because the `mutationId` is unchanged and the Authority dedupes on
    // it. The alternative is worse: an entry stuck in a stage no driver owns.
    const { api, renames } = recordingApi()
    const outbox = await openOver([legacyRow({ state: 'accepted', clientResolvedAt: 1_500 })], api)

    expect(outbox.pending().map((entry) => entry.mutationId)).toEqual(['m-rename'])
    await outbox.drain()
    expect(renames).toHaveLength(1)
    expect((renames[0] as { mutationId: string }).mutationId).toBe('m-rename')
    outbox.dispose()
  })

  it('leaves ANOTHER principal untouched — visible to nobody here, dropped by nobody either', async () => {
    // A shared device. The old writer stamped attribution from the authenticated
    // principal, so a second account's rows sit in the same file; this instance
    // is bound to one of them and must neither drain nor delete the other's
    // unsent work.
    const { api, renames } = recordingApi()
    const outbox = await openOver(
      [
        legacyRow({}),
        legacyRow({
          mutationId: asMutationId('m-theirs'),
          attribution: {
            actor: { kind: 'user', id: asUserId('user-2') },
            onBehalfOf: asUserId('user-2'),
          },
        }),
      ],
      api,
    )

    expect(outbox.pending().map((entry) => entry.mutationId)).toEqual(['m-rename'])
    await outbox.drain()
    expect(renames).toHaveLength(1)
    outbox.dispose()
  })

  it('expires one the phone has been carrying too long, into RECOVERY rather than a retry', async () => {
    // The behaviour the compatibility driver did not have at all, arriving here
    // for the first time on mobile: D10's age horizon. A fortnight-old write is
    // past the Authority's receipt retention, so re-sending it is unsafe; it is
    // parked with its input intact instead, which is what makes the loss
    // something a person can act on rather than something they discover.
    const { api, renames } = recordingApi()
    const aged = legacyRow({ queuedAt: NOW - 15 * 24 * 60 * 60 * 1_000 })
    const outbox = await openOver([aged], api)

    expect(outbox.pending()).toEqual([])
    expect(outbox.deadLetters().map((parked) => parked.entry.mutationId)).toEqual(['m-rename'])
    // The authored text SURVIVES the expiry — recovery is only possible if it does.
    expect(outbox.deadLetters()[0]?.entry.input).toEqual({
      sessionId: 's1',
      name: 'renamed on the train',
    })
    await outbox.drain()
    expect(renames).toEqual([])
    outbox.dispose()
  })
})
