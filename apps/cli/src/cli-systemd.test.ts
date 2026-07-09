import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

/** The `Environment=PATH=` dirs of a rendered unit, in order. */
function pathDirs(unit: string): string[] {
  return unit.match(/^Environment=PATH=(.*)$/m)?.[1]?.split(':') ?? []
}

describe('renderDaemonUnit', () => {
  it('local split daemon auths as the local machine (--local) at the given server URL', () => {
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
})

describe('install.sh fallback unit lockstep (#20)', () => {
  it('the heredoc unit in install.sh is byte-identical to renderDaemonUnit()', () => {
    // install.sh --join normally DELEGATES to `podium setup --join` (which renders the unit
    // via renderDaemonUnit); its fallback heredoc must never drift from that source of truth.
    const sh = readFileSync(fileURLToPath(new URL('../../../install.sh', import.meta.url)), 'utf8')
    const m = sh.match(/cat > "\$UNIT_DIR\/podium-daemon\.service" <<'EOF'\n([\s\S]*?)EOF\n/)
    expect(m, 'install.sh no longer contains the fallback daemon-unit heredoc').toBeTruthy()
    expect(m?.[1]).toBe(renderDaemonUnit())
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
