import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSink, type LogRecord } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONFIG_MIGRATIONS,
  CURRENT_CONFIG_VERSION,
  LAYERED_ENV,
  LAYERED_KEYS,
  configPath,
  inspectConfig,
  loadConfig,
  localServerUrl,
  localServerWsUrl,
  migrateConfig,
  migrateConfigFile,
  needsSetup,
  resolveAgentHomeDir,
  resolveAgentRelay,
  resolveAgentRelayPort,
  resolveAllowedOrigins,
  resolveDevArtifactOrigin,
  resolveFeatureOverrides,
  resolveHookPort,
  resolveInstallDir,
  resolveLocalServerHost,
  resolveLoggingMode,
  resolveMode,
  resolvePort,
  resolvePublicUrl,
  resolveRunRecordMode,
  resolveSessionRelay,
  resolveSetting,
  resolveTranscriptLake,
  resolveUpdateChannel,
  resolveUpdateFeed,
  resolveUpdateScope,
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
    // Observed through a SINK, not a console spy: the warning goes through the
    // logger now, so the console is no longer where it can be seen.
    const records: LogRecord[] = []
    const dispose = addSink({ name: 'test', write: (r) => records.push(r) })
    try {
      expect(loadConfig()).toEqual({})
      expect(records).toHaveLength(1)
      expect(records[0]?.level).toBe('error')
      expect(records[0]?.msg).toContain('--repair')
    } finally {
      dispose()
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
  it('round-trips updateChannel, publicUrl, and networkOption', () => {
    saveConfig({
      mode: 'all-in-one',
      updateChannel: 'edge',
      publicUrl: 'https://b.ts.net',
      networkOption: 'tailscale-serve',
    })
    expect(loadConfig()).toEqual({
      ...V2,
      mode: 'all-in-one',
      updateChannel: 'edge',
      publicUrl: 'https://b.ts.net',
      networkOption: 'tailscale-serve',
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
  it('localServerUrl/localServerWsUrl: local dials follow the bound host (POD-1607)', () => {
    // The CLI's own copies of the POD-1585 bug: every verb dialed a hard-coded
    // `localhost` while the server bound PODIUM_HOST and nothing else.
    expect(localServerUrl(18787, { PODIUM_HOST: '100.113.194.89' })).toBe(
      'http://100.113.194.89:18787',
    )
    expect(localServerWsUrl(18787, { PODIUM_HOST: '100.113.194.89' })).toBe(
      'ws://100.113.194.89:18787',
    )
    // Unset (the ordinary single-machine install) is unchanged: loopback.
    expect(localServerUrl(18787, {})).toBe('http://localhost:18787')
    expect(localServerWsUrl(23000, {})).toBe('ws://localhost:23000')
    // A wildcard bind includes loopback, so the short local path stays.
    expect(localServerUrl(18787, { PODIUM_HOST: '0.0.0.0' })).toBe('http://localhost:18787')
    // IPv6 stays bracketed so the result is a legal URL authority.
    expect(localServerUrl(18787, { PODIUM_HOST: 'fd00::1' })).toBe('http://[fd00::1]:18787')
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
  it('resolveDevArtifactOrigin: env > publicUrl > disabled', () => {
    expect(
      resolveDevArtifactOrigin(
        { publicUrl: 'https://configured.example.test/' },
        { PODIUM_DEV_ARTIFACT_BASE_URL: 'https://override.example.test:8443/' },
      ),
    ).toBe('https://override.example.test:8443')
    expect(resolveDevArtifactOrigin({ publicUrl: 'https://configured.example.test/' }, {})).toBe(
      'https://configured.example.test',
    )
    expect(resolveDevArtifactOrigin({}, {})).toBeUndefined()
  })
  it.each([
    'http://127.0.0.1:18787',
    'http://127.9.8.7',
    'http://localhost:18787',
    'http://dev.localhost',
    'http://0.0.0.0:18787',
    'http://[::1]:18787',
    'https://podium.example.test/proxy',
    'https://podium.example.test?source=dev',
    'https://user:secret@podium.example.test',
    'file:///tmp/podium',
    'not a URL',
    // IPv4-MAPPED IPv6, which the spelling denylist could not see: these ARE
    // the loopback and unspecified addresses, written another way (POD-2229).
    'http://[::ffff:127.0.0.1]:18787',
    'http://[::ffff:7f00:1]:18787',
    'http://[::ffff:0.0.0.0]:18787',
    'http://[::]:18787',
  ])('resolveDevArtifactOrigin rejects a non-origin or local-only value: %s', (value) => {
    expect(() => resolveDevArtifactOrigin({}, { PODIUM_DEV_ARTIFACT_BASE_URL: value })).toThrow(
      /development artifact origin/,
    )
  })

  /**
   * WHAT THE GUARD MAY NOT REFUSE (POD-2229).
   *
   * It reads the address, never a resolver, so a NAME is only refusable when
   * being loopback is part of what the name means (RFC 6761's `localhost`).
   * `127.example.test` is an ordinary hostname that happens to start with
   * three digits, and the old `startsWith('127.')` test refused it.
   */
  it.each([
    'https://podium.example.test',
    'http://127.example.test:18787',
    'http://[64:ff9b::127.0.0.1]:18787',
  ])('resolveDevArtifactOrigin accepts an address it cannot fault: %s', (value) => {
    expect(resolveDevArtifactOrigin({}, { PODIUM_DEV_ARTIFACT_BASE_URL: value })).toBe(
      new URL(value).origin,
    )
  })

  /**
   * The guard says what it CHECKED, not what it wishes it could promise. It
   * reads the address and nothing else, so "externally reachable" was a claim
   * it had no way to make: measured on the box that drove POD-2215, this
   * host's own public FQDN resolves to 127.0.1.1 through /etc/hosts and was
   * accepted, while being perfectly reachable from anywhere else.
   */
  it('resolveDevArtifactOrigin does not promise reachability it never tested', () => {
    let message = ''
    try {
      resolveDevArtifactOrigin({}, { PODIUM_DEV_ARTIFACT_BASE_URL: 'http://127.0.0.1:18787' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/loopback/)
    expect(message).not.toMatch(/externally reachable/)
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
  // POD-1375: the two resolvers answer different questions, and a shell's env is
  // exactly the case that separates them — session relay bound, agent relay absent.
  it('resolveSessionRelay reads a shell session (no agent relay), resolveAgentRelay does not', () => {
    const shellEnv = { PODIUM_SESSION_RELAY: 'http://127.0.0.1:1/agent/s1' }
    expect(resolveSessionRelay(shellEnv)).toBe('http://127.0.0.1:1/agent/s1')
    expect(resolveAgentRelay(shellEnv)).toBeUndefined()
  })
  it('resolveSessionRelay falls back to the agent (then legacy) name for pre-split sessions', () => {
    expect(resolveSessionRelay({ PODIUM_AGENT_RELAY: 'http://127.0.0.1:1/agent/s1' })).toBe(
      'http://127.0.0.1:1/agent/s1',
    )
    expect(resolveSessionRelay({ PODIUM_ISSUE_RELAY: 'http://127.0.0.1:1/issue/s1' })).toBe(
      'http://127.0.0.1:1/issue/s1',
    )
    expect(resolveSessionRelay({})).toBeUndefined()
  })
  it('resolveSessionRelay: PODIUM_NO_RELAY sheds an inherited relay → undefined', () => {
    expect(
      resolveSessionRelay({
        PODIUM_NO_RELAY: '1',
        PODIUM_SESSION_RELAY: 'http://127.0.0.1:1/agent/s1',
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
  it('resolveLoggingMode: the desktop sidecar takes the file, not the discarded console', () => {
    // Its stdout is the Finder-launched .app's, i.e. nowhere — so a "foreground"
    // process is exactly the one whose records must not go to a console sink.
    expect(resolveLoggingMode({ PODIUM_DESKTOP_SUPERVISED: '1' })).toBe('detached')
    // The run-registry label is unchanged by that: two questions, one answer only usually.
    expect(resolveRunRecordMode({ PODIUM_DESKTOP_SUPERVISED: '1' })).toBe('foreground')
  })
  it('resolveLoggingMode: journald still wins, so nothing is written twice', () => {
    expect(resolveLoggingMode({ PODIUM_DESKTOP_SUPERVISED: '1', NOTIFY_SOCKET: '/run/x' })).toBe(
      'systemd',
    )
  })
  it('resolveLoggingMode: every other process keeps its supervision answer', () => {
    expect(resolveLoggingMode({})).toBe('foreground')
    expect(resolveLoggingMode({ PODIUM_RUN_MODE: 'detached' })).toBe('detached')
    expect(resolveLoggingMode({ PODIUM_DESKTOP_SUPERVISED: '0' })).toBe('foreground')
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

describe('the layered keys a cloud deployment sets (PDM-26)', () => {
  it('resolveMode: env wins, then file, then undefined', () => {
    expect(resolveMode({}, {})).toBeUndefined()
    expect(resolveMode({ mode: 'all-in-one' }, {})).toBe('all-in-one')
    expect(resolveMode({ mode: 'all-in-one' }, { PODIUM_MODE: 'server' })).toBe('server')
  })

  it('resolveMode: an unknown PODIUM_MODE throws, naming the accepted values', () => {
    expect(() => resolveMode({}, { PODIUM_MODE: 'sever' })).toThrow(
      /PODIUM_MODE.*all-in-one, daemon, client, server/,
    )
  })

  it('resolvePublicUrl: env wins and is normalized to a bare origin', () => {
    expect(resolvePublicUrl({ publicUrl: 'https://a.example' }, {})).toBe('https://a.example')
    expect(
      resolvePublicUrl(
        { publicUrl: 'https://a.example' },
        { PODIUM_PUBLIC_URL: 'https://b.example/' },
      ),
    ).toBe('https://b.example')
  })

  it('resolvePublicUrl: env must be https unless the host is loopback', () => {
    expect(() => resolvePublicUrl({}, { PODIUM_PUBLIC_URL: 'http://api.example' })).toThrow(
      /PODIUM_PUBLIC_URL.*https/,
    )
    expect(resolvePublicUrl({}, { PODIUM_PUBLIC_URL: 'http://127.0.0.1:8080' })).toBe(
      'http://127.0.0.1:8080',
    )
    // The FILE layer is deliberately unchanged: a self-hosted http:// URL keeps working.
    expect(resolvePublicUrl({ publicUrl: 'http://box.lan:18787' }, {})).toBe('http://box.lan:18787')
  })

  it('resolvePublicUrl: env rejects a path, query or fragment', () => {
    for (const bad of ['https://a.example/podium', 'https://a.example?x=1', 'https://a.example#f']) {
      expect(() => resolvePublicUrl({}, { PODIUM_PUBLIC_URL: bad })).toThrow(/PODIUM_PUBLIC_URL/)
    }
  })

  it('resolveAllowedOrigins: env list wins, trims, drops empties, dedupes in order', () => {
    expect(resolveAllowedOrigins({}, {})).toEqual([])
    expect(resolveAllowedOrigins({ allowedOrigins: ['https://a.example'] }, {})).toEqual([
      'https://a.example',
    ])
    expect(
      resolveAllowedOrigins(
        { allowedOrigins: ['https://file.example'] },
        { PODIUM_ALLOWED_ORIGINS: ' https://b.example , ,https://a.example,https://b.example ' },
      ),
    ).toEqual(['https://b.example', 'https://a.example'])
  })

  it('resolveAllowedOrigins: a PRESENT but empty variable is an explicit empty list', () => {
    expect(
      resolveAllowedOrigins(
        { allowedOrigins: ['https://file.example'] },
        { PODIUM_ALLOWED_ORIGINS: '' },
      ),
    ).toEqual([])
  })

  it('resolveAllowedOrigins: rejects wildcards and anything past the origin', () => {
    for (const bad of ['*', 'https://*.example', 'https://a.example/app', 'a.example']) {
      expect(() => resolveAllowedOrigins({}, { PODIUM_ALLOWED_ORIGINS: bad })).toThrow(
        /PODIUM_ALLOWED_ORIGINS/,
      )
    }
  })

  it('resolveUpdateScope: env → file → all', () => {
    expect(resolveUpdateScope({}, {})).toBe('all')
    expect(resolveUpdateScope({ updateScope: 'fleet-only' }, {})).toBe('fleet-only')
    expect(resolveUpdateScope({ updateScope: 'fleet-only' }, { PODIUM_UPDATE_SCOPE: 'all' })).toBe(
      'all',
    )
    expect(() => resolveUpdateScope({}, { PODIUM_UPDATE_SCOPE: 'none' })).toThrow(
      /PODIUM_UPDATE_SCOPE.*all, fleet-only/,
    )
  })

  it('resolveTranscriptLake: env → file → on', () => {
    expect(resolveTranscriptLake({}, {})).toBe('on')
    expect(resolveTranscriptLake({ transcriptLake: 'off' }, {})).toBe('off')
    expect(resolveTranscriptLake({ transcriptLake: 'off' }, { PODIUM_TRANSCRIPT_LAKE: 'on' })).toBe(
      'on',
    )
    expect(() => resolveTranscriptLake({}, { PODIUM_TRANSCRIPT_LAKE: 'yes' })).toThrow(
      /PODIUM_TRANSCRIPT_LAKE.*on, off/,
    )
  })

  it('the new config keys round-trip through the file', () => {
    saveConfig({
      mode: 'server',
      allowedOrigins: ['https://app.example'],
      updateScope: 'fleet-only',
      transcriptLake: 'off',
    })
    expect(loadConfig()).toMatchObject({
      allowedOrigins: ['https://app.example'],
      updateScope: 'fleet-only',
      transcriptLake: 'off',
    })
  })
})

describe('resolveSetting provenance', () => {
  it('reports the layer each value came from', () => {
    expect(resolveSetting('updateChannel', {}, {})).toEqual({ value: 'stable', source: 'default' })
    expect(resolveSetting('updateChannel', { updateChannel: 'edge' }, {})).toEqual({
      value: 'edge',
      source: 'file',
    })
    expect(
      resolveSetting('updateChannel', { updateChannel: 'edge' }, { PODIUM_UPDATE_CHANNEL: 'dev' }),
    ).toEqual({ value: 'dev', source: 'env', env: 'PODIUM_UPDATE_CHANNEL' })
  })

  it('an absent optional key with no file value reports the default layer', () => {
    expect(resolveSetting('publicUrl', {}, {})).toEqual({ value: undefined, source: 'default' })
    expect(resolveSetting('mode', {}, { PODIUM_MODE: 'server' })).toEqual({
      value: 'server',
      source: 'env',
      env: 'PODIUM_MODE',
    })
  })

  it('every layered key resolves and names a PODIUM_ variable', () => {
    for (const key of LAYERED_KEYS) {
      expect(LAYERED_ENV[key]).toMatch(/^PODIUM_/)
      expect(resolveSetting(key, {}, {}).source).toBe('default')
    }
  })

  it('the shipped accessors and resolveSetting cannot disagree', () => {
    const config = { port: 1234, updateChannel: 'edge' as const, agentHome: '/tmp/h' }
    const env = { PODIUM_UPDATE_FEED: 'https://feed.example' }
    expect(resolveSetting('port', config, env).value).toBe(resolvePort(config, env))
    expect(resolveSetting('updateChannel', config, env).value).toBe(
      resolveUpdateChannel(config, env),
    )
    expect(resolveSetting('updateFeed', config, env).value).toBe(resolveUpdateFeed(config, env))
    expect(resolveSetting('agentHome', config, env).value).toBe(resolveAgentHomeDir(config, env))
  })
})
