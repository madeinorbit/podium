/**
 * Fleet daemon log ingestion — the behaviours POD-3156 promises, not the
 * plumbing: a raised daemon's records land in that MACHINE's own file, tagged
 * with the machine the SERVER authenticated rather than anything the batch
 * claimed, and a lossy link says so in the file rather than leaving a gap.
 *
 * Written against the real rotating file sink and a real temp directory, for
 * `service.test.ts`'s reason: the acceptance criterion is what ends up on disk,
 * and a sink spy deletes exactly that.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FleetLogStore, machineFileKey, taggedDaemonRecord } from './fleet-store'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-fleet-logs-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const record = (msg: string, level: 'warn' | 'debug' = 'warn') => ({
  ts: '2026-08-11T14:03:22.847Z',
  level,
  ns: 'daemon:pty',
  msg,
})

const read = (file: string): Record<string, unknown>[] =>
  readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

/** One event-loop turn. The store's own drain was scheduled first, so it runs
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

describe('fleet daemon log ingestion', () => {
  it('files a machine’s records under that machine', async () => {
    const store = new FleetLogStore({ dir })

    const result = store.append(asMachineId('flatblock'), {
      records: [record('one'), record('two', 'debug')],
      v: '0.1.3',
    })
    // `close` drains what is queued before releasing the descriptors — see the
    // store's note on why the FINAL drain is the one that is not sliced.
    await store.close()

    expect(result).toEqual({
      accepted: 2,
      file: 'logs/fleet/flatblock.ndjson',
      dropped: 0,
      serverDropped: 0,
    })
    const lines = read('flatblock.ndjson')
    expect(lines.map((l) => l.msg)).toEqual(['one', 'two'])
    expect(lines[0]).toMatchObject({ role: 'daemon', machineId: 'flatblock', v: '0.1.3' })
  })

  it('keeps two machines in two files', async () => {
    const store = new FleetLogStore({ dir })

    store.append(asMachineId('flatblock'), { records: [record('theirs')] })
    store.append(asMachineId('ludovico'), { records: [record('ours')] })
    await store.close()

    expect(read('flatblock.ndjson').map((l) => l.msg)).toEqual(['theirs'])
    expect(read('ludovico.ndjson').map((l) => l.msg)).toEqual(['ours'])
  })

  /**
   * THE ATTRIBUTION PROPERTY. The frame carries no machine field, but its
   * records are free-form and a daemon could put anything in one. The server's
   * answer — the authenticated machine — is what reaches disk.
   */
  it('overwrites a machineId a record claimed for itself', () => {
    const tagged = taggedDaemonRecord(
      { ...record('one'), machineId: 'somebody-else' },
      asMachineId('flatblock'),
      '0.1.3',
    )

    expect(tagged).toMatchObject({ machineId: 'flatblock' })
  })

  /** `role` says WHICH PROGRAM wrote the line, and on an all-in-one install the
   *  daemon shares a process with the server — so the record's own answer is the
   *  true one and stamping `daemon` over it would erase the distinction. */
  it('keeps the role the record carries, and only defaults it when absent', () => {
    expect(
      taggedDaemonRecord({ ...record('one'), role: 'all-in-one' }, asMachineId('flatblock')),
    ).toMatchObject({ role: 'all-in-one' })
    expect(taggedDaemonRecord(record('one'), asMachineId('flatblock'))).toMatchObject({
      role: 'daemon',
    })
  })

  it('preserves the free-form fields that make a record worth having', () => {
    const tagged = taggedDaemonRecord(
      { ...record('one'), sessionId: 's1', durationMs: 42 },
      asMachineId('flatblock'),
    )

    expect(tagged).toMatchObject({ sessionId: 's1', durationMs: 42, msg: 'one' })
  })

  /**
   * A GAP IS AMBIGUOUS AND A COUNT IS NOT. A quiet daemon and an overflowing
   * queue look identical in a log file, so the daemon's own drop count is
   * written INTO the file, ahead of the batch it preceded.
   */
  it('writes the daemon’s reported drops into the file, before the batch', async () => {
    const store = new FleetLogStore({ dir })

    const result = store.append(asMachineId('flatblock'), {
      records: [record('after the gap')],
      dropped: 7,
    })
    await store.close()

    expect(result.dropped).toBe(7)
    const lines = read('flatblock.ndjson')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      level: 'warn',
      msg: 'daemon dropped records before this batch',
      dropped: 7,
      machineId: 'flatblock',
    })
    expect(lines[1]).toMatchObject({ msg: 'after the gap' })
  })

  it('accumulates reported drops per machine for the operator’s reply', () => {
    const store = new FleetLogStore({ dir })

    store.append(asMachineId('flatblock'), { records: [record('a')], dropped: 3 })
    store.append(asMachineId('flatblock'), { records: [record('b')], dropped: 4 })
    store.append(asMachineId('ludovico'), { records: [record('c')] })

    expect(store.droppedFor(asMachineId('flatblock'))).toBe(7)
    expect(store.droppedFor(asMachineId('ludovico'))).toBe(0)
  })

  /** The bound exists so one fleet cannot turn the log dir into a file per
   *  machine; the overflow bucket is where the rest land, visibly. */
  it('folds machines past the file budget into one shared file', async () => {
    const store = new FleetLogStore({ dir, maxMachineFiles: 2 })

    store.append(asMachineId('one'), { records: [record('1')] })
    store.append(asMachineId('two'), { records: [record('2')] })
    const third = store.append(asMachineId('three'), { records: [record('3')] })
    await store.close()

    // The overflow is NAMED in the result now: the assignment is made at accept
    // time, so a machine past the budget is told where it actually went rather
    // than being told its own name and finding its records elsewhere.
    expect(third.file).toBe('logs/fleet/other.ndjson')
    expect(read('other.ndjson').map((l) => l.msg)).toEqual(['3'])
  })

  /** A filename built from an id gets an allowlist, not a blocklist. */
  it('cannot be walked out of its directory by a machine id', () => {
    expect(machineFileKey('../../etc/passwd')).toBe('etc_passwd')
    expect(machineFileKey('')).toBe('unknown')
    expect(machineFileKey('Flatblock')).toBe('flatblock')
  })
})

