import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, saveConfig } from './config'
import type { InstanceGuardIo } from './instance-guard'
import {
  acquireTunnelLock,
  parseQuickTunnelUrl,
  QUICK_TUNNEL_BACKOFF_MS,
  QuickTunnelSupervisor,
  quickTunnelArgs,
  quickTunnelOrigin,
  quickTunnelPreflight,
  recordQuickTunnelUrl,
  spawnCloudflared,
  TunnelAlreadyRunningError,
  type TunnelProcess,
} from './quick-tunnel'

/** What cloudflared 2024–2025 prints on stderr for a quick tunnel, box and all. */
function banner(url: string): string {
  return [
    '2025-09-23T10:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.',
    '2025-09-23T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
    '2025-09-23T10:00:01Z INF +--------------------------------------------------------------------------------------------+',
    '2025-09-23T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
    `2025-09-23T10:00:01Z INF |  ${url}                                     |`,
    '2025-09-23T10:00:01Z INF +--------------------------------------------------------------------------------------------+',
    '',
  ].join('\n')
}

// ---- a scripted fake cloudflared and a manual clock ----------------------------------

class FakeCloudflared implements TunnelProcess {
  readonly signals: string[] = []
  alive = true
  #output: ((chunk: string) => void)[] = []
  #exit: ((exit: { code: number | null; signal: string | null }) => void)[] = []
  constructor(readonly pid: number) {}
  onOutput(listener: (chunk: string) => void): void {
    this.#output.push(listener)
  }
  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): void {
    this.#exit.push(listener)
  }
  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal)
    // A well-behaved cloudflared: SIGTERM ends it. `stubborn` ones need SIGKILL.
    if (!this.stubborn || signal === 'SIGKILL') this.die(null, signal)
  }
  stubborn = false
  print(text: string): void {
    for (const listener of this.#output) listener(text)
  }
  die(code: number | null = 1, signal: string | null = null): void {
    if (!this.alive) return
    this.alive = false
    for (const listener of this.#exit) listener({ code, signal })
  }
}

class Clock {
  now = 0
  #next = 1
  #timers = new Map<number, { at: number; fn: () => void }>()
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.#next++
    this.#timers.set(id, { at: this.now + ms, fn })
    return id
  }
  clearTimer = (handle: unknown): void => {
    this.#timers.delete(handle as number)
  }
  get pending(): number {
    return this.#timers.size
  }
  /** Advance, firing due timers in order (timers they arm fire too, if due). */
  advance(ms: number): void {
    const until = this.now + ms
    for (;;) {
      let nextId: number | undefined
      let nextAt = Infinity
      for (const [id, t] of this.#timers) {
        if (t.at <= until && t.at < nextAt) {
          nextAt = t.at
          nextId = id
        }
      }
      if (nextId === undefined) break
      const timer = this.#timers.get(nextId)!
      this.#timers.delete(nextId)
      this.now = timer.at
      timer.fn()
    }
    this.now = until
  }
}

function harness(opts: { recordedUrl?: string; urlTimeoutMs?: number } = {}) {
  const clock = new Clock()
  const children: FakeCloudflared[] = []
  const recorded: string[] = []
  const logs: string[] = []
  const supervisor = new QuickTunnelSupervisor({
    spawn: () => {
      // The invariant under test everywhere: never a second live child.
      expect(children.filter((c) => c.alive)).toHaveLength(0)
      const child = new FakeCloudflared(1000 + children.length)
      children.push(child)
      return child
    },
    recordUrl: (url) => {
      recorded.push(url)
    },
    ...(opts.recordedUrl ? { recordedUrl: opts.recordedUrl } : {}),
    log: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: () => clock.now,
    ...(opts.urlTimeoutMs ? { urlTimeoutMs: opts.urlTimeoutMs } : {}),
  })
  const live = (): FakeCloudflared => {
    const child = children.at(-1)
    if (!child?.alive) throw new Error('no live cloudflared')
    return child
  }
  return { clock, children, recorded, logs, supervisor, live }
}

const A = 'https://prairie-otter-lamp-nine.trycloudflare.com'
const B = 'https://copper-hill-mango-seven.trycloudflare.com'

