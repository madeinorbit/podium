/**
 * ONE REFUSAL RULE THROUGH THE APP'S QUEUE (POD-5430, ADR 3 amendment 2).
 *
 * The kernel tests pin R1 and R3 on the bare state machine. These drive the
 * adapter both composition roots open (`openKernelEngineOutbox`), with the real
 * executor table and the real park policy:
 *
 * - POD-5415's phone sequence: a refused rename parks with its text, and the
 *   read receipt and the next rename on the same issue send at once.
 * - A transition that releases a partition outside a drain pass (the user's
 *   discard, an expiry sweep) starts a drain, so what waited behind it does not
 *   wait for an unrelated trigger.
 */

import { asMutationId, asSessionId } from '@podium/model'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry, OutboxStorage } from '../outbox'
import type { Replica } from '../replica/replica'
import { openKernelEngineOutbox } from './kernel-outbox'
import type { StoreNotices } from './types'
import { CHAT_SEND_MAX_AGE_MS, type EngineOutbox } from './wiring'

const PRINCIPAL = 'user-1'

function memoryStorage(): OutboxStorage {
  let entries: OutboxEntry[] = []
  return {
    load: () => entries,
    save: (next) => {
      entries = [...next]
    },
  }
}

const conflict = (): Error =>
  Object.assign(new Error('issue changed under you'), {
    data: { code: 'CONFLICT', httpStatus: 409 },
  })

const unreachable = (): Error => new Error('fetch failed')

interface Sent {
  readonly command: string
  readonly mutationId: string
  readonly label: string
}

/** An authority whose answer per send the test decides. */
function authority(answer: (sent: Sent) => unknown | Promise<unknown>): {
  api: PodiumClientApi
  sends: Sent[]
} {
  const sends: Sent[] = []
  const call = (command: string, label: (input: Record<string, unknown>) => string) => ({
    mutate: async (input: Record<string, unknown> & { mutationId: string }) => {
      const sent = { command, mutationId: input.mutationId, label: label(input) }
      sends.push(sent)
      const result = await answer(sent)
      if (result instanceof Error) throw result
      return result
    },
  })
  const api = {
    issues: {
      update: call(
        'issues.update',
        (i) => `rename ${(i as { patch?: { title?: string } }).patch?.title}`,
      ),
      markRead: call('issues.markRead', () => 'read'),
    },
    sessions: {
      sendText: call('sessions.sendText', (i) => `chat ${(i as { text?: string }).text}`),
    },
  }
  return { api: api as unknown as PodiumClientApi, sends }
}

let online = true

async function open(
  api: PodiumClientApi,
  now: () => number = Date.now,
): Promise<{ outbox: EngineOutbox; errors: string[] }> {
  const errors: string[] = []
  const create = await openKernelEngineOutbox({
    store: new InMemoryOutboxStore([]),
    principal: PRINCIPAL,
    api,
    onDegraded: (detail) => {
      throw detail instanceof Error ? detail : new Error(String(detail))
    },
    now,
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
      warn: () => {},
    } as unknown as StoreNotices,
    isOnline: () => online,
  })
  return { outbox, errors }
}

afterEach(() => {
  online = true
  vi.useRealTimers()
})

describe("POD-5415's sequence through the app's queue", () => {
  it('parks the refused rename with its text and sends the read receipt and the next rename', async () => {
    const { api, sends } = authority((sent) =>
      sent.label === 'rename A' ? conflict() : { ok: true },
    )
    const { outbox } = await open(api)

    await outbox.enqueue(
      'issueUpdate',
      { id: 'iss_90f8', patch: { title: 'A' } },
      {
        mutationId: asMutationId('m-rename-a'),
      },
    )
    await vi.waitFor(() => expect(outbox.deadLetters()).toHaveLength(1))
    await outbox.enqueue('issueMarkRead', { id: 'iss_90f8' })
    await outbox.enqueue('issueUpdate', { id: 'iss_90f8', patch: { title: 'B' } })

    await vi.waitFor(() => expect(outbox.pending()).toEqual([]))
    expect(sends.map((s) => s.label)).toEqual(['rename A', 'read', 'rename B'])
    // "1 change needing review", nothing queued behind it.
    expect(outbox.size()).toBe(0)
    expect(outbox.deadLetters().map((d) => d.entry.mutationId)).toEqual([
      asMutationId('m-rename-a'),
    ])
    expect(outbox.deadLetters()[0]?.entry.input).toEqual({ id: 'iss_90f8', patch: { title: 'A' } })
    outbox.dispose()
  })
})

describe('a release outside a drain pass starts a drain', () => {
  it('drains what waited behind a backing-off head once the user discards it', async () => {
    const { api, sends } = authority((sent) =>
      sent.label === 'rename A' ? unreachable() : { ok: true },
    )
    online = false
    const { outbox } = await open(api)
    const head = await outbox.enqueue('issueUpdate', { id: 'iss_1', patch: { title: 'A' } })
    await outbox.enqueue('issueUpdate', { id: 'iss_1', patch: { title: 'B' } })
    online = true
    await outbox.drain()
    // The head failed transiently: its outcome is unknown, so B waits.
    expect(sends.map((s) => s.label)).toEqual(['rename A'])

    await outbox.discard(head.mutationId)

    await vi.waitFor(() => expect(sends.map((s) => s.label)).toEqual(['rename A', 'rename B']))
    outbox.dispose()
  })

  it('drains what waited behind a send the expiry sweep gave up on, before the next retry', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const { api, sends } = authority((sent) =>
      sent.label === 'chat first' ? unreachable() : { ok: true, disposition: 'delivered' },
    )
    const { outbox } = await open(api, () => Date.now())
    // The expiry timer runs only while the queue is attached to a mounted runtime.
    outbox.attach()
    await outbox.enqueue('sendText', { sessionId: asSessionId('s1'), text: 'first' })
    await vi.advanceTimersByTimeAsync(60_000)
    await outbox.enqueue('sendText', { sessionId: asSessionId('s1'), text: 'second' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sends.filter((s) => s.label === 'chat second')).toEqual([])

    // The first send's backoff retries land at 1, 3, 7, 15, 31, 63 and 123 s.
    // It gives up at 120 s; the sweep parks it, and that release must send
    // the second message now, not at the 123 s retry.
    await vi.advanceTimersByTimeAsync(CHAT_SEND_MAX_AGE_MS - 60_000 + 500)

    expect(sends.filter((s) => s.label === 'chat second')).toHaveLength(1)
    outbox.dispose()
  })
})
