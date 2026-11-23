import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@podium/model'
import { CausalEnvelope, type RuntimeEventMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRuntimeEventOutbox,
  type DurableRuntimeEvent,
  prepareRuntimeEventDelivery,
} from './runtime-event-outbox'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-runtime-event-outbox-'))
  roots.push(dir)
  return dir
}

function event(deliveryId: string, seq = 1): DurableRuntimeEvent {
  return {
    type: 'runtimeEvent',
    deliveryId,
    sessionId: 'session-1' as SessionId,
    event: {
      t: 'delivery',
      rowId: `row-${seq}`,
      outcome: 'delivered',
      at: '2026-08-20T00:00:00.000Z',
      provenance: 'bootstrap',
      cursor: { segmentId: 'segment-1', components: { seq } },
      observerGeneration: 1,
      turnEpoch: 1,
    },
  }
}

describe('coarse runtime event outbox', () => {
  it('survives a daemon-store reopen and retires only the acknowledged delivery', () => {
    const dir = makeDir()
    const first = createRuntimeEventOutbox(dir)
    expect(first.pendingCount).toBe(0)
    first.enqueue(event('delivery-1'))
    first.enqueue(event('delivery-1'))
    expect(first.pendingCount).toBe(1)
    first.enqueue(event('delivery-2', 2))
    expect(first.pendingCount).toBe(2)
    first.close()

    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.pendingCount).toBe(2)
    expect(reopened.acknowledge('other-delivery')).toBe(false)
    expect(reopened.pendingCount).toBe(2)
    expect(reopened.acknowledge('delivery-1')).toBe(true)
    expect(reopened.pendingCount).toBe(1)
    expect(reopened.pending().map((entry) => entry.deliveryId)).toEqual(['delivery-2'])
    expect(reopened.acknowledge('delivery-1')).toBe(false)
    expect(reopened.pendingCount).toBe(1)
    expect(reopened.acknowledge('delivery-2')).toBe(true)
    expect(reopened.pendingCount).toBe(0)
    reopened.close()
    const drained = createRuntimeEventOutbox(dir)
    expect(drained.pendingCount).toBe(0)
    expect(drained.pending()).toEqual([])
    drained.close()
  })

  /**
   * THE REGRESSION GUARD FOR POD-4261.
   *
   * The defect was not "slow"; it was that EVERY enqueue rewrote the entire
   * pending set, so cost grew with the backlog and a stalled link made each
   * subsequent write worse. This asserts the shape that cannot do that: the
   * snapshot is untouched while a backlog accumulates.
   *
   * It is written against the snapshot's own bytes rather than a spy on fsync,
   * so it keeps its meaning if the write path is reimplemented.
   */
  it('does not rewrite the snapshot while a backlog accumulates', () => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    outbox.enqueue(event('delivery-0'))
    const snapshot = join(dir, 'runtime-event-outbox.json')

    // Nothing has been acknowledged, so the backlog only grows — the exact
    // condition under which the old implementation degraded quadratically.
    const before = statSync(snapshot, { throwIfNoEntry: false })
    for (let i = 1; i <= 64; i += 1) outbox.enqueue(event(`delivery-${i}`, i))
    const after = statSync(snapshot, { throwIfNoEntry: false })

    expect(after?.size ?? 0).toBe(before?.size ?? 0)
    expect(outbox.pending()).toHaveLength(65)
    expect(createRuntimeEventOutbox(dir).pending()).toHaveLength(65)
    outbox.close()
  })

  it('compacts once the backlog drains, so the journal cannot grow without bound', async () => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    const journal = join(dir, 'runtime-event-outbox.log')

    for (let i = 0; i < 8; i += 1) outbox.enqueue(event(`delivery-${i}`, i))
    expect(statSync(journal).size).toBeGreaterThan(0)

    for (let i = 0; i < 8; i += 1) expect(outbox.acknowledge(`delivery-${i}`)).toBe(true)

    // Draining to empty is the cheapest moment to fold the journal away.
    await outbox.settled()
    expect(
      readFileSync(journal, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).op),
    ).toEqual(['coverage'])
    expect(outbox.pending()).toEqual([])
    expect(createRuntimeEventOutbox(dir).pending()).toEqual([])
    outbox.close()
  })

  it('recovers everything before a torn trailing record', () => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    outbox.enqueue(event('delivery-1'))
    outbox.enqueue(event('delivery-2', 2))
    outbox.close()

    // A crash mid-append leaves a partial final line.
    appendFileSync(join(dir, 'runtime-event-outbox.log'), '{"op":"add","event":{"typ')

    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.pendingCount).toBe(2)
    expect(reopened.pending().map((e) => e.deliveryId)).toEqual(['delivery-1', 'delivery-2'])
    reopened.close()
  })

  it('reads a snapshot written before the journal existed', () => {
    const dir = makeDir()
    // The pre-POD-4261 on-disk shape: snapshot only, no journal beside it.
    writeFileSync(
      join(dir, 'runtime-event-outbox.json'),
      `${JSON.stringify({ version: 1, events: [event('legacy-1')] }, null, 2)}\n`,
    )

    const outbox = createRuntimeEventOutbox(dir)
    expect(outbox.pendingCount).toBe(1)
    expect(outbox.pending().map((e) => e.deliveryId)).toEqual(['legacy-1'])
    expect(outbox.acknowledge('legacy-1')).toBe(true)
    outbox.close()
    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.pending()).toEqual([])
    reopened.close()
  })

  it('refuses a delivery id reused for different content', () => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    outbox.enqueue(event('delivery-1', 1))
    expect(() => outbox.enqueue(event('delivery-1', 99))).toThrow(/delivery id collision/)
    outbox.close()
  })

  it('keeps the snapshot readable after compaction', async () => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    for (let i = 0; i < 600; i += 1) outbox.enqueue(event(`delivery-${i}`, i))
    await outbox.settled()

    // Past COMPACT_AFTER_RECORDS the snapshot must carry the set, not the journal.
    const snapshot = readFileSync(join(dir, 'runtime-event-outbox.json'), 'utf8')
    expect(JSON.parse(snapshot).events.length).toBeGreaterThan(0)
    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.pendingCount).toBe(600)
    expect(reopened.pending()).toHaveLength(600)
    reopened.close()
    outbox.close()
  })
})

