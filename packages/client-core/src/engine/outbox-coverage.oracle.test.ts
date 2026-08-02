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
 * SESSION writes plus three issue writes and five replicated per-user writes.
 * Only live interaction (`sendText`, `ask`, and `uploadImage`) remains a
 * deliberate direct-only exclusion: replaying chat, a seance, or an image
 * upload hours later is worse than an immediate failure.
 *
 * Every characterization here is tagged must-not-change: the covered set is a
 * product decision the migration must carry over verbatim, not a
 * single-user artefact. Per-user state (POD-1076) changes WHERE snooze/read
 * rows live, not whether the write queues offline.
 */

import type { SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { PodiumClientApi } from '../api'
import { createOutbox, type OutboxEntry, type OutboxStorage } from '../outbox'
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
      // Present so that a MUTANT executor for these kinds RESOLVES and the
      // exclusion assertion fails sharply. Without them the executor throws a
      // retryable TypeError and the drain loop spins forever — a hang, which
      // tells the next reader nothing about what changed.
      ask: proc('sessions.ask'),
      uploadImage: proc('sessions.uploadImage'),
    },
    snoozes: { set: proc('snoozes.set'), clear: proc('snoozes.clear') },
    pins: { set: proc('pins.set') },
    tabs: { setOrder: proc('tabs.setOrder') },
    settings: { updatePersonal: proc('settings.updatePersonal') },
    layout: { set: proc('layout.set'), clear: proc('layout.clear') },
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
    outboxDeadLetterStorage: () => memoryStorage(),
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

/**
 * Drain to empty, but BOUNDED. `while (size > 0)` retries a failing executor
 * forever, so a harness fault (a missing fake procedure, a thrown TypeError)
 * shows up as a 20s process timeout instead of an assertion. A stall says a test
 * noticed something; it never says what.
 */
async function drainFully(outbox: { size(): number; drain(): Promise<void> }): Promise<void> {
  for (let pass = 0; pass < 20 && outbox.size() > 0; pass += 1) await outbox.drain()
  if (outbox.size() > 0) {
    throw new Error(`outbox did not drain after 20 passes — ${outbox.size()} entries stuck`)
  }
}

