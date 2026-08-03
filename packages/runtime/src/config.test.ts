import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONFIG_MIGRATIONS,
  CURRENT_CONFIG_VERSION,
  configPath,
  inspectConfig,
  loadConfig,
  migrateConfig,
  migrateConfigFile,
  needsSetup,
  resolveAgentHomeDir,
  resolveAgentRelay,
  resolveAgentRelayPort,
  resolveFeatureOverrides,
  resolveHookPort,
  resolveInstallDir,
  resolveLocalServerHost,
  resolvePort,
  resolveRunRecordMode,
  resolveUpdateChannel,
  resolveUpdateFeed,
  resolveUpdateTarget,
  saveConfig,
} from './config'

/** Every saved config carries the current version; spread it into expectations
 *  so a version bump does not have to be typed into a dozen assertions. */
const V2 = { configVersion: CURRENT_CONFIG_VERSION }

describe('podium config', () => {
  let dir: string
  let priorStateDir: string | undefined
  beforeEach(() => {
    priorStateDir = process.env.PODIUM_STATE_DIR
    dir = mkdtempSync(join(tmpdir(), 'podium-cfg-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('configPath honors PODIUM_STATE_DIR', () => {
    expect(configPath()).toBe(join(dir, 'config.json'))
  })
  it('loadConfig returns {} when no file exists', () => {
    expect(loadConfig()).toEqual({})
  })
  it('save then load round-trips', () => {
    saveConfig({ mode: 'daemon', serverUrl: 'ws://host:18787' })
    expect(loadConfig()).toEqual({ ...V2, mode: 'daemon', serverUrl: 'ws://host:18787' })
  })
  it('needsSetup is true with no mode, false once a mode is set', () => {
    expect(needsSetup({})).toBe(true)
    expect(needsSetup({ mode: 'all-in-one' })).toBe(false)
  })
  it('loadConfig tolerates a corrupt file by returning {} — but logs LOUDLY (#21)', () => {
    saveConfig({ mode: 'server' })
    const { writeFileSync } = require('node:fs')
    writeFileSync(configPath(), '{not json')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(loadConfig()).toEqual({})
      expect(err).toHaveBeenCalledTimes(1)
      expect(String(err.mock.calls[0]?.[0])).toContain('--repair')
    } finally {
      err.mockRestore()
    }
  })
  it('inspectConfig distinguishes missing / ok / corrupt (#21)', () => {
    expect(inspectConfig()).toEqual({ state: 'missing', config: {}, migrated: [] })
    saveConfig({ mode: 'server' })
    expect(inspectConfig()).toEqual({
      state: 'ok',
      config: { ...V2, mode: 'server' },
      migrated: [],
    })
    const { writeFileSync } = require('node:fs')
    writeFileSync(configPath(), '{not json')
    const res = inspectConfig()
    expect(res.state).toBe('corrupt')
    expect(res.config).toEqual({})
    expect(res.error).toBeTruthy()
  })
  it('a schema-invalid (but well-formed JSON) file is corrupt, not missing (#21)', () => {
    const { writeFileSync } = require('node:fs')
    writeFileSync(configPath(), JSON.stringify({ mode: 'bogus' }))
    expect(inspectConfig().state).toBe('corrupt')
  })
  it('refuses to save a daemon/client mode without a serverUrl (#21 — boot crash-loop)', () => {
    expect(() => saveConfig({ mode: 'daemon' })).toThrow(/serverUrl/)
    expect(() => saveConfig({ mode: 'client' })).toThrow(/serverUrl/)
    // the valid shapes still save
    saveConfig({ mode: 'daemon', serverUrl: 'wss://relay' })
    expect(loadConfig().mode).toBe('daemon')
  })
  it('saveConfig rejects an invalid mode', () => {
    expect(() => saveConfig({ mode: 'bogus' } as never)).toThrow()
  })
  it('round-trips updateChannel and publicUrl', () => {
    saveConfig({ mode: 'all-in-one', updateChannel: 'edge', publicUrl: 'https://b.ts.net' })
    expect(loadConfig()).toEqual({
      ...V2,
      mode: 'all-in-one',
      updateChannel: 'edge',
      publicUrl: 'https://b.ts.net',
    })
  })
  it('loads an old config without the new fields', () => {
    saveConfig({ mode: 'server' })
    expect(loadConfig()).toEqual({ ...V2, mode: 'server' })
  })
  it('rejects an invalid updateChannel', () => {
    expect(() => saveConfig({ updateChannel: 'nightly' } as never)).toThrow()
  })
  // POD-309 retired the `upstream` key with the node⇄hub dialer. These two replace the
  // round-trip pair that used to live here, and they assert the RETIREMENT rather than
  // the field: the first proves the key is gone from the schema (a re-declared
  // `upstream` makes it fail), the second proves an operator whose config.json still
  // carries the retired block still BOOTS — the failure mode that matters, because
  // `.strict()` here would exit-2 crash-loop every node that ever configured one.
  it('the retired `upstream` key is no longer part of the schema', () => {
    saveConfig({ mode: 'server', upstream: { url: 'https://hub', token: 't' } } as never)
    expect(loadConfig()).toEqual({ ...V2, mode: 'server' })
  })
  it('a config file still carrying a retired `upstream` block loads instead of throwing', () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ mode: 'server', upstream: { url: 'https://hub', token: 'tok_abc' } }),
    )
    expect(inspectConfig().state).toBe('ok')
    expect(loadConfig()).toEqual({ ...V2, mode: 'server' })
  })
})

