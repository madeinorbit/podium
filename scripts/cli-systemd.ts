// systemd `--user` units for the split headless backend. Pure renderers (unit-tested) + a
// best-effort installer. Units call the packaged `%h/.local/bin/podium` in single-component mode,
// are Type=notify with a watchdog (a wedged-but-alive process stops petting → systemd restarts
// it; the daemon has no HTTP /health, so this is its only wedge-recovery), and Restart=always.
// Design: docs/superpowers/specs/2026-07-06-headless-process-model-design.md
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { PodiumConfig } from '../packages/core/src/config'
import { DAEMON_BLOCKED_EXIT_CODE } from '../packages/core/src/connectivity'

const SERVER_UNIT = 'podium-server.service'
const DAEMON_UNIT = 'podium-daemon.service'
const DAEMON_PATH =
  '%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin'

/** `~/.config/systemd/user` (respects XDG_CONFIG_HOME). */
export function userUnitDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME || homedir(), '.config')
  return join(base, 'systemd', 'user')
}

export function renderServerUnit(): string {
  return `[Unit]
Description=Podium coordinating server (relay + HTTP/tRPC + WebSockets)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
ExecStart=%h/.local/bin/podium server
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`
}

/**
 * The daemon unit. `serverUrl` present → `--server <url>` (the local split points at
 * ws://localhost:<port>); absent → bare `podium daemon`, which resolves serverUrl from config
 * (the `--join` daemon-only case).
 */
export function renderDaemonUnit(opts: { serverUrl?: string; local?: boolean } = {}): string {
  // `--local` = the split daemon on a host box (auth as the local machine via the shared secret);
  // `--server` pins the URL. The join case passes neither → bare `podium daemon` (config-driven).
  const flags = [opts.local ? '--local' : '', opts.serverUrl ? `--server ${opts.serverUrl}` : '']
    .filter(Boolean)
    .join(' ')
  const exec = `%h/.local/bin/podium daemon${flags ? ` ${flags}` : ''}`
  // A local-split daemon starts after the co-located server; a joined worker has no local server.
  const after = opts.local ? `network-online.target ${SERVER_UNIT}` : 'network-online.target'
  return `[Unit]
Description=Podium per-machine agent daemon
After=${after}
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
Environment=PATH=${DAEMON_PATH}
ExecStart=${exec}
Restart=always
RestartSec=2
# The daemon exits ${DAEMON_BLOCKED_EXIT_CODE} when the server TERMINALLY rejected it (pairRejected/helloRejected):
# restarting would just re-hammer the same rejected handshake, so don't (issue #19).
# \`podium status\` explains the blocked state and how to re-pair.
RestartPreventExitStatus=${DAEMON_BLOCKED_EXIT_CODE}

[Install]
WantedBy=default.target
`
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit' })
}

export function hasSystemctl(): boolean {
  try {
    execFileSync('systemctl', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface InstallResult {
  ok: boolean
  reason?: string
}

/**
 * Render + install the `--user` units for `mode` and enable+start them. `all-in-one` installs both
 * (daemon → local server); `server` installs only the server; `daemon` (a joined worker) installs
 * only the daemon unit (bare `podium daemon`, config-driven remote server). Best-effort: returns
 * {ok:false, reason} when systemd is absent or a step fails, so setup can fall back.
 */
export function installSystemd(mode: PodiumConfig['mode'], port: number): InstallResult {
  if (!hasSystemctl()) return { ok: false, reason: 'systemctl not found' }
  const dir = userUnitDir()
  const units: string[] = []
  try {
    mkdirSync(dir, { recursive: true })
    if (mode === 'daemon') {
      // Joined worker: only the daemon unit, dialing the remote server from config.
      writeFileSync(join(dir, DAEMON_UNIT), renderDaemonUnit())
      units.push(DAEMON_UNIT)
    } else {
      writeFileSync(join(dir, SERVER_UNIT), renderServerUnit())
      units.push(SERVER_UNIT)
      if (mode === 'all-in-one') {
        writeFileSync(
          join(dir, DAEMON_UNIT),
          renderDaemonUnit({ serverUrl: `ws://localhost:${port}`, local: true }),
        )
        units.push(DAEMON_UNIT)
      }
    }
    run('systemctl', ['--user', 'daemon-reload'])
    // Linger so the units run without an active login session (headless VPS over SSH).
    try {
      run('loginctl', ['enable-linger', userInfo().username])
    } catch {
      // non-fatal: on some hosts linger is already on or loginctl is restricted
    }
    run('systemctl', ['--user', 'enable', '--now', ...units])
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}
