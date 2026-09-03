import { describe, expect, it } from 'vitest'
import { probeSupervision } from './install-supervision'

/**
 * Ported from install.sh:384-428. `systemctl --version` only proves the BINARY exists; the
 * user manager also needs a session bus at /run/user/<uid>/bus. Without one, every
 * `systemctl --user` call prints "Failed to connect to bus: No medium found". install.sh used
 * to discover that by running one and letting it complain mid-install; this probes instead,
 * tries the repair that actually works on a fresh VPS, and only then decides.
 */
describe('probeSupervision', () => {
  const base = {
    hasSystemctl: () => true,
    hasUserSystemd: () => true,
    env: {} as NodeJS.ProcessEnv,
    uid: () => 1000,
    socketExists: () => false,
  }

  it('reports systemd when the user bus already answers', () => {
    expect(probeSupervision(base)).toEqual({ systemd: true })
  })

  it('honours PODIUM_DISABLE_SYSTEMD without probing anything', () => {
    let probed = false
    const res = probeSupervision({
      ...base,
      env: { PODIUM_DISABLE_SYSTEMD: '1' },
      hasSystemctl: () => {
        probed = true
        return true
      },
    })
    expect(res.systemd).toBe(false)
    expect(res.why).toContain('PODIUM_DISABLE_SYSTEMD')
    expect(probed).toBe(false)
  })

  it('explains a host without systemd and offers the @reboot crontab fix', () => {
    const res = probeSupervision({ ...base, hasSystemctl: () => false })
    expect(res.systemd).toBe(false)
    expect(res.why).toContain('does not run systemd')
    expect(res.fix).toContain('crontab -e')
  })

  it('recovers XDG_RUNTIME_DIR when sudo -i dropped it but the bus is right there', () => {
    // `sudo -i` / `su -` drop XDG_RUNTIME_DIR, so systemctl cannot find the bus that is
    // sitting at /run/user/<uid>/bus. Point it there ourselves rather than declaring defeat.
    const env: NodeJS.ProcessEnv = {}
    let asked = 0
    const res = probeSupervision({
      ...base,
      env,
      socketExists: (p) => p === '/run/user/1000/bus',
      // Fails until XDG_RUNTIME_DIR is set, then succeeds — what really happens.
      hasUserSystemd: () => {
        asked++
        return env.XDG_RUNTIME_DIR !== undefined
      },
    })
    expect(res.systemd).toBe(true)
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1000')
    expect(asked).toBeGreaterThan(1)
  })

  it('does not invent XDG_RUNTIME_DIR when there is no socket to point at', () => {
    const env: NodeJS.ProcessEnv = {}
    const res = probeSupervision({
      ...base,
      env,
      hasUserSystemd: () => false,
      socketExists: () => false,
    })
    expect(res.systemd).toBe(false)
    expect(env.XDG_RUNTIME_DIR).toBeUndefined()
  })

  it('leaves an EXISTING XDG_RUNTIME_DIR alone', () => {
    const env: NodeJS.ProcessEnv = { XDG_RUNTIME_DIR: '/run/user/0' }
    probeSupervision({
      ...base,
      env,
      hasUserSystemd: () => false,
      socketExists: () => true,
    })
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/0')
  })

  it('says systemd is present but unreachable — never that it is absent', () => {
    // The distinction matters: "no systemd" sends an operator down a different path than
    // "systemd is here but this session cannot reach its user manager", which is the usual
    // state on a container VPS and under sudo.
    const res = probeSupervision({ ...base, hasUserSystemd: () => false })
    expect(res.systemd).toBe(false)
    expect(res.why).toContain('systemd is installed')
    expect(res.why).not.toContain('does not run systemd')
    expect(res.fix).toContain('re-run')
  })
})
