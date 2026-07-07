import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, saveConfig } from './config'
import { encodeJoin } from './join'
import {
  applyJoin,
  applyMode,
  applyServerUrl,
  applySetup,
  consumePairCode,
  ephemeralTunnelWarning,
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
  it('cloudflare command targets the IPv4 loopback address', () => {
    expect(networkOptionCommand('cloudflare-tunnel', 18787).command).toBe(
      'cloudflared tunnel --url http://127.0.0.1:18787',
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
  it('applySetup persists mode + publicUrl (first run → all-in-one)', () => {
    applySetup({ publicUrl: 'https://box.ts.net' })
    expect(loadConfig()).toEqual({ mode: 'all-in-one', publicUrl: 'https://box.ts.net' })
  })
  it('applySetup preserves a relay-only `server` mode when the URL is set later', () => {
    saveConfig({ mode: 'server' })
    applySetup({ publicUrl: 'https://relay.ts.net' })
    expect(loadConfig()).toEqual({ mode: 'server', publicUrl: 'https://relay.ts.net' })
  })
  it('applySetup takes an explicit mode (web server-only reachability, fresh config)', () => {
    applySetup({ publicUrl: 'https://relay.ts.net', mode: 'server' })
    expect(loadConfig()).toEqual({ mode: 'server', publicUrl: 'https://relay.ts.net' })
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
  describe('applyServerUrl — URL rotation without re-setup (#19)', () => {
    it('patches ONLY serverUrl on a daemon box, preserving every other field', () => {
      saveConfig({
        mode: 'daemon',
        serverUrl: 'wss://old.example',
        updateChannel: 'edge',
        persistence: 'systemd',
        port: 19999,
      })
      const res = applyServerUrl('https://new.example')
      expect(res.serverUrl).toBe('wss://new.example') // http(s) is ws-ified
      expect(loadConfig()).toEqual({
        mode: 'daemon',
        serverUrl: 'wss://new.example',
        updateChannel: 'edge',
        persistence: 'systemd',
        port: 19999,
      })
    })
    it('accepts a pasted join code — takes its URL and fresh pair code', () => {
      saveConfig({ mode: 'daemon', serverUrl: 'wss://old.example', updateChannel: 'edge' })
      const token = encodeJoin({ v: 1, serverUrl: 'wss://new.example', pairCode: 'P9' })
      const res = applyServerUrl(token)
      expect(res).toMatchObject({ serverUrl: 'wss://new.example', pairCode: 'P9' })
      expect(loadConfig()).toEqual({
        mode: 'daemon',
        serverUrl: 'wss://new.example',
        pairCode: 'P9',
        updateChannel: 'edge',
      })
    })
    it('refuses on a host box (mode all-in-one/server/unset) — that is `podium setup`', () => {
      saveConfig({ mode: 'all-in-one', publicUrl: 'https://box.ts.net' })
      expect(() => applyServerUrl('wss://new.example')).toThrow(/set-server only applies/)
      expect(loadConfig().publicUrl).toBe('https://box.ts.net') // untouched
    })
    it('rejects garbage that is neither a URL nor a join code, leaving config intact', () => {
      saveConfig({ mode: 'daemon', serverUrl: 'wss://old.example' })
      expect(() => applyServerUrl('not a url')).toThrow(/not a server URL or join code/)
      expect(loadConfig().serverUrl).toBe('wss://old.example')
    })
    it('warns when the new URL is a rotating trycloudflare quick tunnel', () => {
      saveConfig({ mode: 'daemon', serverUrl: 'wss://old.example' })
      const res = applyServerUrl('wss://rand.trycloudflare.com')
      expect(res.warning).toMatch(/quick tunnel/i)
    })
  })

  describe('consumePairCode (#19)', () => {
    it('drops the exact consumed code, preserving the rest of the config', () => {
      saveConfig({ mode: 'daemon', serverUrl: 'wss://relay', pairCode: 'P1', persistence: 'systemd' })
      consumePairCode('P1')
      expect(loadConfig()).toEqual({
        mode: 'daemon',
        serverUrl: 'wss://relay',
        persistence: 'systemd',
      })
    })
    it('never drops a NEWER code written by a concurrent re-join', () => {
      saveConfig({ mode: 'daemon', serverUrl: 'wss://relay', pairCode: 'P2-newer' })
      consumePairCode('P1-old')
      expect(loadConfig().pairCode).toBe('P2-newer')
    })
  })

  describe('ephemeralTunnelWarning (#19)', () => {
    it('flags *.trycloudflare.com in any scheme', () => {
      expect(ephemeralTunnelWarning('https://a-b-c.trycloudflare.com')).toMatch(/quick tunnel/i)
      expect(ephemeralTunnelWarning('wss://a-b-c.trycloudflare.com')).toMatch(/quick tunnel/i)
    })
    it('does not flag stable hosts (incl. lookalike domains)', () => {
      expect(ephemeralTunnelWarning('https://box.ts.net')).toBeUndefined()
      expect(ephemeralTunnelWarning('https://nottrycloudflare.com')).toBeUndefined()
      expect(ephemeralTunnelWarning('garbage')).toBeUndefined()
    })
    it('applyJoin surfaces the warning for a quick-tunnel join code', () => {
      const token = encodeJoin({ v: 1, serverUrl: 'wss://x.trycloudflare.com', pairCode: 'P1' })
      expect(applyJoin(token).warning).toMatch(/quick tunnel/i)
    })
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
