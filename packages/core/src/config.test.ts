import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configPath, inspectConfig, loadConfig, needsSetup, saveConfig } from './config'

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
