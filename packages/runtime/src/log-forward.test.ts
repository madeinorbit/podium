/**
 * The daemon half of fleet log capture (POD-3156) — the promises, not the
 * plumbing:
 *
 *  - nothing leaves a daemon until an operator raises it;
 *  - a raise ships the minute BEFORE it, from the flight recorder;
 *  - the raise expires by itself, and expiry stops the stream;
 *  - a link that is down costs records at a bounded rate, and says how many;
 *  - the sink cannot feed itself through the socket it is describing.
 */

import { clearSinks, createLogger, resetLevels, setLogLevel } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type DaemonLogBatch,
  installDaemonLogForwarding,
  toWireRecord,
} from './log-forward'

const log = createLogger('daemon:test')

/** A transport that records what it was handed and can be taken offline. */
function transport() {
  const batches: DaemonLogBatch[] = []
  let up = true
  return {
    batches,
    down: () => {
      up = false
    },
    up: () => {
      up = true
    },
    send: (batch: DaemonLogBatch): boolean => {
      if (!up) return false
      batches.push({ records: [...batch.records], ...(batch.dropped !== undefined ? { dropped: batch.dropped } : {}) })
      return true
    },
  }
}

const messages = (batches: DaemonLogBatch[]): string[] =>
  batches.flatMap((b) => b.records.map((r) => r.msg))

beforeEach(() => {
  vi.useFakeTimers()
  resetLevels()
  clearSinks()
  setLogLevel('info')
})
afterEach(() => {
  vi.useRealTimers()
  clearSinks()
  resetLevels()
})

describe('daemon log forwarding', () => {
  /** THE DEFAULT POSTURE. A daemon's records are another host's contents; they
   *  do not cross a network because somebody started a server. */
  it('forwards nothing until it is raised', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    log.warn('before anyone asked')
    vi.advanceTimersByTime(10_000)

    expect(t.batches).toEqual([])
    expect(forwarding.status().forwarding).toBe(false)
    forwarding.dispose()
  })

  /** THE HALF THAT IS USUALLY MISSING. An operator raises a daemon BECAUSE
   *  something already happened; a knob that only captures the future asks them
   *  to reproduce it first. */
  it('a raise ships the flight recorder, then what follows', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    log.warn('the thing that made me look')
    forwarding.raise({ level: 'debug', ttlMs: 60_000 })
    log.debug('and what came after')
    vi.advanceTimersByTime(10_000)

    expect(messages(t.batches)).toEqual([
      'the thing that made me look',
      'daemon log level raised',
      'and what came after',
    ])
    forwarding.dispose()
  })

  /** ONE KNOB: the raise moves the process level, so what the journal shows and
   *  what is forwarded cannot disagree. */
  it('raising forwards records the boot level was hiding', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    forwarding.raise({ level: 'debug' })
    log.debug('below the boot level')
    vi.advanceTimersByTime(10_000)

    expect(messages(t.batches)).toContain('below the boot level')
    forwarding.dispose()
  })

  /**
   * THE RECORDER RUNS AT `trace` WHATEVER THE PROCESS LEVEL IS, which is what
   * makes a raise able to answer a question about the PAST. `debug` on a daemon
   * running at `info` costs memory and nothing else — until somebody asks, and
   * then it is the minute that explains the incident they are asking about.
   */
  it('the seeded past includes records below the level the daemon was running at', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    log.debug('nobody was going to see this')
    forwarding.raise({ level: 'debug' })
    vi.advanceTimersByTime(10_000)

    expect(messages(t.batches)).toContain('nobody was going to see this')
    forwarding.dispose()
  })

  it('does not re-seed the recorder when a raise is re-issued inside its window', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    log.warn('history')
    forwarding.raise({ level: 'debug', ttlMs: 60_000 })
    vi.advanceTimersByTime(10_000)
    forwarding.raise({ level: 'trace', ttlMs: 60_000 })
    vi.advanceTimersByTime(10_000)

    expect(messages(t.batches).filter((m) => m === 'history')).toHaveLength(1)
    forwarding.dispose()
  })

  /** THE WAY BACK THAT DOES NOT DEPEND ON ANYBODY REMEMBERING. A daemon runs for
   *  weeks; nothing reloads it. */
  it('the raise expires by itself and the stream stops', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    forwarding.raise({ level: 'debug', ttlMs: 60_000 })
    vi.advanceTimersByTime(60_000)
    const afterExpiry = t.batches.length
    log.warn('long after the window')
    vi.advanceTimersByTime(10_000)

    expect(forwarding.status()).toMatchObject({ forwarding: false, level: 'info', expiresAt: null })
    expect(t.batches.length).toBe(afterExpiry)
    // The explanation for why the central file goes quiet is IN the central file.
    expect(messages(t.batches)).toContain('daemon log level restored')
    forwarding.dispose()
  })

  it('a null level ends the raise early and restores the boot default', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'warn', send: t.send })

    forwarding.raise({ level: 'trace', ttlMs: 60_000 })
    forwarding.raise({ level: null })
    log.warn('after the reset')
    vi.advanceTimersByTime(10_000)

    expect(forwarding.status()).toMatchObject({ forwarding: false, level: 'warn' })
    expect(messages(t.batches)).not.toContain('after the reset')
    forwarding.dispose()
  })

  it('clamps a raise to the 24h ceiling however long the server asked for', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({
      boot: 'info',
      send: t.send,
      now: () => 1_000,
    })

    forwarding.raise({ level: 'debug', ttlMs: 7 * 24 * 60 * 60 * 1000 })

    expect(forwarding.status().expiresAt).toBe(1_000 + 24 * 60 * 60 * 1000)
    forwarding.dispose()
  })

  /** A SOCKET IS NOT A REQUEST. There is nothing to retry — there is a link that
   *  is down — so the batch is kept and goes out on the reconnect drain. */
  it('keeps a batch the transport refused and drains it on reconnect', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })
    forwarding.raise({ level: 'info', ttlMs: 600_000 })
    vi.advanceTimersByTime(10_000)
    t.batches.length = 0

    t.down()
    log.warn('while the link was down')
    vi.advanceTimersByTime(10_000)
    expect(t.batches).toEqual([])

    t.up()
    forwarding.flush()

    expect(messages(t.batches)).toContain('while the link was down')
    forwarding.dispose()
  })

  /** BOUNDED, AND HONEST ABOUT IT. Oldest goes first — when a link has been
   *  down, what is happening now matters more than what already passed. */
  it('drops oldest past the queue bound and reports the count in-band', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({
      boot: 'info',
      send: t.send,
      maxQueue: 4,
      batchSize: 4,
    })
    forwarding.raise({ level: 'info', ttlMs: 600_000 })
    vi.advanceTimersByTime(10_000)
    t.batches.length = 0

    t.down()
    for (let i = 0; i < 10; i++) log.warn(`record ${i}`)
    vi.advanceTimersByTime(10_000)
    t.up()
    forwarding.flush()

    const sent = messages(t.batches)
    expect(sent).toContain('record 9')
    expect(sent).not.toContain('record 0')
    expect(t.batches[0]?.dropped).toBeGreaterThan(0)
    expect(forwarding.status().dropped).toBeGreaterThan(0)
    forwarding.dispose()
  })

  /** IT MUST NOT FEED ITSELF. Sending is socket traffic and socket traffic logs;
   *  a sink that queued its own send's records would guarantee its next send. */
  it('never forwards a record emitted by the send path itself', () => {
    const inner = createLogger('daemon:transport')
    const batches: DaemonLogBatch[] = []
    const forwarding = installDaemonLogForwarding({
      boot: 'info',
      send: (batch) => {
        batches.push({ records: [...batch.records] })
        inner.warn('socket said something while sending')
        return true
      },
    })

    forwarding.raise({ level: 'info', ttlMs: 600_000 })
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10_000)
    }

    expect(messages(batches)).not.toContain('socket said something while sending')
    // Counted rather than silently discarded.
    expect(forwarding.status().dropped).toBeGreaterThan(0)
    forwarding.dispose()
  })

  /**
   * The raise notice is IN the central file, exactly once. Without it a reader
   * cannot tell "this daemon had nothing to say" from "this daemon was never
   * turned up" — which is the question they would otherwise answer by guessing.
   */
  it('forwards the raise notice itself, once', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })
    forwarding.raise({ level: 'debug', ttlMs: 600_000 })
    vi.advanceTimersByTime(10_000)

    const raised = t.batches.flatMap((b) => b.records).filter((r) => r.msg === 'daemon log level raised')
    expect(raised).toHaveLength(1)
    // `to`, not `level`: the record shape OWNS `level` and drops a caller field
    // of that name, so a raise reported under `level` would say nothing.
    expect(raised[0]).toMatchObject({ to: 'debug' })
    forwarding.dispose()
  })

  it('stops writing to the sink once disposed', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })
    forwarding.raise({ level: 'info', ttlMs: 600_000 })
    vi.advanceTimersByTime(10_000)
    t.batches.length = 0

    forwarding.dispose()
    log.warn('after dispose')
    vi.advanceTimersByTime(10_000)

    expect(t.batches).toEqual([])
  })
})

