/**
 * The shared ingestion writer (POD-3167) — the properties that bound how long a
 * request waits behind somebody else's log batch, and the accounting that keeps
 * "the sender lost records" apart from "we lost records".
 *
 * ASSERTED STRUCTURALLY, NOT BY TIMING A CLOCK. A wall-clock threshold on a
 * shared CI box measures the box, and would either flake or pass while doing
 * nothing. What actually decides how long a request waits is (a) that the
 * accepting call writes nothing at all and (b) that no single drain turn writes
 * more than a fixed slice however much is queued. Both are checkable exactly.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogRecord } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QueuedRecordWriter, type QueuedWriterPolicy, WRITE_SLICE } from './queued-writer'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-queued-writer-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const record = (msg: string): LogRecord =>
  ({ ts: '2026-08-31T09:00:00.000Z', level: 'warn', ns: 'test', msg }) as LogRecord

/** One event-loop turn. The writer's drain was scheduled first, so it runs
 *  before this resolves — which makes "one tick" a countable thing. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A sink that counts, so a test can watch WHEN writes happen rather than only
 *  that they did. */
function countingSink() {
  const writes: string[] = []
  return {
    writes,
    make: () =>
      ({
        name: 'counting',
        write: (r: { msg: string }) => void writes.push(r.msg),
        flush: async () => undefined,
        close: async () => undefined,
        degraded: false,
        bytes: 0,
      }) as never,
  }
}

const writer = (over: Partial<QueuedWriterPolicy> = {}) =>
  new QueuedRecordWriter({
    dir,
    kind: 'test',
    maxFiles: 64,
    maxPending: 5000,
    ...over,
  })

const linesIn = (file: string): Record<string, unknown>[] =>
  readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

