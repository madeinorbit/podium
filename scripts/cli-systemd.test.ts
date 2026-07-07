import { describe, expect, it } from 'vitest'
import { renderDaemonUnit, renderServerUnit, userUnitDir } from './cli-systemd'

describe('renderServerUnit', () => {
  it('is a Type=notify, watchdog, Restart=always user unit calling `podium server`', () => {
    const u = renderServerUnit()
    expect(u).toContain('ExecStart=%h/.local/bin/podium server')
    expect(u).toContain('Type=notify')
    expect(u).toContain('WatchdogSec=30')
    expect(u).toContain('Restart=always')
    expect(u).toContain('WantedBy=default.target')
  })
})

describe('renderDaemonUnit', () => {
  it('local split daemon auths as the local machine (--local) at the given server URL', () => {
    const u = renderDaemonUnit({ serverUrl: 'ws://localhost:18787', local: true })
    expect(u).toContain(
      'ExecStart=%h/.local/bin/podium daemon --local --server ws://localhost:18787',
    )
    expect(u).toContain('After=network-online.target podium-server.service')
    expect(u).toContain('Type=notify')
    expect(u).toContain(
      'Environment=PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin',
    )
    expect(u).toContain('Restart=always')
  })
  it('join case (no serverUrl) uses config-driven bare `podium daemon`', () => {
    const u = renderDaemonUnit()
    expect(u).toContain('ExecStart=%h/.local/bin/podium daemon\n')
    expect(u).not.toContain('--server')
  })
})

describe('userUnitDir', () => {
  it('respects XDG_CONFIG_HOME', () => {
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = '/tmp/xdg'
    try {
      expect(userUnitDir()).toBe('/tmp/xdg/systemd/user')
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
    }
  })
})
