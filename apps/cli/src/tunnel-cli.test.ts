import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '@podium/runtime/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tunnelCliMain, type TunnelCliIo } from './tunnel-cli'

const A = 'https://prairie-otter-lamp-nine.trycloudflare.com'

function capture(): TunnelCliIo & { out: (l: string) => void; lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('podium tunnel', () => {
  const priorStateDir = process.env.PODIUM_STATE_DIR
  let dir: string
  let bin: string
  let env: NodeJS.ProcessEnv
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-tunnel-cli-'))
    bin = join(dir, 'bin')
    mkdirSync(bin)
    process.env.PODIUM_STATE_DIR = dir
    // A fake cloudflared on PATH: prints a quick-tunnel banner line on stderr and
    // then idles, with a child of its own that only a group kill would reach.
    writeFileSync(
      join(bin, 'cloudflared'),
      [
        '#!/bin/sh',
        `echo "$$ $*" > "${join(dir, 'argv')}"`,
        'sleep 300 &',
        `echo "$!" > "${join(dir, 'helper.pid')}"`,
        `printf '%s\\n' 'INF |  ${A}  |' >&2`,
        'wait',
      ].join('\n'),
    )
    chmodSync(join(bin, 'cloudflared'), 0o755)
    env = { PATH: `${bin}:/usr/bin:/bin`, PODIUM_STATE_DIR: dir }
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('does nothing on a box that has not opted in: run refuses with the no-restart exit', async () => {
    saveConfig({ mode: 'all-in-one', networkOption: 'tailscale-funnel', publicUrl: 'https://box.ts.net' })
    const io = capture()
    expect(await tunnelCliMain(['run'], { io, env, shutdownSignal: () => new Promise(() => {}) })).toBe(78)
    expect(io.errors.join('\n')).toContain('opted in')
    expect(existsSync(join(dir, 'argv'))).toBe(false)
  })

  it('refuses to start, and says why, when PODIUM_PUBLIC_URL owns the URL', async () => {
    saveConfig({ mode: 'all-in-one', networkOption: 'cloudflare-tunnel' })
    const io = capture()
    const code = await tunnelCliMain(['run'], {
      io,
      env: { ...env, PODIUM_PUBLIC_URL: 'https://podium.example.com' },
      shutdownSignal: () => new Promise(() => {}),
    })
    expect(code).toBe(78)
    expect(io.errors.join('\n')).toMatch(/PODIUM_PUBLIC_URL is set.*deployment owns the public URL/s)
    expect(existsSync(join(dir, 'argv'))).toBe(false)
  })

  it('run: records the URL cloudflared prints, and a shutdown leaves no process behind', async () => {
    saveConfig({ mode: 'all-in-one', networkOption: 'cloudflare-tunnel', port: 18787 })
    const io = capture()
    const code = await tunnelCliMain(['run'], {
      io,
      env,
      shutdownSignal: async () => {
        const deadline = Date.now() + 15_000
        while (loadConfig().publicUrl !== A && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25))
        }
        return 'SIGTERM'
      },
    })
    expect(code).toBe(0)
    expect(loadConfig()).toMatchObject({ mode: 'all-in-one', publicUrl: A, port: 18787 })
    const [pid, ...argv] = readFileSync(join(dir, 'argv'), 'utf8').trim().split(' ')
    expect(argv).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:18787'])
    expect(alive(Number(pid))).toBe(false)
    const helper = Number(readFileSync(join(dir, 'helper.pid'), 'utf8').trim())
    const deadline = Date.now() + 5_000
    while (alive(helper) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect(alive(helper)).toBe(false)
    // The lock is released, so the next run is not refused.
    expect(existsSync(join(dir, 'run', 'tunnel.json'))).toBe(false)
  })

  it('enable: refuses without the opt-in and writes no unit', async () => {
    saveConfig({ mode: 'all-in-one' })
    const io = capture()
    const written: string[] = []
    const code = await tunnelCliMain(['enable'], {
      io,
      env,
      hasSystemctl: () => true,
      hasUserSystemd: () => true,
      writeUnit: (unit) => written.push(unit),
      enableAndStart: (unit) => written.push(`start ${unit}`),
    })
    expect(code).toBe(1)
    expect(written).toEqual([])
  })

  it('enable: writes and starts the tunnel unit on an opted-in box', async () => {
    saveConfig({ mode: 'server', networkOption: 'cloudflare-tunnel', port: 18787 })
    const io = capture()
    const calls: string[] = []
    let body = ''
    const code = await tunnelCliMain(['enable'], {
      io,
      env,
      hasSystemctl: () => true,
      hasUserSystemd: () => true,
      writeUnit: (unit, text) => {
        calls.push(`write ${unit}`)
        body = text
      },
      enableAndStart: (unit) => calls.push(`start ${unit}`),
    })
    expect(code).toBe(0)
    expect(calls).toEqual(['write podium-tunnel.service', 'start podium-tunnel.service'])
    expect(body).toContain('tunnel run')
    expect(body).toContain('Environment=PODIUM_PORT=18787')
  })

  it('enable without a systemd user session points at `podium tunnel run` instead', async () => {
    saveConfig({ mode: 'all-in-one', networkOption: 'cloudflare-tunnel' })
    const io = capture()
    const code = await tunnelCliMain(['enable'], {
      io,
      env,
      hasSystemctl: () => true,
      hasUserSystemd: () => false,
    })
    expect(code).toBe(1)
    expect(io.errors.join('\n')).toContain('podium tunnel run')
  })

  it('unknown commands and stray arguments are usage errors', async () => {
    expect(await tunnelCliMain(['start'], { io: capture(), env })).toBe(2)
    expect(await tunnelCliMain(['run', '--now'], { io: capture(), env })).toBe(2)
    expect(await tunnelCliMain([], { io: capture(), env })).toBe(2)
    expect(await tunnelCliMain(['--help'], { io: capture(), env })).toBe(0)
  })
})