describe('queued ingestion writer', () => {
  it('writes nothing in the accepting call — the records are only queued', () => {
    const sink = countingSink()
    const w = writer({ createSink: sink.make })

    for (let i = 0; i < 200; i++) w.enqueue('web-m1', record(`r${i}`))

    expect(sink.writes).toEqual([])
    expect(w.pendingWrites()).toBe(200)
    void w.close()
  })

  /**
   * THE ACCEPTANCE PROPERTY: no turn writes more than the configured slice,
   * REGARDLESS of how much is queued. Checked at three volumes an order of
   * magnitude apart, because "bounded" that only holds for small backlogs is
   * the bug this exists to prevent.
   */
  it.each([100, 1000, 4800])(
    'writes at most one slice per event-loop turn with %i queued',
    async (volume) => {
      const sink = countingSink()
      const w = writer({ createSink: sink.make })

      for (let i = 0; i < volume; i++) w.enqueue('web-m1', record(`r${i}`))
      expect(w.pendingWrites()).toBe(volume)

      let previous = 0
      for (let turn = 0; turn < 6; turn++) {
        await tick()
        const thisTurn = sink.writes.length - previous
        previous = sink.writes.length
        expect(thisTurn).toBeGreaterThan(0)
        expect(thisTurn).toBeLessThanOrEqual(WRITE_SLICE)
      }
      await w.close()
    },
  )

  it('honours a slice size the policy sets rather than a baked-in one', async () => {
    const sink = countingSink()
    const w = writer({ createSink: sink.make, writeSlice: 4 })

    for (let i = 0; i < 100; i++) w.enqueue('web-m1', record(`r${i}`))
    await tick()

    expect(sink.writes).toHaveLength(4)
    await w.close()
  })

  it('eventually writes everything it accepted', async () => {
    const sink = countingSink()
    const w = writer({ createSink: sink.make })

    for (let i = 0; i < 120; i++) w.enqueue('web-m1', record(`r${i}`))
    for (let i = 0; i < 20; i++) await tick()

    expect(sink.writes).toHaveLength(120)
    expect(w.pendingWrites()).toBe(0)
    await w.close()
  })

  /** A bounded queue is the only honest answer to a server that cannot keep up;
   *  an unbounded one just moves the failure somewhere less legible. */
  it('drops oldest past its bound and counts what it dropped', () => {
    const sink = countingSink()
    const w = writer({ createSink: sink.make, maxPending: 100 })

    for (let i = 0; i < 250; i++) w.enqueue('web-m1', record(`r${i}`))

    expect(w.pendingWrites()).toBe(100)
    expect(w.droppedFor('web-m1')).toBe(150)
    void w.close()
  })

  /**
   * A drop is charged to the key whose RECORD went over the side, not to the key
   * whose append happened to overflow the queue. Otherwise a chatty machine
   * makes a quiet one's file look complete while its records are the ones being
   * discarded — the counter would then point at the wrong investigation.
   */
  it('charges a drop to whoever’s record was dropped', () => {
    const sink = countingSink()
    const w = writer({ createSink: sink.make, maxPending: 10 })

    for (let i = 0; i < 10; i++) w.enqueue('quiet', record(`q${i}`))
    for (let i = 0; i < 10; i++) w.enqueue('chatty', record(`c${i}`))

    expect(w.droppedFor('quiet')).toBe(10)
    expect(w.droppedFor('chatty')).toBe(0)
    void w.close()
  })

  /** At shutdown there is no request left to protect, and the tail of a log is
   *  the part that explains why the process is stopping. */
  it('drains the whole queue on close rather than losing the tail', async () => {
    const w = writer()

    for (let i = 0; i < 300; i++) w.enqueue('web-m1', record(`r${i}`))
    expect(w.pendingWrites()).toBe(300)
    await w.close()

    expect(linesIn('web-m1.ndjson')).toHaveLength(300)
  })

  it('accepts nothing once closed', async () => {
    const w = writer()
    await w.close()

    w.enqueue('web-m1', record('too late'))

    expect(w.closed).toBe(true)
    expect(w.pendingWrites()).toBe(0)
  })

  /** The file a sender is told it landed in must not depend on how far the
   *  drain has got — the answer is given while its request is still running. */
  it('assigns a key its file at accept time, before anything is opened', () => {
    const w = writer({ maxFiles: 2 })

    expect(w.assign('one')).toBe('one')
    expect(w.assign('two')).toBe('two')
    expect(w.assign('three')).toBe('other')
    // Stable: asking again never moves a key that already has an answer.
    expect(w.assign('one')).toBe('one')
    expect(w.assign('three')).toBe('other')
    void w.close()
  })

  /** The sink is opened by the DRAIN, on the turn it is first needed — which is
   *  what keeps a rotation (five renames plus an open) inside a bounded slice
   *  instead of inside the accepting call. */
  it('opens no file until the drain reaches its first record', async () => {
    let opened = 0
    const sink = countingSink()
    const w = writer({
      createSink: () => {
        opened += 1
        return sink.make()
      },
    })

    w.enqueue('web-m1', record('one'))
    expect(opened).toBe(0)

    await tick()
    expect(opened).toBe(1)
    await w.close()
  })

  it('degrades rather than throwing when a sink cannot be constructed', async () => {
    const w = writer({
      createSink: () => {
        throw new Error('no space left on device')
      },
    })

    w.enqueue('web-m1', record('one'))
    await tick()

    // Discarded by the drain rather than held forever, and nothing thrown at a
    // caller who is long gone.
    expect(w.pendingWrites()).toBe(0)
    await expect(w.close()).resolves.toBeUndefined()
  })
})

/**
 * THE STRUCTURAL HALF of the acceptance criterion: no ingestion entry point may
 * reach a `FileSink` itself (POD-3167).
 *
 * A behavioural test can only prove that the paths it exercises are deferred.
 * This one reads the SOURCE of both ingestion modules, which is the whole set,
 * and fails if either grows a direct sink write or its own `createFileSink`
 * again — the exact regression this refactor exists to prevent, and the one a
 * later change would otherwise reintroduce without a red test.
 */
describe('no ingestion path writes to a file sink directly', () => {
  const INGESTION_MODULES = ['service.ts', 'fleet-store.ts']

  /** The prose in these files DISCUSSES sinks at length and must be allowed to;
   *  what may not come back is code that builds or writes one. */
  const codeOf = (file: string): string =>
    readFileSync(join(import.meta.dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')

  it.each(INGESTION_MODULES)('%s constructs no file sink of its own', (file) => {
    // The import is the tell: a module that cannot build a sink cannot write to
    // one, and this catches a reintroduction at the line that reintroduces it.
    expect(codeOf(file)).not.toMatch(/\bcreateFileSink\b/)
  })

  it.each(INGESTION_MODULES)('%s calls no sink write', (file) => {
    const writeCalls = codeOf(file)
      .split('\n')
      .filter((line) => /\.write\s*\(/.test(line))
    expect(writeCalls).toEqual([])
  })
})
