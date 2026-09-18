/**
 * `podium telemetry` tests [spec:SP-f933].
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '@podium/runtime/config'
import { enqueueReport, readTelemetryState, recordLastSent, type UsageReport } from '@podium/telemetry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showText, telemetryCliMain, tiersFromFlags } from './telemetry-cli'

vi.mock('./operator-client', () => ({
  makeOperatorIssueClient: () => ({ telemetry: client }),
}))
let stored: NonNullable<ReturnType<typeof loadConfig>['telemetry']>
const client = {
  state: { query: async () => readTelemetryState({ telemetry: stored }) },
  set: { mutate: vi.fn(async (updates: { usage?: 'on' | 'off'; crash?: 'on' | 'off' }) => {
    stored = { ...stored, ...updates }
    if (!stored.installId && (stored.usage === 'on' || stored.crash === 'on')) {
      stored.installId = crypto.randomUUID()
      stored.since = Date.now()
    }
    return readTelemetryState({ telemetry: stored })
  }) },
  resetId: { mutate: async () => {
    stored = { ...stored, installId: crypto.randomUUID(), since: Date.now() }
    return readTelemetryState({ telemetry: stored })
  } },
}

let dir: string
const out: string[] = []
const err: string[] = []
const io = { print: (s: string) => out.push(s), printErr: (s: string) => err.push(s) }
const text = () => out.join('\n')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-telemetry-cli-'))
  process.env.PODIUM_STATE_DIR = dir
  stored = {}
  out.length = 0
  err.length = 0
  saveConfig({ mode: 'all-in-one' })
})
afterEach(() => {
  process.env.PODIUM_STATE_DIR = priorStateDir
  delete process.env.DO_NOT_TRACK
  rmSync(dir, { recursive: true, force: true })
})

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('tiersFromFlags', () => {
  it('no flag = both tiers', async () => {
    expect(tiersFromFlags([])).toEqual(['usage', 'crash'])
  })
  it('targets one tier', async () => {
    expect(tiersFromFlags(['--usage'])).toEqual(['usage'])
    expect(tiersFromFlags(['--crash'])).toEqual(['crash'])
  })
  it('rejects an unknown flag rather than silently doing both', async () => {
    expect(tiersFromFlags(['--all'])).toEqual({ error: 'podium telemetry: unknown option --all' })
  })
})

describe('podium telemetry (status)', () => {
  it('reports effective unset choices', async () => {
    expect(await telemetryCliMain([], io)).toBe(0)
    expect(text()).toContain('usage      unset (off)')
    expect(text()).toContain('crash      unset (off)')
    expect(text()).toContain('(unset)')
  })

  it('shows the endpoint reports would go to', async () => {
    await telemetryCliMain([], io)
    expect(text()).toContain('https://pulse.podium.do/v1/u')
  })
})

describe('podium telemetry on/off', () => {
  it('turns both tiers on and mints an id', async () => {
    expect(await telemetryCliMain(['on'], io)).toBe(0)
    const config = { telemetry: stored }
    expect(config.telemetry?.usage).toBe('on')
    expect(config.telemetry?.crash).toBe('on')
    expect(config.telemetry?.installId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('turns a single tier on', async () => {
    await telemetryCliMain(['on', '--usage'], io)
    expect(stored?.usage).toBe('on')
    expect(stored?.crash).toBeUndefined()
  })

  it('off writes through the server settings API', async () => {
    await telemetryCliMain(['on'], io)
    await telemetryCliMain(['off'], io)
    expect(stored).toMatchObject({ usage: 'off', crash: 'off' })
  })

  it('rejects an unknown flag with exit 2', async () => {
    expect(await telemetryCliMain(['on', '--everything'], io)).toBe(2)
    // POD-3836 moved the refusal to the shared argv parser, which names the
    // command as well as the flag and points at its help.
    expect(err.join('\n')).toContain('unknown flag --everything')
    expect(stored).toEqual({})
  })

  it('says so when a kill switch overrides an opt-in (never a silent no-op)', async () => {
    process.env.DO_NOT_TRACK = '1'
    await telemetryCliMain(['on'], io)
    expect(text()).toContain('DO_NOT_TRACK is set in this environment')
    expect(text()).toContain('forced off by DO_NOT_TRACK')
  })
})

describe('RPC failures', () => {
  it('does not fall back to config.json when the server rejects or cannot accept a write', async () => {
    const before = readFileSync(join(dir, 'config.json'), 'utf8')
    client.set.mutate.mockRejectedValueOnce(new Error('Server unavailable'))
    expect(await telemetryCliMain(['on'], io)).toBe(1)
    expect(err.join('\n')).toContain('Server unavailable')
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before)
  })
})

describe('podium telemetry reset-id', () => {
  it('mints a new id', async () => {
    await telemetryCliMain(['on'], io)
    const first = stored?.installId
    out.length = 0
    expect(await telemetryCliMain(['reset-id'], io)).toBe(0)
    expect(stored?.installId).not.toBe(first)
    expect(text()).toContain('New install id:')
  })
})

describe('podium telemetry show', () => {
  const report: UsageReport = {
    schema: 1,
    installId: '3f9c1a2e-0000-4000-8000-000000000000',
    version: '1.4.2',
    os: 'linux',
    arch: 'x64',
    installAge: '1-7d',
    machines: '1',
    sessions: { 'claude-code': 4 },
    features: { issues: true },
  }

  it('says plainly when nothing is queued and nothing was ever sent', async () => {
    expect(await telemetryCliMain(['show'], io)).toBe(0)
    expect(text()).toContain('(nothing queued)')
    expect(text()).toContain('(nothing has ever been sent)')
  })

  it('prints the REAL queued payload, not an example', async () => {
    enqueueReport(dir, report)
    const shown = showText(dir)
    expect(shown).toContain('"installId": "3f9c1a2e-0000-4000-8000-000000000000"')
    expect(shown).toContain('"claude-code": 4')
  })

  it('prints the last-sent payload with its timestamp', async () => {
    recordLastSent(dir, report, new Date('2026-07-16T10:00:00Z'))
    const shown = showText(dir)
    expect(shown).toContain('at 2026-07-16T10:00:00.000Z')
    expect(shown).toContain('"machines": "1"')
  })

  it('names the queue file so the user can read it without us', async () => {
    expect(showText(dir)).toContain(`${dir}/telemetry/queue.jsonl`)
  })
})

describe('usage errors', () => {
  it('unknown command exits 2', async () => {
    expect(await telemetryCliMain(['enable'], io)).toBe(2)
    expect(err.join('\n')).toContain("unknown command 'enable'")
  })
  it('--help prints the usage', async () => {
    expect(await telemetryCliMain(['--help'], io)).toBe(0)
    expect(text()).toContain('podium telemetry [command]')
    expect(text()).toContain('DO_NOT_TRACK=1')
  })
})
