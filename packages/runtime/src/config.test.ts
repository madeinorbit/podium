import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configPath,
  inspectConfig,
  loadConfig,
  needsSetup,
  resolveAgentHomeDir,
  resolveAgentRelay,
  resolveAgentRelayPort,
  resolveHookPort,
  resolveInstallDir,
  resolvePort,
  resolveRunRecordMode,
  resolveUpdateChannel,
  resolveUpdateFeed,
  resolveUpdateTarget,
  saveConfig,
} from './config'

describe('podium config', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-cfg-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    delete process.env.PODIUM_STATE_DIR
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
    expect(loadConfig()).toEqual({ mode: 'daemon', serverUrl: 'ws://host:18787' })
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
    expect(inspectConfig()).toEqual({ state: 'missing', config: {} })
    saveConfig({ mode: 'server' })
    expect(inspectConfig()).toEqual({ state: 'ok', config: { mode: 'server' } })
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
      mode: 'all-in-one',
      updateChannel: 'edge',
      publicUrl: 'https://b.ts.net',
    })
  })
  it('loads an old config without the new fields', () => {
    saveConfig({ mode: 'server' })
    expect(loadConfig()).toEqual({ mode: 'server' })
  })
  it('rejects an invalid updateChannel', () => {
    expect(() => saveConfig({ updateChannel: 'nightly' } as never)).toThrow()
  })
  it('round-trips the upstream hub target (node⇄hub sync §2.1)', () => {
    saveConfig({
      mode: 'server',
      upstream: { url: 'https://hub.example:18787', token: 'tok_abc' },
    })
    expect(loadConfig()).toEqual({
      mode: 'server',
      upstream: { url: 'https://hub.example:18787', token: 'tok_abc' },
    })
  })
  it('rejects a partial upstream block (url and token are both required)', () => {
    expect(() => saveConfig({ upstream: { url: 'https://hub' } } as never)).toThrow()
  })
})

describe('layered resolvers (#251): env → config.json → default', () => {
  it('resolvePort: PODIUM_PORT > config.port > 18787; junk env falls through', () => {
    expect(resolvePort({ port: 2000 }, { PODIUM_PORT: '3000' })).toBe(3000)
    expect(resolvePort({ port: 2000 }, {})).toBe(2000)
    expect(resolvePort({}, {})).toBe(18787)
    expect(resolvePort({ port: 2000 }, { PODIUM_PORT: 'nope' })).toBe(2000)
    expect(resolvePort({}, { PODIUM_PORT: '0' })).toBe(18787)
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
