// systemd user units for packaged installs and the source-based dev host. Every unit body is
// rendered here, so the runtime installer, release artifacts, and dev-host configuration share
// one source (including the CPU/IO tiers from e4660620 and the health backstop from 54d60a8b).
// Design: docs/internal/superpowers/specs/2026-07-06-headless-process-model-design.md
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { PodiumConfig } from '@podium/runtime/config'
import { DAEMON_BLOCKED_EXIT_CODE } from '@podium/runtime/connectivity'
import {
  defaultInstancePorts,
  instanceCommandName,
  instanceServiceName,
  instanceUpdateTimerName,
  resolveInstanceId,
} from '@podium/runtime/instance'

export type SystemdProfile = 'packaged' | 'dev'

export interface SystemdRenderOptions {
  profile?: SystemdProfile
  instanceId?: string
  port?: number
  /** Dev profile only. Defaults to the checked-in dev host account. */
  home?: string
  /** Dev profile only. Defaults to the checked-in dev host checkout. */
  repoRoot?: string
}

export interface DaemonRenderOptions extends SystemdRenderOptions {
  /** Packaged profile only: pin the local daemon to a server URL. */
  serverUrl?: string
  /** Packaged profile only: authenticate as the co-located machine. */
  local?: boolean
}

export interface RenderedSystemdFiles {
  readonly units: Readonly<Record<string, string>>
  readonly healthProbe?: string
}

const GENERATED_UNIT_NOTICE =
  '# GENERATED from apps/cli/src/cli-systemd.ts by scripts/render-systemd.ts.\n' +
  '# Do not hand-edit; rerun the renderer after changing the source.\n'

// Child processes inherit their service's PATH, so every supported per-user runtime and harness
// directory has to be here — a systemd unit gets none of the login shell's PATH. The server needs
// this for updater build children; the daemon needs it for agent CLIs. User dirs precede system
// dirs so a supported user install wins over a stale system-wide one.
const USER_RUNTIME_PATH =
  '%h/.local/bin:%h/.bun/bin:%h/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin'
const DEV_HOME = '/home/user'
const DEV_REPO = '/home/user/src/other/podium'

/** `~/.config/systemd/user` (respects XDG_CONFIG_HOME). */
export function userUnitDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME || homedir(), '.config')
  return join(base, 'systemd', 'user')
}

interface RenderContext {
  profile: SystemdProfile
  instanceId: string
  command: string
  port: number
  home: string
  repoRoot: string
  parentUnit: string
  serverUnit: string
  janitorUnit: string
  daemonUnit: string
  redeployUnit: string
  healthUnit: string
  healthTimer: string
  backendUnit: string
  systemDaemonUnit: string
}

function healthTimerName(instanceId: string): string {
  return instanceId === 'default' ? 'podium-health.timer' : `podium-${instanceId}-health.timer`
}

function context(opts: SystemdRenderOptions = {}): RenderContext {
  const profile = opts.profile ?? 'packaged'
  const instanceId = opts.instanceId ?? resolveInstanceId()
  const port = opts.port ?? defaultInstancePorts(instanceId).server
  return {
    profile,
    instanceId,
    command: instanceCommandName(instanceId),
    port,
    home: opts.home ?? DEV_HOME,
    repoRoot: opts.repoRoot ?? DEV_REPO,
    parentUnit: instanceServiceName('parent', instanceId),
    serverUnit: instanceServiceName('server', instanceId),
    janitorUnit: instanceServiceName('janitor', instanceId),
    daemonUnit: instanceServiceName('daemon', instanceId),
    redeployUnit: instanceServiceName('redeploy', instanceId),
    healthUnit: instanceServiceName('health', instanceId),
    healthTimer: healthTimerName(instanceId),
    backendUnit:
      instanceId === 'default' ? 'podium-backend.service' : `podium-${instanceId}-backend.service`,
    systemDaemonUnit:
      instanceId === 'default'
        ? 'podium-daemon-system.service'
        : `podium-${instanceId}-daemon-system.service`,
  }
}

function generatedUnit(body: string): string {
  return `${GENERATED_UNIT_NOTICE}${body}`
}

