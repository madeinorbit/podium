/**
 * Consent tests [spec:SP-f933]. The tri-state and the kill switches are the
 * feature's load-bearing promises — "absent ≠ off ≠ on" and "DO_NOT_TRACK
 * suppresses the prompt too" are the ones a reviewer should be able to find.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPath, loadConfig, saveConfig } from '@podium/runtime/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  allTiersOff,
  DEFAULT_TELEMETRY_ENDPOINT,
  isTierOn,
  readTelemetryState,
  resetInstallId,
  resolveTelemetryEndpoint,
  setConsent,
  shouldAskForConsent,
  telemetrySuppressedBy,
} from './consent'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-telemetry-consent-'))
  process.env.PODIUM_STATE_DIR = dir
})
afterEach(() => {
  delete process.env.PODIUM_STATE_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('tri-state: absent ≠ off ≠ on', () => {
  it('absent means never asked, and sends nothing', () => {
    saveConfig({ mode: 'all-in-one' })
    const state = readTelemetryState(loadConfig(), {})
    expect(state.usage).toBe('absent')
    expect(state.crash).toBe('absent')
    expect(isTierOn('usage', loadConfig(), {})).toBe(false)
    expect(allTiersOff(loadConfig(), {})).toBe(true)
  })

  it('off is distinguishable from absent, and also sends nothing', () => {
    saveConfig({ mode: 'all-in-one', telemetry: { usage: 'off' } })
    const state = readTelemetryState(loadConfig(), {})
    expect(state.usage).toBe('off')
    expect(state.crash).toBe('absent')
    expect(isTierOn('usage', loadConfig(), {})).toBe(false)
  })

  it('on sends — and only for the tier that is on', () => {
    saveConfig({
      mode: 'all-in-one',
      telemetry: { usage: 'on', crash: 'off', installId: '3f9c1a2e-0000-4000-8000-000000000000' },
    })
    expect(isTierOn('usage', loadConfig(), {})).toBe(true)
    expect(isTierOn('crash', loadConfig(), {})).toBe(false)
    expect(allTiersOff(loadConfig(), {})).toBe(false)
  })
})

describe('kill switches', () => {
  it('DO_NOT_TRACK=1 forces every tier off regardless of stored consent', () => {
    saveConfig({
      mode: 'all-in-one',
      telemetry: { usage: 'on', crash: 'on', installId: '3f9c1a2e-0000-4000-8000-000000000000' },
    })
    const env = { DO_NOT_TRACK: '1' }
    expect(telemetrySuppressedBy(env)).toBe('DO_NOT_TRACK')
    expect(isTierOn('usage', loadConfig(), env)).toBe(false)
    expect(isTierOn('crash', loadConfig(), env)).toBe(false)
    expect(allTiersOff(loadConfig(), env)).toBe(true)
    expect(readTelemetryState(loadConfig(), env).suppressedBy).toBe('DO_NOT_TRACK')
  })

  it('DO_NOT_TRACK also accepts true, and ignores 0/empty', () => {
    expect(telemetrySuppressedBy({ DO_NOT_TRACK: 'true' })).toBe('DO_NOT_TRACK')
    expect(telemetrySuppressedBy({ DO_NOT_TRACK: '0' })).toBeUndefined()
    expect(telemetrySuppressedBy({ DO_NOT_TRACK: '' })).toBeUndefined()
  })

  it('PODIUM_TELEMETRY=off forces every tier off', () => {
    saveConfig({
      mode: 'all-in-one',
      telemetry: { usage: 'on', installId: '3f9c1a2e-0000-4000-8000-000000000000' },
    })
    const env = { PODIUM_TELEMETRY: 'off' }
    expect(telemetrySuppressedBy(env)).toBe('PODIUM_TELEMETRY')
    expect(isTierOn('usage', loadConfig(), env)).toBe(false)
  })

  it('a kill switch suppresses the setup PROMPT, not just the sending', () => {
    // Homebrew's lesson: asking a box that has already said "do not track" is
    // exactly the nagging that draws complaints.
    expect(shouldAskForConsent({})).toBe(true)
    expect(shouldAskForConsent({ DO_NOT_TRACK: '1' })).toBe(false)
    expect(shouldAskForConsent({ PODIUM_TELEMETRY: 'off' })).toBe(false)
  })

  it('the stored consent SURVIVES a kill switch (it masks, it does not erase)', () => {
    saveConfig({
      mode: 'all-in-one',
      telemetry: { usage: 'on', installId: '3f9c1a2e-0000-4000-8000-000000000000' },
    })
    // Reading under DO_NOT_TRACK must not rewrite the file: unset the env and
    // the user's actual choice is still there.
    isTierOn('usage', loadConfig(), { DO_NOT_TRACK: '1' })
    expect(loadConfig().telemetry?.usage).toBe('on')
  })
})

describe('setConsent — minting rules (D5)', () => {
  it('mints an installId + clock on the first opt-in', () => {
    saveConfig({ mode: 'all-in-one' })
    const state = setConsent({ usage: 'on' }, 1_700_000_000_000)
    expect(state.usage).toBe('on')
    expect(state.installId).toMatch(/^[0-9a-f-]{36}$/)
    expect(state.since).toBe(1_700_000_000_000)
  })

  it('does NOT mint an id for someone who opts OUT', () => {
    // Saying no must not leave you with an identifier.
    saveConfig({ mode: 'all-in-one' })
    const state = setConsent({ usage: 'off', crash: 'off' })
    expect(state.installId).toBeUndefined()
    expect(state.since).toBeUndefined()
    expect(state.usage).toBe('off')
  })

  it('keeps the same id across later tier changes', () => {
    saveConfig({ mode: 'all-in-one' })
    const first = setConsent({ usage: 'on' })
    const second = setConsent({ crash: 'on' })
    expect(second.installId).toBe(first.installId)
    expect(second.since).toBe(first.since)
  })

  it('preserves the id when a tier is turned back off (so re-opting in is not a new identity)', () => {
    saveConfig({ mode: 'all-in-one' })
    const on = setConsent({ usage: 'on' })
    const off = setConsent({ usage: 'off' })
    expect(off.installId).toBe(on.installId)
    expect(off.usage).toBe('off')
  })

  it('patches config.json without touching neighbouring keys', () => {
    saveConfig({ mode: 'server', publicUrl: 'https://box.example', updateChannel: 'edge' })
    setConsent({ usage: 'on' })
    const config = loadConfig()
    expect(config.mode).toBe('server')
    expect(config.publicUrl).toBe('https://box.example')
    expect(config.updateChannel).toBe('edge')
    expect(config.telemetry?.usage).toBe('on')
  })

  it('writes a config the schema accepts (no drift between writer and shape)', () => {
    saveConfig({ mode: 'all-in-one' })
    setConsent({ usage: 'on', crash: 'on' })
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'))
    expect(raw.telemetry.usage).toBe('on')
    expect(() => loadConfig()).not.toThrow()
  })
})

describe('resetInstallId', () => {
  it('produces a new, unlinkable id and restarts the clock', () => {
    saveConfig({ mode: 'all-in-one' })
    const before = setConsent({ usage: 'on' }, 1_000)
    const after = resetInstallId(2_000)
    expect(after.installId).not.toBe(before.installId)
    // An age carried across the reset would re-link the two identities in the
    // aggregate — which would defeat the point of being able to reset.
    expect(after.since).toBe(2_000)
    expect(after.usage).toBe('on')
  })
})

describe('endpoint precedence', () => {
  it('defaults to the baked-in relay', () => {
    expect(resolveTelemetryEndpoint({}, {})).toBe(DEFAULT_TELEMETRY_ENDPOINT)
  })
  it('signed-manifest value beats the baked-in default', () => {
    expect(resolveTelemetryEndpoint({}, {}, 'https://manifest.example')).toBe(
      'https://manifest.example',
    )
  })
  it('config beats the manifest', () => {
    expect(
      resolveTelemetryEndpoint(
        { telemetry: { endpoint: 'https://config.example' } },
        {},
        'https://manifest.example',
      ),
    ).toBe('https://config.example')
  })
  it('env beats everything', () => {
    expect(
      resolveTelemetryEndpoint(
        { telemetry: { endpoint: 'https://config.example' } },
        { PODIUM_TELEMETRY_ENDPOINT: 'http://localhost:9999' },
        'https://manifest.example',
      ),
    ).toBe('http://localhost:9999')
  })
  it('an endpoint override never implies consent', () => {
    // Subordinate to the toggles: pointing at a relay does not turn anything on.
    saveConfig({ mode: 'all-in-one', telemetry: { endpoint: 'http://localhost:9999' } })
    expect(isTierOn('usage', loadConfig(), {})).toBe(false)
  })
})
