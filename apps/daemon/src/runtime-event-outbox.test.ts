import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { type DurableRuntimeEvent, createRuntimeEventOutbox } from './runtime-event-outbox'

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
      t: 'state',
      change: { kind: 'activity' },
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
    first.enqueue(event('delivery-1'))

    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.pending()).toHaveLength(1)
    expect(reopened.acknowledge('other-delivery')).toBe(false)
    expect(reopened.pending()).toHaveLength(1)
    expect(reopened.acknowledge('delivery-1')).toBe(true)
    expect(createRuntimeEventOutbox(dir).pending()).toEqual([])
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

  it('compacts once the backlog drains, so the journal cannot grow without bound', () => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    const journal = join(dir, 'runtime-event-outbox.log')

    for (let i = 0; i < 8; i += 1) outbox.enqueue(event(`delivery-${i}`, i))
    expect(statSync(journal).size).toBeGreaterThan(0)

    for (let i = 0; i < 8; i += 1) expect(outbox.acknowledge(`delivery-${i}`)).toBe(true)

    // Draining to empty is the cheapest moment to fold the journal away.
    expect(statSync(journal).size).toBe(0)
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
    expect(outbox.pending().map((e) => e.deliveryId)).toEqual(['legacy-1'])
    expect(outbox.acknowledge('legacy-1')).toBe(true)
    expect(createRuntimeEventOutbox(dir).pending()).toEqual([])
    outbox.close()
  })

  it('refuses a delivery id reused for different content', () => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    outbox.enqueue(event('delivery-1', 1))
    expect(() => outbox.enqueue(event('delivery-1', 99))).toThrow(/delivery id collision/)
    outbox.close()
  })

  it('keeps the snapshot readable after compaction', () => {
    const dir = makeDir()
    const outbox = createRuntimeEventOutbox(dir)
    for (let i = 0; i < 600; i += 1) outbox.enqueue(event(`delivery-${i}`, i))

    // Past COMPACT_AFTER_RECORDS the snapshot must carry the set, not the journal.
    const snapshot = readFileSync(join(dir, 'runtime-event-outbox.json'), 'utf8')
    expect(JSON.parse(snapshot).events.length).toBeGreaterThan(0)
    expect(createRuntimeEventOutbox(dir).pending()).toHaveLength(600)
    outbox.close()
  })
})
