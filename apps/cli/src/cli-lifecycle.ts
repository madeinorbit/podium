// `podium status` / `podium stop` / `podium logs` — lifecycle commands over the run registry
// (packages/runtime/src/run-registry.ts). Pure rendering (`renderStatus`) is split from the impure
// command wrappers so it can be unit-tested. Design:
// docs/internal/superpowers/specs/2026-07-06-headless-process-model-design.md
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadConfig,
  localServerUrl,
  type PodiumConfig,
  resolveInstanceId,
  resolvePort,
} from '@podium/runtime/config'
import { type ConnectivityStatus, readConnectivity } from '@podium/runtime/connectivity'
import { CRASH_MAX_EVENTS, type CrashEvent, createCrashStore } from '@podium/runtime/crash-store'
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
  // Which roles are relevant to this deployment mode. Parent-supervised hosts
  // report parent + server + daemon (janitor is a server worker). The
  // `all-in-one` role is only the desktop in-process sidecar.
  const roles: RunRole[] =
    config.mode === 'all-in-one'
      ? byRole.has('all-in-one')
        ? ['all-in-one']
        : byRole.has('parent')
          ? ['parent', 'server', 'daemon']
          : ['server', 'janitor', 'daemon']
      : config.mode === 'server'
        ? byRole.has('parent')
          ? ['parent', 'server']
          : ['server', 'janitor']
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

