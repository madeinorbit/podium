// systemd `--user` units for the split headless backend. Pure renderers (unit-tested) + a
// best-effort installer. Units call the packaged `%h/.local/bin/podium` in single-component mode,
// are Type=notify with a watchdog (a wedged-but-alive process stops petting → systemd restarts
// it; the daemon has no HTTP /health, so this is its only wedge-recovery), and Restart=always.
// Design: docs/internal/superpowers/specs/2026-07-06-headless-process-model-design.md
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { PodiumConfig } from '@podium/runtime/config'
import { DAEMON_BLOCKED_EXIT_CODE } from '@podium/runtime/connectivity'
import {
  instanceCommandName,
  instanceServiceName,
  resolveInstanceId,
} from '@podium/runtime/instance'

// Spawned agent CLIs inherit the daemon's PATH, so every dir a harness binary can install into
// has to be here — a systemd unit gets none of the login shell's PATH (#220). `%h/.local/bin`
// holds claude, grok, cursor-agent (and abduco); `%h/.bun/bin` holds bun/npm globals such as
// codex; opencode's installer hardcodes `%h/.opencode/bin`. User dirs precede the system dirs so
// a user-installed CLI wins over a stale system-wide one.
const DAEMON_PATH =
  '%h/.local/bin:%h/.bun/bin:%h/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin'

/** `~/.config/systemd/user` (respects XDG_CONFIG_HOME). */
export function userUnitDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME || homedir(), '.config')
  return join(base, 'systemd', 'user')
}

export function renderServerUnit(instanceId: string = resolveInstanceId()): string {
  const command = instanceCommandName(instanceId)
  return `[Unit]
Description=Podium coordinating server (relay + HTTP/tRPC + WebSockets)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
Environment=PODIUM_INSTANCE=${instanceId}
ExecStart=%h/.local/bin/${command} server
Restart=always
RestartSec=2
# Two-tier scheduling (POD-598): hosts run heavily CPU-oversubscribed by agent/test
# workloads; POD-594 measured the daemon main thread runqueue-waiting 60% of wall time
# (server 51%) with everything at default CPUWeight=100. Interactive Podium services
# get the high tier; per-agent scopes get CPUWeight=50/IOWeight=100 (agent-bridge).
CPUWeight=900
IOWeight=500
MemoryLow=512M

[Install]
WantedBy=default.target
`
}

/**
 * The daemon unit. `serverUrl` present → `--server <url>` (the local split points at
 * ws://localhost:<port>); absent → bare `podium daemon`, which resolves serverUrl from config
 * (the `--join` daemon-only case).
 */
export function renderDaemonUnit(
  opts: { serverUrl?: string; local?: boolean; instanceId?: string } = {},
): string {
  const instanceId = opts.instanceId ?? resolveInstanceId()
  const command = instanceCommandName(instanceId)
  const serverUnit = instanceServiceName('server', instanceId)
  // `--local` = the split daemon on a host box (auth as the local machine via the shared secret);
  // `--server` pins the URL. The join case passes neither → bare `podium daemon` (config-driven).
  const flags = [opts.local ? '--local' : '', opts.serverUrl ? `--server ${opts.serverUrl}` : '']
    .filter(Boolean)
    .join(' ')
  const exec = `%h/.local/bin/${command} daemon${flags ? ` ${flags}` : ''}`
  // A local-split daemon starts after the co-located server; a joined worker has no local server.
  const after = opts.local ? `network-online.target ${serverUnit}` : 'network-online.target'
  return `[Unit]
Description=Podium per-machine agent daemon
After=${after}
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
Environment=PODIUM_INSTANCE=${instanceId}
Environment=PATH=${DAEMON_PATH}
ExecStart=${exec}
Restart=always
RestartSec=2
# The daemon exits ${DAEMON_BLOCKED_EXIT_CODE} when the server TERMINALLY rejected it (pairRejected/helloRejected):
# restarting would just re-hammer the same rejected handshake, so don't (issue #19).
# \`podium status\` explains the blocked state and how to re-pair.
RestartPreventExitStatus=${DAEMON_BLOCKED_EXIT_CODE}
# Two-tier scheduling (POD-598): hosts run heavily CPU-oversubscribed by agent/test
# workloads; POD-594 measured this daemon's main thread runqueue-waiting 60% of wall
# time with everything at default CPUWeight=100. Interactive Podium services get the
# high tier; per-agent scopes get CPUWeight=50/IOWeight=100 (agent-bridge).
CPUWeight=900
IOWeight=500
MemoryLow=2G

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
export function installSystemd(
  mode: PodiumConfig['mode'],
  port: number,
  instanceId: string = resolveInstanceId(),
): InstallResult {
  if (!hasSystemctl()) return { ok: false, reason: 'systemctl not found' }
  const dir = userUnitDir()
  const serverUnit = instanceServiceName('server', instanceId)
  const daemonUnit = instanceServiceName('daemon', instanceId)
  const units: string[] = []
  try {
    mkdirSync(dir, { recursive: true })
    if (mode === 'daemon') {
      // Joined worker: only the daemon unit, dialing the remote server from config.
      writeFileSync(join(dir, daemonUnit), renderDaemonUnit({ instanceId }))
      units.push(daemonUnit)
    } else {
      writeFileSync(join(dir, serverUnit), renderServerUnit(instanceId))
      units.push(serverUnit)
      if (mode === 'all-in-one') {
        writeFileSync(
          join(dir, daemonUnit),
          renderDaemonUnit({ serverUrl: `ws://localhost:${port}`, local: true, instanceId }),
        )
        units.push(daemonUnit)
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
