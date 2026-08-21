import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultInstancePorts } from '@podium/runtime/instance'
import { afterEach, describe, expect, it } from 'vitest'
import {
  enableSystemdUnits,
  installSystemd,
  maskSystemdUnitsRuntime,
  removeUserUnits,
  renderDaemonUnit,
  renderJanitorUnit,
  renderParentUnit,
  renderServerUnit,
  renderSystemdFiles,
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
  it('prefers supported per-user runtimes for updater build children', () => {
    const dirs = pathDirs(renderServerUnit())
    expect(dirs, 'server unit has no Environment=PATH').not.toEqual([])
    expect(dirs).toContain('%h/.local/bin')
    expect(dirs).toContain('%h/.bun/bin')
    expect(dirs.findLastIndex((dir) => dir.startsWith('%h/'))).toBeLessThan(
      dirs.findIndex((dir) => dir.startsWith('/')),
    )
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
    expect(u).toContain('Environment=PODIUM_PORT=18787')
    expect(u).toContain('ExecStart=%h/.local/bin/podium janitor\n')
    expect(u).toContain('Restart=always')
    expect(u).toContain('RestartPreventExitStatus=78')
  })

  it('binds a named janitor only to its named server and command', () => {
    const u = renderJanitorUnit({ instanceId: 'blue', port: 23000 })
    expect(u).toContain('Environment=PODIUM_INSTANCE=blue')
    expect(u).toContain('Environment=PODIUM_PORT=23000')
    expect(u).toContain('After=network-online.target podium-blue-server.service')
    expect(u).toContain('ExecStart=%h/.local/bin/podium-blue janitor\n')
  })
})

describe('renderParentUnit', () => {
  it('is Type=notify with watchdog, Restart=always, takeover, interactive tier', () => {
    const u = renderParentUnit()
    expect(u).toContain('Type=notify')
    expect(u).toContain('WatchdogSec=90')
    expect(u).toContain('Restart=always')
    expect(u).toContain('ExecStart=%h/.local/bin/podium parent --takeover')
    expect(u).toContain('CPUWeight=900')
    expect(u).toContain('IOWeight=500')
    expect(u).toContain('MemoryLow=2G')
    expect(u).toContain('WantedBy=default.target')
  })
})