export function selectedUnits(instanceId: string = resolveInstanceId()): string[] {
  // Prefer the parent unit; keep legacy peers listed so `podium stop` still
  // tears down pre-migration installs.
  return [
    instanceServiceName('parent', instanceId),
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
const LOG_COMPONENTS = [
  'server',
  'janitor',
  'daemon',
  'all-in-one',
  'cli',
  // The desktop shell's NATIVE half (apps/desktop/src-tauri/src/logging.rs) —
  // the supervisor process, its panics, and the update path. It writes the same
  // NDJSON shape into the same directory, so it costs one name here to be
  // readable by the same tail; without it the file exists and nothing shows it.
  // Named apart from the webview, which forwards its own records as a client.
  'desktop-native',
] as const

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
 *
 * `clients/<origin>.ndjson` is searched too (POD-1947). A raised client's records
 * are the ONE thing in this directory a reader arrives at by name rather than by
 * role — `podium logs level debug --role web` tells you the origin, and the next
 * thing anybody types is that origin. Only for a component named explicitly: the
 * bare `podium logs` still means this host's own processes, and a default that
 * swept in every client that ever forwarded would bury them.
 */
export function logFilesFor(components: string[], dir: string = logDir()): string[] {
  const wanted = components.length > 0 ? components : [...LOG_COMPONENTS]
  const named = components.length > 0
  return wanted
    .flatMap((role) => [
      join(dir, `${role}.ndjson`),
      join(dir, `${role}.log`),
      ...(named ? [join(dir, 'clients', `${role}.ndjson`)] : []),
    ])
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
export interface ExportCrashOptions {
  /** How many of the most recent events to bundle. */
  limit: number
  /** Where to write the bundle; stdout when absent. */
  out?: string
}

/** PURE: `podium logs export-crash [--limit N] [--out FILE]`. */
export function parseExportCrashArgs(argv: string[]): ExportCrashOptions {
  const value = (flag: string): string | undefined => {
    const inline = argv.find((a) => a.startsWith(`${flag}=`))
    if (inline) return inline.slice(flag.length + 1)
    const at = argv.indexOf(flag)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const rawLimit = Number(value('--limit'))
  const out = value('--out')
  return {
    limit: Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : CRASH_MAX_EVENTS,
    ...(out !== undefined && !out.startsWith('-') ? { out } : {}),
  }
}

/**
 * PURE: the support bundle, as a JSON string.
 *
 * ONE OBJECT, NOT A DIRECTORY OF FILES, and the envelope is not decoration:
 * whoever opens this needs to know which install and which build produced the
 * events, and a bare array of crash events answers neither. `exportedAt` is
 * here for the same reason — a bundle read three weeks later should not have to
 * be dated from the newest event it happens to contain.
 *
 * WHAT IS DELIBERATELY NOT IN IT: nothing is scrubbed, and that is the point of
 * the command. This is the CONSCIOUS-ACT path from the design spec — the user
 * runs it and hands the file to support — so it carries the full messages and
 * stacks the automatic telemetry hop may never send. The scrubbed, consent-gated
 * path is `telemetry.recordCrash`; conflating the two would either cripple the
 * export or turn a support request into an unconsented disclosure.
 */
export function renderCrashBundle(
  events: CrashEvent[],
  meta: { exportedAt: string; instanceId?: string; version?: string },
): string {
  return `${JSON.stringify(
    {
      kind: 'podium-crash-bundle',
      version: 1,
      exportedAt: meta.exportedAt,
      ...(meta.instanceId ? { instanceId: meta.instanceId } : {}),
      ...(meta.version ? { podiumVersion: meta.version } : {}),
      count: events.length,
      events,
    },
    null,
    2,
  )}\n`
}

/**
 * `podium logs export-crash [--limit N] [--out FILE]` — bundle recent crash
 * events for a deliberate support hand-off.
 *
 * Reads the crash dir DIRECTLY rather than over RPC. The events are files on
 * this host, and the moment support most wants them is the moment the server is
 * not running.
 */
export function exportCrashCommand(argv: string[]): void {
  const { limit, out } = parseExportCrashArgs(argv)
  const store = createCrashStore()
  const events = store.list(limit)
  if (events.length === 0) {
    console.log(`No crash events in ${store.dir}.`)
    return
  }
  const bundle = renderCrashBundle(events, {
    exportedAt: new Date().toISOString(),
    instanceId: resolveInstanceId(),
    version: process.env.PODIUM_APP_VERSION,
  })
  if (out === undefined) {
    process.stdout.write(bundle)
    return
  }
  writeFileSync(out, bundle, 'utf8')
  // The count and the path go to stderr-free stdout because this is CLI OUTPUT,
  // not logging: a human asked for a file and wants to be told where it is.
  console.log(`Wrote ${events.length} crash event(s) to ${out}`)
}

/**
 * `podium logs --help`. It exists because `logs` grew verbs (POD-1947): reading
 * this host's files is still the default and the common case, but "how do I turn
 * a client up" has to be answerable from the verb that reads what a raised
 * client produces, not only from a doc.
 */
export function logsHelpText(): string {
  return [
    'podium logs [component…] [-f] [--pretty]',
    '',
    `Tail this host's own NDJSON logs. Components: ${LOG_COMPONENTS.join(', ')}, or a`,
    'client origin (`web-<machine>`) for records a client forwarded here.',
    '',
    '  -f, --follow          Follow the files as they are written (and across rotation)',
    '  --pretty              Render each record as a readable line instead of NDJSON',
    '',
    'Connected clients (these reach the server; the rest is local files):',
    '  logs clients          List the clients connected right now — and reset them',
    '  logs level <level|reset> [--role R] [--machine M] [--client C] [--for 30m]',
    '                        Raise or restore what a connected client records',
    '                        (`podium logs level --help` for the full selector)',
    '',
    'Crash events:',
    '  logs export-crash [--limit N] [--out FILE]',
    '                        Bundle recent crash events for a support hand-off',
  ].join('\n')
}

export async function logsCommand(argv: string[]): Promise<void> {
  // `export-crash` is a subcommand of `logs` rather than a sibling verb: it is
  // the same data under the same directory, and a support instruction that says
  // "run podium logs export-crash" is easier to give than one more top-level
  // verb to remember.
  if (argv[0] === 'export-crash') {
    exportCrashCommand(argv.slice(1))
    return
  }
  // `clients` / `level` are the SAME reason, one hop further out (POD-1947):
  // raising a connected client is what fills `logs/clients/<origin>.ndjson`, and
  // the verb that reads those files is where an operator looks for the verb that
  // fills them. Unlike everything else here it needs the server — imported
  // lazily so `podium logs -f` still costs no tRPC client.
  if (argv[0] === 'clients' || argv[0] === 'level') {
    const { logsLevelCliMain } = await import('./logs-level-cli')
    await logsLevelCliMain(argv)
    return
  }
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.log(logsHelpText())
    return
  }
  const config = loadConfig()
  const { follow, pretty, components } = parseLogsArgs(argv)
  if (config.persistence === 'systemd') {
    const units = selectedUnits()
    const unitFlags = units.map((u) => `-u ${u}`).join(' ')
    const parentOrServer =
      units.find((u) => u.includes('-parent.') || u.endsWith('podium-parent.service')) ??
      units.find((u) => u.includes('-server.') || u.endsWith('podium-server.service')) ??
      units[0]
    console.log(
      'Under systemd — view logs with:\n' +
        `  journalctl --user ${unitFlags} -f\n` +
        '\nRecords are NDJSON, one object per line. To read them as a table:\n' +
        `  journalctl --user -u ${parentOrServer} -o cat | jq -r '"\\(.ts) \\(.level) \\(.ns) \\(.msg)"'`,
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