describe('toWireRecord', () => {
  it('clamps an oversized field and says so, rather than letting the batch be refused', () => {
    const wire = toWireRecord({
      ts: '2026-08-11T14:03:22.847Z',
      level: 'warn',
      ns: 'daemon:git',
      msg: 'x'.repeat(20_000),
    })

    expect(wire.msg).toHaveLength(8192)
    expect(wire.truncated).toBe(true)
  })

  it('keeps free-form fields, which are the point of the record shape', () => {
    const wire = toWireRecord({
      ts: '2026-08-11T14:03:22.847Z',
      level: 'debug',
      ns: 'daemon:pty',
      msg: 'resize dropped',
      sessionId: 's1',
      durationMs: 12,
    })

    expect(wire).toMatchObject({ sessionId: 's1', durationMs: 12 })
    expect(wire.truncated).toBeUndefined()
  })

  it('drops the fields rather than the record when they will not encode', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const wire = toWireRecord({
      ts: '2026-08-11T14:03:22.847Z',
      level: 'error',
      ns: 'daemon:pty',
      msg: 'it broke',
      cyclic,
    })

    expect(wire.msg).toBe('it broke')
    expect(wire.cyclic).toBeUndefined()
    expect(wire.fieldsDropped).toBeTypeOf('string')
  })

  it('clamps a serialized error’s parts too', () => {
    const wire = toWireRecord({
      ts: '2026-08-11T14:03:22.847Z',
      level: 'error',
      ns: 'daemon:pty',
      msg: 'it broke',
      err: { name: 'Error', message: 'm'.repeat(20_000), stack: 's'.repeat(200_000) },
    })

    expect(wire.err?.message).toHaveLength(8192)
    expect(wire.err?.stack).toHaveLength(8192 * 4)
    expect(wire.truncated).toBe(true)
  })
})