describe('parseQuickTunnelUrl', () => {
  it('finds the URL inside the banner box, by shape, not by line or column', () => {
    expect(parseQuickTunnelUrl(banner(A))).toBe(A)
    expect(parseQuickTunnelUrl(`|${A}|`)).toBe(A)
    expect(parseQuickTunnelUrl(`visit ${A.toUpperCase()}/ now`)).toBe(A)
  })
  it("never takes Cloudflare's own API endpoint from a failure line", () => {
    expect(
      parseQuickTunnelUrl(
        'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: i/o timeout',
      ),
    ).toBeUndefined()
    expect(parseQuickTunnelUrl('Requesting new quick Tunnel on trycloudflare.com...')).toBeUndefined()
  })
  it('rejects look-alikes that are not a trycloudflare.com subdomain', () => {
    expect(parseQuickTunnelUrl('https://evil.trycloudflare.com.attacker.net')).toBeUndefined()
    expect(parseQuickTunnelUrl('http://a-b.trycloudflare.com')).toBeUndefined()
    expect(parseQuickTunnelUrl('https://a.b.example.com')).toBeUndefined()
    expect(parseQuickTunnelUrl('https://evil.trycloudflare.com-attacker.net')).toBeUndefined()
    expect(parseQuickTunnelUrl('visit https://a-b.trycloudflare.com.')).toBe('https://a-b.trycloudflare.com')
    expect(parseQuickTunnelUrl('"https://a-b.trycloudflare.com/"')).toBe('https://a-b.trycloudflare.com')
  })
})