/**
 * INGESTION MUST NOT SIT ON THE EVENT LOOP THE SERVER IS SERVING REQUESTS ON.
 *
 * These are the properties that bound request latency, asserted structurally
 * rather than by timing a clock: a wall-clock threshold on a shared CI box
 * measures the box, and would either flake or pass while doing nothing. What
 * actually decides how long a request waits behind ingestion is (a) that the
 * socket callback writes nothing at all, and (b) that no single drain turn
 * writes more than a fixed slice however much is queued. Both are checkable
 * exactly.
 */
describe('ingestion backpressure and event-loop occupancy', () => {
  it('writes nothing in the socket callback — the batch is only queued', () => {
    const sink = countingSink()
    const store = new FleetLogStore({ dir, createSink: sink.make })

    const result = store.append(asMachineId('flatblock'), {
      records: Array.from({ length: 50 }, (_, i) => record(`r${i}`)),
    })

    expect(result.accepted).toBe(50)
    expect(sink.writes).toEqual([])
    expect(store.pendingWrites()).toBe(50)
    void store.close()
  })

  it('writes a bounded slice per event-loop turn, not the whole backlog', async () => {
    const sink = countingSink()
    const store = new FleetLogStore({ dir, createSink: sink.make })

    for (let b = 0; b < 8; b++) {
      store.append(asMachineId('flatblock'), {
        records: Array.from({ length: 50 }, (_, i) => record(`b${b}-r${i}`)),
      })
    }
    expect(store.pendingWrites()).toBe(400)

    await tick()
    const afterOne = sink.writes.length
    await tick()
    const afterTwo = sink.writes.length

    // A constant, and the same constant, regardless of the 400 waiting.
    expect(afterOne).toBeGreaterThan(0)
    expect(afterOne).toBeLessThanOrEqual(16)
    expect(afterTwo - afterOne).toBe(afterOne)
    await store.close()
  })

  it('eventually writes everything it accepted', async () => {
    const sink = countingSink()
    const store = new FleetLogStore({ dir, createSink: sink.make })

    store.append(asMachineId('flatblock'), {
      records: Array.from({ length: 120 }, (_, i) => record(`r${i}`)),
    })
    for (let i = 0; i < 20; i++) await tick()

    expect(sink.writes).toHaveLength(120)
    expect(store.pendingWrites()).toBe(0)
    await store.close()
  })

  /** A bounded queue is the only honest answer to a server that cannot keep up;
   *  an unbounded one just moves the failure somewhere less legible. */
  it('drops oldest past its own bound and counts that separately from the daemon’s', async () => {
    const sink = countingSink()
    const store = new FleetLogStore({ dir, createSink: sink.make })
    const flatblock = asMachineId('flatblock')

    // 12 000 records with no chance to drain: far past the 5 000 bound.
    for (let b = 0; b < 24; b++) {
      store.append(flatblock, {
        records: Array.from({ length: 500 }, (_, i) => record(`b${b}-r${i}`)),
      })
    }

    expect(store.pendingWrites()).toBe(5000)
    expect(store.serverDroppedFor(flatblock)).toBe(7000)
    // The daemon reported none — the loss was entirely on this side, and the two
    // counters must not be confusable.
    expect(store.droppedFor(flatblock)).toBe(0)
    await store.close()
  })

  /** At shutdown there is no request left to protect, and the tail of a log is
   *  the part that explains why the process is stopping. */
  it('drains the queue on close rather than losing the tail', async () => {
    const store = new FleetLogStore({ dir })

    store.append(asMachineId('flatblock'), {
      records: Array.from({ length: 120 }, (_, i) => record(`r${i}`)),
    })
    expect(store.pendingWrites()).toBe(120)
    await store.close()

    expect(read('flatblock.ndjson')).toHaveLength(120)
  })

  it('refuses a batch after close rather than queueing into a closed store', async () => {
    const store = new FleetLogStore({ dir })
    await store.close()

    const result = store.append(asMachineId('flatblock'), { records: [record('too late')] })

    expect(result.accepted).toBe(0)
    expect(store.pendingWrites()).toBe(0)
  })

  /** The file a batch is told it landed in must not depend on how far the drain
   *  has got — the answer is given while the socket callback is still running. */
  it('assigns a machine its file at accept time, before anything is opened', () => {
    const store = new FleetLogStore({ dir, maxMachineFiles: 2 })

    const one = store.append(asMachineId('one'), { records: [record('1')] })
    const two = store.append(asMachineId('two'), { records: [record('2')] })
    const three = store.append(asMachineId('three'), { records: [record('3')] })

    expect(one.file).toBe('logs/fleet/one.ndjson')
    expect(two.file).toBe('logs/fleet/two.ndjson')
    // Past the budget: told the truth immediately, not after a drain.
    expect(three.file).toBe('logs/fleet/other.ndjson')
    void store.close()
  })
})
