/**
 * A TERMINAL VERDICT THAT DOES NOT REACH DURABILITY MUST NOT REPLAY ON RELOAD (this issue).
 *
 * The phone queues a send offline, the session is deleted, the phone comes back.
 * The drain POSTs `sessions.resumeAndSend`, the server answers "dead-lettered:
 * session no longer exists", the operator is told the message was not sent.
 * That verdict retires in its own commit (POD-4690) — applied, then retired —
 * so no later drain can re-read the entry and POST it again.
 *
 * What POD-4690 did not cover is the commit itself failing to reach the store.
 * Under memory pressure a durable write can abort (IndexedDB transaction abort,
 * quota) after the verdict was already reported: the notice showed, the mirror
 * reads empty, but the file still holds `sending`. A screen change that reloads
 * the persisted outbox (a full reload on navigation, a remount) reconciles that
 * `sending` back to `queued` and POSTs the dead message again — a second
 * dead-letter reply — behind a "1 change is queued" banner. An exact repeat.
 *
 * The fix is twofold, and both halves are in this file's scope:
 *
 * - the kernel requeues a verdict commit that did not land (like a transport
 *   failure: back to `queued` with backoff) instead of getting stuck in
 *   `sending` until a reload replays it. The retry re-POSTs the same id; the
 *   server dedupes it by receipt (ADR 3 D11.7) without re-running, reports the
 *   same dead letter, and the second retire lands. One extra POST on the wire,
 *   harmless server-side, and no reload replay.
 * - the engine announces the "session no longer exists" notice strictly AFTER
 *   the verdict commit lands, never on the reply. Announcing on the reply
 *   teaches the operator the entry is resolved while a reload can still
 *   resurrect it; announcing after durability means navigating away on the
 *   notice can never race the commit it announces. A commit that never lands
 *   announces nothing — the retry announces on its own landing instead, still
 *   once per id per session.
 *
 * The test runs the live flow with a store that drops the verdict commit once:
 * offline enqueue, online drain (no notice yet — the commit did not land),
 * clock past backoff, same-session retry (second POST, retires, one notice),
 * remount from the same persisted store (no third POST, no banner, no second
 * notice).
 */

import { asMutationId, asSessionId, UNADDRESSABLE_SEND_REASON } from '@podium/model'
import { InMemoryOutboxStore, ManualClock } from '@podium/sync/outbox'
import { describe, expect, it } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry, OutboxStorage } from '../outbox'
import type { Replica } from '../replica/replica'
import { openKernelEngineOutbox } from './kernel-outbox'
import type { StoreNotices } from './types'
import type { EngineOutbox } from './wiring'

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

/** The authority after `s-gone` was deleted: every send to it dead-letters. */
function authority(): { api: PodiumClientApi; sends: string[] } {
  const sends: string[] = []
  const api = {
    sessions: {
      resumeAndSend: {
        mutate: async (input: { mutationId: string }) => {
          sends.push(input.mutationId)
          return {
            ok: false,
            reason: UNADDRESSABLE_SEND_REASON,
            disposition: 'dead_letter',
          }
        },
      },
    },
  }
  return { api: api as unknown as PodiumClientApi, sends }
}

/** A store that drops the Nth apply call once (transient durability failure). */
function failingStore(inner: InMemoryOutboxStore, failAtCall: number): InMemoryOutboxStore {
  let calls = 0
  let failed = false
  const orig = inner.apply.bind(inner)
  inner.apply = (async (mutation: never, span?: never) => {
    calls += 1
    if (!failed && calls === failAtCall) {
      failed = true
      throw new Error('transient durability failure (IDB abort under pressure)')
    }
    return await orig(mutation as never, span as never)
  }) as typeof inner.apply
  return inner
}

async function openEngine(
  store: InMemoryOutboxStore,
  api: PodiumClientApi,
  clock: ManualClock,
  online: () => boolean,
  errors: string[],
): Promise<EngineOutbox> {
  const create = await openKernelEngineOutbox({
    store,
    principal: PRINCIPAL,
    api,
    onDegraded: (detail) => {
      throw detail instanceof Error ? detail : new Error(String(detail))
    },
    now: clock.now,
  })
  return create({
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
    isOnline: online,
  })
}

describe('a dead-letter verdict that does not reach durability', () => {
  it('retries in the same session and never replays on remount: one notice, no banner (this issue)', async () => {
    // Call 1: enqueue put queued. Call 2: drain-started put sending. Call 3:
    // the verdict commit (applied + retired in one draft) is dropped once.
    const store = failingStore(new InMemoryOutboxStore([]), 3)
    const clock = new ManualClock()
    const { api, sends } = authority()
    let online = false
    const errors: string[] = []

    const first = await openEngine(store, api, clock, () => online, errors)
    await first.enqueue(
      'resumeAndSend',
      { sessionId: asSessionId('s-gone'), text: 'What is 3 times 3?' },
      { mutationId: asMutationId('msg_gone') },
    )
    online = true
    await first.drain()

    // The verdict was reported by the server but its commit did not land: the
    // entry is requeued with backoff, not stuck in `sending` until a reload
    // replays it — and nothing is announced yet, because announcing on the
    // reply would teach the operator the entry is resolved while a reload can
    // still resurrect it. One announcement, on the landing retry below.
    expect(errors).toEqual([])
    expect(first.pending().map((entry) => entry.mutationId)).toEqual(['msg_gone'])
    expect(first.size()).toBe(1)

    // Past backoff, the same session retries: the same id POSTs again (the
    // server dedupes it by receipt without re-running), the retire lands, and
    // the landing announces the verdict — once, not twice.
    clock.advance(60_000)
    await first.drain()
    expect(sends).toEqual(['msg_gone', 'msg_gone'])
    expect(errors).toEqual([expect.stringMatching(/not sent.*session no longer exists/i)])
    expect(first.pending()).toEqual([])
    expect(first.size()).toBe(0)
    expect(first.deadLetters()).toEqual([])
    first.dispose()

    // A screen change that reloads the persisted outbox — a remount from the
    // same store — sends nothing again and shows no banner and no second
    // notice. This is the live symptom: a second POST plus "1 change is
    // queued" on navigating to /mobile/work.
    const remountErrors: string[] = []
    const second = await openEngine(store, api, clock, () => true, remountErrors)
    ;(second as unknown as { attach?: () => void }).attach?.()
    expect(second.pending()).toEqual([])
    expect(second.size()).toBe(0)
    await second.drain()
    expect(sends).toEqual(['msg_gone', 'msg_gone'])
    expect(second.pending()).toEqual([])
    expect(second.size()).toBe(0)
    expect(remountErrors).toEqual([])
    second.dispose()
  })
})
