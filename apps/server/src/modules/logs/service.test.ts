/**
 * Client log ingestion — the behaviours chunk 3 promises, not the plumbing:
 * records land tagged in a per-origin file, a crash is durable BEFORE the
 * optional telemetry hop, and that hop reaches the real crash tier only when
 * the user has consented.
 *
 * The last one is tested against a REAL `TelemetryEmitter` with a real config
 * and a real queue directory, not a spy. A spy would prove that this service
 * calls a method; the acceptance criterion is about what ends up in the
 * telemetry queue, and that is decided by the scrubber and the consent read
 * inside `recordCrash` — the parts a mock deletes.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forwardedLogLevel, type LogsCrashInput, type LogsForwardInput } from '@podium/commands'
import { LEVELS } from '@podium/logger'
import { asMachineId } from '@podium/model'
import type { PodiumConfig } from '@podium/runtime/config'
import { createCrashStore } from '@podium/runtime/crash-store'
import { readQueue, TelemetryEmitter } from '@podium/telemetry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogIngestService, originKey, taggedRecord } from './service'

const INSTALL = '/opt/podium'
const INSTALL_ID = '3f9c1a2e-0000-4000-8000-000000000000'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-logs-ingest-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const record = (msg: string, level: 'warn' | 'debug' = 'warn') => ({
  ts: '2026-08-11T14:03:22.847Z',
  level,
  ns: 'web:app',
  msg,
})

const batch = (over: Partial<LogsForwardInput> = {}): LogsForwardInput => ({
  origin: { role: 'web', v: '0.1.3', machineId: asMachineId('m1') },
  records: [record('one'), record('two', 'debug')],
  ...over,
})

const crashInput = (over: Partial<LogsCrashInput> = {}): LogsCrashInput => ({
  origin: { role: 'web', v: '0.1.3', machineId: asMachineId('m1') },
  err: {
    name: 'TypeError',
    message: 'failed to read /home/alice/acme/private.key',
    stack: [
      'TypeError: failed to read /home/alice/acme/private.key',
      `    at handleSession (${INSTALL}/apps/server/src/router.ts:412:15)`,
    ].join('\n'),
  },
  snapshot: [record('right before it died', 'debug')],
  ...over,
})

/** Ingestion writing into a temp dir, with a crash store on the same clock. */
function service(overrides: { telemetryDir?: string } = {}) {
  void overrides
  let n = 0
  return new LogIngestService({
    dir: join(dir, 'clients'),
    crashStore: createCrashStore({
      dir: join(dir, 'crashes'),
      id: () => {
        n += 1
        return `id${n}`
      },
    }),
  })
}

const linesIn = (file: string): Record<string, unknown>[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

describe('forwarded client logs', () => {
  it('writes the batch to a per-origin NDJSON file, tagged with the origin', async () => {
    const ingest = service()

    const result = ingest.forward(batch())

    expect(result).toEqual({ accepted: 2, origin: 'web-m1' })
    const lines = linesIn(join(dir, 'clients', 'web-m1.ndjson'))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      ts: '2026-08-11T14:03:22.847Z',
      level: 'warn',
      ns: 'web:app',
      msg: 'one',
      role: 'web',
      v: '0.1.3',
      machineId: 'm1',
    })
    await ingest.close()
  })

  it('separates origins into their own files', async () => {
    const ingest = service()

    ingest.forward(batch())
    ingest.forward(
      batch({ origin: { role: 'mobile', machineId: asMachineId('m2') }, records: [record('m')] }),
    )

    expect(linesIn(join(dir, 'clients', 'web-m1.ndjson'))).toHaveLength(2)
    expect(linesIn(join(dir, 'clients', 'mobile-m2.ndjson'))).toHaveLength(1)
    await ingest.close()
  })

  it('keeps a DEBUG record the client chose to forward', async () => {
    // The client already applied its own threshold; a second gate here would
    // silently discard the records an operator just turned on for one user.
    const ingest = service()

    ingest.forward(batch({ records: [record('turned up for diagnosis', 'debug')] }))

    expect(linesIn(join(dir, 'clients', 'web-m1.ndjson'))[0]).toMatchObject({ level: 'debug' })
    await ingest.close()
  })

  it('caps how many distinct origins get their own file', async () => {
    const ingest = new LogIngestService({
      dir: join(dir, 'clients'),
      crashStore: createCrashStore({ dir: join(dir, 'crashes') }),
      maxOriginFiles: 2,
    })

    for (const machineId of ['a', 'b', 'c', 'd']) {
      ingest.forward(
        batch({
          origin: { role: 'web', machineId: asMachineId(machineId) },
          records: [record(machineId)],
        }),
      )
    }

    // Two named files, then everything else shares one — not one file per
    // machineId, which is how a client that mints a fresh id per launch would
    // otherwise turn the log dir into a directory of single-line files.
    expect(linesIn(join(dir, 'clients', 'web-a.ndjson'))).toHaveLength(1)
    expect(linesIn(join(dir, 'clients', 'web-b.ndjson'))).toHaveLength(1)
    expect(linesIn(join(dir, 'clients', 'other.ndjson')).map((r) => r.msg)).toEqual(['c', 'd'])
    await ingest.close()
  })

  it('cannot be talked into writing outside the log dir', () => {
    // Separators become underscores and a leading run of them is stripped, so
    // the traversal collapses to a plain filename in the clients dir.
    expect(originKey({ role: '../../etc', machineId: asMachineId('passwd') })).toBe('etc-passwd')
    expect(originKey({ role: '/', machineId: asMachineId('/') })).toBe('unknown')
    expect(originKey({ role: 'WEB', machineId: asMachineId('M 1') })).toBe('web-m_1')
    // The property the three cases are examples of: no separator survives, at
    // any position, so the key can only ever name a file in one directory.
    // The NUL case is written as an ESCAPE, never as a literal byte: a raw NUL
    // makes this file binary to grep, which is how the epic review came to
    // report the level-enum assertion below as missing when it is right there.
    for (const role of ['a/b', 'a\\b', '..', 'a/../..', '\u0000/x']) {
      expect(originKey({ role })).not.toMatch(/[/\\]/)
    }
  })

  it('lets the server own the origin tags rather than the payload', () => {
    // A client that claims to be the server in its own record fields does not
    // get to say so in the file the operator groups by role.
    const tagged = taggedRecord(
      { ...record('x'), role: 'server', v: '9.9.9' },
      {
        role: 'web',
        v: '0.1.3',
      },
    )
    expect(tagged).toMatchObject({ role: 'web', v: '0.1.3' })
  })

  it('reports zero accepted rather than throwing when the sink cannot be built', () => {
    const ingest = new LogIngestService({
      dir: join(dir, 'clients'),
      crashStore: createCrashStore({ dir: join(dir, 'crashes') }),
      createSink: () => {
        throw new Error('no space left on device')
      },
    })

    expect(ingest.forward(batch())).toEqual({ accepted: 0, origin: 'web-m1' })
  })
})

