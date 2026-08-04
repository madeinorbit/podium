import { describe, expect, it } from 'vitest'
import {
  renderDaemonUnit,
  renderJanitorUnit,
  renderServerUnit,
  renderSystemdFiles,
  shouldInstallUpdateTimer,
  userUnitDir,
} from './cli-systemd'

describe('renderServerUnit', () => {
  it('is a Type=notify, watchdog, Restart=always user unit calling podium server', () => {
    const u = renderServerUnit()
    expect(u).toContain('ExecStart=%h/.local/bin/podium server')
    expect(u).toContain('Type=notify')
    expect(u).toContain('WatchdogSec=30')
    expect(u).toContain('Restart=always')
    expect(u).toContain('WantedBy=default.target')
  })
  it('runs in the interactive scheduling tier (POD-598)', () => {
    const u = renderServerUnit()
    expect(u).toContain('CPUWeight=900')
    expect(u).toContain('IOWeight=500')
    expect(u).toContain('MemoryLow=512M')
  })
  it('renders a named server with an explicit identity and command', () => {
    const u = renderServerUnit('blue')
    expect(u).toContain('Environment=PODIUM_INSTANCE=blue')
    expect(u).toContain('ExecStart=%h/.local/bin/podium-blue server')
  })
})

/** The `Environment=PATH=` dirs of a rendered unit, in order. */
function pathDirs(unit: string): string[] {
  return unit.match(/^Environment=PATH=(.*)$/m)?.[1]?.split(':') ?? []
}

describe('renderDaemonUnit', () => {
  it('local split daemon auths as the local machine at the given server URL', () => {
    const u = renderDaemonUnit({ serverUrl: 'ws://localhost:18787', local: true })
    expect(u).toContain(
      'ExecStart=%h/.local/bin/podium daemon --local --server ws://localhost:18787',
    )
    expect(u).toContain('After=network-online.target podium-server.service')
    expect(u).toContain('Type=notify')
    expect(u).toContain(
      'Environment=PATH=%h/.local/bin:%h/.bun/bin:%h/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin',
    )
    expect(u).toContain('Restart=always')
  })
  it('renders a named local daemon against only its named server unit', () => {
    const u = renderDaemonUnit({
      instanceId: 'blue',
      serverUrl: 'ws://localhost:23000',
      local: true,
    })
    expect(u).toContain('Environment=PODIUM_INSTANCE=blue')
    expect(u).toContain('ExecStart=%h/.local/bin/podium-blue daemon --local')
    expect(u).toContain('After=network-online.target podium-blue-server.service')
    expect(u).not.toContain('After=network-online.target podium-server.service')
  })
  // #220: the daemon spawns the agent CLIs, which inherit its PATH (agent-bridge session.ts
  // spreads process.env). A dir missing here means `claude`/`codex`/`opencode` are simply not
  // found once the daemon runs under systemd, even though they work in an interactive shell.
  it('PATH covers every per-user dir an agent CLI installs into (#220)', () => {
    const dirs = pathDirs(renderDaemonUnit())
    expect(dirs, 'daemon unit has no Environment=PATH').not.toEqual([])
    // claude (native installer), grok, cursor-agent, and abduco all land in ~/.local/bin.
    expect(dirs).toContain('%h/.local/bin')
    // codex installs as a bun/npm global → ~/.bun/bin when bun is the package manager.
    expect(dirs).toContain('%h/.bun/bin')
    // opencode's install script hardcodes its own prefix.
    expect(dirs).toContain('%h/.opencode/bin')
  })
  it('prefers per-user CLI dirs over system dirs (#220)', () => {
    const dirs = pathDirs(renderDaemonUnit())
    const lastUser = dirs.findLastIndex((d) => d.startsWith('%h/'))
    const firstSystem = dirs.findIndex((d) => d.startsWith('/'))
    // A user-installed `claude` must win over a stale system-wide one.
    expect(lastUser).toBeLessThan(firstSystem)
  })
  it('join case (no serverUrl) uses config-driven bare `podium daemon`', () => {
    const u = renderDaemonUnit()
    expect(u).toContain('ExecStart=%h/.local/bin/podium daemon\n')
    expect(u).not.toContain('--server')
  })
  it('does not crash-loop on a terminally-blocked daemon (#19): exit 78 prevents restart', () => {
    // DAEMON_BLOCKED_EXIT_CODE — the exit the daemon uses when the server rejected its
    // handshake for good (pairRejected / helloRejected). Restart=always must not apply.
    const u = renderDaemonUnit()
    expect(u).toContain('Restart=always')
    expect(u).toContain('RestartPreventExitStatus=78')
    // The server unit has no pairing handshake — no blocked exit to except.
    expect(renderServerUnit()).not.toContain('RestartPreventExitStatus')
  })
  it('runs in the interactive scheduling tier (POD-598)', () => {
    // POD-594: the daemon main thread runqueue-waited 60% of wall time when it competed
    // with per-agent scopes at uniform default CPUWeight=100.
    const u = renderDaemonUnit()
    expect(u).toContain('CPUWeight=900')
    expect(u).toContain('IOWeight=500')
    expect(u).toContain('MemoryLow=2G')
  })
})