describe('off-thread acknowledgement commit and compaction (POD-7438)', () => {
  const snapshotOf = (dir: string) => readFileSync(join(dir, 'runtime-event-outbox.json'), 'utf8')
  const journalOf = (dir: string) =>
    readFileSync(join(dir, 'runtime-event-outbox.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))

  /**
   * A reconnect replay acknowledges its whole backlog in one burst. The ACK
   * records must reach the journal in order before acknowledge() returns (a
   * process kill keeps them), but neither their fsync nor the compaction they
   * trigger may run on the caller's thread. Asserted on file bytes: the
   * snapshot cannot change before the event loop has turned.
   */
  it('journals each ACK at once and folds the burst into the snapshot in the background', async () => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    for (let i = 0; i < 700; i += 1) outbox.enqueue(event(`delivery-${i}`, i))
    await outbox.settled()
    const before = snapshotOf(dir)

    for (let i = 0; i < 600; i += 1) expect(outbox.acknowledge(`delivery-${i}`)).toBe(true)
    expect(outbox.pendingCount).toBe(100)
    expect(snapshotOf(dir)).toBe(before)
    expect(journalOf(dir).filter((record) => record.op === 'ack')).toHaveLength(600)

    await outbox.settled()
    expect(JSON.parse(snapshotOf(dir)).events.length).toBeGreaterThanOrEqual(100)
    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.pending().map((entry) => entry.deliveryId)).toEqual(
      Array.from({ length: 100 }, (_, i) => `delivery-${600 + i}`),
    )
    reopened.close()
    outbox.close()
  })

  it('carries records appended during a background compaction into the next journal', async () => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    const sessionId = event('unused').sessionId
    // The 512th record starts a compaction; everything after it is appended while it runs.
    for (let i = 0; i < 600; i += 1) outbox.enqueue(event(`delivery-${i}`, i))
    outbox.deliveryJournal(sessionId).store('witness')
    expect(outbox.acknowledge('delivery-599')).toBe(true)
    await outbox.settled()

    const snapshot = JSON.parse(snapshotOf(dir))
    const [header, ...records] = journalOf(dir)
    expect(header).toMatchObject({ op: 'coverage', epoch: snapshot.typingEpoch })
    expect(snapshot.events.length + records.filter((record) => record.op === 'add').length).toBe(
      600,
    )
    expect(records.at(-1)).toEqual({ op: 'ack', deliveryId: 'delivery-599' })
    outbox.close()

    // A trusted coverage header is what keeps the stored-only no-write proof.
    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.pendingCount).toBe(599)
    expect(reopened.deliveryJournal(sessionId).read('witness')).toEqual({ typingStarted: false })
    reopened.close()
  })

  it('finishes a running compaction on close, keeping the coverage proof', () => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    const sessionId = event('unused').sessionId
    for (let i = 0; i < 520; i += 1) outbox.enqueue(event(`delivery-${i}`, i))
    outbox.deliveryJournal(sessionId).store('witness')
    // Same tick: no thread-pool result has come back, so close() must finish every step.
    outbox.close()

    expect(journalOf(dir)[0]).toMatchObject({
      op: 'coverage',
      epoch: JSON.parse(snapshotOf(dir)).typingEpoch,
    })
    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.pendingCount).toBe(520)
    expect(reopened.deliveryJournal(sessionId).read('witness')).toEqual({ typingStarted: false })
    reopened.close()
  })

  it('discards a next journal that an interrupted compaction never installed', () => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    outbox.enqueue(event('delivery-1'))
    outbox.close()
    const next = join(dir, 'runtime-event-outbox.log.next')
    writeFileSync(
      next,
      '{"op":"coverage","epoch":"interrupted"}\n{"op":"ack","deliveryId":"delivery-1"}\n',
    )

    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.pending().map((entry) => entry.deliveryId)).toEqual(['delivery-1'])
    expect(statSync(next, { throwIfNoEntry: false })).toBeUndefined()
    reopened.close()
  })
})

