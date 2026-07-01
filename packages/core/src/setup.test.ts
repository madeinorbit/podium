import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config'
import { encodeJoin } from './join'
import {
  applyJoin,
  applyMode,
  applySetup,
  getUpdateChannel,
  networkOptionCommand,
  setUpdateChannel,
  validatePublicUrl,
  wssFrom,
} from './setup'

describe('setup core', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-setup-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    delete process.env.PODIUM_STATE_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('funnel command includes the port', () => {
    expect(networkOptionCommand('tailscale-funnel', 18787).command).toBe('tailscale funnel 18787')
  })
  it('cloudflare command targets localhost:port', () => {
    expect(networkOptionCommand('cloudflare-tunnel', 18787).command).toBe(
      'cloudflared tunnel --url http://localhost:18787',
    )
  })
  it('validatePublicUrl accepts https and strips a trailing slash', () => {
    expect(validatePublicUrl('https://box.ts.net/')).toEqual({
      ok: true,
      normalized: 'https://box.ts.net',
    })
  })
  it('validatePublicUrl rejects a non-http(s) url', () => {
    expect(validatePublicUrl('ftp://x').ok).toBe(false)
    expect(validatePublicUrl('not a url').ok).toBe(false)
  })
  it('wssFrom converts https→wss and http→ws', () => {
    expect(wssFrom('https://box.ts.net')).toBe('wss://box.ts.net')
    expect(wssFrom('http://10.0.0.1:18787')).toBe('ws://10.0.0.1:18787')
  })
  it('applySetup persists mode + publicUrl', () => {
    applySetup({ publicUrl: 'https://box.ts.net' })
    expect(loadConfig()).toEqual({ mode: 'all-in-one', publicUrl: 'https://box.ts.net' })
  })
  it('applyJoin writes a self-contained daemon config from a join token', () => {
    const token = encodeJoin({ v: 1, serverUrl: 'wss://relay', pairCode: 'P1', name: 'box' })
    expect(applyJoin(token)).toEqual({ name: 'box' })
    expect(loadConfig()).toEqual({ mode: 'daemon', serverUrl: 'wss://relay', pairCode: 'P1' })
  })
  it('applyJoin throws on a malformed token', () => {
    expect(() => applyJoin('garbage!')).toThrow()
  })
  it('applyMode persists client mode + server URL', () => {
    applyMode({ mode: 'client', serverUrl: 'ws://host:18787' })
    expect(loadConfig().mode).toBe('client')
    expect(loadConfig().serverUrl).toBe('ws://host:18787')
  })
  it('applyMode persists server mode (no URL needed)', () => {
    applyMode({ mode: 'server' })
    expect(loadConfig().mode).toBe('server')
  })
  it('applyMode requires a server URL for client mode', () => {
    expect(() => applyMode({ mode: 'client' })).toThrow()
    expect(loadConfig().mode).toBeUndefined()
  })
  it('getUpdateChannel defaults to stable when unset', () => {
    expect(getUpdateChannel()).toBe('stable')
  })
  it('setUpdateChannel persists and getUpdateChannel reflects it', () => {
    expect(setUpdateChannel('edge')).toBe('edge')
    expect(getUpdateChannel()).toBe('edge')
    expect(loadConfig().updateChannel).toBe('edge')
  })
  it('setUpdateChannel round-trips back to stable', () => {
    setUpdateChannel('edge')
    setUpdateChannel('stable')
    expect(getUpdateChannel()).toBe('stable')
    expect(loadConfig().updateChannel).toBe('stable')
  })
})
