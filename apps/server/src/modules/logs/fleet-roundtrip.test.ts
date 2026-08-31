/**
 * FLEET DAEMON LOG CAPTURE, END TO END (POD-3156) — the acceptance the issue
 * asks for, as far as one process can hold it.
 *
 * The unit suites either side of this one each pin half of the feature and
 * neither can see the seam: the daemon module is tested against a fake
 * transport, and the store against a hand-built batch. That leaves the exact
 * failure this design is most exposed to — a record the daemon considers fine
 * and the SERVER'S SCHEMA REFUSES, which wedges a FIFO queue forever — invisible
 * to both.
 *
 * So this drives the real chain: the operator's level director produces the real
 * control frame; the real daemon-side forwarding module applies it and emits a
 * batch; the batch goes through `parseDaemonMessage`, which is the same
 * validation the socket performs; the real `DaemonMux` routes it under a machine
 * principal resolved from the (here, injected) authenticated transport; and the
 * real `FleetLogStore` writes it to a real file, which is then read back.
 *
 * WHAT IS NOT HERE is the socket and the two hosts. Those cannot be a hermetic
 * test, and pretending otherwise with a mock WebSocket would prove less than
 * this does — every schema, every table and every filename rule in the path is
 * the production one.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearSinks, createLogger, resetLevels, setLogLevel } from '@podium/logger'
import { asMachineId, type MachineId } from '@podium/model'
import { asCapabilityRef, asDeviceId, type MachinePrincipal } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { encodeDaemonMessage, parseDaemonMessage } from '@podium/protocol/daemon'
import { installDaemonLogForwarding } from '@podium/runtime/log-forward'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonMux } from '../../gateway/daemon-mux'
import type { DaemonFeaturePorts } from '../../gateway/daemon-ports'
import { FleetLogLevelDirector } from './fleet-director'
import { FleetLogStore } from './fleet-store'

const FLATBLOCK = asMachineId('flatblock')

const principalFor = (machine: MachineId): MachinePrincipal => ({
  kind: 'machine',
  machine,
  device: asDeviceId(`daemon:${machine}`),
  capability: asCapabilityRef(`cap:machine:${machine}`),
})

let dir: string
beforeEach(() => {
  vi.useFakeTimers()
  clearSinks()
  resetLevels()
  setLogLevel('info')
  dir = mkdtempSync(join(tmpdir(), 'podium-fleet-e2e-'))
})
afterEach(() => {
  vi.useRealTimers()
  clearSinks()
  resetLevels()
  rmSync(dir, { recursive: true, force: true })
})

const read = (file: string): Record<string, unknown>[] =>
  readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

/**
 * One host: a daemon with the real forwarding module, wired to a `send` that
 * encodes, re-parses and routes the frame exactly as the socket pair does.
 */
function host(
  machine: MachineId,
  mux: DaemonMux,
  boot: 'info' | 'warn' = 'info',
  coResident = false,
) {
  const forwarding = installDaemonLogForwarding({
    boot,
    coResident,
    send: (batch) => {
      // ENCODE AND RE-PARSE. This is the whole point of the seam: a record the
      // daemon clamped incorrectly would be refused HERE, exactly as the server
      // would refuse it, rather than sailing through an object handoff.
      const frame = parseDaemonMessage(
        encodeDaemonMessage({
          type: 'daemonLogBatch',
          records: batch.records,
          ...(batch.dropped !== undefined ? { dropped: batch.dropped } : {}),
          v: '0.1.3',
        }),
      )
      mux.routeDaemonFrame(principalFor(machine), frame)
      return true
    },
  })
  return {
    forwarding,
    /** What `apps/daemon/src/control/logs.ts` does with the frame, verbatim. */
    apply: (msg: ControlMessage) => {
      if (msg.type !== 'setDaemonLogLevel') throw new Error(`not for this handler: ${msg.type}`)
      forwarding.raise({
        level: msg.level,
        ...(msg.ttlMs !== undefined ? { ttlMs: msg.ttlMs } : {}),
      })
    },
  }
}

/** The server: a real store behind a real mux, with the other ports absent —
 *  nothing in this path touches them. */
function server(store: FleetLogStore) {
  const ports = {
    logs: {
      onDaemonLogBatch: (machineId: MachineId, msg: { records: never[]; dropped?: number; v?: string }) => {
        store.append(machineId, msg)
      },
    },
  } as unknown as DaemonFeaturePorts
  return new DaemonMux({
    ports,
    bus: { emit: () => undefined } as never,
  })
}