describe('delivery typing state in the runtime-event journal (POD-5556)', () => {
  const sessionId = event('unused').sessionId

  it('retains a fresh stored row across reopen, including a proven no-write', () => {
    const dir = makeDir()
    const first = createRuntimeEventOutbox(dir)
    first.deliveryJournal(sessionId).store('row-1')
    first.close()
    const after = createRuntimeEventOutbox(dir)
    expect(after.deliveryJournal(sessionId).read('row-1')).toEqual({ typingStarted: false })
    after.deliveryJournal(sessionId).start('row-1')
    after.deliveryJournal(sessionId).clear('row-1')
    after.close()
    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.deliveryJournal(sessionId).read('row-1')).toEqual({ typingStarted: false })
    reopened.close()
  })

  it.each([
    'missing-log',
    'missing-snapshot',
    'reset-snapshot',
    'torn-snapshot',
  ] as const)('discards stored-only proof on %s but retains known write evidence', (damage) => {
    const dir = makeDir()
    const first = createRuntimeEventOutbox(dir)
    first.deliveryJournal(sessionId).store('held')
    first.deliveryJournal(sessionId).start('started')
    // Force a snapshot carrying both entries, leaving a valid anchored log.
    for (let index = 0; index < 510; index++) first.enqueue(event(`queued-${index}`, index))
    first.close()
    const snapshot = join(dir, 'runtime-event-outbox.json')
    if (damage === 'missing-log') rmSync(join(dir, 'runtime-event-outbox.log'))
    else if (damage === 'missing-snapshot') rmSync(snapshot)
    else {
      const saved = JSON.parse(readFileSync(snapshot, 'utf8'))
      if (damage === 'reset-snapshot')
        saved.typing = [{ sessionId, rowId: 'held', storedAt: '2026-10-04T00:00:00.000Z' }]
      else delete saved.typing
      writeFileSync(snapshot, JSON.stringify(saved))
    }
    const after = createRuntimeEventOutbox(dir)
    expect(after.deliveryJournal(sessionId).read('held')).toBeUndefined()
    if (damage === 'missing-log')
      expect(after.deliveryJournal(sessionId).read('started')).toEqual({ typingStarted: true })
    after.close()
    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.deliveryJournal(sessionId).read('held')).toBeUndefined()
    reopened.deliveryJournal(sessionId).store('new-after-repair')
    reopened.close()
    const covered = createRuntimeEventOutbox(dir)
    expect(covered.deliveryJournal(sessionId).read('new-after-repair')).toEqual({
      typingStarted: false,
    })
    covered.close()
  })

  it('retains a typing fence without an event, and clears a proven no-write across reopen', () => {
    const dir = makeDir()
    const first = createRuntimeEventOutbox(dir)
    expect(first.deliveryJournal(sessionId).read('row-1')).toBeUndefined()
    first.deliveryJournal(sessionId).start('row-1')
    first.close()
    const after = createRuntimeEventOutbox(dir)
    expect(after.pending()).toEqual([])
    expect(after.pendingCount).toBe(0)
    expect(after.deliveryJournal(sessionId).read('row-1')).toEqual({ typingStarted: true })
    expect(after.deliveryJournal('other-session' as SessionId).read('row-1')).toBeUndefined()
    after.deliveryJournal(sessionId).clear('row-1')
    after.close()
    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.deliveryJournal(sessionId).read('row-1')).toBeUndefined()
    reopened.close()
  })

  it('replays the recorded outcome and prunes the fence after its final acknowledgement', () => {
    const dir = makeDir()
    const first = createRuntimeEventOutbox(dir)
    first.deliveryJournal(sessionId).start('row-1')
    first.enqueue(event('delivered'))
    first.close()
    const after = createRuntimeEventOutbox(dir)
    expect(after.deliveryJournal(sessionId).read('row-1')).toEqual({
      typingStarted: true,
      outcome: { t: 'delivery', rowId: 'row-1', outcome: 'delivered' },
    })
    after.acknowledge('delivered')
    after.close()
    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.deliveryJournal(sessionId).read('row-1')).toBeUndefined()
    expect(reopened.pending()).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'runtime-event-outbox.json'), 'utf8')).typing).toEqual(
      [],
    )
    reopened.close()
  })

  it('retains an outcome before an asynchronous event sink has forwarded it', () => {
    const dir = makeDir()
    const first = createRuntimeEventOutbox(dir)
    first.deliveryJournal(sessionId).start('row-1')
    first.deliveryJournal(sessionId).record({
      t: 'delivery',
      rowId: 'row-1',
      outcome: 'delivered',
      transcriptItem: { id: 'entry' },
    })
    first.close()
    const after = createRuntimeEventOutbox(dir)
    expect(after.pending()).toEqual([])
    expect(after.deliveryJournal(sessionId).read('row-1')?.outcome).toEqual({
      t: 'delivery',
      rowId: 'row-1',
      outcome: 'delivered',
      transcriptItem: { id: 'entry' },
    })
    after.close()
  })

  it.each([
    'typing',
    'no-write',
  ] as const)('keeps a known outcome when replaying a later %s record', (mode) => {
    const dir = makeDir()
    const first = createRuntimeEventOutbox(dir)
    const journal = first.deliveryJournal(sessionId)
    journal.record({ t: 'delivery', rowId: 'row-1', outcome: 'accepted', held: 'durable' })
    journal.start('row-1')
    if (mode === 'no-write') journal.clear('row-1')
    const before = journal.read('row-1')
    first.close()
    const after = createRuntimeEventOutbox(dir)
    expect(after.deliveryJournal(sessionId).read('row-1')).toEqual(before)
    expect(after.deliveryJournal(sessionId).read('row-1')?.outcome).toMatchObject({
      outcome: 'accepted',
      held: 'durable',
    })
    after.close()
  })

  it('keeps the final failed outcome when the event stream reports a contradiction', () => {
    const dir = makeDir()
    const first = createRuntimeEventOutbox(dir)
    first
      .deliveryJournal(sessionId)
      .record({ t: 'delivery', rowId: 'row-1', outcome: 'failed', cause: 'agent-exited' })
    first.enqueue(event('contradiction'))
    first.close()
    const after = createRuntimeEventOutbox(dir)
    expect(after.deliveryJournal(sessionId).read('row-1')?.outcome).toMatchObject({
      outcome: 'failed',
      cause: 'agent-exited',
    })
    after.close()
  })

  it('does not prune a later confirmed outcome on an earlier unconfirmed acknowledgement', () => {
    const dir = makeDir()
    const first = createRuntimeEventOutbox(dir)
    const unconfirmed: DurableRuntimeEvent = {
      ...event('unknown'),
      event: {
        ...event('unknown').event,
        t: 'delivery',
        rowId: 'row-1',
        outcome: 'failed',
        cause: 'unconfirmed',
      },
    }
    first.enqueue(unconfirmed)
    first.deliveryJournal(sessionId).record({
      t: 'delivery',
      rowId: 'row-1',
      outcome: 'delivered',
      transcriptItem: { id: 'entry' },
    })
    first.acknowledge('unknown')
    first.close()
    const after = createRuntimeEventOutbox(dir)
    expect(after.deliveryJournal(sessionId).read('row-1')?.outcome).toMatchObject({
      outcome: 'delivered',
      transcriptItem: { id: 'entry' },
    })
    after.close()
  })

  it.each([
    'accepted-first',
    'final-first',
  ] as const)('prunes settled rows with %s acknowledgements', (order) => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    outbox.deliveryJournal(sessionId).start('row-1')
    const accepted: DurableRuntimeEvent = {
      ...event('accepted'),
      event: {
        ...event('accepted').event,
        t: 'delivery',
        rowId: 'row-1',
        outcome: 'accepted',
        held: 'durable',
      },
    }
    outbox.enqueue(accepted)
    outbox.enqueue(event('final'))
    for (const id of order === 'accepted-first' ? ['accepted', 'final'] : ['final', 'accepted'])
      outbox.acknowledge(id)
    outbox.close()
    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.pending()).toEqual([])
    expect(reopened.deliveryJournal(sessionId).read('row-1')).toBeUndefined()
    reopened.close()
  })

  it('keeps a durable program hold through acknowledgement and journal compaction', () => {
    const dir = makeDir()
    const first = createRuntimeEventOutbox(dir)
    first.deliveryJournal(sessionId).start('row-1')
    first.enqueue({
      ...event('accepted'),
      event: {
        ...event('accepted').event,
        t: 'delivery',
        rowId: 'row-1',
        outcome: 'accepted',
        held: 'durable',
      },
    })
    first.acknowledge('accepted')
    for (let index = 0; index < 520; index++) {
      first.deliveryJournal(sessionId).start(`waiting-${index}`)
      first.deliveryJournal(sessionId).clear(`waiting-${index}`)
    }
    first.close()
    const after = createRuntimeEventOutbox(dir)
    expect(after.deliveryJournal(sessionId).read('row-1')).toEqual({
      typingStarted: true,
      outcome: { t: 'delivery', rowId: 'row-1', outcome: 'accepted', held: 'durable' },
    })
    expect(after.pending()).toEqual([])
    after.close()
  })

  it.each([
    '{"op":"typing"',
    '{"op":"ack","deliveryId":"absent"}',
  ])('preserves new typing records appended after a torn tail: %s', (tail) => {
    const dir = makeDir()
    const first = createRuntimeEventOutbox(dir)
    first.deliveryJournal(sessionId).start('row-1')
    first.close()
    appendFileSync(join(dir, 'runtime-event-outbox.log'), tail)
    const after = createRuntimeEventOutbox(dir)
    after.deliveryJournal(sessionId).start('row-2')
    after.close()
    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.deliveryJournal(sessionId).read('row-1')).toEqual({ typingStarted: true })
    expect(reopened.deliveryJournal(sessionId).read('row-2')).toEqual({ typingStarted: true })
    reopened.close()
  })
})

