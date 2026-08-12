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
 * SESSION writes plus TWELVE issue writes and five replicated per-user writes.
 * Only live interaction (`sendText`, `ask`, and `uploadImage`) remains a
 * deliberate direct-only exclusion: replaying chat, a seance, or an image
 * upload hours later is worse than an immediate failure.
 *
 * Every characterization here is tagged must-not-change: the covered set is a
 * product decision the migration must carry over verbatim, not a
 * single-user artefact. Per-user state (POD-1076) changes WHERE snooze/read
 * rows live, not whether the write queues offline.
 *
 * ---------------------------------------------------------------------------
 * THE ONE DELIBERATE EXTENSION (POD-781), recorded rather than merely made
 * ---------------------------------------------------------------------------
 *
 * The issue half of this set was THREE per-user markers (`markRead`,
 * `markUnread`, `setTucked`) and is now TWELVE: `issues.update`, `issues.archive`
 * and `issues.delete` joined them, then `issues.close`, `issues.defer`,
 * `issues.undefer` and `issues.setLabels`, and finally `issues.setPlacement` and
 * `issues.restore`. Every case here is tagged must-not-change ON PURPOSE, so
 * growing the set is a product decision and this paragraph is where it is taken.
 *
 * WHY. The sidebar's delete, dismiss and inline rename went straight to the
 * server and painted NOTHING until it answered — on a slow link the click read
 * as not having registered, which is the failure the outbox-as-overlay (#263)
 * exists to delete. The same was true of every other row edit the context menu
 * offers: the colour, the pin, close, snooze, unsnooze, stage, priority and
 * labels. The commands were already `offline-eligible` on ADR 1's `issueCore`
 * row, and idempotency was already framework-owned (`MutationLedgerPort.once`);
 * what was missing was the client half — and, for
 * `defer`/`undefer`/`setLabels`/`restore`/`setPlacement`, a `mutationId` on the
 * input to key the receipt on.
 *
 * THE LAST TWO ARE THE SAME DECISION SEEN FROM THE EDGES OF THE FAMILY.
 * `setPlacement` moves a row between missions — the operator's triage answer, and
 * as much a row edit as a stage change. `restore` is the UNDO of a write already
 * in this set, and leaving it out would have been the odd choice: an instant
 * delete whose undo waits on the network reads as the undo having failed. It
 * also buys the one collapse in the family that spares real work — a delete still
 * queued is cancelled by the restore rather than round-tripping out and back,
 * PTYs and all.
 *
 * WHY NOT THE WHOLE ISSUE SURFACE. What joined are the CURATION writes: edits to
 * a row the operator is looking at, whose effect is that row looking different.
 * `start`, `addSession`, `promote`, `duplicate` and the git-workflow commands did
 * not, and not for want of an overlay — they do work (spawn a process, move a
 * branch) whose result is not a field this client could paint, so queueing them
 * would promise an outcome the queue cannot deliver.
 *
 * WHAT DID NOT CHANGE, and must not: `sendText`, `ask` and `uploadImage` stay
 * OUT. Those exclusions are about REPLAY being wrong — a chat message sent
 * hours late is worse than a failure — and nothing about curating an issue row
 * argues for reopening them. The exclusion test below still pins all three.
 */

import type { SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { PodiumClientApi } from '../api'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { createOutbox, type OutboxEntry, type OutboxStorage } from '../outbox'
import type { Replica } from '../replica/replica'
import type { StoreNotices } from './types'
import { openKernelEngineOutbox } from './kernel-outbox'
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
      update: proc('issues.update'),
      archive: proc('issues.archive'),
      delete: proc('issues.delete'),
      close: proc('issues.close'),
      defer: proc('issues.defer'),
      undefer: proc('issues.undefer'),
      setLabels: proc('issues.setLabels'),
      setPlacement: proc('issues.setPlacement'),
      restore: proc('issues.restore'),
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
  // POD-781 — the curation writes. One generic patch kind plus the five commands
  // that are not `issues.update`; see the header for why the set grew.
  {
    kind: 'issueUpdate',
    input: { id: 'i1', patch: { title: 'renamed offline' } },
    path: 'issues.update',
  },
  { kind: 'issueArchive', input: { id: 'i1' }, path: 'issues.archive' },
  { kind: 'issueDelete', input: { id: 'i1' }, path: 'issues.delete' },
  { kind: 'issueClose', input: { id: 'i1', reason: 'done' }, path: 'issues.close' },
  { kind: 'issueDefer', input: { id: 'i1', until: null }, path: 'issues.defer' },
  { kind: 'issueUndefer', input: { id: 'i1' }, path: 'issues.undefer' },
  { kind: 'issueSetLabels', input: { id: 'i1', labels: ['bug'] }, path: 'issues.setLabels' },
  {
    kind: 'issueSetPlacement',
    input: { id: 'i1', placement: 'mission', originId: 'i2' },
    path: 'issues.setPlacement',
  },
  { kind: 'issueRestore', input: { id: 'i1' }, path: 'issues.restore' },
]

/**
 * THE KERNEL QUEUE IS THE ONE THE WEB APP RUNS (`apps/web/src/lib/kernelReplica.ts`
 * → `openKernelEngineOutbox`), and until POD-781 group 3 nothing in the repo
 * drove it. Everything above this line exercises the COMPATIBILITY queue, and
 * the two used to name their procedures in two hand-written tables: this one as
 * a `switch` over dotted command names that stopped at `issues.setTucked`. Seven
 * curation commands were queued, routed, overlaid and unit-tested, and every one
 * of them fell through to the switch's BAD_REQUEST — a definitive refusal — so
 * the optimistic row painted and then snapped back. Found by driving a drag in a
 * real browser, not by any test here.
 *
 * The tables are one table now (`outboxExecutors`). This walks the covered set
 * through the kernel adapter so the claim is checked on the queue that ships,
 * rather than on the one that happened to be easy to construct.
 */
describe('oracle: the KERNEL queue delivers the same covered set', () => {
  it(`${MUST_NOT_CHANGE}: every covered kind reaches its tRPC procedure through the queue the web app runs`, async () => {
    const { api, calls } = recordingApi()
    const create = await openKernelEngineOutbox({
      store: new InMemoryOutboxStore(),
      principal: 'user-1',
      api,
      onDegraded: () => {},
    })
    const outbox = create({
      api,
      replica: {
        outboxStorage: memoryStorage,
        outboxAwaitingStorage: memoryStorage,
        outboxDeadLetterStorage: memoryStorage,
      } as unknown as Replica,
      notices: { error: () => {}, info: () => {}, warn: () => {} } as unknown as StoreNotices,
    })

    // ONE TARGET PER ENTRY. The kernel queue COLLAPSES (POD-785): the pairs that
    // share a cell — markRead/markUnread, snoozeSet/snoozeClear, delete/restore —
    // supersede each other when they name the same row, which is the point of
    // them and would read here as "the executor was never called". Giving each
    // entry its own id asks the question this test is asking: can every kind be
    // SENT. The collapse itself is pinned in wiring.test.ts.
    for (const [index, covered] of COVERED.entries()) {
      const input = { ...(covered.input as Record<string, unknown>) }
      for (const key of ['id', 'sessionId', 'worktree']) {
        if (typeof input[key] === 'string') input[key] = `${input[key] as string}-${index}`
      }
      await outbox.enqueue(covered.kind, input as OutboxKinds[typeof covered.kind])
    }
    await drainFully(outbox)

    // Sorted: the kernel drains per PARTITION, so the order across targets is not
    // the enqueue order. What must hold is that none was refused for want of an
    // executor — a missing one dead-letters instead of calling anything.
    expect(calls.map((c) => c.path).sort()).toEqual(COVERED.map((c) => c.path).sort())
    expect(outbox.deadLetters()).toEqual([])
    outbox.dispose()
  })
})

describe('oracle: the offline-queued write set', () => {
  it(`${MUST_NOT_CHANGE}: eight session writes, twelve issue writes, and five replicated per-user writes drain to their tRPC procedures — offline queueing is not issue-only`, async () => {
    const { outbox, calls } = makeOutbox()

    for (const covered of COVERED) {
      outbox.enqueue(covered.kind, covered.input as OutboxKinds[typeof covered.kind])
    }
    await drainFully(outbox)

    expect(calls.map((c) => c.path)).toEqual(COVERED.map((c) => c.path))
    expect(
      calls.filter((c) => c.path.startsWith('sessions.') || c.path.startsWith('snooze')),
    ).toHaveLength(8)
    // Counted, not implied by the list above: POD-781 took the issue half from
    // three to twelve, and a future edit that drops one of the curation kinds
    // while leaving its row in COVERED would still pass the ordering assertion.
    expect(calls.filter((c) => c.path.startsWith('issues.'))).toHaveLength(12)
    outbox.dispose()
  })

  it(`${MUST_NOT_CHANGE}: an issue write replays with its mutationId too — the property that makes a cascading delete safe to re-send`, async () => {
    const { outbox, calls } = makeOutbox()

    // `issues.delete` tombstones the issue AND every session on it. Without a
    // stable id on the replay the server would run that cascade twice, which is
    // why `issues.archive`/`issues.delete` gained a `mutationId` input field and
    // a `ctx.withMutation` wrapper alongside this kind (POD-781).
    const entry = outbox.enqueue('issueDelete', { id: 'i1' })
    await outbox.drain()

    expect(calls).toEqual([
      { path: 'issues.delete', input: { id: 'i1', mutationId: entry.mutationId } },
    ])
    outbox.dispose()
  })

  it(`${MUST_NOT_CHANGE}: defer, undefer and setLabels replay with a mutationId too — the input field they had to GAIN to be queueable`, async () => {
    const { outbox, calls } = makeOutbox()

    // None of the three carried one before POD-781, and `undefer` is the sharp
    // case: it backdates `deferUntil` against the clock at APPLY time, so a
    // second unguarded pass moves the "Unsnoozed" marker and re-emits the event.
    const defer = outbox.enqueue('issueDefer', { id: 'i1', until: '2099-01-01' })
    const undefer = outbox.enqueue('issueUndefer', { id: 'i1' })
    const labels = outbox.enqueue('issueSetLabels', { id: 'i1', labels: ['bug'] })
    await drainFully(outbox)

    expect(calls).toEqual([
      {
        path: 'issues.defer',
        input: { id: 'i1', until: '2099-01-01', mutationId: defer.mutationId },
      },
      { path: 'issues.undefer', input: { id: 'i1', mutationId: undefer.mutationId } },
      {
        path: 'issues.setLabels',
        input: { id: 'i1', labels: ['bug'], mutationId: labels.mutationId },
      },
    ])
    outbox.dispose()
  })

  it(`${MUST_NOT_CHANGE}: restore and setPlacement replay with a mutationId — the last two inputs to gain one`, async () => {
    const { outbox, calls } = makeOutbox()

    // `restore` is the sharp one here, and its hazard is ORDER rather than
    // double-application: restoring a live issue is already a no-op, but a
    // re-sent restore arriving after the operator deleted the issue AGAIN would
    // resurrect it and every session that second delete took with it.
    const restore = outbox.enqueue('issueRestore', { id: 'i1' })
    const placement = outbox.enqueue('issueSetPlacement', {
      id: 'i2',
      placement: 'mission',
      originId: 'i3',
    })
    await drainFully(outbox)

    expect(calls).toEqual([
      { path: 'issues.restore', input: { id: 'i1', mutationId: restore.mutationId } },
      {
        path: 'issues.setPlacement',
        input: {
          id: 'i2',
          placement: 'mission',
          originId: 'i3',
          mutationId: placement.mutationId,
        },
      },
    ])
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