describe('raising a remote daemon and reading its records centrally', () => {
  it('goes from the operator’s command to a per-machine file on the server', () => {
    const store = new FleetLogStore({ dir })
    const mux = server(store)
    const flatblock = host(FLATBLOCK, mux)
    const log = createLogger('daemon:pty')

    // Something goes wrong on Flatblock BEFORE anybody is looking.
    log.debug('resize dropped', { sessionId: 's1' })

    // The operator, on Ludovico, raises exactly that machine.
    const sent: ControlMessage[] = []
    const director = new FleetLogLevelDirector({
      onlineMachineIds: () => [FLATBLOCK],
      machineName: () => 'Flatblock',
      toMachine: (_id, msg) => void sent.push(msg),
    })
    const reply = director.setLevel({
      level: 'debug',
      ttlMs: 60_000,
      target: { machineId: FLATBLOCK },
    })
    expect(reply.daemons).toEqual([{ machineId: 'flatblock', name: 'Flatblock' }])

    // Flatblock's daemon applies it.
    for (const msg of sent) flatblock.apply(msg)
    log.debug('and here is what happened next', { sessionId: 's1' })
    vi.advanceTimersByTime(10_000)

    const lines = read('flatblock.ndjson')
    const messages = lines.map((l) => l.msg)
    // The minute BEFORE the raise is there, at a level the daemon was not
    // running at — the flight recorder is why a raise can answer a question
    // about the past.
    expect(messages).toContain('resize dropped')
    expect(messages).toContain('daemon log level raised')
    expect(messages).toContain('and here is what happened next')
    // Filed under the machine the SERVER authenticated, with its free-form
    // context intact.
    expect(lines[0]).toMatchObject({
      machineId: 'flatblock',
      role: 'daemon',
      v: '0.1.3',
      sessionId: 's1',
    })
    flatblock.forwarding.dispose()
  })

  it('stops on its own when the window expires, and says so in the file', () => {
    const store = new FleetLogStore({ dir })
    const mux = server(store)
    const flatblock = host(FLATBLOCK, mux)
    const log = createLogger('daemon:pty')

    flatblock.forwarding.raise({ level: 'debug', ttlMs: 60_000 })
    vi.advanceTimersByTime(60_000)
    log.debug('long after the window closed')
    log.warn('but this machine is still being watched')
    vi.advanceTimersByTime(30_000)

    const messages = read('flatblock.ndjson').map((l) => l.msg)
    expect(messages).toContain('daemon log level restored')
    // Expiry puts the DETAIL back, not the stream (POD-3184).
    expect(messages).not.toContain('long after the window closed')
    expect(messages).toContain('but this machine is still being watched')
    flatblock.forwarding.dispose()
  })

  /** THE DEFAULT, END TO END: a remote machine that nobody touched is legible
   *  centrally, and its error arrives with the minute that explains it. */
  it('files a remote daemon’s warnings and errors with nobody having raised it', () => {
    const store = new FleetLogStore({ dir })
    const mux = server(store)
    const flatblock = host(FLATBLOCK, mux)
    const log = createLogger('daemon:git')

    log.debug('fetching origin')
    log.warn('remote is slow')
    log.error('fetch failed', { err: new Error('timed out') })
    vi.advanceTimersByTime(10_000)

    const lines = read('flatblock.ndjson')
    const messages = lines.map((l) => l.msg)
    expect(messages).toContain('remote is slow')
    expect(messages).toContain('fetch failed')
    // The context the error dragged with it — below the forwarding threshold,
    // and the reason the failure is diagnosable at all.
    expect(messages).toContain('fetching origin')
    expect(lines[0]).toMatchObject({ machineId: 'flatblock', role: 'daemon' })
    flatblock.forwarding.dispose()
  })

  /**
   * THE WEDGE THIS SEAM EXISTS TO CATCH. An unclamped record is a frame the
   * server's schema refuses, and on a FIFO queue that batch fails identically
   * forever. The daemon clamps, so the record ARRIVES — marked, and short.
   */
  it('a record far past the wire’s size cap still arrives, clamped and marked', () => {
    const store = new FleetLogStore({ dir })
    const mux = server(store)
    const flatblock = host(FLATBLOCK, mux)
    const log = createLogger('daemon:git')

    flatblock.forwarding.raise({ level: 'debug', ttlMs: 60_000 })
    log.warn('x'.repeat(50_000))
    vi.advanceTimersByTime(10_000)

    const oversized = read('flatblock.ndjson').find((l) => String(l.msg).startsWith('xxx'))
    expect(oversized).toBeDefined()
    expect(String(oversized?.msg)).toHaveLength(8192)
    expect(oversized?.truncated).toBe(true)
    flatblock.forwarding.dispose()
  })

  it('keeps two machines’ records in two files', () => {
    const store = new FleetLogStore({ dir })
    const mux = server(store)
    const flatblock = host(FLATBLOCK, mux)
    // The SERVER'S OWN daemon: co-resident, so its records stay where they
    // already are — this machine's own log files — until somebody raises it.
    const ludovico = host(asMachineId('ludovico'), mux, 'info', true)
    const log = createLogger('daemon:pty')

    flatblock.forwarding.raise({ level: 'info', ttlMs: 60_000 })
    log.warn('from whichever daemon is forwarding')
    vi.advanceTimersByTime(10_000)

    expect(read('flatblock.ndjson').map((l) => l.msg)).toContain(
      'from whichever daemon is forwarding',
    )
    // A file per machine is filed on FIRST BATCH, and the co-resident daemon
    // sent none — so it has no file at all.
    expect(() => read('ludovico.ndjson')).toThrow()
    flatblock.forwarding.dispose()
    ludovico.forwarding.dispose()
  })
})
