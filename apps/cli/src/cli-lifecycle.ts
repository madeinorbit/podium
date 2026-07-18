// `podium status` / `podium stop` / `podium logs` — lifecycle commands over the run registry
// (packages/runtime/src/run-registry.ts). Pure rendering (`renderStatus`) is split from the impure
// command wrappers so it can be unit-tested. Design:
// docs/internal/superpowers/specs/2026-07-06-headless-process-model-design.md
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadConfig,
  type PodiumConfig,
  resolveInstanceId,
  resolvePort,
} from '@podium/runtime/config'
import { type ConnectivityStatus, readConnectivity } from '@podium/runtime/connectivity'
import { instanceServiceName } from '@podium/runtime/instance'
import { listLive, logDir, type RunRecord, RunRole, reclaim } from '@podium/runtime/run-registry'
/** Human "3s / 4m / 2h / 1d ago" from an ISO start time. */
export function humanUptime(startedAtIso: string, nowMs: number): string {
  const started = Date.parse(startedAtIso)
  if (Number.isNaN(started)) return 'unknown'
  const s = Math.max(0, Math.round((nowMs - started) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export interface StatusView {
  live: RunRecord[]
  config: Pick<PodiumConfig, 'mode' | 'persistence' | 'publicUrl' | 'port'>
  nowMs: number
  instanceId?: string
  port?: number
  /** Daemon⇄server link state written by the daemon itself (issue #19); absent on
   *  boxes that run no remote daemon (or before the daemon's first write). */
  connectivity?: ConnectivityStatus
}

/** Render the daemon⇄server connectivity line(s) from the daemon-written status file. */
function renderConnectivity(c: ConnectivityStatus, nowMs: number): string[] {
  const target = c.serverUrl ? ` → ${c.serverUrl}` : ''
  const lastSeen = c.lastHelloOkAt
    ? ` (last contact ${humanUptime(c.lastHelloOkAt, nowMs)} ago)`
    : ''
  if (c.state === 'blocked') {
    return [
      `  ✖ server link${target}: BLOCKED — ${c.blockedReason ?? 'the server rejected this daemon'}`,
      '    Re-pair: mint a new join code on the server (Machines → Add machine), then run',
      '    `podium set-server <join-code>` here and restart the daemon.',
    ]
  }
  if (c.state === 'disconnected') {
    const err = c.lastError ? ` — ${c.lastError}` : ''
    const retry = c.retryBackoffMs
      ? ` (retrying every ~${Math.round(c.retryBackoffMs / 1000)}s)`
      : ''
    return [`  ! server link${target}: disconnected${err}${retry}${lastSeen}`]
  }
  return [`  ✓ server link${target}: connected${lastSeen}`]
}

/** PURE: render the status report from live records + config. */
export function renderStatus(view: StatusView): string {
  const { live, config, nowMs } = view
  const byRole = new Map(live.map((r) => [r.role, r]))
  const lines: string[] = []
  const instanceId = view.instanceId ?? 'default'
  const instanceLabel = instanceId === 'default' ? '' : ` [${instanceId}]`
  lines.push(
    `Podium${instanceLabel} — mode: ${config.mode ?? '(unset — run `podium setup`)'}` +
      (config.persistence ? `, persistence: ${config.persistence}` : ''),
  )
  // Which roles are relevant to this deployment mode. A host (`all-in-one`) box runs the split —
  // server + janitor + daemon — so that's what we report (the `all-in-one` role is only the
  // desktop in-process sidecar, which doesn't use this CLI). If an `all-in-one` record is
  // nonetheless live, surface it too.
  const roles: RunRole[] =
    config.mode === 'all-in-one'
      ? byRole.has('all-in-one')
        ? ['all-in-one']
        : ['server', 'janitor', 'daemon']
      : config.mode === 'server'
        ? ['server', 'janitor']
        : config.mode === 'daemon'
          ? ['daemon']
          : (RunRole.options as RunRole[]) // unknown mode: show whatever is live
  for (const role of roles) {
    const rec = byRole.get(role)
    if (rec) {
      const port = rec.port ? ` :${rec.port}` : ''
      lines.push(`  ● ${role}  up${port}  pid ${rec.pid}  (${humanUptime(rec.startedAt, nowMs)})`)
    } else {
      lines.push(`  ○ ${role}  down`)
    }
  }
  // Connectivity truthfulness (#19): a PID only proves the daemon process exists. When the
  // daemon has written its link state, report it — including the terminal blocked state,
  // which explains why the unit is down and what to do.
  if (view.connectivity) lines.push(...renderConnectivity(view.connectivity, nowMs))
  const url = config.publicUrl ?? `http://localhost:${view.port ?? config.port ?? 18787}`
  lines.push(`  URL: ${url}`)
  return lines.join('\n')
}

function systemctlUser(args: string[]): void {
  execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' })
}

export function selectedUnits(instanceId: string = resolveInstanceId()): [string, string, string] {
  return [
    instanceServiceName('daemon', instanceId),
    instanceServiceName('janitor', instanceId),
    instanceServiceName('server', instanceId),
  ]
}

function hasSystemctl(): boolean {
  try {
    execFileSync('systemctl', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** `podium status` */
export function statusCommand(): void {
  const config = loadConfig()
  const connectivity = readConnectivity()
  console.log(
    renderStatus({
      live: listLive(),
      config,
      nowMs: Date.now(),
      instanceId: resolveInstanceId(),
      port: resolvePort(config),
      ...(connectivity ? { connectivity } : {}),
    }),
  )
}

/** `podium stop` — systemd mode stops the units; detached/foreground reclaims each live role. */
export async function stopCommand(): Promise<void> {
  const config = loadConfig()
  if (config.persistence === 'systemd' && hasSystemctl()) {
    try {
      systemctlUser(['stop', ...selectedUnits()])
      console.log(`Stopped ${selectedUnits().join(' + ')} (systemd).`)
    } catch (e) {
      console.error(`podium stop: ${(e as Error).message}`)
      process.exit(1)
    }
    return
  }
  const live = listLive()
  if (live.length === 0) {
    console.log('Nothing running.')
    return
  }
  for (const rec of live) {
    await reclaim(rec.role)
    console.log(`Stopped ${rec.role} (pid ${rec.pid}).`)
  }
}

/**
 * Fully tear down ANY currently-running backend — every systemd unit AND every detached/foreground
 * role — so a `podium setup` mode SWITCH never leaves the old mode running alongside the new one.
 * Best-effort + idempotent: no-op on a fresh box. `disable --now` (not just `stop`) is required so
 * a `Restart=always` unit doesn't respawn, and so switching modes drops units the new mode won't
 * use. Called only from the real backend-starter (never the stubbed test path).
 */
export async function stopBackend(): Promise<void> {
  if (hasSystemctl()) {
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', ...selectedUnits()], {
        stdio: 'ignore',
      })
    } catch {
      // units may not exist / already disabled — fine.
    }
  }
  for (const role of RunRole.options) {
    try {
      await reclaim(role)
    } catch {
      // an unkillable holder shouldn't block the switch; the new start will surface conflicts.
    }
  }
}

/** `podium logs [-f]` — tails detached component logs; systemd mode points at journalctl. */
export function logsCommand(argv: string[]): void {
  const config = loadConfig()
  if (config.persistence === 'systemd') {
    const [daemonUnit, janitorUnit, serverUnit] = selectedUnits()
    console.log(
      'Under systemd — view logs with:\n' +
        `  journalctl --user -u ${serverUnit} -u ${janitorUnit} -u ${daemonUnit} -f`,
    )
    return
  }
  const follow = argv.includes('-f') || argv.includes('--follow')
  const files = ['server', 'janitor', 'daemon', 'all-in-one']
    .map((r) => join(logDir(), `${r}.log`))
    .filter((f) => existsSync(f))
  if (files.length === 0) {
    console.log(`No logs yet in ${logDir()}.`)
    return
  }
  // Delegate to `tail` for correct follow semantics; inherit stdio so it streams to the terminal.
  const args = [follow ? '-F' : '-n', follow ? undefined : '200', ...files].filter(
    (a): a is string => a !== undefined,
  )
  const child = spawn('tail', args, { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))
}
