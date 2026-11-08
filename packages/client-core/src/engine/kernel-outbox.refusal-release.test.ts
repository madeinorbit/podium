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

import { asIssueId, asMutationId, asSessionId, asUserId, issueUserStateRowId } from '@podium/model'
import { SyncSubmitRefusedError } from '@podium/protocol'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry, OutboxStorage } from '../outbox'
import type { Replica } from '../replica/contract'
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

describe('server refusal explanations', () => {
  it.each([
    'kernel',
    'executor',
  ] as const)('keeps the message and paths in the toast and durable recovery entry through the %s', async (path) => {
    const refusal = {
      kind: 'invalid' as const,
      message: 'Choose a machine before starting the task.',
      details: ['input.machineId'],
    }
    const api = {
      sync: {
        submit: {
          mutate: vi.fn(async () => {
            if (path === 'executor') throw new SyncSubmitRefusedError('effects.create', refusal)
            return { outcome: 'rejected', refusal }
          }),
        },
      },
    } as unknown as PodiumClientApi
    const { outbox, errors } = await open(api)
    try {
      await outbox.enqueue('effectCreate', {
        id: 'eff_00000000-0000-4000-8000-000000000001',
        kind: 'issue.begin',
        target: { kind: 'issue', id: 'iss_task' },
        input: { text: 'Keep my task instructions.' },
      })
      await vi.waitFor(() => expect(outbox.deadLetters()).toHaveLength(1))
      expect(outbox.deadLetters()[0]?.reason).toEqual({
        code: 'invalid',
        message: refusal.message,
        details: refusal.details,
      })
      expect(errors).toEqual([
        'Couldn’t start the task — Choose a machine before starting the task.',
      ])
    } finally {
      outbox.dispose()
    }
  })

  it('explains a refused Start even when no prose is parked', async () => {
    const api = {
      sync: {
        submit: {
          mutate: async () => ({
            outcome: 'rejected',
            refusal: { kind: 'conflict', message: 'This task is already starting.' },
          }),
        },
      },
    } as unknown as PodiumClientApi
    const { outbox, errors } = await open(api)
    try {
      await outbox.enqueue('effectCreate', {
        id: 'eff_00000000-0000-4000-8000-000000000001',
        kind: 'issue.begin',
        target: { kind: 'issue', id: 'iss_task' },
        input: { sessionId: 's-1' },
      })
      await vi.waitFor(() =>
        expect(errors).toEqual(['Couldn’t start the task — This task is already starting.']),
      )
      expect(outbox.deadLetters()).toEqual([])
    } finally {
      outbox.dispose()
    }
  })
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
    // A read mark is a record edit (POD-6404); this server has no sync.submit,
    // so it goes out as the old `issues.markRead`.
    await outbox.enqueue('recordEdit', {
      kind: 'issueUserState',
      id: issueUserStateRowId(asUserId('u-reader'), asIssueId('iss_90f8')),
      patch: { readAt: '2026-11-05T00:00:00.000Z' },
    })
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

describe('a refused task base branch (POD-2153)', () => {
  // The task page awaits only the enqueue: a server refusal arrives later, here.
  it('surfaces as the outbox recovery notice naming the branch change', async () => {
    const refused = (): Error =>
      Object.assign(new Error("Branch 'nope' does not exist"), {
        data: { code: 'BAD_REQUEST', httpStatus: 400 },
      })
    const { api } = authority(() => refused())
    const { outbox, errors } = await open(api)
    await outbox.enqueue('issueUpdate', { id: 'iss_2153', patch: { parentBranch: 'nope' } })
    await vi.waitFor(() =>
      expect(errors).toEqual(["Couldn’t save issue branch — Branch 'nope' does not exist"]),
    )
    outbox.dispose()
  })
})