describe('layered resolvers (#251): env → config.json → default', () => {
  let dir: string
  let priorStateDir: string | undefined
  beforeEach(() => {
    priorStateDir = process.env.PODIUM_STATE_DIR
    dir = mkdtempSync(join(tmpdir(), 'podium-resolvers-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps layered-resolver config writes in throwaway state', () => {
    expect(configPath()).toBe(join(dir, 'config.json'))
  })
  it('resolvePort: PODIUM_PORT > config.port > 18787; junk env falls through', () => {
    expect(resolvePort({ port: 2000 }, { PODIUM_PORT: '3000' })).toBe(3000)
    expect(resolvePort({ port: 2000 }, {})).toBe(2000)
    expect(resolvePort({}, {})).toBe(18787)
    expect(resolvePort({ port: 2000 }, { PODIUM_PORT: 'nope' })).toBe(2000)
    expect(resolvePort({}, { PODIUM_PORT: '0' })).toBe(18787)
  })
  it('resolveLocalServerHost: the daemon dials what the server BOUND (POD-1585)', () => {
    // The pair must agree. `resolveBindHost` binds PODIUM_HOST and NOTHING else,
    // so a specific interface leaves loopback unbound — a daemon that assumed
    // `localhost` was refused on every retry and its machine read offline
    // forever, which blocks folder browsing, agent placement, and onboarding.
    expect(resolveLocalServerHost({ PODIUM_HOST: '100.113.194.89' })).toBe('100.113.194.89')
    expect(resolveLocalServerHost({ PODIUM_HOST: 'podium.example.com' })).toBe('podium.example.com')
    // Unset matches the server's own 127.0.0.1 default.
    expect(resolveLocalServerHost({})).toBe('localhost')
    // Wildcards DO include loopback, so the short local path stays — and
    // '0.0.0.0' is not a valid destination to dial.
    expect(resolveLocalServerHost({ PODIUM_HOST: '0.0.0.0' })).toBe('localhost')
    expect(resolveLocalServerHost({ PODIUM_HOST: '::' })).toBe('localhost')
    expect(resolveLocalServerHost({ PODIUM_HOST: '  ' })).toBe('localhost')
    // A bare IPv6 literal must be bracketed to be a legal URL authority.
    expect(resolveLocalServerHost({ PODIUM_HOST: 'fd00::1' })).toBe('[fd00::1]')
    expect(resolveLocalServerHost({ PODIUM_HOST: '[fd00::1]' })).toBe('[fd00::1]')
  })
  it('named instances get stable distinct endpoint defaults with env/config overrides', () => {
    const env = { PODIUM_INSTANCE: 'blue' }
    const server = resolvePort({}, env)
    const hook = resolveHookPort({}, env)
    const relay = resolveAgentRelayPort({}, env)
    expect(new Set([server, hook, relay]).size).toBe(3)
    expect(resolvePort({}, { PODIUM_INSTANCE: 'green' })).not.toBe(server)
    expect(resolveHookPort({ hookPort: 31001 }, env)).toBe(31001)
    expect(resolveAgentRelayPort({ agentRelayPort: 31002 }, env)).toBe(31002)
    expect(resolveHookPort({ hookPort: 31001 }, { ...env, PODIUM_HOOK_PORT: '32001' })).toBe(32001)
  })
  it('named instances isolate native agent HOME unless sharing is explicit', () => {
    const env = { PODIUM_INSTANCE: 'blue', HOME: '/home/u' }
    expect(resolveAgentHomeDir({}, env)).toBe('/home/u/.local/state/podium/blue/agent-home')
    expect(resolveAgentHomeDir({ agentHome: '/shared/agents' }, env)).toBe('/shared/agents')
    expect(resolveAgentHomeDir({ agentHome: '/cfg' }, { ...env, PODIUM_AGENT_HOME: '/env' })).toBe(
      '/env',
    )
    expect(resolveAgentHomeDir({}, { HOME: '/home/u' })).toBe('/home/u')
  })
  it('resolveUpdateChannel: env > config > stable', () => {
    expect(resolveUpdateChannel({ updateChannel: 'edge' }, {})).toBe('edge')
    expect(
      resolveUpdateChannel({ updateChannel: 'edge' }, { PODIUM_UPDATE_CHANNEL: 'stable' }),
    ).toBe('stable')
    expect(resolveUpdateChannel({}, {})).toBe('stable')
  })
  it('resolveFeatureOverrides: config.features only (no env layer) [spec:SP-f4b9]', () => {
    expect(resolveFeatureOverrides({})).toEqual({})
    expect(resolveFeatureOverrides({ features: { 'sample-experiment': true } })).toEqual({
      'sample-experiment': true,
    })
    expect(
      resolveFeatureOverrides({
        features: { a: true, b: false },
      }),
    ).toEqual({ a: true, b: false })
  })
  it('PodiumConfig accepts features record and round-trips via save/load', () => {
    saveConfig({ mode: 'server', features: { 'sample-experiment': true, other: false } })
    expect(loadConfig().features).toEqual({ 'sample-experiment': true, other: false })
  })
  it('resolveUpdateFeed: env > config > undefined', () => {
    expect(
      resolveUpdateFeed({ updateFeed: 'http://cfg' }, { PODIUM_UPDATE_FEED: 'http://env' }),
    ).toBe('http://env')
    expect(resolveUpdateFeed({ updateFeed: 'http://cfg' }, {})).toBe('http://cfg')
    expect(resolveUpdateFeed({}, {})).toBeUndefined()
  })
  it('resolveUpdateTarget: env > linux-x86_64', () => {
    expect(resolveUpdateTarget({ PODIUM_UPDATE_TARGET: 'darwin-arm64' })).toBe('darwin-arm64')
    expect(resolveUpdateTarget({})).toBe('linux-x86_64')
  })
  it('resolveInstallDir: PODIUM_HOME > dirname(execPath)', () => {
    expect(resolveInstallDir({ PODIUM_HOME: '/opt/podium' }, '/usr/bin/podium')).toBe('/opt/podium')
    expect(resolveInstallDir({}, '/usr/bin/podium')).toBe('/usr/bin')
  })
  it('resolveAgentRelay is env-only', () => {
    expect(resolveAgentRelay({ PODIUM_AGENT_RELAY: 'http://127.0.0.1:1/x' })).toBe(
      'http://127.0.0.1:1/x',
    )
    expect(resolveAgentRelay({})).toBeUndefined()
  })
  it('resolveAgentRelay: PODIUM_AGENT_RELAY wins over legacy PODIUM_ISSUE_RELAY', () => {
    expect(
      resolveAgentRelay({
        PODIUM_AGENT_RELAY: 'http://127.0.0.1:1/agent/s1',
        PODIUM_ISSUE_RELAY: 'http://127.0.0.1:1/issue/s1',
      }),
    ).toBe('http://127.0.0.1:1/agent/s1')
  })
  it('resolveAgentRelay: legacy PODIUM_ISSUE_RELAY alone still resolves (one-release alias)', () => {
    expect(resolveAgentRelay({ PODIUM_ISSUE_RELAY: 'http://127.0.0.1:1/issue/s1' })).toBe(
      'http://127.0.0.1:1/issue/s1',
    )
  })
  it('resolveAgentRelay: PODIUM_NO_RELAY sheds an inherited relay → undefined', () => {
    expect(
      resolveAgentRelay({
        PODIUM_NO_RELAY: '1',
        PODIUM_AGENT_RELAY: 'http://127.0.0.1:1/agent/s1',
        PODIUM_ISSUE_RELAY: 'http://127.0.0.1:1/issue/s1',
      }),
    ).toBeUndefined()
  })
  it('resolveRunRecordMode: NOTIFY_SOCKET > PODIUM_RUN_MODE=detached > foreground', () => {
    expect(resolveRunRecordMode({ NOTIFY_SOCKET: '/run/x' })).toBe('systemd')
    expect(resolveRunRecordMode({ PODIUM_RUN_MODE: 'detached' })).toBe('detached')
    expect(resolveRunRecordMode({ NOTIFY_SOCKET: '/run/x', PODIUM_RUN_MODE: 'detached' })).toBe(
      'systemd',
    )
    expect(resolveRunRecordMode({})).toBe('foreground')
  })
})

/**
 * VERSIONED CONFIG + ONE-SHOT MIGRATIONS (POD-333).
 *
 * The cases below are HISTORICAL SHAPES, not invented ones: each is a config
 * this repo's own writers produced, named with the writer that produced it, so
 * "tested from every historical shape" is checkable rather than asserted.
 */
describe('config versioning and one-shot migrations (POD-333)', () => {
  let dir: string
  let prior: string | undefined
  beforeEach(() => {
    prior = process.env.PODIUM_STATE_DIR
    dir = mkdtempSync(join(tmpdir(), 'podium-cfg-migrate-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    if (prior === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = prior
    rmSync(dir, { recursive: true, force: true })
  })

  /** Write a raw file exactly as some past writer would have. */
  function writeRaw(raw: Record<string, unknown>): void {
    writeFileSync(configPath(), JSON.stringify(raw, null, 2))
  }

  it('treats a file with no configVersion as v1 and stamps it', () => {
    // The population every migration targets: everything written before POD-333.
    writeRaw({ mode: 'server', port: 18787 })
    expect(loadConfig().configVersion).toBe(CURRENT_CONFIG_VERSION)
  })

  it('does not trust a non-numeric configVersion to skip migrations', () => {
    // A hand-edited `"configVersion": "2"` claiming to be current would otherwise
    // sail past every step — the one way a versioned scheme fails silently.
    writeRaw({ configVersion: '2', mode: 'all-in-one', pendingPersistence: 'systemd' })
    expect(loadConfig().persistence).toBe('systemd')
  })

  describe('v1 → v2: pendingPersistence folds into persistence', () => {
    it('applySetup shape: web setup on a fresh host box (packages/runtime/src/setup.ts)', () => {
      writeRaw({
        mode: 'all-in-one',
        publicUrl: 'https://box.ts.net',
        pendingPersistence: 'systemd',
      })
      const cfg = loadConfig()
      expect(cfg.persistence).toBe('systemd')
      expect((cfg as Record<string, unknown>).pendingPersistence).toBeUndefined()
    })

    it('applyJoin shape: one-paste join code, daemon mode', () => {
      writeRaw({
        mode: 'daemon',
        serverUrl: 'wss://relay.example',
        pairCode: 'abc',
        pendingPersistence: 'systemd',
      })
      expect(loadConfig().persistence).toBe('systemd')
    })

    it('detached intent survives as detached, not silently upgraded to systemd', () => {
      writeRaw({ mode: 'server', pendingPersistence: 'detached' })
      expect(loadConfig().persistence).toBe('detached')
    })

    it('a FULFILLED persistence wins over a stale intent', () => {
      // savePersistence cleared the intent, but a crash between write and clear
      // could leave both. `persistence` is the one that actually happened.
      writeRaw({ mode: 'server', persistence: 'detached', pendingPersistence: 'systemd' })
      expect(loadConfig().persistence).toBe('detached')
    })

    it('leaves a box with neither field unmanaged — the desktop sidecar', () => {
      // THE CASE THE VERSION FIELD EXISTS FOR. Pre-v2 this shape was ambiguous
      // between "sidecar, deliberately unmanaged" and "configured before the
      // persistence step existed", and the CLI carried a plan state
      // (`incomplete-headless-config`) to straddle it. At v2, absent means
      // unmanaged and nothing downstream has to ask which.
      writeRaw({ mode: 'all-in-one' })
      expect(loadConfig().persistence).toBeUndefined()
      expect(loadConfig().configVersion).toBe(CURRENT_CONFIG_VERSION)
    })

    it('an unrecognised intent value is dropped rather than carried forward', () => {
      writeRaw({ mode: 'server', pendingPersistence: 'launchd' })
      const cfg = loadConfig()
      expect(cfg.persistence).toBeUndefined()
      expect((cfg as Record<string, unknown>).pendingPersistence).toBeUndefined()
    })

    it('preserves every unrelated key across the migration', () => {
      // A migration that silently drops updateChannel is how `install.sh
      // --channel edge --join` reverted to stable once already (issue #20).
      writeRaw({
        mode: 'all-in-one',
        pendingPersistence: 'systemd',
        updateChannel: 'edge',
        port: 19000,
        publicUrl: 'https://box.ts.net',
        features: { 'some-flag': true },
        telemetry: { usage: 'on', installId: '9f1c2f8e-4b3a-4a1e-9a2b-8c7d6e5f4a3b' },
      })
      const cfg = loadConfig()
      expect(cfg.updateChannel).toBe('edge')
      expect(cfg.port).toBe(19000)
      expect(cfg.publicUrl).toBe('https://box.ts.net')
      expect(cfg.features).toEqual({ 'some-flag': true })
      expect(cfg.telemetry?.usage).toBe('on')
    })
  })

  it('is idempotent — the loader runs it on every load, in every process', () => {
    // Not a theoretical property: migrateConfig is deliberately pure and does not
    // write, so the same file is re-migrated by the server, the daemon, the
    // janitor and every CLI invocation until something calls migrateConfigFile.
    const once = migrateConfig({ mode: 'server', pendingPersistence: 'systemd' })
    const twice = migrateConfig(once.config)
    expect(twice.config).toEqual(once.config)
    expect(twice.applied).toEqual([])
  })

  it('reports WHICH migrations ran, and reports none for a current file', () => {
    writeRaw({ mode: 'server', pendingPersistence: 'systemd' })
    expect(inspectConfig().migrated).toEqual([
      'v2: persistence is one field, and absent means not headless-managed',
    ])
    saveConfig({ mode: 'server', persistence: 'systemd' })
    expect(inspectConfig().migrated).toEqual([])
  })

  it('migrateConfigFile persists once, then has nothing left to do', () => {
    writeRaw({ mode: 'server', pendingPersistence: 'systemd' })
    expect(migrateConfigFile()).toEqual([
      'v2: persistence is one field, and absent means not headless-managed',
    ])
    const onDisk = JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>
    expect(onDisk.persistence).toBe('systemd')
    expect(onDisk.pendingPersistence).toBeUndefined()
    expect(onDisk.configVersion).toBe(CURRENT_CONFIG_VERSION)
    expect(migrateConfigFile()).toEqual([])
  })

  it('migrateConfigFile does NOT rewrite a corrupt file', () => {
    // A corrupt file is not an old file. Rewriting it destroys whatever the
    // operator had, which is the whole reason inspectConfig separates the two
    // states (#21).
    const raw = '{not json'
    writeFileSync(configPath(), raw)
    expect(migrateConfigFile()).toEqual([])
    expect(readFileSync(configPath(), 'utf8')).toBe(raw)
  })

  it('leaves a config from a NEWER Podium at its own version', () => {
    // Stamping it backwards would make the old binary re-apply migrations the
    // new one already has.
    writeRaw({ configVersion: CURRENT_CONFIG_VERSION + 5, mode: 'server' })
    expect(loadConfig().configVersion).toBe(CURRENT_CONFIG_VERSION + 5)
    expect(inspectConfig().migrated).toEqual([])
  })

  it('every migration declares the version it produces, contiguously from 2', () => {
    // A gap or a duplicate would make `to <= from` skip or double-apply a step.
    expect(CONFIG_MIGRATIONS.map((m) => m.to)).toEqual(CONFIG_MIGRATIONS.map((_, i) => i + 2))
    expect(CONFIG_MIGRATIONS.at(-1)?.to).toBe(CURRENT_CONFIG_VERSION)
    for (const m of CONFIG_MIGRATIONS) expect(m.describe.length).toBeGreaterThan(0)
  })
})
