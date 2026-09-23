/**
 * A SEND THE OPERATOR STOPPED BEFORE IT ARRIVED (POD-4654).
 *
 * The phone sends through this queue, and its Stop is a direct
 * `sessions.interrupt` naming the queued send's id. A Stop pressed at once
 * reaches the server first, and the server reserves that id so the late send
 * replays "interaction interrupted" instead of starting the stopped work. That
 * reply is the Stop taking effect, not a refusal someone must review: parking
 * it stops the session's partition, and every later message to the session
 * sits in the queue for good ("N changes are queued" while connected).
 */

import { asMutationId, STOPPED_SEND_REASON } from '@podium/model'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { describe, expect, it } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry, OutboxStorage } from '../outbox'
import type { Replica } from '../replica/replica'
import { openKernelEngineOutbox } from './kernel-outbox'
import type { StoreNotices } from './types'
import type { EngineOutbox } from './wiring'

const PRINCIPAL = 'user-1'
const NOW = 5_000

function memoryStorage(): OutboxStorage {
  let entries: OutboxEntry[] = []
  return {
    load: () => entries,
    save: (next) => {
      entries = [...next]
    },
  }
}

/** The authority as the stop left it: the stopped id replays `refusal`, any
 *  other send is delivered. */
function authority(refusal: { ok: false; reason: string; disposition: string }): {
  api: PodiumClientApi
  sends: string[]
} {
  const sends: string[] = []
  const api = {
    sessions: {
      resumeAndSend: {
        mutate: async (input: { mutationId: string }) => {
          sends.push(input.mutationId)
          return input.mutationId === 'msg_stopped'
            ? { ...refusal }
            : { ok: true, disposition: 'delivered' }
        },
      },
    },
  }
  return { api: api as unknown as PodiumClientApi, sends }
}

/** Offline while the two sends queue, so they drain in one pass, in order. */
let online = false

async function open(api: PodiumClientApi): Promise<EngineOutbox> {
  online = false
  const create = await openKernelEngineOutbox({
    store: new InMemoryOutboxStore([]),
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
    isOnline: () => online,
  })
}

async function sendTwo(outbox: EngineOutbox): Promise<void> {
  await outbox.enqueue(
    'resumeAndSend',
    { sessionId: 's1', text: 'Write the numbers from 1 to 400' },
    { mutationId: asMutationId('msg_stopped') },
  )
  await outbox.enqueue(
    'resumeAndSend',
    { sessionId: 's1', text: 'What is 3 times 3?' },
    { mutationId: asMutationId('msg_next') },
  )
  online = true
  await outbox.drain()
}

describe('a send stopped before it reached the server', () => {
  it('resolves, and the next message to the same session goes out', async () => {
    const { api, sends } = authority({
      ok: false,
      reason: STOPPED_SEND_REASON,
      disposition: 'dead_letter',
    })
    const outbox = await open(api)

    await sendTwo(outbox)

    expect(sends).toEqual(['msg_stopped', 'msg_next'])
    expect(outbox.pending()).toEqual([])
    expect(outbox.deadLetters()).toEqual([])
    outbox.dispose()
  })

  it('any OTHER refused send still parks for recovery and holds the session behind it', async () => {
    // The control arm: only the stop's own reply is a resolution. A send the
    // server refused for a reason the operator did not choose keeps its words
    // recoverable, and ordering on the session is kept by waiting behind it.
    const { api, sends } = authority({
      ok: false,
      reason: 'session archived',
      disposition: 'dead_letter',
    })
    const outbox = await open(api)

    await sendTwo(outbox)

    expect(sends).toEqual(['msg_stopped'])
    expect(outbox.deadLetters().map((parked) => parked.entry.mutationId)).toEqual(['msg_stopped'])
    expect(outbox.pending().map((entry) => entry.mutationId)).toEqual(['msg_next'])
    outbox.dispose()
  })
})
