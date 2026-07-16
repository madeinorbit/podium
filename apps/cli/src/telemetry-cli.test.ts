/**
 * `podium telemetry` tests [spec:SP-f933].
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '@podium/runtime/config'
import { enqueueReport, recordLastSent, type UsageReport } from '@podium/telemetry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { showText, telemetryCliMain, tiersFromFlags } from './telemetry-cli'

let dir: string
const out: string[] = []
const err: string[] = []
const io = { print: (s: string) => out.push(s), printErr: (s: string) => err.push(s) }
const text = () => out.join('\n')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-telemetry-cli-'))
  process.env.PODIUM_STATE_DIR = dir
  out.length = 0
  err.length = 0
  saveConfig({ mode: 'all-in-one' })
})
afterEach(() => {
  delete process.env.PODIUM_STATE_DIR
  delete process.env.DO_NOT_TRACK
  rmSync(dir, { recursive: true, force: true })
})

describe('tiersFromFlags', () => {
  it('no flag = both tiers', () => {
    expect(tiersFromFlags([])).toEqual(['usage', 'crash'])
  })
  it('targets one tier', () => {
    expect(tiersFromFlags(['--usage'])).toEqual(['usage'])
    expect(tiersFromFlags(['--crash'])).toEqual(['crash'])
  })
  it('rejects an unknown flag rather than silently doing both', () => {
    expect(tiersFromFlags(['--all'])).toEqual({ error: 'podium telemetry: unknown option --all' })
  })
})

describe('podium telemetry (status)', () => {
  it('reports off/never-asked on a fresh box, with no install id', () => {
    expect(telemetryCliMain([], io)).toBe(0)
    expect(text()).toContain('usage      off (never asked)')
    expect(text()).toContain('crash      off (never asked)')
    expect(text()).toContain('(none — minted only when you opt in)')
  })

  it('shows the endpoint reports would go to', () => {
    telemetryCliMain([], io)
    expect(text()).toContain('https://telemetry.podium.dev')
  })
})

describe('podium telemetry on/off', () => {
  it('turns both tiers on and mints an id', () => {
    expect(telemetryCliMain(['on'], io)).toBe(0)
    const config = loadConfig()
    expect(config.telemetry?.usage).toBe('on')
    expect(config.telemetry?.crash).toBe('on')
    expect(config.telemetry?.installId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('turns a single tier on', () => {
    telemetryCliMain(['on', '--usage'], io)
    expect(loadConfig().telemetry?.usage).toBe('on')
    expect(loadConfig().telemetry?.crash).toBeUndefined()
  })

  it('off takes effect against config, no server required', () => {
    telemetryCliMain(['on'], io)
    telemetryCliMain(['off'], io)
    expect(loadConfig().telemetry).toMatchObject({ usage: 'off', crash: 'off' })
  })

  it('rejects an unknown flag with exit 2', () => {
    expect(telemetryCliMain(['on', '--everything'], io)).toBe(2)
    expect(err.join('\n')).toContain('unknown option --everything')
    expect(loadConfig().telemetry).toBeUndefined()
  })

  it('says so when a kill switch overrides an opt-in (never a silent no-op)', () => {
    process.env.DO_NOT_TRACK = '1'
    telemetryCliMain(['on'], io)
    expect(text()).toContain('DO_NOT_TRACK is set in this environment')
    expect(text()).toContain('forced off by DO_NOT_TRACK')
  })
})

describe('podium telemetry reset-id', () => {
  it('mints a new id', () => {
    telemetryCliMain(['on'], io)
    const first = loadConfig().telemetry?.installId
    out.length = 0
    expect(telemetryCliMain(['reset-id'], io)).toBe(0)
    expect(loadConfig().telemetry?.installId).not.toBe(first)
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

  it('says plainly when nothing is queued and nothing was ever sent', () => {
    expect(telemetryCliMain(['show'], io)).toBe(0)
    expect(text()).toContain('(nothing queued)')
    expect(text()).toContain('(nothing has ever been sent)')
  })

  it('prints the REAL queued payload, not an example', () => {
    enqueueReport(dir, report)
    const shown = showText(dir)
    expect(shown).toContain('"installId": "3f9c1a2e-0000-4000-8000-000000000000"')
    expect(shown).toContain('"claude-code": 4')
  })

  it('prints the last-sent payload with its timestamp', () => {
    recordLastSent(dir, report, new Date('2026-07-16T10:00:00Z'))
    const shown = showText(dir)
    expect(shown).toContain('at 2026-07-16T10:00:00.000Z')
    expect(shown).toContain('"machines": "1"')
  })

  it('names the queue file so the user can read it without us', () => {
    expect(showText(dir)).toContain(`${dir}/telemetry/queue.jsonl`)
  })
})

describe('usage errors', () => {
  it('unknown command exits 2', () => {
    expect(telemetryCliMain(['enable'], io)).toBe(2)
    expect(err.join('\n')).toContain("unknown command 'enable'")
  })
  it('--help prints the usage', () => {
    expect(telemetryCliMain(['--help'], io)).toBe(0)
    expect(text()).toContain('podium telemetry [command]')
    expect(text()).toContain('DO_NOT_TRACK=1')
  })
})
