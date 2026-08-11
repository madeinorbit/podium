// `podium status` / `podium stop` / `podium logs` — lifecycle commands over the run registry
// (packages/runtime/src/run-registry.ts). Pure rendering (`renderStatus`) is split from the impure
// command wrappers so it can be unit-tested. Design:
// docs/internal/superpowers/specs/2026-07-06-headless-process-model-design.md
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadConfig,
  localServerUrl,
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
  /** HTTP liveness is an independent truth source. A surviving server may have
   * lost its advisory run-registry record during a redeploy or signal race. */
  serverHealthy?: boolean
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
  if (c.state === 'unauthorized') {
    return [
      `  ✖ server link${target}: UNAUTHORIZED — ${c.authorizationReason ?? 'this machine is not authorized'}`,
      '    This is not an outage and will not be retried. Ask the machine owner or an admin',
      '    to authorize/re-pair it, then restart the daemon.',
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
    } else if (role === 'server' && view.serverHealthy) {
      lines.push(`  ● server  up :${view.port ?? config.port ?? 18787}  (health)`)
    } else {
      lines.push(`  ○ ${role}  down`)
    }
  }
  // Connectivity truthfulness (#19): a PID only proves the daemon process exists. When the
  // daemon has written its link state, report it — including the terminal blocked state,
  // which explains why the unit is down and what to do.
  if (view.connectivity) lines.push(...renderConnectivity(view.connectivity, nowMs))
  const url = config.publicUrl ?? localServerUrl(view.port ?? config.port ?? 18787)
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

async function serverHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_500),
    })
    return res.ok
  } catch {
    return false
  }
}

/** `podium status` */
export async function statusCommand(): Promise<void> {
  const config = loadConfig()
  const connectivity = readConnectivity()
  const port = resolvePort(config)
  const serverHealthy =
    config.mode === 'server' || config.mode === 'all-in-one' ? await serverHealth(port) : false
  console.log(
    renderStatus({
      live: listLive(),
      config,
      nowMs: Date.now(),
      instanceId: resolveInstanceId(),
      port,
      serverHealthy,
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

/** The components `podium logs` knows how to tail, in the order it shows them. */
const LOG_COMPONENTS = ['server', 'janitor', 'daemon', 'all-in-one', 'cli'] as const

export interface LogsOptions {
  follow: boolean
  /** Render NDJSON as one human line instead of streaming the raw bytes. */
  pretty: boolean
  /** Empty means every component. */
  components: string[]
}

/** PURE: `podium logs [component…] [-f] [--pretty]`. */
export function parseLogsArgs(argv: string[]): LogsOptions {
  const flags = new Set(argv.filter((a) => a.startsWith('-')))
  return {
    follow: flags.has('-f') || flags.has('--follow'),
    pretty: flags.has('--pretty'),
    components: argv.filter((a) => !a.startsWith('-')),
  }
}

/**
 * PURE: the files to tail, newest-format first.
 *
 * BOTH extensions, deliberately. `<role>.ndjson` is what the logger writes;
 * `<role>.log` is where the detached spawner still points the process's raw
 * stdout/stderr, so it is the only place a bun panic or a library's own printf
 * ends up. Showing one without the other means the two most interesting
 * failures — the structured one and the one that escaped structure entirely —
 * are in different places and a reader only knows about one of them.
 *
 * Rotated archives (`.1` … `.4`) are history and are not tailed; they are plain
 * NDJSON files in the same directory for anyone who wants them.
 */
export function logFilesFor(components: string[], dir: string = logDir()): string[] {
  const wanted = components.length > 0 ? components : [...LOG_COMPONENTS]
  return wanted
    .flatMap((role) => [join(dir, `${role}.ndjson`), join(dir, `${role}.log`)])
    .filter((f) => existsSync(f))
}

/**
 * PURE: one NDJSON record as a human line, in the same shape the console sink
 * uses — `12:34:56.789 WARN  daemon:pty resize dropped sessionId=s1`.
 *
 * A line that is not a log record is passed through UNCHANGED rather than
 * dropped or flagged. `<role>.log` is full of them by design (see above), and a
 * reader who asked for readable output is worse off if the one raw stack trace
 * in the file is the thing that goes missing.
 */
export function renderLogLine(line: string): string {
  if (!line.startsWith('{')) return line
  let record: Record<string, unknown>
  try {
    record = JSON.parse(line) as Record<string, unknown>
  } catch {
    return line
  }
  const { ts, level, ns, msg } = record
  if (typeof ts !== 'string' || typeof level !== 'string' || typeof ns !== 'string') return line
  const parts = [ts.slice(11, 23), level.toUpperCase().padEnd(5), ns, String(msg ?? '')]
  for (const [key, value] of Object.entries(record)) {
    if (key === 'ts' || key === 'level' || key === 'ns' || key === 'msg' || key === 'err') continue
    parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
  }
  const err = record.err as { name?: string; message?: string; stack?: string } | undefined
  if (err) parts.push(`\n${err.stack ?? `${err.name}: ${err.message}`}`)
  return parts.join(' ')
}

/**
 * `podium logs [component…] [-f] [--pretty]` — tails the component logs;
 * systemd mode points at journalctl, which owns the records there.
 */
export function logsCommand(argv: string[]): void {
  const config = loadConfig()
  const { follow, pretty, components } = parseLogsArgs(argv)
  if (config.persistence === 'systemd') {
    const [daemonUnit, janitorUnit, serverUnit] = selectedUnits()
    console.log(
      'Under systemd — view logs with:\n' +
        `  journalctl --user -u ${serverUnit} -u ${janitorUnit} -u ${daemonUnit} -f\n` +
        '\nRecords are NDJSON, one object per line. To read them as a table:\n' +
        `  journalctl --user -u ${serverUnit} -o cat | jq -r '"\\(.ts) \\(.level) \\(.ns) \\(.msg)"'`,
    )
    return
  }
  const files = logFilesFor(components)
  if (files.length === 0) {
    const which = components.length > 0 ? ` for ${components.join(', ')}` : ''
    console.log(`No logs yet${which} in ${logDir()}.`)
    return
  }
  // Delegate to `tail` for correct follow semantics, including `-F` across a
  // rotation — which now happens in-process, so the live file really is
  // replaced underneath a follower.
  const args = [follow ? '-F' : '-n', follow ? undefined : '200', ...files].filter(
    (a): a is string => a !== undefined,
  )
  if (!pretty) {
    // Inherit stdio: the exact bytes, no decode/encode round trip.
    const child = spawn('tail', args, { stdio: 'inherit' })
    child.on('exit', (code) => process.exit(code ?? 0))
    return
  }
  const child = spawn('tail', args, { stdio: ['ignore', 'pipe', 'inherit'] })
  let pending = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    // Chunks split mid-line; the tail of a chunk is held until its newline
    // arrives so a record is never parsed in halves.
    pending += chunk.toString('utf8')
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) console.log(renderLogLine(line))
  })
  child.on('exit', (code) => {
    if (pending.length > 0) console.log(renderLogLine(pending))
    process.exit(code ?? 0)
  })
}