describe('renderJanitorUnit', () => {
  it('runs one instance-scoped sibling after the server with blocked-version restart fencing', () => {
    const u = renderJanitorUnit({ port: 18787 })
    expect(u).toContain('Description=Podium durable maintenance janitor')
    expect(u).toContain('After=network-online.target podium-server.service')
    expect(u).toContain('ExecStart=%h/.local/bin/podium janitor --server http://localhost:18787')
    expect(u).toContain('Restart=always')
    expect(u).toContain('RestartPreventExitStatus=78')
  })

  it('binds a named janitor only to its named server and command', () => {
    const u = renderJanitorUnit({ instanceId: 'blue', port: 23000 })
    expect(u).toContain('Environment=PODIUM_INSTANCE=blue')
    expect(u).toContain('After=network-online.target podium-blue-server.service')
    expect(u).toContain(
      'ExecStart=%h/.local/bin/podium-blue janitor --server http://localhost:23000',
    )
  })
})

describe('systemd profile rendering', () => {
  it('packages the daemon and daily update artifacts from the same source', () => {
    const files = renderSystemdFiles({ profile: 'packaged', instanceId: 'default' }).units
    expect(files['podium-daemon.service']).toBe(renderDaemonUnit())
    expect(files['podium-server.service']).toBe(renderServerUnit())
    expect(files['podium-update-user.service']).toContain('podium update')
    expect(files['podium-update-user.timer']).toContain('Unit=podium-update-user.service')
  })

  it('keeps packaged units instance-scoped', () => {
    const files = renderSystemdFiles({ profile: 'packaged', instanceId: 'blue', port: 23000 }).units
    expect(files['podium-blue-server.service']).toContain('Environment=PODIUM_INSTANCE=blue')
    expect(files['podium-blue-daemon.service']).toContain(
      'ExecStart=%h/.local/bin/podium-blue daemon',
    )
    expect(files['podium-blue-janitor.service']).toContain(
      'ExecStart=%h/.local/bin/podium-blue janitor --server http://localhost:23000',
    )
    expect(files['podium-blue-update.service']).toContain('%h/.local/bin/podium-blue update')
    expect(files['podium-blue-update.timer']).toContain('Unit=podium-blue-update.service')
  })

  it('renders an instance-scoped dev profile, including redeploy and health units', () => {
    const files = renderSystemdFiles({ profile: 'dev', instanceId: 'blue', port: 23000 }).units
    expect(files['podium-blue-server.service']).toContain('Environment=PODIUM_INSTANCE=blue')
    expect(files['podium-blue-server.service']).toContain('Environment=PODIUM_PORT=23000')
    expect(files['podium-blue-daemon.service']).toContain(
      'After=network-online.target podium-blue-server.service',
    )
    expect(files['podium-blue-redeploy.path']).toContain('Unit=podium-blue-redeploy.service')
    expect(files['podium-blue-health.service']).toContain(
      'Environment=PODIUM_HEALTH_UNIT=podium-blue-server.service',
    )
    expect(files['podium-blue-health.timer']).toContain('Unit=podium-blue-health.service')
    expect(files['podium-blue-update.timer']).toContain('Unit=podium-blue-update.service')
  })

  /**
   * POD-1663: a redeploy that moved the maintenance protocol/schema left the
   * long-lived janitor skewed against the new server. It exited 78, and
   * RestartPreventExitStatus kept it stopped for good — steward-poll, and with it
   * ALL durable message delivery, stopped silently for 14 hours. The revive hook
   * lives in `podium update`, which this git-HEAD path never calls, so the redeploy
   * itself has to carry the janitor.
   */
  it('restarts the janitor with the server, clearing a compatibility block first', () => {
    const files = renderSystemdFiles({ profile: 'dev', instanceId: 'blue', port: 23000 }).units
    const redeploy = files['podium-blue-redeploy.service'] ?? ''
    const restart = redeploy
      .split('\n')
      .find((line) => line.startsWith('ExecStart=/usr/bin/systemctl --user restart'))
    expect(restart).toBeDefined()
    // The janitor must be restarted in the SAME step as the server, or it keeps
    // running the module graph the previous deploy gave it.
    expect(restart).toContain('podium-blue-janitor.service')
    expect(restart).toContain('podium-blue-server.service')
    // A janitor already blocked on exit 78 (or sitting on a hit start-limit) will not
    // come back from `restart` alone; the failure state has to be cleared, and that
    // clear must not fail the deploy when the unit is healthy or absent.
    expect(redeploy).toContain(
      'ExecStart=-/usr/bin/systemctl --user reset-failed podium-blue-janitor.service',
    )
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

describe('shouldInstallUpdateTimer', () => {
  it('installs for a standalone all-in-one install with no server', () => {
    expect(shouldInstallUpdateTimer({ mode: 'all-in-one', serverUrl: undefined })).toBe(true)
  })

  it('does not install for a daemon attached to a server', () => {
    expect(shouldInstallUpdateTimer({ mode: 'daemon', serverUrl: 'wss://hub.test' })).toBe(false)
  })

  it('does not install for a client attached to a server', () => {
    expect(shouldInstallUpdateTimer({ mode: 'client', serverUrl: 'wss://hub.test' })).toBe(false)
  })

  it('installs for a standalone server', () => {
    expect(shouldInstallUpdateTimer({ mode: 'server', serverUrl: undefined })).toBe(true)
  })

  it('keeps a daemon without authority standalone', () => {
    expect(shouldInstallUpdateTimer({ mode: 'daemon', serverUrl: undefined })).toBe(true)
  })
})