describe('QuickTunnelSupervisor', () => {
  it('records A, then after cloudflared dies and restarts printing B, records B', async () => {
    const h = harness()
    h.supervisor.start()
    h.live().print(banner(A))
    await h.supervisor.settled
    expect(h.recorded).toEqual([A])
    expect(h.supervisor.state).toBe('running')

    h.live().die(1)
    expect(h.supervisor.state).toBe('backoff')
    h.clock.advance(QUICK_TUNNEL_BACKOFF_MS[0])
    expect(h.children).toHaveLength(2)
    h.live().print(banner(B))
    await h.supervisor.settled
    expect(h.recorded).toEqual([A, B])
    expect(h.supervisor.url).toBe(B)
  })

  it('a restart that prints the SAME URL writes nothing', async () => {
    const h = harness()
    h.supervisor.start()
    h.live().print(banner(A))
    h.live().die(1)
    h.clock.advance(QUICK_TUNNEL_BACKOFF_MS[0])
    h.live().print(banner(A))
    await h.supervisor.settled
    expect(h.recorded).toEqual([A])
  })

  it('a URL already on record at start is not written again', async () => {
    const h = harness({ recordedUrl: A })
    h.supervisor.start()
    h.live().print(banner(A))
    await h.supervisor.settled
    expect(h.recorded).toEqual([])
  })

  it('parses only complete lines, so a URL split across two chunks is not truncated', async () => {
    const h = harness()
    h.supervisor.start()
    h.live().print('INF |  https://prairie-otter')
    h.live().print('-lamp-nine.trycloudflare.com   |\n')
    await h.supervisor.settled
    expect(h.recorded).toEqual([A])
  })

  it('restarts a repeatedly dying cloudflared with growing backoff, never spinning, and stays up', () => {
    const h = harness()
    h.supervisor.start()
    const delays: number[] = []
    for (let i = 0; i < QUICK_TUNNEL_BACKOFF_MS.length + 3; i++) {
      h.live().die(1)
      expect(h.supervisor.state).toBe('backoff')
      const before = h.children.length
      // Not a millisecond early: nothing restarts before the delay is up.
      let waited = 0
      while (h.children.length === before) {
        h.clock.advance(250)
        waited += 250
        expect(waited).toBeLessThanOrEqual(QUICK_TUNNEL_BACKOFF_MS.at(-1)!)
      }
      delays.push(waited)
    }
    expect(delays.slice(0, QUICK_TUNNEL_BACKOFF_MS.length)).toEqual([...QUICK_TUNNEL_BACKOFF_MS])
    // Capped, not reset and not unbounded.
    expect(delays.slice(QUICK_TUNNEL_BACKOFF_MS.length)).toEqual([300_000, 300_000, 300_000])
    expect(h.supervisor.state).toBe('starting')
    expect(h.children.filter((c) => c.alive)).toHaveLength(1)
  })

  it('a run that served a URL for a while resets the backoff: a normal rotation restarts fast', () => {
    const h = harness()
    h.supervisor.start()
    for (let i = 0; i < 4; i++) {
      h.live().die(1)
      h.clock.advance(QUICK_TUNNEL_BACKOFF_MS[i]!)
    }
    h.live().print(banner(A))
    h.clock.advance(10 * 60_000)
    h.live().die(0)
    const before = h.children.length
    h.clock.advance(QUICK_TUNNEL_BACKOFF_MS[0])
    expect(h.children.length).toBe(before + 1)
  })

  it('a cloudflared that starts but never prints a URL is a failed start, not a hang', () => {
    const h = harness({ urlTimeoutMs: 30_000 })
    h.supervisor.start()
    const first = h.live()
    first.print('INF Requesting new quick Tunnel on trycloudflare.com...\n')
    h.clock.advance(29_999)
    expect(first.alive).toBe(true)
    h.clock.advance(1)
    expect(first.signals).toEqual(['SIGTERM'])
    expect(first.alive).toBe(false)
    expect(h.logs.some((l) => l.includes('printed no tunnel URL'))).toBe(true)
    h.clock.advance(QUICK_TUNNEL_BACKOFF_MS[0])
    expect(h.children).toHaveLength(2)
  })

  it('a wedged cloudflared that ignores SIGTERM is SIGKILLed, and only then replaced', () => {
    const h = harness({ urlTimeoutMs: 1_000 })
    h.supervisor.start()
    const first = h.live()
    first.stubborn = true
    h.clock.advance(1_000)
    expect(first.signals).toEqual(['SIGTERM'])
    // Still alive: no second process, whatever time passes short of the grace.
    h.clock.advance(4_999)
    expect(h.children).toHaveLength(1)
    h.clock.advance(1)
    expect(first.signals).toEqual(['SIGTERM', 'SIGKILL'])
    h.clock.advance(QUICK_TUNNEL_BACKOFF_MS[0])
    expect(h.children).toHaveLength(2)
  })

  it('never starts a second cloudflared while one is alive', () => {
    const h = harness()
    h.supervisor.start()
    h.supervisor.start()
    h.live().print(banner(A))
    h.supervisor.start()
    h.clock.advance(60 * 60_000)
    expect(h.children).toHaveLength(1)
  })

  it('stop takes cloudflared down and resolves only once it has exited; nothing restarts', async () => {
    const h = harness()
    h.supervisor.start()
    const child = h.live()
    child.print(banner(A))
    child.stubborn = true
    let stopped = false
    const stopping = h.supervisor.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(child.signals).toEqual(['SIGTERM'])
    expect(stopped).toBe(false)
    h.clock.advance(5_000)
    await stopping
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.alive).toBe(false)
    expect(h.supervisor.state).toBe('stopped')
    h.clock.advance(60 * 60_000)
    expect(h.children).toHaveLength(1)
    expect(h.clock.pending).toBe(0)
  })

  it('stop during a backoff cancels the pending restart', async () => {
    const h = harness()
    h.supervisor.start()
    h.live().die(1)
    await h.supervisor.stop()
    h.clock.advance(60 * 60_000)
    expect(h.children).toHaveLength(1)
    expect(h.supervisor.state).toBe('stopped')
  })

  it('a failed write is logged and retried by the next run that prints a URL', async () => {
    const clock = new Clock()
    const children: FakeCloudflared[] = []
    const attempts: string[] = []
    let failNext = true
    const supervisor = new QuickTunnelSupervisor({
      spawn: () => {
        const child = new FakeCloudflared(children.length)
        children.push(child)
        return child
      },
      recordUrl: (url) => {
        attempts.push(url)
        if (failNext) {
          failNext = false
          throw new Error('config.json exists but is invalid')
        }
      },
      log: { info: () => {}, warn: () => {} },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
    })
    supervisor.start()
    children.at(-1)!.print(banner(A))
    await supervisor.settled
    children.at(-1)!.die(1)
    clock.advance(QUICK_TUNNEL_BACKOFF_MS[0])
    children.at(-1)!.print(banner(A))
    await supervisor.settled
    expect(attempts).toEqual([A, A])
  })
})