describe('runtime event delivery preparation', () => {
  it.each(['state', 'workspace'] as const)('sends live %s without touching the journal', (kind) => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    const { deliveryId: _id, ...base } = event('unused')
    const body =
      kind === 'state'
        ? { t: 'state' as const, change: { kind: 'activity' } }
        : { t: 'workspace' as const, ev: { ev: 'cwd-changed' as const, cwd: '/repo' } }
    const message: RuntimeEventMessage = {
      ...base,
      event: { ...CausalEnvelope.parse(base.event), ...body, provenance: 'live' },
    }
    const before = readFileSync(join(dir, 'runtime-event-outbox.log'))
    expect(prepareRuntimeEventDelivery(outbox, message)).toBe(message)
    expect(message.deliveryId).toBeUndefined()
    expect(outbox.pending()).toEqual([])
    expect(readFileSync(join(dir, 'runtime-event-outbox.log'))).toEqual(before)
    outbox.close()
  })

  it('retains bootstrap state synchronously before the transport exists', () => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    const { deliveryId: _id, ...base } = event('unused')
    const message: RuntimeEventMessage = {
      ...base,
      event: {
        ...CausalEnvelope.parse(base.event),
        t: 'state',
        change: { kind: 'activity' },
        observerGeneration: 2,
      },
    }
    const prepared = prepareRuntimeEventDelivery(outbox, message)
    expect(prepared.deliveryId).toEqual(expect.any(String))
    // Reopen before close/ack: the call returning, not a timer, is the crash boundary.
    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.pending()).toEqual([prepared])
    reopened.close()
    outbox.close()
  })

  it('keeps the delivery id and retention of a previously retained live observation', () => {
    const outbox = createRuntimeEventOutbox(makeDir())
    const old: DurableRuntimeEvent = {
      ...event('old-state'),
      event: {
        ...CausalEnvelope.parse(event('old-state').event),
        t: 'state',
        change: { kind: 'activity' },
        provenance: 'live',
      },
    }
    expect(prepareRuntimeEventDelivery(outbox, old)).toEqual(old)
    expect(outbox.pending()).toEqual([old])
    outbox.close()
  })
})
