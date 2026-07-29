/**
 * ORACLE — which session writes are OFFLINE-QUEUED (POD-379 for POD-312).
 *
 * The server half of the oracle lives in
 * apps/server/src/modules/sessions/oracle-idempotency.test.ts (mutationId
 * dedup, which is what makes a replay safe). This file pins the CLIENT half:
 * exactly which mutations survive an offline gap, and — just as load-bearing
 * for the migration — which ones deliberately do not.
 *
 * Recorded here because the issue brief says "offline queueing is issue-writes
 * only today", and that is not what the code does: the covered set spans eight
 * SESSION writes plus three issue writes. Pins, tab order and sendText are the
 * deliberate exclusions (`createEngineOutbox`'s docstring: pins/tab-orders are
 * low offline value; live chat must fail fast rather than silently queue).
 *
 * Every characterization here is tagged must-not-change: the covered set is a
 * product decision the migration must carry over verbatim, not a
 * single-user artefact. Per-user state (POD-1076) changes WHERE snooze/read
 * rows live, not whether the write queues offline.
 */

import { describe, expect, it } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry, OutboxStorage } from '../outbox'
import type { Replica } from '../replica/replica'
import type { StoreNotices } from './types'
import { createEngineOutbox, type OutboxKinds } from './wiring'

const MUST_NOT_CHANGE = 'must-not-change'

function memoryStorage(): OutboxStorage {
  let entries: OutboxEntry[] = []
  return {
    load: () => entries,
    save: (next) => {
      entries = [...next]
    },
  }
}

/** Records every api.<router>.<proc>.mutate call the outbox drains into. */
function recordingApi() {
  const calls: { path: string; input: Record<string, unknown> }[] = []
  const proc = (path: string) => ({
    mutate: async (input: Record<string, unknown>) => {
      calls.push({ path, input })
      return undefined
    },
  })
  const api = {
    sessions: {
      resumeAndSend: proc('sessions.resumeAndSend'),
      rename: proc('sessions.rename'),
      setArchived: proc('sessions.setArchived'),
      setWorkState: proc('sessions.setWorkState'),
      markRead: proc('sessions.markRead'),
      markUnread: proc('sessions.markUnread'),
      sendText: proc('sessions.sendText'),
    },
    snoozes: { set: proc('snoozes.set'), clear: proc('snoozes.clear') },
    pins: { set: proc('pins.set') },
    tabs: { setOrder: proc('tabs.setOrder') },
    issues: {
      markRead: proc('issues.markRead'),
      markUnread: proc('issues.markUnread'),
      setTucked: proc('issues.setTucked'),
    },
  } as unknown as PodiumClientApi
  return { api, calls }
}

function makeOutbox() {
  const { api, calls } = recordingApi()
  const poisoned: OutboxEntry[] = []
  const errors: string[] = []
  const replica = {
    outboxStorage: () => memoryStorage(),
    outboxAwaitingStorage: () => memoryStorage(),
  } as unknown as Replica
  const notices = {
    error: (message: string) => errors.push(message),
    info: () => {},
    warn: () => {},
  } as unknown as StoreNotices
  const outbox = createEngineOutbox({
    api,
    replica,
    notices,
    onDropped: (entry) => poisoned.push(entry),
  })
  return { outbox, calls, poisoned, errors }
}

/** The covered set, as the engine enqueues it (engine.ts session/issue actions). */
const COVERED: { kind: keyof OutboxKinds & string; input: object; path: string }[] = [
  { kind: 'rename', input: { sessionId: 's1', name: 'n' }, path: 'sessions.rename' },
  { kind: 'setArchived', input: { sessionId: 's1', archived: true }, path: 'sessions.setArchived' },
  {
    kind: 'setWorkState',
    input: { sessionId: 's1', workState: 'done' },
    path: 'sessions.setWorkState',
  },
  { kind: 'sessionMarkRead', input: { sessionId: 's1' }, path: 'sessions.markRead' },
  { kind: 'sessionMarkUnread', input: { sessionId: 's1' }, path: 'sessions.markUnread' },
  { kind: 'snoozeSet', input: { sessionId: 's1', until: null }, path: 'snoozes.set' },
  { kind: 'snoozeClear', input: { sessionId: 's1' }, path: 'snoozes.clear' },
  {
    kind: 'resumeAndSend',
    input: { sessionId: 's1', text: 'hi' },
    path: 'sessions.resumeAndSend',
  },
  { kind: 'issueMarkRead', input: { id: 'i1' }, path: 'issues.markRead' },
  { kind: 'issueMarkUnread', input: { id: 'i1' }, path: 'issues.markUnread' },
  { kind: 'issueSetTucked', input: { id: 'i1', tucked: true }, path: 'issues.setTucked' },
]

describe('oracle: the offline-queued write set', () => {
  it(`${MUST_NOT_CHANGE}: eight SESSION writes and three issue writes drain to their tRPC procedures — offline queueing is not issue-only`, async () => {
    const { outbox, calls } = makeOutbox()

    for (const covered of COVERED) {
      outbox.enqueue(covered.kind, covered.input as OutboxKinds[typeof covered.kind])
    }
    while (outbox.size() > 0) await outbox.drain()

    expect(calls.map((c) => c.path)).toEqual(COVERED.map((c) => c.path))
    expect(
      calls.filter((c) => c.path.startsWith('sessions.') || c.path.startsWith('snooze')),
    ).toHaveLength(8)
    outbox.dispose()
  })

  it(`${MUST_NOT_CHANGE}: each replay carries the entry's STABLE mutationId, which is what the server dedupes on`, async () => {
    const { outbox, calls } = makeOutbox()

    const entry = outbox.enqueue('rename', { sessionId: 's1', name: 'queued offline' })
    await outbox.drain()

    expect(calls).toEqual([
      {
        path: 'sessions.rename',
        input: { sessionId: 's1', name: 'queued offline', mutationId: entry.mutationId },
      },
    ])
    outbox.dispose()
  })

  it(`${MUST_NOT_CHANGE}: pins, tab order and sendText are NOT offline-capable — an entry for them is poison-dropped, never sent`, async () => {
    const { outbox, calls, poisoned, errors } = makeOutbox()

    for (const uncovered of ['pinSet', 'tabSetOrder', 'sendText']) {
      // Deliberately outside OutboxKinds: this is the assertion that the kind
      // has no executor, i.e. that the write stays direct-to-server.
      outbox.enqueue(
        uncovered as keyof OutboxKinds & string,
        {
          sessionId: 's1',
        } as OutboxKinds[keyof OutboxKinds],
      )
    }
    while (outbox.size() > 0) await outbox.drain()

    expect(calls).toEqual([])
    expect(poisoned.map((e) => e.kind)).toEqual(['pinSet', 'tabSetOrder', 'sendText'])
    // The user is TOLD, per kind — a dropped write is never silent.
    expect(errors).toHaveLength(3)
    outbox.dispose()
  })

  it(`${MUST_NOT_CHANGE}: queued writes drain in FIFO order, so two edits to one row compose in the order they were made`, async () => {
    const { outbox, calls } = makeOutbox()

    outbox.enqueue('rename', { sessionId: 's1', name: 'first' })
    outbox.enqueue('setArchived', { sessionId: 's1', archived: true })
    await outbox.drain()

    expect(calls.map((c) => c.path)).toEqual(['sessions.rename', 'sessions.setArchived'])
    expect(outbox.size()).toBe(0)
    outbox.dispose()
  })
})
