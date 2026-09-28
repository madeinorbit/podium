/**
 * A CHAT SEND'S OUTBOX ID IS ITS MESSAGE ID (POD-4763).
 *
 * The server stores a chat message under the send's mutationId and the daemon
 * types it under the same id, so the server checks it has a message id's shape.
 * Every id this queue mints for a chat send must therefore be one — including
 * the NEW id an edited dead letter goes out under — or the send would be refused
 * at the boundary it exists to cross.
 */

import { asSessionId, MessageId } from '@podium/model'
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function memoryStorage(): OutboxStorage {
  let entries: OutboxEntry[] = []
  return {
    load: () => entries,
    save: (next) => {
      entries = [...next]
    },
  }
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

/** Refuses every send with a rights denial, which parks it for the user. */
function refusingAuthority(): { api: PodiumClientApi; sends: string[] } {
  const sends: string[] = []
  const deny = async (input: { mutationId: string }) => {
    sends.push(input.mutationId)
    throw Object.assign(new Error('forbidden'), { data: { code: 'FORBIDDEN', httpStatus: 403 } })
  }
  const api = { sessions: { resumeAndSend: { mutate: deny }, setArchived: { mutate: deny } } }
  return { api: api as unknown as PodiumClientApi, sends }
}

describe('chat sends get message ids from the outbox', () => {
  it('mints a message id for a chat send and a plain UUID for anything else', async () => {
    const outbox = await open(refusingAuthority().api)
    const chat = await outbox.enqueue('resumeAndSend', { sessionId: asSessionId('s1'), text: 'hi' })
    const other = await outbox.enqueue('setArchived', {
      sessionId: asSessionId('s1'),
      archived: true,
    })

    expect(MessageId.safeParse(chat.mutationId).success).toBe(true)
    expect(other.mutationId).toMatch(UUID)
    outbox.dispose()
  })

  it('an edited dead-lettered chat send goes out under a NEW message id', async () => {
    const { api, sends } = refusingAuthority()
    const outbox = await open(api)
    const first = await outbox.enqueue('resumeAndSend', {
      sessionId: asSessionId('s1'),
      text: 'hi',
    })
    online = true
    await outbox.drain()
    expect(outbox.deadLetters().map((parked) => parked.entry.mutationId)).toEqual([
      first.mutationId,
    ])

    await outbox.edit(first.mutationId, { sessionId: asSessionId('s1'), text: 'hi again' })
    await outbox.drain()

    const edited = sends.at(-1)
    expect(edited).not.toBe(first.mutationId)
    expect(MessageId.safeParse(edited).success).toBe(true)
    outbox.dispose()
  })
})