function renderPackagedServer(c: RenderContext): string {
  return `[Unit]
Description=Podium coordinating server (relay + HTTP/tRPC + WebSockets)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
Environment=PODIUM_INSTANCE=${c.instanceId}
Environment=PATH=${USER_RUNTIME_PATH}
ExecStart=%h/.local/bin/${c.command} server
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

function renderDevServer(c: RenderContext): string {
  return `[Unit]
Description=Podium coordinating server (relay + HTTP/tRPC + client/daemon WebSockets, :${c.port})
After=network-online.target
Wants=network-online.target

[Service]
# Type=notify + WatchdogSec: the server pets the watchdog from its event loop.
# 90s, not 30: boot can stall tens of seconds at LOW cpu on disk contention
# (packages/runtime/src/sd-notify.ts), so a wedged-but-alive coordinating loop stops petting and
# systemd restarts it — Restart=always only fires on EXIT and cannot see a stall.
Type=notify
NotifyAccess=all
WatchdogSec=90
WorkingDirectory=${c.repoRoot}
Environment=HOME=${c.home}
Environment=PATH=${c.home}/.local/bin:${c.home}/.opencode/bin:${c.home}/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=PODIUM_PORT=${c.port}
Environment=PODIUM_INSTANCE=${c.instanceId}
# Event-loop stall logging + starved-vs-busy classification (POD-600).
Environment=PODIUM_LOOP_PROFILE=1
# Run @podium/* from TypeScript SOURCE (--conditions=@podium/source), like Vite — no build,
# no dist, no stale-dist trap. Bun runs TS natively and this process does no PTY work.
ExecStart=${c.home}/.local/bin/bun --conditions=@podium/source scripts/server.ts
Restart=always
RestartSec=2
# Two-tier scheduling (POD-598): the host runs ~10x CPU-oversubscribed by agent/test
# workloads; POD-594 measured the daemon main thread waiting on the runqueue 60% of
# wall time (server 51%) with everything at default CPUWeight=100. Interactive Podium
# services get the high tier; per-agent scopes get CPUWeight=50/IOWeight=100 (abduco.ts).
CPUWeight=900
IOWeight=500
MemoryLow=512M

[Install]
WantedBy=default.target
`
}

export function renderServerUnit(
  instanceIdOrOptions: string | SystemdRenderOptions = resolveInstanceId(),
): string {
  const opts =
    typeof instanceIdOrOptions === 'string'
      ? { instanceId: instanceIdOrOptions }
      : instanceIdOrOptions
  const c = context(opts)
  return generatedUnit(c.profile === 'dev' ? renderDevServer(c) : renderPackagedServer(c))
}

function renderPackagedParent(c: RenderContext): string {
  return `[Unit]
Description=Podium parent supervisor (server + daemon children; janitor as server worker)
After=network-online.target
Wants=network-online.target

[Service]
# Type=notify + MAINPID re-declaration: self-handover keeps the unit active across updates.
Type=notify
NotifyAccess=all
WatchdogSec=90
Environment=PODIUM_INSTANCE=${c.instanceId}
Environment=PODIUM_PORT=${c.port}
Environment=PATH=${USER_RUNTIME_PATH}
ExecStart=%h/.local/bin/${c.command} parent --takeover
Restart=always
RestartSec=2
# Degraded children never bubble here — only a wedged parent trips the watchdog.
CPUWeight=900
IOWeight=500
MemoryLow=2G

[Install]
WantedBy=default.target
`
}

function renderDevParent(c: RenderContext): string {
  return `[Unit]
Description=Podium parent supervisor (source checkout)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=90
WorkingDirectory=${c.repoRoot}
Environment=HOME=${c.home}
Environment=PATH=${c.home}/.local/bin:${c.home}/.opencode/bin:${c.home}/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=PODIUM_PORT=${c.port}
Environment=PODIUM_INSTANCE=${c.instanceId}
ExecStart=${c.home}/.local/bin/bun --conditions=@podium/source scripts/cli.ts parent --takeover
Restart=always
RestartSec=2
CPUWeight=900
IOWeight=500
MemoryLow=2G

[Install]
WantedBy=default.target
`
}

/** Single parent unit that owns server + daemon children [POD-2506]. */
export function renderParentUnit(opts: SystemdRenderOptions = {}): string {
  const c = context(opts)
  return generatedUnit(c.profile === 'dev' ? renderDevParent(c) : renderPackagedParent(c))
}

function renderPackagedJanitor(c: RenderContext): string {
  return `[Unit]
Description=Podium durable maintenance janitor
After=network-online.target ${c.serverUnit}
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
Environment=PODIUM_INSTANCE=${c.instanceId}
ExecStart=%h/.local/bin/${c.command} janitor --server http://localhost:${c.port}
Restart=always
RestartSec=2
# A protocol/schema mismatch is terminal until the installed bundle catches up.
RestartPreventExitStatus=${DAEMON_BLOCKED_EXIT_CODE}
# Housekeeping is deliberately below the interactive server/daemon tier. Each DB
# pass is bounded and yields via the shared time-budget helper.
CPUWeight=100
IOWeight=100

[Install]
WantedBy=default.target
`
}

function renderPackagedDaemon(c: RenderContext, opts: DaemonRenderOptions): string {
  // `--local` = the split daemon on a host box; `--server` pins the URL. The join case passes
  // neither, so bare `podium daemon` resolves serverUrl from config.
  const flags = [opts.local ? '--local' : '', opts.serverUrl ? `--server ${opts.serverUrl}` : '']
    .filter(Boolean)
    .join(' ')
  const exec = `%h/.local/bin/${c.command} daemon${flags ? ` ${flags}` : ''}`
  const after = opts.local ? `network-online.target ${c.serverUnit}` : 'network-online.target'
  return `[Unit]
Description=Podium per-machine agent daemon
After=${after}
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
Environment=PODIUM_INSTANCE=${c.instanceId}
Environment=PATH=${USER_RUNTIME_PATH}
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

function renderDevDaemon(c: RenderContext): string {
  return `[Unit]
Description=Podium per-machine agent daemon (PTY attach, transcript tails, discovery, metrics)
After=network-online.target ${c.serverUnit}
Wants=network-online.target
# Loose coupling on purpose: the daemon reconnects to the server with backoff, so it can start
# before the server and survives a server restart without dropping agents.

[Service]
# Type=notify + WatchdogSec: the daemon exposes no HTTP surface, so the systemd watchdog is the
# only thing that catches a wedged-but-alive daemon.
Type=notify
NotifyAccess=all
WatchdogSec=30
WorkingDirectory=${c.repoRoot}
Environment=HOME=${c.home}
Environment=PATH=${c.home}/.local/bin:${c.home}/.opencode/bin:${c.home}/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=PODIUM_PORT=${c.port}
Environment=PODIUM_INSTANCE=${c.instanceId}
# Bun runtime: the PTY backend is selected at runtime (@podium/harness). Run from SOURCE so
# redeploy-on-main-change re-reads it like tsx did.
ExecStart=${c.home}/.local/bin/bun --conditions=@podium/source scripts/daemon.ts
Restart=always
RestartSec=2
# Two-tier scheduling (POD-598): the host runs ~10x CPU-oversubscribed by agent/test
# workloads; POD-594 measured this daemon's main thread waiting on the runqueue 60% of
# wall time with everything at default CPUWeight=100. Interactive Podium services get
# the high tier; per-agent scopes get CPUWeight=50/IOWeight=100 (abduco.ts).
CPUWeight=900
IOWeight=500
MemoryLow=2G

[Install]
WantedBy=default.target
`
}

/**
 * The daemon unit. `serverUrl` present → `--server <url>`; absent → config-driven bare daemon.
 * The dev profile runs the source split directly and keeps the same instance identity, unit
 * naming, port, and CPU/IO tier as the packaged profile.
 */
export function renderDaemonUnit(opts: DaemonRenderOptions = {}): string {
  const c = context(opts)
  return generatedUnit(c.profile === 'dev' ? renderDevDaemon(c) : renderPackagedDaemon(c, opts))
}

export function renderJanitorUnit(opts: { port: number; instanceId?: string }): string {
  const c = context({ instanceId: opts.instanceId, port: opts.port })
  return generatedUnit(renderPackagedJanitor(c))
}

// There is no web-build unit any more (POD-1985). The server runs those builds
// itself, in batch-tier transient scopes. Health probing and git-HEAD redeploy
// units are gone too (POD-2506): the parent watchdog + self-handover subsume
// them, and the cutover issue owns source-host update.

/** Render the complete file set for either the release bundle or the dev host. */
export function renderSystemdFiles(opts: SystemdRenderOptions = {}): RenderedSystemdFiles {
  const c = context(opts)
  return {
    units: {
      [c.parentUnit]: renderParentUnit({
        profile: c.profile,
        instanceId: c.instanceId,
        port: c.port,
        ...(c.profile === 'dev' ? { home: c.home, repoRoot: c.repoRoot } : {}),
      }),
    },
  }
}

/** Write a rendered profile, used by the build and the explicit dev-host renderer. */
export function writeSystemdFiles(
  outputDir: string,
  opts: SystemdRenderOptions = {},
  healthProbePath = join(outputDir, '..', 'podium-health-probe.sh'),
): void {
  const rendered = renderSystemdFiles(opts)
  mkdirSync(outputDir, { recursive: true })
  for (const [name, body] of Object.entries(rendered.units)) {
    writeFileSync(join(outputDir, name), body)
  }
  if (rendered.healthProbe) writeFileSync(healthProbePath, rendered.healthProbe, { mode: 0o755 })
}

/**
 * Run a lifecycle command quietly, folding its stderr into the thrown error instead of letting
 * it reach the operator's terminal. Callers report failure in their own words (an installer that
 * recovers should not also print the raw `systemctl` complaint it recovered from).
 */
function run(cmd: string, args: string[]): void {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    const detail = (e as { stderr?: Buffer }).stderr?.toString().trim().split('\n')[0]
    throw new Error(detail ? `${cmd}: ${detail}` : (e as Error).message)
  }
}

