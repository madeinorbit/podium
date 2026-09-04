/**
 * The daemon half of fleet log capture (POD-3156, POD-3184) — the promises, not
 * the plumbing:
 *
 *  - `warn`+ leaves a daemon continuously, and nothing below it does;
 *  - an `error` brings the recorder's unsent tail with it, once per burst;
 *  - a daemon co-resident with its server stays silent until it is raised;
 *  - a raise ships the minute BEFORE it, from the flight recorder;
 *  - the raise expires by itself, and expiry stops the DETAIL, not the stream;
 *  - a link that is down costs records at a bounded rate, and says how many;
 *  - the sink cannot feed itself through the socket it is describing;
 *  - a FLOORED namespace clears the steady stream at its floor, so an update's
 *    phases reach the coordinator without anybody having raised the daemon.
 */

import {
  clearSinks,
  createLogger,
  resetLevels,
  setLogLevel,
  setNamespaceFloor,
} from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DaemonLogBatch, installDaemonLogForwarding, toWireRecord } from './log-forward'

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
  /** THE DEFAULT POSTURE (POD-3184). A machine with a problem must not be silent
   *  just because nobody knew to ask it a question. */
  it('forwards warn and above with nobody having asked', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    log.warn('nobody asked, and it still went out')
    vi.advanceTimersByTime(10_000)

    expect(messages(t.batches)).toContain('nobody asked, and it still went out')
    expect(forwarding.status()).toMatchObject({ forwarding: true, raised: false })
    forwarding.dispose()
  })

  /** LOW VOLUME BY CONSTRUCTION. `info` is what a healthy daemon spends all day
   *  emitting, and it is exactly what does not cross the network for free. */
  it('forwards nothing below warn until a raise says otherwise', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    log.info('routine')
    log.debug('detail')
    vi.advanceTimersByTime(10_000)

    expect(t.batches).toEqual([])
    forwarding.dispose()
  })

  /**
   * THE BIGGEST GAIN. The recorder already runs at `trace` on every daemon; an
   * error that shipped alone said THAT something broke and threw away the minute
   * saying WHY.
   */
  it('an error brings the recorder tail that explains it', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    log.debug('opened the repository')
    log.info('started the fetch')
    log.error('the fetch failed')
    vi.advanceTimersByTime(10_000)

    // In emission order, with the error last: the payload reads as a narrative.
    expect(messages(t.batches)).toEqual([
      'opened the repository',
      'started the fetch',
      'the fetch failed',
    ])
    forwarding.dispose()
  })

  /** ONE WINDOW PER BURST, not one window each. A failure that fires twenty
   *  times must not put the same minute on the wire twenty times. */
  it('does not re-send a window a previous error already shipped', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    log.debug('the context')
    log.error('first')
    log.error('second')
    vi.advanceTimersByTime(10_000)

    expect(messages(t.batches).filter((m) => m === 'the context')).toHaveLength(1)
    forwarding.dispose()
  })

  /** The tail is BOUNDED. The ring holds 500; an error must not put ten frames
   *  on the wire for one failure. */
  it('caps how far back an error reaches', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({
      boot: 'info',
      send: t.send,
      errorContext: 3,
    })

    for (let i = 0; i < 20; i++) log.debug(`step ${i}`)
    log.error('broke')
    vi.advanceTimersByTime(10_000)

    const sent = messages(t.batches)
    expect(sent).toEqual(['step 17', 'step 18', 'step 19', 'broke'])
    forwarding.dispose()
  })

  /**
   * THE CO-RESIDENT EXCEPTION. These records are already on this machine's disk,
   * written by this same process; the steady stream would file a second copy.
   */
  it('a daemon co-resident with its server stays silent until raised', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({
      boot: 'info',
      send: t.send,
      coResident: true,
    })

    log.warn('already on this disk')
    log.error('and so is this')
    vi.advanceTimersByTime(10_000)
    expect(t.batches).toEqual([])
    expect(forwarding.status().forwarding).toBe(false)

    // A RAISE STILL FORWARDS THERE, which is what makes an all-in-one install
    // answerable — and it is bounded, so the duplicate is too.
    forwarding.raise({ level: 'debug', ttlMs: 60_000 })
    log.debug('under the raise')
    vi.advanceTimersByTime(10_000)

    expect(messages(t.batches)).toContain('under the raise')
    expect(messages(t.batches)).toContain('already on this disk')
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

  /**
   * THE WAY BACK THAT DOES NOT DEPEND ON ANYBODY REMEMBERING. A daemon runs for
   * weeks; nothing reloads it.
   *
   * Since POD-3184 expiry puts the DETAIL back, not the stream: `warn`+ keeps
   * flowing afterwards, and `debug` stops.
   */
  it('the raise expires by itself and the detail stops', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    forwarding.raise({ level: 'debug', ttlMs: 60_000 })
    vi.advanceTimersByTime(60_000)
    t.batches.length = 0
    log.debug('long after the window')
    log.warn('still watching, though')
    vi.advanceTimersByTime(10_000)

    expect(forwarding.status()).toMatchObject({
      forwarding: true,
      raised: false,
      level: 'info',
      expiresAt: null,
    })
    expect(messages(t.batches)).not.toContain('long after the window')
    expect(messages(t.batches)).toContain('still watching, though')
    forwarding.dispose()
  })

  /** The explanation for why the detail stops is IN the central file, not only
   *  in the daemon's own journal. */
  it('forwards the expiry notice', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    forwarding.raise({ level: 'debug', ttlMs: 60_000 })
    vi.advanceTimersByTime(70_000)

    expect(messages(t.batches)).toContain('daemon log level restored')
    forwarding.dispose()
  })

  it('a null level ends the raise early and restores the boot default', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'warn', send: t.send })

    forwarding.raise({ level: 'trace', ttlMs: 60_000 })
    forwarding.raise({ level: null })
    log.debug('after the reset')
    vi.advanceTimersByTime(10_000)

    expect(forwarding.status()).toMatchObject({ raised: false, level: 'warn' })
    expect(messages(t.batches)).not.toContain('after the reset')
    forwarding.dispose()
  })

  /** A CO-RESIDENT DAEMON DOES go quiet again — there the raise was the only
   *  reason anything was leaving the process. */
  it('a co-resident daemon stops forwarding when its raise expires', () => {
    const t = transport()
    const forwarding = installDaemonLogForwarding({
      boot: 'info',
      send: t.send,
      coResident: true,
    })

    forwarding.raise({ level: 'debug', ttlMs: 60_000 })
    vi.advanceTimersByTime(60_000)
    const afterExpiry = t.batches.length
    log.warn('long after the window')
    vi.advanceTimersByTime(10_000)

    expect(forwarding.status()).toMatchObject({ forwarding: false, raised: false })
    expect(t.batches.length).toBe(afterExpiry)
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

/**
 * THE STEADY FLOOR IS PER-NAMESPACE (POD-3224).
 *
 * `warn` is right for a daemon's own chatter and wrong for the update path,
 * whose whole purpose is to be read later. Before this, a grant that downloaded,
 * verified, swapped and restarted wrote five `info` lines that never left the
 * machine — and the raise that would have captured them is the one nobody thinks
 * to make until after the update they wanted to understand.
 */
describe('a floored namespace in the steady stream', () => {
  const updateLog = createLogger('daemon:update')

  it('forwards a floored namespace at its floor, with nobody having raised anything', () => {
    setNamespaceFloor('daemon:update', 'info')
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    updateLog.info('update bundle swapped')
    log.info('routine daemon chatter')
    vi.advanceTimersByTime(10_000)

    expect(messages(t.batches)).toContain('update bundle swapped')
    // The floor lifts ONE namespace, not the steady level everywhere.
    expect(messages(t.batches)).not.toContain('routine daemon chatter')
    expect(forwarding.status()).toMatchObject({ raised: false })
    forwarding.dispose()
  })

  it('keeps the floored namespace bounded: debug still stays on the machine', () => {
    setNamespaceFloor('daemon:update', 'info')
    setLogLevel('debug')
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'debug', send: t.send })

    updateLog.debug('update status reported')
    vi.advanceTimersByTime(10_000)

    // A per-frame record is exactly what the floor must not put on the wire.
    expect(messages(t.batches)).not.toContain('update status reported')
    forwarding.dispose()
  })

  it('cannot QUIETEN a namespace: a floor below the steady level changes nothing', () => {
    // `error` is stricter than the steady `warn`. A threshold would silence this
    // namespace's warnings; a floor composes upwards only, so it must not.
    setNamespaceFloor('daemon:update', 'error')
    const t = transport()
    const forwarding = installDaemonLogForwarding({ boot: 'info', send: t.send })

    updateLog.warn('the grant was refused by this machine')
    vi.advanceTimersByTime(10_000)

    expect(messages(t.batches)).toContain('the grant was refused by this machine')
    forwarding.dispose()
  })
})
