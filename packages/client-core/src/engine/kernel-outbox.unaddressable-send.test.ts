/**
 * A SEND THAT REACHES THE SERVER AFTER ITS SESSION WAS DELETED (POD-4660).
 *
 * The phone queues its sends, so a message can still be on its way when the
 * session it names is deleted. The server answers that send "dead-lettered:
 * session no longer exists". There is nothing to recover: no session is left
 * to deliver it to, and a retry can only get the same answer. Parked, it would
 * stop the session's partition, and the phone would show "N changes queued"
 * for good — the same wedge an early Stop's reply caused (POD-4654). So the
 * entry resolves, and the operator is told the message was not sent and why.
 */

import { asMutationId, asSessionId, UNADDRESSABLE_SEND_REASON } from '@podium/model'
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

/** The authority after `s-gone` was deleted: its FIRST send is answered with
 *  `refusal`, and every other send is delivered. */
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
          return input.mutationId === 'msg_gone'
            ? { ...refusal }
            : { ok: true, disposition: 'delivered' }
        },
      },
    },
  }
  return { api: api as unknown as PodiumClientApi, sends }
}

let online = false

async function open(api: PodiumClientApi): Promise<{ outbox: EngineOutbox; errors: string[] }> {
  online = false
  const errors: string[] = []
  const create = await openKernelEngineOutbox({
    store: new InMemoryOutboxStore([]),
    principal: PRINCIPAL,
    api,
    onDegraded: (detail) => {
      throw detail instanceof Error ? detail : new Error(String(detail))
    },
    now: () => NOW,
  })
  const outbox = create({
    api,
    replica: {
      outboxStorage: memoryStorage,
      outboxAwaitingStorage: memoryStorage,
      outboxDeadLetterStorage: memoryStorage,
    } as unknown as Replica,
    notices: {
      error: (message: string) => errors.push(message),
      info: () => {},
    } as unknown as StoreNotices,
    isOnline: () => online,
  })
  return { outbox, errors }
}

/** Queued offline, drained in one pass: the send to the deleted session first,
 *  then one more to it and one to a live session. */
async function sendThree(outbox: EngineOutbox): Promise<void> {
  await outbox.enqueue(
    'resumeAndSend',
    { sessionId: asSessionId('s-gone'), text: 'Write the numbers from 1 to 400' },
    { mutationId: asMutationId('msg_gone') },
  )
  await outbox.enqueue(
    'resumeAndSend',
    { sessionId: asSessionId('s-gone'), text: 'What is 3 times 3?' },
    { mutationId: asMutationId('msg_same_session') },
  )
  await outbox.enqueue(
    'resumeAndSend',
    { sessionId: asSessionId('s-live'), text: 'Summarise the diff' },
    { mutationId: asMutationId('msg_other_session') },
  )
  online = true
  await outbox.drain()
}

describe('a send to a session that no longer exists', () => {
  it('resolves, says the message was not sent, and nothing behind it waits', async () => {
    const { api, sends } = authority({
      ok: false,
      reason: UNADDRESSABLE_SEND_REASON,
      disposition: 'dead_letter',
    })
    const { outbox, errors } = await open(api)

    await sendThree(outbox)

    expect([...sends].sort()).toEqual(['msg_gone', 'msg_other_session', 'msg_same_session'])
    expect(outbox.pending()).toEqual([])
    expect(outbox.deadLetters()).toEqual([])
    expect(errors).toEqual([expect.stringMatching(/not sent.*session no longer exists/i)])
    outbox.dispose()
  })

  it('any OTHER refused send still parks for recovery and holds the session behind it', async () => {
    // The control arm: only the "session is gone" reply resolves. A send
    // refused for a reason the operator can still act on keeps its words
    // recoverable, and ordering on that session is kept by waiting behind it.
    const { api, sends } = authority({
      ok: false,
      reason: 'session archived',
      disposition: 'dead_letter',
    })
    const { outbox, errors } = await open(api)

    await sendThree(outbox)

    expect([...sends].sort()).toEqual(['msg_gone', 'msg_other_session'])
    expect(outbox.deadLetters().map((parked) => parked.entry.mutationId)).toEqual(['msg_gone'])
    expect(outbox.pending().map((entry) => entry.mutationId)).toEqual(['msg_same_session'])
    expect(errors).not.toContainEqual(expect.stringMatching(/session no longer exists/i))
    outbox.dispose()
  })
})
