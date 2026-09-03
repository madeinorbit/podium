import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_CONFIG_VERSION, loadConfig, saveConfig } from './config'
import { encodeJoin } from './join'
import {
  applyJoin,
  applyLocalSetupDefault,
  applyMode,
  applyServerUrl,
  applySetup,
  consumePairCode,
  ephemeralTunnelWarning,
  fetchRemoteAppUrl,
  fetchTargetAppUrl,
  getUpdateChannel,
  networkOptionCommand,
  setUpdateChannel,
  validatePublicUrl,
  wssFrom,
} from './setup'

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('setup core', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-setup-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
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
    applySetup({ publicUrl: 'https://box.ts.net', networkOption: 'tailscale-serve' })
    expect(loadConfig()).toEqual({
      configVersion: CURRENT_CONFIG_VERSION,
      mode: 'all-in-one',
      publicUrl: 'https://box.ts.net',
      networkOption: 'tailscale-serve',
      // Web setup can't START the backend from inside the serving process, but
      // it records the CHOICE — one field, not an intent beside a result
      // (POD-333). The next `podium` invocation brings the split up.
      persistence: 'systemd',
    })
  })
  it('applySetup preserves a relay-only `server` mode when the URL is set later', () => {
    saveConfig({ mode: 'server' })
    applySetup({ publicUrl: 'https://relay.ts.net' })
    expect(loadConfig()).toMatchObject({ mode: 'server', publicUrl: 'https://relay.ts.net' })
  })
  it('applySetup takes an explicit mode (web server-only reachability, fresh config)', () => {
    applySetup({ publicUrl: 'https://relay.ts.net', mode: 'server', port: 24_444 })
    expect(loadConfig()).toMatchObject({
      mode: 'server',
      publicUrl: 'https://relay.ts.net',
      port: 24_444,
    })
  })
  it('applySetup does not overwrite a persistence the box already chose', () => {
    saveConfig({ mode: 'all-in-one', persistence: 'detached' })
    applySetup({ publicUrl: 'https://box.ts.net' })
    expect(loadConfig().persistence).toBe('detached')
  })
  it('applySetup invents no persistence for a box that already answered "none" [POD-2766]', () => {
    // A CONFIGURED box with no `persistence` HAS answered: since config v2 that
    // absence means "not headless-managed" — a desktop sidecar, or a container
    // running the binary in the foreground.
    //
    // The back-fill used to run on every call, so `setup.complete` — which is
    // also how a password is set — wrote `systemd` over that answer. Two things
    // went wrong at once: the box was told something untrue about how it is
    // supervised, and `persistence` is BOOT-RELEVANT, so the running server saw
    // its config change underneath it, declared itself stale and shut the data
    // plane. Login is behind the data plane, so setting a password locked the
    // operator out of their own server.
    saveConfig({ mode: 'all-in-one', publicUrl: 'https://sandbox.example.com' })
    applySetup({ publicUrl: 'https://sandbox.example.com' })
    expect(loadConfig().persistence).toBeUndefined()
    // Everything the caller DID ask for still lands.
    expect(loadConfig()).toMatchObject({
      mode: 'all-in-one',
      publicUrl: 'https://sandbox.example.com',
    })
  })
  it('applyJoin writes a daemon config from a join token', () => {
    const token = encodeJoin({ v: 1, serverUrl: 'wss://relay', pairCode: 'P1', name: 'box' })
    expect(applyJoin(token)).toEqual({ name: 'box' })
    expect(loadConfig()).toEqual({
      configVersion: CURRENT_CONFIG_VERSION,
      mode: 'daemon',
      serverUrl: 'wss://relay',
      pairCode: 'P1',
      persistence: 'systemd',
    })
  })
  it('applyJoin persists shared mode from the join token', () => {
    const token = encodeJoin({
      v: 1,
      serverUrl: 'wss://relay',
      pairCode: 'P1',
      podiumManaged: false,
    })
    applyJoin(token)
    expect(loadConfig().podiumManaged).toBe(false)
  })

  it('applyJoin PATCHES config: updateChannel/port/persistence survive; host fields drop (#20)', () => {
    // The install.sh --channel edge --join regression: the join must not revert the channel.
    saveConfig({
      mode: 'all-in-one',
      publicUrl: 'https://old-host.ts.net',
      networkOption: 'tailscale-serve',
      pairCode: 'STALE',
      updateChannel: 'edge',
      port: 19999,
      persistence: 'systemd',
    })
    const token = encodeJoin({ v: 1, serverUrl: 'wss://relay', pairCode: 'P2' })
    applyJoin(token)
    expect(loadConfig()).toEqual({
      configVersion: CURRENT_CONFIG_VERSION,
      mode: 'daemon',
      serverUrl: 'wss://relay',
      pairCode: 'P2', // fresh code replaces the stale one
      updateChannel: 'edge', // preserved
      port: 19999, // preserved
      persistence: 'systemd', // preserved, not re-decided
      // publicUrl and networkOption dropped: a daemon box hosts nothing
    })
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
  /**
   * PDM-34. `uiUrl` is the client-side answer to "where is the UI for the server
   * I dial", and every writer here is re-pointing this box at a server — so the
   * cases that matter are as much about CLEARING a stale value as writing a new
   * one.
   */
  describe('uiUrl (split hosting)', () => {
    const token = (serverUrl: string) => encodeJoin({ v: 1, serverUrl, pairCode: 'P1' })

    it('applyJoin persists the UI origin the joined server advertised', () => {
      applyJoin(token('wss://api.example.com'), 'https://app.example.com')
      expect(loadConfig().uiUrl).toBe('https://app.example.com')
    })

    it('applyJoin without one leaves the key absent — the UI is the server', () => {
      applyJoin(token('wss://api.example.com'))
      expect(loadConfig()).not.toHaveProperty('uiUrl')
    })

    it('applyJoin CLEARS a uiUrl left behind by a previous server', () => {
      // The exact regression: re-join a self-hosted box and the window would
      // still open the previous deployment's app host.
      applyJoin(token('wss://api.example.com'), 'https://app.example.com')
      applyJoin(token('wss://elsewhere.example'))
      expect(loadConfig()).not.toHaveProperty('uiUrl')
      expect(loadConfig().serverUrl).toBe('wss://elsewhere.example')
    })

    it('applyMode persists and clears it for client mode', () => {
      applyMode({
        mode: 'client',
        serverUrl: 'wss://api.example.com',
        uiUrl: 'https://app.example.com',
      })
      expect(loadConfig().uiUrl).toBe('https://app.example.com')
      applyMode({ mode: 'client', serverUrl: 'wss://plain.example' })
      expect(loadConfig()).not.toHaveProperty('uiUrl')
    })

    it('applyMode back to all-in-one drops it: a local server serves its own UI', () => {
      applyMode({
        mode: 'client',
        serverUrl: 'wss://api.example.com',
        uiUrl: 'https://app.example.com',
      })
      applyMode({ mode: 'all-in-one' })
      expect(loadConfig()).not.toHaveProperty('uiUrl')
    })

    it('applyServerUrl re-decides it, because a rotated URL can be another deployment', () => {
      applyJoin(token('wss://api.example.com'), 'https://app.example.com')
      applyServerUrl('https://other.example', 'https://ui.other.example')
      expect(loadConfig().uiUrl).toBe('https://ui.other.example')
      applyServerUrl('https://third.example')
      expect(loadConfig()).not.toHaveProperty('uiUrl')
    })
  })

  /**
   * The one network call in the setup core. Everything that is not a bare https
   * origin from a live server has to answer `undefined`, because `undefined`
   * means "load the server's own URL" — the behaviour every self-hosted install
   * already has, and the only safe thing to do when we cannot tell who answered.
   */
  describe('fetchRemoteAppUrl', () => {
    const respond = (body: unknown, ok = true) =>
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok,
        json: async () => body,
      } as Response)

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('reads appUrl from the remote /version, asking over http(s) not ws', async () => {
      const fetchMock = respond({ appUrl: 'https://app.meetpodium.com' })
      await expect(fetchRemoteAppUrl('wss://api.meetpodium.com')).resolves.toBe(
        'https://app.meetpodium.com',
      )
      expect(String((fetchMock.mock.calls[0] as [URL])[0])).toBe(
        'https://api.meetpodium.com/version',
      )
    })

    it('is undefined for a server that advertises nothing', async () => {
      respond({ instanceId: 'i1' })
      await expect(fetchRemoteAppUrl('wss://api.example.com')).resolves.toBeUndefined()
    })

    it('is undefined for a non-2xx answer', async () => {
      respond({ appUrl: 'https://app.example.com' }, false)
      await expect(fetchRemoteAppUrl('wss://api.example.com')).resolves.toBeUndefined()
    })

    it('is undefined when the server is unreachable — a join must not fail for this', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
      await expect(fetchRemoteAppUrl('wss://api.example.com')).resolves.toBeUndefined()
    })

    it.each([
      ['not https', 'http://app.example.com'],
      ['carries a path', 'https://app.example.com/ui'],
      ['carries a query', 'https://app.example.com/?x=1'],
      ['is not a URL', 'app.example.com'],
      ['is not a string', 42],
    ])('rejects an advertised value that %s', async (_why, appUrl) => {
      respond({ appUrl })
      await expect(fetchRemoteAppUrl('wss://api.example.com')).resolves.toBeUndefined()
    })

    it('normalizes a trailing slash to a bare origin', async () => {
      respond({ appUrl: 'https://app.example.com/' })
      await expect(fetchRemoteAppUrl('wss://api.example.com')).resolves.toBe(
        'https://app.example.com',
      )
    })

    it('is undefined for an unusable server URL, without calling out', async () => {
      const fetchMock = respond({ appUrl: 'https://app.example.com' })
      await expect(fetchRemoteAppUrl('not a url')).resolves.toBeUndefined()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('fetchTargetAppUrl asks the server named inside a join token', async () => {
      const fetchMock = respond({ appUrl: 'https://app.meetpodium.com' })
      const token = encodeJoin({ v: 1, serverUrl: 'wss://api.meetpodium.com', pairCode: 'P1' })
      await expect(fetchTargetAppUrl(token)).resolves.toBe('https://app.meetpodium.com')
      expect(String((fetchMock.mock.calls[0] as [URL])[0])).toBe(
        'https://api.meetpodium.com/version',
      )
    })

    it('fetchTargetAppUrl accepts a bare server URL too — set-server takes either', async () => {
      const fetchMock = respond({ appUrl: 'https://app.meetpodium.com' })
      await expect(fetchTargetAppUrl('https://api.meetpodium.com')).resolves.toBe(
        'https://app.meetpodium.com',
      )
      expect(String((fetchMock.mock.calls[0] as [URL])[0])).toBe(
        'https://api.meetpodium.com/version',
      )
    })

    it('fetchTargetAppUrl is undefined for input that is neither, without calling out', async () => {
      const fetchMock = respond({ appUrl: 'https://app.example.com' })
      await expect(fetchTargetAppUrl('garbage!')).resolves.toBeUndefined()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  it('applyLocalSetupDefault persists all-in-one on a fresh box and preserves config', () => {
    saveConfig({ updateChannel: 'edge' })
    expect(applyLocalSetupDefault()).toBe('applied')
    expect(loadConfig()).toMatchObject({ mode: 'all-in-one', updateChannel: 'edge' })
  })
  it('applyLocalSetupDefault never replaces an explicit advanced choice', () => {
    saveConfig({ mode: 'server', publicUrl: 'https://relay.example' })
    expect(applyLocalSetupDefault()).toBe('configured')
    expect(loadConfig()).toMatchObject({ mode: 'server', publicUrl: 'https://relay.example' })
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
        configVersion: CURRENT_CONFIG_VERSION,
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
        configVersion: CURRENT_CONFIG_VERSION,
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
      saveConfig({
        mode: 'daemon',
        serverUrl: 'wss://relay',
        pairCode: 'P1',
        persistence: 'systemd',
      })
      consumePairCode('P1')
      expect(loadConfig()).toEqual({
        configVersion: CURRENT_CONFIG_VERSION,
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

  describe('destructive re-setup over a corrupt config is refused (#21)', () => {
    it('every setup mutation throws and leaves the broken file for --repair', () => {
      const { writeFileSync, readFileSync } = require('node:fs')
      const configFile = join(dir, 'config.json')
      writeFileSync(configFile, '{not json')
      expect(() => applySetup({ publicUrl: 'https://box.ts.net' })).toThrow(/--repair/)
      expect(() =>
        applyJoin(encodeJoin({ v: 1, serverUrl: 'wss://relay', pairCode: 'P1' })),
      ).toThrow(/--repair/)
      expect(() => applyMode({ mode: 'server' })).toThrow(/--repair/)
      expect(applyLocalSetupDefault()).toBe('blocked')
      expect(() => applyServerUrl('wss://new.example')).toThrow(/--repair/)
      // The broken file is untouched — the operator's data is recoverable.
      expect(readFileSync(configFile, 'utf8')).toBe('{not json')
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

const priorStateDirForEnvTests = process.env.PODIUM_STATE_DIR!

describe('the deployment owns mode and public URL (PDM-26)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-setup-env-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    process.env.PODIUM_STATE_DIR = priorStateDirForEnvTests
    rmSync(dir, { recursive: true, force: true })
  })

  it('applySetup refuses when PODIUM_MODE is set', () => {
    vi.stubEnv('PODIUM_MODE', 'server')
    expect(() => applySetup({ publicUrl: 'https://a.example' })).toThrow(/PODIUM_MODE/)
  })

  it('applySetup refuses when PODIUM_PUBLIC_URL is set', () => {
    vi.stubEnv('PODIUM_PUBLIC_URL', 'https://a.example')
    expect(() => applySetup({ publicUrl: 'https://b.example' })).toThrow(/PODIUM_PUBLIC_URL/)
  })

  it('applyMode and applyJoin refuse under PODIUM_MODE, before they parse anything', () => {
    vi.stubEnv('PODIUM_MODE', 'server')
    expect(() => applyMode({ mode: 'all-in-one' })).toThrow(/PODIUM_MODE/)
    expect(() => applyJoin('not-even-a-token')).toThrow(/PODIUM_MODE/)
  })

  it('applyLocalSetupDefault is blocked under PODIUM_MODE — it must not contradict the env', () => {
    vi.stubEnv('PODIUM_MODE', 'server')
    expect(applyLocalSetupDefault()).toBe('blocked')
    expect(loadConfig().mode).toBeUndefined()
  })

  it('a SECOND, different public URL needs confirmation; the same URL is idempotent', () => {
    expect(applySetup({ publicUrl: 'https://a.example' }).publicUrl).toBe('https://a.example')
    expect(() => applySetup({ publicUrl: 'https://b.example' })).toThrow(
      /already set to https:\/\/a\.example/,
    )
    expect(applySetup({ publicUrl: 'https://a.example' }).publicUrl).toBe('https://a.example')
    expect(applySetup({ publicUrl: 'https://b.example', confirmUrlChange: true }).publicUrl).toBe(
      'https://b.example',
    )
  })

  it('confirmUrlChange is a flag, never a config key', () => {
    applySetup({ publicUrl: 'https://a.example', confirmUrlChange: true })
    expect(loadConfig()).not.toHaveProperty('confirmUrlChange')
  })
})