export function hasSystemctl(): boolean {
  try {
    execFileSync('systemctl', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
function systemctlSucceeds(args: string[]): boolean {
  try {
    execFileSync('systemctl', ['--user', ...args], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** True only while systemd considers the user unit active. */
export function systemdUnitActive(unit: string): boolean {
  return systemctlSucceeds(['is-active', '--quiet', unit])
}

/**
 * True when systemd can resurrect the unit, including enabled-but-currently-restarting units.
 * Active-but-disabled units also count because role demotion must stop their current process.
 */
export function systemdUnitManaged(unit: string): boolean {
  return systemdUnitActive(unit) || systemctlSucceeds(['is-enabled', '--quiet', unit])
}

/**
 * Whether `systemctl --user` can actually reach a user manager. `hasSystemctl()` only proves the
 * binary is installed; the *user* instance additionally needs a session bus at
 * /run/user/<uid>/bus, which is missing on container-based VPS images, on hosts with pam_systemd
 * disabled, and under `sudo`/`su` without a login session. Without this probe the first real
 * `systemctl --user` call is what discovers the problem — by printing "Failed to connect to bus:
 * No medium found" mid-install, even though we go on to fall back successfully.
 */
export function hasUserSystemd(): boolean {
  try {
    execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface InstallResult {
  ok: boolean
  reason?: string
  /** One actionable sentence for THIS reason, so the fallback message can stay specific. */
  remedy?: string
}

export interface InstallSystemdDeps {
  hasSystemctl?: () => boolean
  hasUserSystemd?: () => boolean
  unitDir?: () => string
  run?: (cmd: string, args: string[]) => void
}

/**
 * Retire the daily updater from installs created by older Podium releases. Disabling before
 * unlinking removes systemd's enablement symlink and stops the timer; the caller's daemon-reload
 * then makes the removed definitions disappear from the user manager as part of normal setup.
 */
function removeLegacyUpdateTimer(
  dir: string,
  instanceId: string,
  runCommand: (cmd: string, args: string[]) => void,
): void {
  const timer = instanceUpdateTimerName(instanceId)
  const service = instanceServiceName('update', instanceId)
  if (existsSync(join(dir, timer))) {
    runCommand('systemctl', ['--user', 'disable', '--now', timer])
  }
  rmSync(join(dir, timer), { force: true })
  rmSync(join(dir, service), { force: true })
}

/**
 * Render + install the `--user` units for `mode` and enable+start them. Every
 * managed mode installs the single parent unit (POD-2506), including daemon-only
 * join — the parent reads config.mode and supervises only the daemon child.
 * Best-effort: returns {ok:false, reason} when systemd is absent or a step fails.
 */
export function installSystemd(
  mode: PodiumConfig['mode'],
  port: number,
  instanceId: string = resolveInstanceId(),
  deps: InstallSystemdDeps = {},
): InstallResult {
  if (!(deps.hasSystemctl ?? hasSystemctl)())
    return {
      ok: false,
      reason: 'systemd is not installed on this host',
      remedy: 'To start it at boot, add an "@reboot" entry with `crontab -e`.',
    }
  if (!(deps.hasUserSystemd ?? hasUserSystemd)())
    return {
      ok: false,
      reason: 'this host has no systemd user session (nothing is listening on the user D-Bus)',
      remedy:
        `If the host does run systemd, \`sudo loginctl enable-linger ${userInfo().username}\`, ` +
        'reconnect over SSH, then re-run `podium setup` to convert this into a service.',
    }
  const dir = (deps.unitDir ?? userUnitDir)()
  const runCommand = deps.run ?? run
  const parentUnit = instanceServiceName('parent', instanceId)
  if (mode === 'client') {
    return { ok: false, reason: 'client mode has no supervised unit' }
  }
  try {
    mkdirSync(dir, { recursive: true })
    removeLegacyUpdateTimer(dir, instanceId, runCommand)
    writeFileSync(join(dir, parentUnit), renderParentUnit({ instanceId, port }))
    runCommand('systemctl', ['--user', 'daemon-reload'])
    // Linger so the units run without an active login session (headless VPS over SSH).
    try {
      runCommand('loginctl', ['enable-linger', userInfo().username])
    } catch {
      // non-fatal: on some hosts linger is already on or loginctl is restricted
    }
    runCommand('systemctl', ['--user', 'enable', '--now', parentUnit])
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}

/**
 * Write a user unit file (idempotent) and return its path — used by reconcile to put the
 * per-role unit in place before `enable --now`. Callers render a single role body.
 */
export function writeUserUnit(unit: string, body: string): string {
  const path = join(userUnitDir(), unit)
  mkdirSync(userUnitDir(), { recursive: true })
  writeFileSync(path, body)
  return path
}

/**
 * Enable + start the named user units (no-ops on units already active). Does not write
 * files — `writeUserUnit` did that — but `daemon-reload`s so systemd forgets the old body.
 */
export function enableSystemdUnits(units: string[]): void {
  run('systemctl', ['--user', 'daemon-reload'])
  run('systemctl', ['--user', 'enable', '--now', ...units])
}

/**
 * Disable + stop the named user units, so a changed deployment mode (a cutover) can never
 * be resurrected by a `Restart=always` unit or a reboot. `disable --now` is the "stop AND
 * forget" step — `podium stop` alone leaves the unit enabled, which is right for stop but
 * wrong for a role switch.
 */
export function disableSystemdUnits(units: string[]): void {
  run('systemctl', ['--user', 'disable', '--now', ...units])
}

/**
 * Prevent the named units from being resurrected on reboot/reload without stopping their current
 * processes. Target promotion uses this for its in-flight daemon: the daemon remains available for
 * a lost promote-reply retry, while systemd can no longer create a second copy later.
 */
export function disarmSystemdUnits(units: string[]): void {
  run('systemctl', ['--user', 'disable', ...units])
}

/**
 * Runtime-only mask: a running unit stays up, but Restart=always cannot
 * resurrect it. The mask lives in /run and vanishes on reboot, so a kill
 * mid-handover still boots into the fully-armed legacy set.
 */
export function maskSystemdUnitsRuntime(units: string[]): void {
  if (units.length === 0) return
  run('systemctl', ['--user', 'mask', '--runtime', ...units])
}

export function unmaskSystemdUnits(units: string[]): void {
  if (units.length === 0) return
  run('systemctl', ['--user', 'unmask', ...units])
}

export function startSystemdUnits(units: string[]): void {
  if (units.length === 0) return
  run('systemctl', ['--user', 'start', ...units])
}

/**
 * Stop, disable, unlink, and daemon-reload so the definitions disappear.
 * Used only AFTER the parent reports healthy. Empty input is a no-op.
 */
export function removeUserUnits(
  units: string[],
  deps: { unitDir?: () => string; run?: (cmd: string, args: string[]) => void } = {},
): void {
  if (units.length === 0) return
  const dir = (deps.unitDir ?? userUnitDir)()
  const runCommand = deps.run ?? run
  try {
    runCommand('systemctl', ['--user', 'unmask', ...units])
  } catch {
    // not masked — fine
  }
  try {
    runCommand('systemctl', ['--user', 'disable', '--now', ...units])
  } catch {
    // absent / already disabled — still unlink
  }
  for (const unit of units) {
    rmSync(join(dir, unit), { force: true })
  }
  runCommand('systemctl', ['--user', 'daemon-reload'])
}
