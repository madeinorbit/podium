import type { PodiumConfig } from '@podium/runtime/config'
import { describe, expect, it } from 'vitest'
import { type TunnelCliDeps, tunnelCliMain, tunnelOrigin, tunnelPreflight } from './tunnel-cli'

const OPTED_IN: PodiumConfig = {
  mode: 'all-in-one',
  networkOption: 'cloudflare-tunnel',
  port: 18787,
}
const BIN = '/opt/podium/podium-tunnel'
const ENV = { PODIUM_TUNNEL_BIN: BIN, PODIUM_STATE_DIR: '/home/u/.podium' }

function capture() {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    io: { out: (l: string) => lines.push(l), err: (l: string) => errors.push(l) },
  }
}

function deps(over: Partial<TunnelCliDeps> = {}) {
  const calls: string[] = []
  const bodies: string[] = []
  const out = capture()
  const d: TunnelCliDeps = {
    io: out.io,
    env: ENV,
    config: OPTED_IN,
    hasBinary: () => true,
    fileExists: () => true,
    hasSystemctl: () => true,
    hasUserSystemd: () => true,
    writeUnit: (unit, body) => {
      calls.push(`write ${unit}`)
      bodies.push(body)
    },
    enableAndStart: (unit) => calls.push(`start ${unit}`),
    disableAndRemove: (unit) => calls.push(`remove ${unit}`),
    ...over,
  }
  return { d, calls, bodies, out }
}

describe('tunnelPreflight: the opt-in', () => {
  const ok = { hasBinary: () => true, fileExists: () => true }

  it('is OFF by default: a fresh box refuses', () => {
    expect(tunnelPreflight({ config: {}, env: ENV, ...ok }).ok).toBe(false)
  })

  it('is OFF for a host that chose any other reachability option', () => {
    for (const networkOption of ['tailscale-funnel', 'tailscale-serve', 'manual'] as const) {
      expect(
        tunnelPreflight({ config: { mode: 'all-in-one', networkOption }, env: ENV, ...ok }),
      ).toMatchObject({ ok: false, reason: expect.stringContaining('Cloudflare quick tunnel') })
    }
  })

  it('passes only for a host that chose the quick tunnel, and names the origin and binary', () => {
    expect(tunnelPreflight({ config: OPTED_IN, env: ENV, ...ok })).toEqual({
      ok: true,
      origin: 'http://127.0.0.1:18787',
      binary: BIN,
    })
  })

  it('PODIUM_PUBLIC_URL set: refuses, and says the deployment owns the URL', () => {
    const result = tunnelPreflight({
      config: OPTED_IN,
      env: { ...ENV, PODIUM_PUBLIC_URL: 'https://podium.example.com' },
      ...ok,
    })
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('PODIUM_PUBLIC_URL is set'),
    })
    expect(result.ok === false && result.reason).toContain('deployment owns the public URL')
  })

  it('refuses on a daemon or client box', () => {
    for (const mode of ['daemon', 'client'] as const) {
      expect(tunnelPreflight({ config: { ...OPTED_IN, mode }, env: ENV, ...ok }).ok).toBe(false)
    }
  })

  it('refuses without cloudflared, with install instructions, and never installs it', () => {
    expect(
      tunnelPreflight({
        config: OPTED_IN,
        env: ENV,
        hasBinary: () => false,
        fileExists: () => true,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('cloudflared is not installed') })
  })

  it('refuses when podium-tunnel is not where it should be, and says how to build it', () => {
    expect(
      tunnelPreflight({
        config: OPTED_IN,
        env: ENV,
        hasBinary: () => true,
        fileExists: () => false,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('cargo build --release') })
  })

  it('forwards to IPv4 loopback, or to the one interface the server bound', () => {
    expect(tunnelOrigin(18787, {})).toBe('http://127.0.0.1:18787')
    expect(tunnelOrigin(18787, { PODIUM_HOST: '0.0.0.0' })).toBe('http://127.0.0.1:18787')
    expect(tunnelOrigin(18787, { PODIUM_HOST: '10.0.0.5' })).toBe('http://10.0.0.5:18787')
  })
})

describe('podium tunnel enable / disable', () => {
  it('enable writes and starts the unit, pointing podium-tunnel at the origin and the control socket', () => {
    const { d, calls, bodies } = deps()
    expect(tunnelCliMain(['enable'], d)).toBe(0)
    expect(calls).toEqual(['write podium-tunnel.service', 'start podium-tunnel.service'])
    expect(bodies[0]).toContain(
      `ExecStart="${BIN}" "--origin" "http://127.0.0.1:18787" "--socket" "/home/u/.podium/run/control.sock"`,
    )
  })

  it('enable on a box that has not opted in writes nothing', () => {
    const { d, calls, out } = deps({ config: { mode: 'all-in-one' } })
    expect(tunnelCliMain(['enable'], d)).toBe(1)
    expect(calls).toEqual([])
    expect(out.errors.join('\n')).toContain('Cloudflare quick tunnel')
  })

  it('enable without a systemd user session prints the command to run under another supervisor', () => {
    const { d, calls, out } = deps({ hasUserSystemd: () => false })
    expect(tunnelCliMain(['enable'], d)).toBe(1)
    expect(calls).toEqual([])
    expect(out.errors.join('\n')).toContain(`${BIN} --origin http://127.0.0.1:18787 --socket`)
  })

  it('disable stops and removes the unit', () => {
    const { d, calls } = deps()
    expect(tunnelCliMain(['disable'], d)).toBe(0)
    expect(calls).toEqual(['remove podium-tunnel.service'])
  })

  it('unknown commands and stray arguments are usage errors', () => {
    expect(tunnelCliMain(['run'], deps().d)).toBe(2)
    expect(tunnelCliMain(['enable', '--now'], deps().d)).toBe(2)
    expect(tunnelCliMain([], deps().d)).toBe(2)
    expect(tunnelCliMain(['--help'], deps().d)).toBe(0)
  })
})
