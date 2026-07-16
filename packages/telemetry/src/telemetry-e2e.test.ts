/**
 * End-to-end [spec:SP-f933]: a real HTTP server standing in for the relay, the
 * real emitter, the real queue, the real config file.
 *
 * The assertion that matters: the bytes on the wire are BYTE-IDENTICAL to what
 * `podium telemetry show` printed. That is the whole trust story — if `show`
 * could print one thing while we sent another, every other promise here would
 * be worth nothing.
 *
 * (Named *-e2e* so it runs in the integration lane, not the hermetic unit lane:
 * it binds a real port.)
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '@podium/runtime/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setConsent } from './consent'
import { TelemetryEmitter } from './emitter'
import { readLastSent, readQueue } from './queue'
import { TelemetryReport } from './schema'

/** A stub relay that records exactly what arrived. */
async function stubRelay(): Promise<{
  url: string
  bodies: string[]
  headers: Record<string, string | string[] | undefined>[]
  close: () => Promise<void>
  server: Server
}> {
  const bodies: string[] = []
  const headers: Record<string, string | string[] | undefined>[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      bodies.push(raw)
      headers.push(req.headers)
      res.writeHead(204).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}/`,
    bodies,
    headers,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

let dir: string
let relay: Awaited<ReturnType<typeof stubRelay>>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'podium-telemetry-e2e-'))
  process.env.PODIUM_STATE_DIR = dir
  relay = await stubRelay()
})
afterEach(async () => {
  await relay.close()
  delete process.env.PODIUM_STATE_DIR
  delete process.env.PODIUM_TELEMETRY_ENDPOINT
  rmSync(dir, { recursive: true, force: true })
})

const emitter = () =>
  new TelemetryEmitter({
    stateDir: dir,
    installRoot: '/opt/podium',
    version: '1.4.2',
    gauges: () => ({ machines: 3 }),
    platform: 'linux',
    arch: 'x64',
  })

describe('opt in → flush → the wire', () => {
  it('sends exactly what `podium telemetry show` printed, byte for byte', async () => {
    saveConfig({ mode: 'all-in-one' })
    process.env.PODIUM_TELEMETRY_ENDPOINT = relay.url
    setConsent({ usage: 'on' })

    const e = emitter()
    e.recordSession('claude-code')
    e.recordSession('claude-code')
    e.recordSession('codex')
    e.markFeature('issues')

    // What `podium telemetry show` would print as pending, captured BEFORE the
    // flush, straight from the same builder the CLI reads.
    const pending = e.buildUsageReport()

    await e.flush()

    expect(relay.bodies).toHaveLength(1)
    // Byte-identical: not "structurally similar", not "matches after parsing".
    expect(relay.bodies[0]).toBe(JSON.stringify(pending))
    // And the same bytes are what `podium telemetry show` reports as last-sent.
    expect(JSON.stringify(readLastSent(dir)?.report)).toBe(relay.bodies[0])
  })

  it('the wire payload is valid against the schema the relay validates with', async () => {
    saveConfig({ mode: 'all-in-one' })
    process.env.PODIUM_TELEMETRY_ENDPOINT = relay.url
    setConsent({ usage: 'on' })
    const e = emitter()
    e.recordSession('codex')
    await e.flush()
    expect(TelemetryReport.safeParse(JSON.parse(relay.bodies[0] as string)).success).toBe(true)
  })

  it('sends the design-doc shape and nothing else', async () => {
    saveConfig({ mode: 'all-in-one' })
    process.env.PODIUM_TELEMETRY_ENDPOINT = relay.url
    setConsent({ usage: 'on' })
    const e = emitter()
    e.recordSession('claude-code')
    await e.flush()
    const sent = JSON.parse(relay.bodies[0] as string)
    expect(Object.keys(sent).sort()).toEqual([
      'arch',
      'features',
      'installAge',
      'installId',
      'machines',
      'os',
      'schema',
      'sessions',
      'version',
    ])
    expect(sent.installId).toBe(loadConfig().telemetry?.installId)
    expect(sent.machines).toBe('2-5')
    expect(sent.installAge).toBe('0d')
  })

  it('drains the queue on success', async () => {
    saveConfig({ mode: 'all-in-one' })
    process.env.PODIUM_TELEMETRY_ENDPOINT = relay.url
    setConsent({ usage: 'on' })
    const e = emitter()
    e.recordSession('codex')
    await e.flush()
    expect(readQueue(dir)).toEqual([])
  })
})

describe('the negative case, end to end', () => {
  it('a flush with no consent puts NOTHING on the wire', async () => {
    saveConfig({ mode: 'all-in-one' })
    process.env.PODIUM_TELEMETRY_ENDPOINT = relay.url
    const e = emitter()
    e.recordSession('claude-code')
    e.markFeature('issues')
    await e.flush()
    expect(relay.bodies).toEqual([])
  })

  it('`podium telemetry off` mid-run stops the very next flush', async () => {
    saveConfig({ mode: 'all-in-one' })
    process.env.PODIUM_TELEMETRY_ENDPOINT = relay.url
    setConsent({ usage: 'on' })
    const e = emitter()
    e.recordSession('claude-code')
    await e.flush()
    expect(relay.bodies).toHaveLength(1)

    // The CLI writes config.json; the running emitter must notice with no restart.
    setConsent({ usage: 'off' })
    e.recordSession('codex')
    await e.flush()
    expect(relay.bodies).toHaveLength(1) // still 1 — nothing new went out
  })

  it('DO_NOT_TRACK stops a fully consented install cold', async () => {
    saveConfig({ mode: 'all-in-one' })
    process.env.PODIUM_TELEMETRY_ENDPOINT = relay.url
    setConsent({ usage: 'on', crash: 'on' })
    process.env.DO_NOT_TRACK = '1'
    try {
      const e = emitter()
      e.recordSession('claude-code')
      await e.flush()
      expect(relay.bodies).toEqual([])
    } finally {
      delete process.env.DO_NOT_TRACK
    }
  })

  it('an unreachable relay never throws and keeps the report for next time', async () => {
    saveConfig({ mode: 'all-in-one' })
    // Nothing is listening here.
    process.env.PODIUM_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/'
    setConsent({ usage: 'on' })
    const e = emitter()
    e.recordSession('codex')
    await expect(e.flush()).resolves.toBeUndefined()
    expect(readQueue(dir)).toHaveLength(1)
  })
})

describe('what the wire actually carries', () => {
  it('carries no path, username, or hostname anywhere in the body', async () => {
    saveConfig({ mode: 'all-in-one' })
    process.env.PODIUM_TELEMETRY_ENDPOINT = relay.url
    setConsent({ usage: 'on' })
    const e = emitter()
    e.recordSession('claude-code')
    await e.flush()
    const body = relay.bodies[0] as string
    expect(body).not.toContain('/home')
    expect(body).not.toContain(dir)
    expect(body).not.toContain(process.env.USER ?? '\u0000never')
  })

  it('is small — a daily report is a few hundred bytes', async () => {
    saveConfig({ mode: 'all-in-one' })
    process.env.PODIUM_TELEMETRY_ENDPOINT = relay.url
    setConsent({ usage: 'on' })
    const e = emitter()
    for (const kind of ['claude-code', 'codex', 'grok', 'opencode', 'cursor', 'shell'] as const) {
      e.recordSession(kind)
    }
    e.markFeature('issues')
    await e.flush()
    expect((relay.bodies[0] as string).length).toBeLessThan(500)
  })
})
