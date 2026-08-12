import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CRASH_MAX_EVENTS, type CrashEvent } from '@podium/runtime/crash-store'
import type { RunRecord } from '@podium/runtime/run-registry'
import { describe, expect, it } from 'vitest'
import {
  humanUptime,
  logFilesFor,
  parseExportCrashArgs,
  parseLogsArgs,
  renderCrashBundle,
  renderLogLine,
  renderStatus,
  selectedUnits,
} from './cli-lifecycle'

const T0 = Date.parse('2026-07-06T12:00:00.000Z')

describe('humanUptime', () => {
  it('formats seconds/minutes/hours/days', () => {
    expect(humanUptime(new Date(T0).toISOString(), T0 + 5_000)).toBe('5s')
    expect(humanUptime(new Date(T0).toISOString(), T0 + 5 * 60_000)).toBe('5m')
    expect(humanUptime(new Date(T0).toISOString(), T0 + 3 * 3600_000)).toBe('3h')
    expect(humanUptime(new Date(T0).toISOString(), T0 + 2 * 86400_000)).toBe('2d')
  })
  it('handles a bad timestamp', () => {
    expect(humanUptime('not-a-date', T0)).toBe('unknown')
  })
})

const rec = (over: Partial<RunRecord>): RunRecord => ({
  role: 'server',
  pid: 100,
  startedAt: new Date(T0).toISOString(),
  ...over,
})

describe('renderStatus', () => {
  it('shows a named identity and its derived runtime port', () => {
    const out = renderStatus({
      live: [],
      config: { mode: 'server' },
      instanceId: 'blue',
      port: 23000,
      nowMs: Date.now(),
    })
    expect(out).toContain('Podium [blue]')
    expect(out).toContain('http://localhost:23000')
    expect(selectedUnits('blue')).toEqual([
      'podium-blue-daemon.service',
      'podium-blue-janitor.service',
      'podium-blue-server.service',
    ])
  })
  it('a host (all-in-one) box reports the split — server + janitor + daemon', () => {
    const out = renderStatus({
      live: [
        rec({ role: 'server', pid: 42, port: 18787 }),
        rec({ role: 'janitor', pid: 44 }),
        rec({ role: 'daemon', pid: 43 }),
      ],
      config: { mode: 'all-in-one', persistence: 'detached', port: 18787 },
      nowMs: T0 + 90_000,
    })
    expect(out).toContain('● server  up :18787  pid 42')
    expect(out).toContain('● janitor  up  pid 44')
    expect(out).toContain('● daemon  up  pid 43')
  })

  it('an in-process all-in-one record (desktop sidecar) is surfaced directly', () => {
    const out = renderStatus({
      live: [rec({ role: 'all-in-one', pid: 42, port: 18787 })],
      config: { mode: 'all-in-one', port: 18787 },
      nowMs: T0,
    })
    expect(out).toContain('● all-in-one  up :18787')
  })

  it('shows a down component when nothing is live for the mode', () => {
    const out = renderStatus({
      live: [],
      config: { mode: 'server', port: 18787 },
      nowMs: T0,
    })
    expect(out).toContain('○ server  down')
    expect(out).toContain('○ janitor  down')
  })

  it('reports a healthy server when its advisory run record is missing', () => {
    const out = renderStatus({
      live: [],
      config: { mode: 'server', port: 18787 },
      port: 18787,
      serverHealthy: true,
      nowMs: T0,
    })
    expect(out).toContain('● server  up :18787  (health)')
    expect(out).not.toContain('○ server  down')
  })

  it('prefers publicUrl for the URL line', () => {
    const out = renderStatus({
      live: [],
      config: { mode: 'daemon', publicUrl: 'https://box.ts.net' },
      nowMs: T0,
    })
    expect(out).toContain('URL: https://box.ts.net')
    expect(out).toContain('○ daemon  down')
  })

  describe('daemon connectivity truthfulness (#19)', () => {
    it('a live PID no longer implies "up" — the daemon-written link state is shown', () => {
      const out = renderStatus({
        live: [rec({ role: 'daemon', pid: 7 })],
        config: { mode: 'daemon', persistence: 'systemd' },
        nowMs: T0 + 65_000,
        connectivity: {
          state: 'disconnected',
          serverUrl: 'wss://relay.example',
          lastHelloOkAt: new Date(T0).toISOString(),
          lastError: 'ECONNREFUSED',
          retryBackoffMs: 5000,
          updatedAt: new Date(T0 + 60_000).toISOString(),
        },
      })
      expect(out).toContain('● daemon  up') // the process exists…
      expect(out).toContain('disconnected — ECONNREFUSED') // …but the link is honest
      expect(out).toContain('wss://relay.example')
      expect(out).toContain('retrying every ~5s')
      expect(out).toContain('last contact 1m ago')
    })

    it('a blocked daemon explains the rejection and the re-pair recovery path', () => {
      const out = renderStatus({
        live: [],
        config: { mode: 'daemon', persistence: 'systemd' },
        nowMs: T0,
        connectivity: {
          state: 'blocked',
          serverUrl: 'wss://relay.example',
          blockedReason: 'pairRejected: bad code',
          updatedAt: new Date(T0).toISOString(),
        },
      })
      expect(out).toContain('BLOCKED — pairRejected: bad code')
      expect(out).toContain('podium set-server <join-code>')
    })

    it('a connected daemon reports the server URL and last contact', () => {
      const out = renderStatus({
        live: [rec({ role: 'daemon', pid: 7 })],
        config: { mode: 'daemon' },
        nowMs: T0 + 3_000,
        connectivity: {
          state: 'connected',
          serverUrl: 'wss://relay.example',
          lastHelloOkAt: new Date(T0).toISOString(),
          updatedAt: new Date(T0).toISOString(),
        },
      })
      expect(out).toContain('connected')
      expect(out).toContain('last contact 3s ago')
    })
  })

  it('unknown mode falls back to listing every role that is live', () => {
    const out = renderStatus({
      live: [rec({ role: 'daemon', pid: 7 })],
      config: {},
      nowMs: T0,
    })
    expect(out).toContain('● daemon  up')
  })
})