/** The covered set, as the engine enqueues it (engine.ts session/issue actions). */
const COVERED: { kind: keyof OutboxKinds & string; input: object; path: string }[] = [
  { kind: 'pinSet', input: { kind: 'panel', id: 's1', pinned: true }, path: 'pins.set' },
  { kind: 'tabSetOrder', input: { worktree: '/w', sessionIds: ['s1'] }, path: 'tabs.setOrder' },
  { kind: 'layoutSet', input: { values: { superOpen: '0' } }, path: 'layout.set' },
  { kind: 'layoutClear', input: { keys: ['superOpen'] }, path: 'layout.clear' },
  {
    kind: 'settingsUpdatePersonal',
    input: { values: { 'sidebar.repoSort': 'name' } },
    path: 'settings.updatePersonal',
  },
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
  it(`${MUST_NOT_CHANGE}: eight session writes, three issue writes, and five replicated per-user writes drain to their tRPC procedures — offline queueing is not issue-only`, async () => {
    const { outbox, calls } = makeOutbox()

    for (const covered of COVERED) {
      outbox.enqueue(covered.kind, covered.input as OutboxKinds[typeof covered.kind])
    }
    await drainFully(outbox)

    expect(calls.map((c) => c.path)).toEqual(COVERED.map((c) => c.path))
    expect(
      calls.filter((c) => c.path.startsWith('sessions.') || c.path.startsWith('snooze')),
    ).toHaveLength(8)
    outbox.dispose()
  })

  it(`${MUST_NOT_CHANGE}: each replay carries the entry's STABLE mutationId, which is what the server dedupes on`, async () => {
    const { outbox, calls } = makeOutbox()

    const entry = outbox.enqueue('rename', { sessionId: asSessionId('s1'), name: 'queued offline' })
    await outbox.drain()

    expect(calls).toEqual([
      {
        path: 'sessions.rename',
        input: { sessionId: 's1', name: 'queued offline', mutationId: entry.mutationId },
      },
    ])
    outbox.dispose()
  })

  it(`${MUST_NOT_CHANGE}: sendText, ask and uploadImage are NOT offline-capable — an entry for them is never sent, and PARKS for recovery rather than being dropped`, async () => {
    const { outbox, calls, poisoned, errors } = makeOutbox()

    // The full direct-only exclusion set. `ask` and `uploadImage` are here so
    // that ADDING an executor for either to createEngineOutbox — which would
    // make a seance or an image upload survive an offline gap, a real behaviour
    // change — turns this oracle red instead of passing silently.
    for (const uncovered of ['sendText', 'ask', 'uploadImage']) {
      // Deliberately outside OutboxKinds: this is the assertion that the kind
      // has no executor, i.e. that the write stays direct-to-server.
      outbox.enqueue(
        uncovered as keyof OutboxKinds & string,
        {
          sessionId: 's1',
        } as OutboxKinds[keyof OutboxKinds],
      )
    }
    await drainFully(outbox)

    expect(calls).toEqual([])
    expect(poisoned.map((e) => e.kind)).toEqual(['sendText', 'ask', 'uploadImage'])
    // The user is TOLD, per kind — a refused write is never silent.
    expect(errors).toHaveLength(3)
    // DELIBERATE CHANGE OF DISPOSAL (POD-316). The oracle's intent — these kinds
    // never reach the server — is unchanged and still asserted above
    // (`calls` is empty). What changed is what happens to the entry afterwards:
    // it used to be shift()ed away, which is the silent poison-drop ADR 3 D9
    // invariant 1 forbids. It now parks, and this assertion is what stops a
    // future edit quietly restoring the drop while the name above still reads
    // "never sent".
    expect(outbox.deadLetters().map((d) => d.entry.kind)).toEqual([
      'sendText',
      'ask',
      'uploadImage',
    ])
    outbox.dispose()
  })

  it(`${MUST_NOT_CHANGE}: the exclusion assertion discriminates on EXECUTOR PRESENCE — the same kind drains when an executor exists`, async () => {
    // Guards the guard. The exclusion test above proves ask/uploadImage are
    // poison-dropped today, and the real product mutant (adding an executor to
    // createEngineOutbox) reds it. This keeps the two arms honest independently:
    // the fake api now exposes ask/uploadImage procedures so a mutant resolves
    // rather than hanging, and this test proves a resolving executor really does
    // change poison-drop into drain — i.e. that the exclusion assertion turns on
    // executor presence and not on some incidental property of the harness.
    const sent: unknown[] = []
    const dropped: string[] = []
    const withExecutor = createOutbox<{ ask: { sessionId: SessionId } }>({
      storage: memoryStorage(),
      awaitingStorage: memoryStorage(),
      executors: {
        ask: async (input) => {
          sent.push(input)
        },
      },
      onPoison: (entry) => dropped.push(entry.kind),
    })

    withExecutor.enqueue('ask', { sessionId: asSessionId('s1') })
    await drainFully(withExecutor)

    expect(sent).toHaveLength(1)
    expect(dropped).toEqual([])
    withExecutor.dispose()
  })

  it(`${MUST_NOT_CHANGE}: queued writes drain in FIFO order, so two edits to one row compose in the order they were made`, async () => {
    const { outbox, calls } = makeOutbox()

    outbox.enqueue('rename', { sessionId: asSessionId('s1'), name: 'first' })
    outbox.enqueue('setArchived', { sessionId: asSessionId('s1'), archived: true })
    await outbox.drain()

    expect(calls.map((c) => c.path)).toEqual(['sessions.rename', 'sessions.setArchived'])
    expect(outbox.size()).toBe(0)
    outbox.dispose()
  })
})