describe('crash events', () => {
  it('stores the error and the whole ring buffer', () => {
    const ingest = service()

    const result = ingest.crash(crashInput())

    expect(result.id).toBe('id1')
    const [stored] = createCrashStore({ dir: join(dir, 'crashes') }).list()
    expect(stored?.err.message).toContain('private.key')
    expect(stored?.snapshot).toHaveLength(1)
    expect(stored?.origin).toEqual({ role: 'web', v: '0.1.3', machineId: 'm1' })
  })

  it('keeps the durable event when the telemetry hop throws', () => {
    const ingest = service()
    const telemetry = {
      recordCrash: vi.fn(() => {
        throw new Error('emitter exploded')
      }),
    }

    expect(() => ingest.crash(crashInput(), telemetry)).not.toThrow()
    expect(createCrashStore({ dir: join(dir, 'crashes') }).list()).toHaveLength(1)
  })

  it('hands the emitter the wire object, unmodified and unscrubbed', () => {
    // The scrubber is the single gate and it accepts the serialized shape
    // directly (design addendum). Rebuilding an `Error` here would report every
    // unrecognised client error type as `Error` — an accepted member of the
    // closed enum — and poison the crash-signature cooldown.
    const ingest = service()
    const telemetry = { recordCrash: vi.fn() }
    const input = crashInput()

    ingest.crash(input, telemetry)

    expect(telemetry.recordCrash).toHaveBeenCalledWith(input.err)
  })
})

/** The acceptance criterion, end to end, against the real emitter. */
describe('the crash tier hop', () => {
  const emitterFor = (config: PodiumConfig) =>
    new TelemetryEmitter({
      stateDir: dir,
      installRoot: INSTALL,
      version: '1.4.2',
      gauges: () => ({ machines: 1 }),
      env: {},
      loadConfig: () => config,
      now: () => 1_700_000_000_000,
      random: () => 0,
      platform: 'linux',
      arch: 'x64',
    })

  const consent = (crash: 'on' | 'off'): PodiumConfig => ({
    telemetry: {
      usage: 'on',
      crash,
      installId: INSTALL_ID,
      since: 1_700_000_000_000 - 3 * 86_400_000,
    },
  })

  it('queues a scrubbed crash report when the crash tier is on', () => {
    const ingest = service()

    ingest.crash(crashInput(), emitterFor(consent('on')))

    const queued = readQueue(dir).filter((r) => 'errorType' in r)
    expect(queued).toEqual([
      expect.objectContaining({
        errorType: 'TypeError',
        frames: [{ file: 'apps/server/src/router.ts', line: 412, fn: 'handleSession' }],
      }),
    ])
    // The message never enters the payload — the scrubber drops it whole.
    expect(JSON.stringify(queued)).not.toContain('private.key')
    expect(JSON.stringify(queued)).not.toContain('alice')
  })

  it('keeps the client’s own error TYPE rather than flattening it to Error', () => {
    // What the serialized-crash widening buys, observed at the queue: a client
    // TypeError arrives as a TypeError, and an application error the enum does
    // not know folds to 'Other' instead of colonising the 'Error' signature.
    const ingest = service()
    const emitter = emitterFor(consent('on'))

    ingest.crash(crashInput(), emitter)
    ingest.crash(
      crashInput({
        err: {
          name: 'PodiumSyncError',
          message: 'boom',
          stack: `PodiumSyncError: boom\n    at sync (${INSTALL}/packages/sync/src/ledger.ts:9:1)`,
        },
      }),
      emitter,
    )

    expect(readQueue(dir).flatMap((r) => ('errorType' in r ? [r.errorType] : []))).toEqual([
      'TypeError',
      'Other',
    ])
  })

  it('queues nothing when the crash tier is off — but still stores the event', () => {
    const ingest = service()

    ingest.crash(crashInput(), emitterFor(consent('off')))

    expect(readQueue(dir).filter((r) => 'errorType' in r)).toEqual([])
    expect(createCrashStore({ dir: join(dir, 'crashes') }).list()).toHaveLength(1)
  })
})

describe('the wire level enum', () => {
  it('is exactly the logger’s levels — the restatement cannot drift', () => {
    // `@podium/commands` may not import `@podium/logger` (L1, and the logger is
    // zod-free), so the enum is restated there. This is the check that keeps the
    // restatement honest, in the one place both imports are legal.
    expect(forwardedLogLevel.options).toEqual([...LEVELS])
  })
})