describe('the opt-in and its preconditions', () => {
  const always = () => true

  it('is OFF by default: a fresh box refuses to start a tunnel', () => {
    const result = quickTunnelPreflight({ config: {}, env: {}, hasBinary: always })
    expect(result.ok).toBe(false)
  })

  it('is OFF for a configured host that chose any other reachability option', () => {
    for (const networkOption of ['tailscale-funnel', 'tailscale-serve', 'manual'] as const) {
      const result = quickTunnelPreflight({
        config: { mode: 'all-in-one', networkOption, publicUrl: 'https://box.ts.net' },
        env: {},
        hasBinary: always,
      })
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('opted in') })
    }
  })

  it('runs only for a host that chose the cloudflare quick tunnel', () => {
    expect(
      quickTunnelPreflight({
        config: { mode: 'server', networkOption: 'cloudflare-tunnel', port: 18787 },
        env: {},
        hasBinary: always,
      }),
    ).toEqual({ ok: true, origin: 'http://127.0.0.1:18787' })
  })

  it('PODIUM_PUBLIC_URL set: refuses, and says the deployment owns the URL', () => {
    const result = quickTunnelPreflight({
      config: { mode: 'all-in-one', networkOption: 'cloudflare-tunnel' },
      env: { PODIUM_PUBLIC_URL: 'https://podium.example.com' },
      hasBinary: always,
    })
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('PODIUM_PUBLIC_URL is set'),
    })
    expect(result.ok === false && result.reason).toContain('deployment owns the public URL')
  })

  it('refuses on a daemon or client box: those do not host the server', () => {
    for (const mode of ['daemon', 'client'] as const) {
      expect(
        quickTunnelPreflight({
          config: { mode, networkOption: 'cloudflare-tunnel' },
          env: {},
          hasBinary: always,
        }).ok,
      ).toBe(false)
    }
  })

  it('refuses without cloudflared on PATH, and says how to install it (never installs it)', () => {
    const result = quickTunnelPreflight({
      config: { mode: 'all-in-one', networkOption: 'cloudflare-tunnel' },
      env: {},
      hasBinary: () => false,
    })
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('cloudflared is not installed') })
  })

  it('forwards to IPv4 loopback, or to the one interface the server bound', () => {
    expect(quickTunnelOrigin(18787, {})).toBe('http://127.0.0.1:18787')
    expect(quickTunnelOrigin(18787, { PODIUM_HOST: '0.0.0.0' })).toBe('http://127.0.0.1:18787')
    expect(quickTunnelOrigin(18787, { PODIUM_HOST: '10.0.0.5' })).toBe('http://10.0.0.5:18787')
    expect(quickTunnelArgs('http://127.0.0.1:18787')).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--url',
      'http://127.0.0.1:18787',
    ])
  })
})

describe('recordQuickTunnelUrl', () => {
  const priorStateDir = process.env.PODIUM_STATE_DIR
  const priorPublicUrl = process.env.PODIUM_PUBLIC_URL
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-quick-tunnel-'))
    process.env.PODIUM_STATE_DIR = dir
    delete process.env.PODIUM_PUBLIC_URL
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    if (priorPublicUrl === undefined) delete process.env.PODIUM_PUBLIC_URL
    else process.env.PODIUM_PUBLIC_URL = priorPublicUrl
    rmSync(dir, { recursive: true, force: true })
  })

  it('replaces a live public URL (the rotation) and keeps everything else', () => {
    saveConfig({ mode: 'all-in-one', publicUrl: A, networkOption: 'cloudflare-tunnel', port: 18787 })
    expect(recordQuickTunnelUrl(`${B}/`)).toBe(true)
    expect(loadConfig()).toMatchObject({
      mode: 'all-in-one',
      publicUrl: B,
      networkOption: 'cloudflare-tunnel',
      port: 18787,
    })
  })

  it('the same URL writes nothing', () => {
    saveConfig({ mode: 'server', publicUrl: A, networkOption: 'cloudflare-tunnel' })
    expect(recordQuickTunnelUrl(A)).toBe(false)
  })

  it('refuses when PODIUM_PUBLIC_URL owns the URL', () => {
    saveConfig({ mode: 'all-in-one', publicUrl: A, networkOption: 'cloudflare-tunnel' })
    process.env.PODIUM_PUBLIC_URL = 'https://podium.example.com'
    expect(() => recordQuickTunnelUrl(B)).toThrow(/PODIUM_PUBLIC_URL/)
    delete process.env.PODIUM_PUBLIC_URL
    expect(loadConfig().publicUrl).toBe(A)
  })

  it('never turns a box that became a daemon back into a host', () => {
    saveConfig({ mode: 'daemon', serverUrl: 'wss://elsewhere.example.com' })
    expect(() => recordQuickTunnelUrl(B)).toThrow(/mode=daemon/)
    expect(loadConfig()).toMatchObject({ mode: 'daemon' })
    expect(loadConfig().publicUrl).toBeUndefined()
  })
})