describe('podium logs', () => {
  describe('parseLogsArgs', () => {
    it('reads the follow and pretty flags in either spelling', () => {
      expect(parseLogsArgs(['-f'])).toMatchObject({ follow: true, pretty: false })
      expect(parseLogsArgs(['--follow'])).toMatchObject({ follow: true })
      expect(parseLogsArgs(['--pretty'])).toMatchObject({ pretty: true, follow: false })
      expect(parseLogsArgs([])).toMatchObject({ follow: false, pretty: false, components: [] })
    })

    it('treats bare words as a component filter, in any order with the flags', () => {
      expect(parseLogsArgs(['server', '-f']).components).toEqual(['server'])
      expect(parseLogsArgs(['--pretty', 'daemon', 'janitor']).components).toEqual([
        'daemon',
        'janitor',
      ])
    })
  })

  describe('logFilesFor', () => {
    it('tails the structured file AND the stray-output file, and skips what is absent', () => {
      const dir = mkdtempSync(join(tmpdir(), 'podium-logs-'))
      try {
        writeFileSync(join(dir, 'server.ndjson'), '')
        // Raw stdout/stderr from the detached spawn: a bun panic lands here and
        // nowhere else, so it must not be filtered out.
        writeFileSync(join(dir, 'server.log'), '')
        writeFileSync(join(dir, 'daemon.ndjson'), '')
        expect(logFilesFor([], dir)).toEqual([
          join(dir, 'server.ndjson'),
          join(dir, 'server.log'),
          join(dir, 'daemon.ndjson'),
        ])
        expect(logFilesFor(['daemon'], dir)).toEqual([join(dir, 'daemon.ndjson')])
        expect(logFilesFor(['janitor'], dir)).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('a NAMED component also finds a forwarded client’s per-origin file (POD-1947)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'podium-logs-'))
      try {
        mkdirSync(join(dir, 'clients'))
        writeFileSync(join(dir, 'clients', 'web-m2.ndjson'), '')
        writeFileSync(join(dir, 'server.ndjson'), '')
        // The origin `podium logs level` just printed is what a reader types next.
        expect(logFilesFor(['web-m2'], dir)).toEqual([join(dir, 'clients', 'web-m2.ndjson')])
        // …but the bare command still means THIS host's processes. A default that
        // swept in every client that ever forwarded would bury the server's own.
        expect(logFilesFor([], dir)).toEqual([join(dir, 'server.ndjson')])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('includes the desktop shell’s native records in the default tail', () => {
      // The Rust half of the desktop app writes the same NDJSON shape into the
      // same directory (apps/desktop/src-tauri/src/logging.rs). A file nobody
      // tails is a file nobody reads, so its role has to be in the default set —
      // this is the assertion that fails if the two names ever drift apart.
      const dir = mkdtempSync(join(tmpdir(), 'podium-logs-'))
      try {
        writeFileSync(join(dir, 'desktop-native.ndjson'), '')
        expect(logFilesFor([], dir)).toEqual([join(dir, 'desktop-native.ndjson')])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('renderLogLine', () => {
    const record = {
      ts: '2026-08-11T14:03:22.847Z',
      level: 'warn',
      ns: 'daemon:pty',
      msg: 'resize dropped',
      sessionId: 's1',
      role: 'daemon',
    }

    it('renders a record as one readable line', () => {
      const out = renderLogLine(JSON.stringify(record))
      expect(out).toContain('14:03:22.847')
      expect(out).toContain('WARN ')
      expect(out).toContain('daemon:pty')
      expect(out).toContain('resize dropped')
      expect(out).toContain('sessionId=s1')
    })

    it('puts a serialized error stack on its own line', () => {
      const out = renderLogLine(
        JSON.stringify({
          ...record,
          err: { name: 'TypeError', message: 'x', stack: 'TypeError: x\n  at f' },
        }),
      )
      expect(out).toContain('\nTypeError: x\n  at f')
    })

    it('passes a non-record line through unchanged', () => {
      // `<role>.log` is full of these by design. A reader who asked for readable
      // output is worse off if the one raw stack trace goes missing.
      expect(renderLogLine('panic: something bun printed')).toBe('panic: something bun printed')
      expect(renderLogLine('')).toBe('')
      expect(renderLogLine('{not json')).toBe('{not json')
      // JSON, but not a log record — no ts/level/ns to render.
      expect(renderLogLine('{"hello":"world"}')).toBe('{"hello":"world"}')
    })
  })
})

describe('podium logs export-crash', () => {
  const event = (message: string): CrashEvent => ({
    id: 'abc123',
    receivedAt: '2026-08-11T14:03:22.847Z',
    origin: { role: 'web', v: '0.1.3', machineId: 'm1' },
    err: { name: 'TypeError', message, stack: 'TypeError: x\n  at f' },
    snapshot: [{ ts: '2026-08-11T14:03:22.800Z', level: 'debug', ns: 'web:app', msg: 'before' }],
  })

  describe('parseExportCrashArgs', () => {
    it('defaults to the retention ceiling and no output file', () => {
      expect(parseExportCrashArgs([])).toEqual({ limit: CRASH_MAX_EVENTS })
    })

    it('reads --limit and --out in both spellings', () => {
      expect(parseExportCrashArgs(['--limit', '3'])).toEqual({ limit: 3 })
      expect(parseExportCrashArgs(['--limit=3'])).toEqual({ limit: 3 })
      expect(parseExportCrashArgs(['--out', '/tmp/b.json'])).toMatchObject({ out: '/tmp/b.json' })
      expect(parseExportCrashArgs(['--out=/tmp/b.json'])).toMatchObject({ out: '/tmp/b.json' })
    })

    it('ignores a nonsense limit rather than exporting zero events', () => {
      // `--limit 0` and `--limit banana` both mean the user mistyped; silently
      // writing an empty bundle would look like "there were no crashes".
      expect(parseExportCrashArgs(['--limit', '0']).limit).toBe(CRASH_MAX_EVENTS)
      expect(parseExportCrashArgs(['--limit', 'banana']).limit).toBe(CRASH_MAX_EVENTS)
      expect(parseExportCrashArgs(['--out', '--limit', '2'])).toEqual({ limit: 2 })
    })
  })

  describe('renderCrashBundle', () => {
    it('carries the events whole, under an envelope that dates and names them', () => {
      const bundle = JSON.parse(
        renderCrashBundle([event('boom')], {
          exportedAt: '2026-08-12T09:00:00.000Z',
          instanceId: 'inst-1',
          version: '1.4.2',
        }),
      )
      expect(bundle).toMatchObject({
        kind: 'podium-crash-bundle',
        version: 1,
        exportedAt: '2026-08-12T09:00:00.000Z',
        instanceId: 'inst-1',
        podiumVersion: '1.4.2',
        count: 1,
      })
      expect(bundle.events[0].snapshot).toHaveLength(1)
    })

    it('does NOT scrub — the export is the deliberate full hand-off', () => {
      // The scrubbed path is telemetry.recordCrash, gated by consent. This one
      // is a conscious user act, so it keeps the message and the stack that
      // make a crash diagnosable.
      const bundle = renderCrashBundle([event('failed to read /home/alice/private.key')], {
        exportedAt: '2026-08-12T09:00:00.000Z',
      })
      expect(bundle).toContain('/home/alice/private.key')
      expect(bundle).toContain('at f')
    })
  })
})