describe('systemd profile rendering', () => {
  it('packaged profile emits exactly podium.service', () => {
    const files = renderSystemdFiles({ profile: 'packaged', instanceId: 'default' }).units
    expect(Object.keys(files)).toEqual(['podium.service'])
    expect(files['podium.service']).toBe(renderParentUnit({ profile: 'packaged' }))
    expect(files['podium-server.service']).toBeUndefined()
    expect(files['podium-daemon.service']).toBeUndefined()
    expect(files['podium-janitor.service']).toBeUndefined()
  })

  it('keeps the packaged parent instance-scoped', () => {
    const files = renderSystemdFiles({ profile: 'packaged', instanceId: 'blue', port: 23000 }).units
    expect(Object.keys(files)).toEqual(['podium-blue.service'])
    expect(files['podium-blue.service']).toContain('Environment=PODIUM_INSTANCE=blue')
    expect(files['podium-blue.service']).toContain(
      'ExecStart=%h/.local/bin/podium-blue parent --takeover',
    )
    expect(files['podium-blue.service']).toContain('Environment=PODIUM_PORT=23000')
  })

  it('dev profile emits exactly the parent unit — extras are dropped', () => {
    const files = renderSystemdFiles({ profile: 'dev', instanceId: 'blue', port: 23000 }).units
    expect(Object.keys(files)).toEqual(['podium-blue.service'])
    expect(files['podium-blue.service']).toContain('Environment=PODIUM_INSTANCE=blue')
    expect(files['podium-blue.service']).toContain('Environment=PODIUM_PORT=23000')
    expect(files['podium-blue.service']).toContain('scripts/cli.ts parent --takeover')
    expect(files['podium-blue-redeploy.service']).toBeUndefined()
    expect(files['podium-blue-health.service']).toBeUndefined()
    expect(files['podium-blue-health.timer']).toBeUndefined()
    expect(files['podium-blue-backend.service']).toBeUndefined()
    expect(files['podium-blue-server.service']).toBeUndefined()
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

describe('migration systemd operations', () => {
  it('keeps the configured port authoritative while the legacy three-unit topology is armed', () => {
    const instanceId = 'update-e2e'
    const configuredPort = 18_787
    const derivedDefault = defaultInstancePorts(instanceId).server
    expect(derivedDefault).not.toBe(configuredPort)

    // This is the population the topology migration starts from, not a fresh
    // parent-only install: three packaged role units remain live until the new
    // parent proves healthy. All three must resolve the operator's configured
    // port through the same runtime source for that entire safety window.
    const legacyUnits = {
      server: renderServerUnit({ profile: 'packaged', instanceId, port: configuredPort }),
      daemon: renderDaemonUnit({
        profile: 'packaged',
        instanceId,
        port: configuredPort,
        local: true,
      }),
      janitor: renderJanitorUnit({ instanceId, port: configuredPort }),
    }
    const resolvedPorts = Object.fromEntries(
      Object.entries(legacyUnits).map(([role, unit]) => [
        role,
        unit.match(/^Environment=PODIUM_PORT=(\d+)$/m)?.[1],
      ]),
    )

    expect(
      resolvedPorts,
      `legacy migration roles must all read configured :${configuredPort}, not named default :${derivedDefault}`,
    ).toEqual({
      server: String(configuredPort),
      daemon: String(configuredPort),
      janitor: String(configuredPort),
    })
  })

  it('arms the parent without starting it; start is a separate migration step', () => {
    const commands: Array<{ cmd: string; args: string[] }> = []
    enableSystemdUnits(['podium.service'], {
      run: (cmd, args) => commands.push({ cmd, args }),
    })
    expect(commands).toEqual([
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', 'podium.service'] },
    ])
    expect(commands.flatMap(({ args }) => args)).not.toContain('--now')
  })

  it('masks legacy units only in the runtime manager state', () => {
    const commands: Array<{ cmd: string; args: string[] }> = []
    maskSystemdUnitsRuntime(['podium-server.service'], {
      run: (cmd, args) => commands.push({ cmd, args }),
    })
    expect(commands).toEqual([
      {
        cmd: 'systemctl',
        args: ['--user', 'mask', '--runtime', 'podium-server.service'],
      },
    ])
  })

  it('stops every legacy unit before deleting any unit file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-systemd-remove-'))
    const units = ['podium-server.service', 'podium-daemon.service']
    for (const unit of units) writeFileSync(join(dir, unit), unit)
    const commands: Array<{ cmd: string; args: string[] }> = []
    const stopped: string[] = []
    try {
      await removeUserUnits(units, {
        unitDir: () => dir,
        run: (cmd, args) => commands.push({ cmd, args }),
        afterStop: (unit) => {
          stopped.push(unit)
          expect(units.every((name) => existsSync(join(dir, name)))).toBe(true)
        },
        beforeRemove: () => {
          expect(stopped).toEqual(units)
          expect(units.every((name) => existsSync(join(dir, name)))).toBe(true)
        },
      })
      expect(commands).toEqual([
        { cmd: 'systemctl', args: ['--user', 'unmask', ...units] },
        {
          cmd: 'systemctl',
          args: ['--user', 'disable', '--now', 'podium-server.service'],
        },
        {
          cmd: 'systemctl',
          args: ['--user', 'disable', '--now', 'podium-daemon.service'],
        },
        { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      ])
      expect(units.some((name) => existsSync(join(dir, name)))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('installSystemd update-timer retirement', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function install(mode: 'all-in-one' | 'server' | 'daemon', instanceId = 'default') {
    const dir = mkdtempSync(join(tmpdir(), 'podium-systemd-install-'))
    dirs.push(dir)
    const commands: Array<{ cmd: string; args: string[] }> = []
    const result = installSystemd(mode, 18787, instanceId, {
      hasSystemctl: () => true,
      hasUserSystemd: () => true,
      unitDir: () => dir,
      run: (cmd, args) => commands.push({ cmd, args }),
    })
    expect(result).toEqual({ ok: true })
    return { dir, commands }
  }

  it.each([
    'all-in-one',
    'server',
    'daemon',
  ] as const)('setup/reconcile installs no update units in %s mode', (mode) => {
    const { dir, commands } = install(mode)
    expect(readdirSync(dir).filter((name) => name.includes('update'))).toEqual([])
    expect(commands.flatMap(({ args }) => args).filter((arg) => arg.includes('update'))).toEqual([])
  })

  it.each([
    'all-in-one',
    'server',
    'daemon',
  ] as const)('fresh %s installs write exactly podium.service', (mode) => {
    const { dir } = install(mode)
    expect(readdirSync(dir)).toEqual(['podium.service'])
  })

  it.each([
    {
      instanceId: 'default',
      timer: 'podium-update-user.timer',
      service: 'podium-update-user.service',
    },
    {
      instanceId: 'blue',
      timer: 'podium-blue-update.timer',
      service: 'podium-blue-update.service',
    },
  ])('disables and removes an existing $instanceId timer on setup/reconcile', (fixture) => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-systemd-install-'))
    dirs.push(dir)
    writeFileSync(join(dir, fixture.timer), 'legacy timer')
    writeFileSync(join(dir, fixture.service), 'legacy service')
    const commands: Array<{ cmd: string; args: string[] }> = []

    const result = installSystemd('server', 18787, fixture.instanceId, {
      hasSystemctl: () => true,
      hasUserSystemd: () => true,
      unitDir: () => dir,
      run: (cmd, args) => commands.push({ cmd, args }),
    })

    expect(result).toEqual({ ok: true })
    expect(commands).toContainEqual({
      cmd: 'systemctl',
      args: ['--user', 'disable', '--now', fixture.timer],
    })
    expect(readdirSync(dir)).not.toContain(fixture.timer)
    expect(readdirSync(dir)).not.toContain(fixture.service)
  })
})