describe('acquireTunnelLock', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-tunnel-lock-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function io(self: number, alive: Record<number, string>): InstanceGuardIo {
    return {
      pidAlive: (pid) => pid in alive,
      bootId: () => 'boot-1',
      startTime: (pid) => alive[pid],
      now: () => 0,
      selfPid: () => self,
    }
  }

  it('refuses a second wrapper while the first is alive, and frees on release', () => {
    const path = join(dir, 'tunnel.json')
    const first = acquireTunnelLock({ path, io: io(10, { 10: 's10', 20: 's20' }) })
    expect(() => acquireTunnelLock({ path, io: io(20, { 10: 's10', 20: 's20' }) })).toThrow(
      TunnelAlreadyRunningError,
    )
    first.release()
    expect(() => acquireTunnelLock({ path, io: io(20, { 10: 's10', 20: 's20' }) })).not.toThrow()
  })

  it("reaps a dead wrapper's surviving cloudflared before a new one starts", () => {
    const path = join(dir, 'tunnel.json')
    const first = acquireTunnelLock({ path, io: io(10, { 10: 's10', 11: 's11' }) })
    first.setChild(11)
    // Wrapper 10 was SIGKILLed; its cloudflared 11 is still running.
    const killed: [number, string][] = []
    const second = acquireTunnelLock({
      path,
      io: io(20, { 11: 's11', 20: 's20' }),
      kill: (pid, signal) => killed.push([pid, signal]),
    })
    expect(killed).toEqual([[11, 'SIGTERM']])
    expect(second.reapedOrphan).toBe(11)
  })

  it('never signals a recycled pid that only LOOKS like the old cloudflared', () => {
    const path = join(dir, 'tunnel.json')
    const first = acquireTunnelLock({ path, io: io(10, { 10: 's10', 11: 's11' }) })
    first.setChild(11)
    const killed: number[] = []
    acquireTunnelLock({
      path,
      io: io(20, { 11: 'a-different-process', 20: 's20' }),
      kill: (pid) => killed.push(pid),
    })
    expect(killed).toEqual([])
  })
})

describe('spawnCloudflared (a real fake process, never the real binary)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-fake-cloudflared-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('reads the URL from stderr, and shutting down leaves no process behind', async () => {
    const fake = join(dir, 'cloudflared')
    // A shell that forks a long-lived helper, which a pid-only kill would orphan.
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        'sleep 300 &',
        `echo "$!" > "${join(dir, 'helper.pid')}"`,
        `printf '%s\\n' 'INF |  ${A}  |' >&2`,
        'wait',
      ].join('\n'),
    )
    chmodSync(fake, 0o755)
    const recorded: string[] = []
    let pid: number | undefined
    const supervisor = new QuickTunnelSupervisor({
      spawn: () => spawnCloudflared({ binary: fake, args: [] }),
      recordUrl: (url) => {
        recorded.push(url)
      },
      onChild: (p) => {
        if (p !== undefined) pid = p
      },
      log: { info: () => {}, warn: () => {} },
    })
    supervisor.start()
    const deadline = Date.now() + 10_000
    while (supervisor.url === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    await supervisor.settled
    expect(recorded).toEqual([A])
    const helper = Number(readFileSync(join(dir, 'helper.pid'), 'utf8').trim())
    expect(pid && alive(pid)).toBe(true)
    expect(alive(helper)).toBe(true)

    await supervisor.stop()
    expect(alive(pid!)).toBe(false)
    // The whole process group went, not just the pid we spawned.
    const gone = Date.now() + 5_000
    while (alive(helper) && Date.now() < gone) await new Promise((r) => setTimeout(r, 20))
    expect(alive(helper)).toBe(false)
  })

  it('a binary that cannot be spawned reports an exit instead of throwing', async () => {
    const exits: unknown[] = []
    const child = spawnCloudflared({ binary: join(dir, 'does-not-exist'), args: [] })
    await new Promise<void>((resolve) =>
      child.onExit((exit) => {
        exits.push(exit)
        resolve()
      }),
    )
    expect(exits).toEqual([{ code: null, signal: null }])
  })
})
