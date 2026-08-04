// systemd user units for packaged installs and the source-based dev host. Every unit body is
// rendered here, so the runtime installer, release artifacts, and dev-host configuration share
// one source (including the CPU/IO tiers from e4660620 and the health backstop from 54d60a8b).
// Design: docs/internal/superpowers/specs/2026-07-06-headless-process-model-design.md
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { PodiumConfig } from '@podium/runtime/config'
import { DAEMON_BLOCKED_EXIT_CODE } from '@podium/runtime/connectivity'
import {
  defaultInstancePorts,
  instanceCommandName,
  instanceServiceName,
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
const GENERATED_SCRIPT_NOTICE =
  '# GENERATED from apps/cli/src/cli-systemd.ts by scripts/render-systemd.ts.\n' +
  '# Do not hand-edit; rerun the renderer after changing the source.\n'

// Spawned agent CLIs inherit the daemon's PATH, so every dir a harness binary can install into
// has to be here — a systemd unit gets none of the login shell's PATH. `%h/.local/bin` holds
// claude, grok, cursor-agent (and abduco); `%h/.bun/bin` holds bun/npm globals such as codex;
// opencode's installer hardcodes `%h/.opencode/bin`. User dirs precede system dirs so a user
// installed CLI wins over a stale system-wide one.
const DAEMON_PATH =
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
  serverUnit: string
  janitorUnit: string
  daemonUnit: string
  updateUnit: string
  updateTimer: string
  webUnit: string
  redeployUnit: string
  redeployPath: string
  healthUnit: string
  healthTimer: string
  backendUnit: string
  systemDaemonUnit: string
}

function updateTimerName(instanceId: string): string {
  return instanceId === 'default' ? 'podium-update-user.timer' : `podium-${instanceId}-update.timer`
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
    serverUnit: instanceServiceName('server', instanceId),
    janitorUnit: instanceServiceName('janitor', instanceId),
    daemonUnit: instanceServiceName('daemon', instanceId),
    updateUnit: instanceServiceName('update', instanceId),
    updateTimer: updateTimerName(instanceId),
    webUnit: instanceServiceName('web', instanceId),
    redeployUnit: instanceServiceName('redeploy', instanceId),
    redeployPath:
      instanceId === 'default' ? 'podium-redeploy.path' : `podium-${instanceId}-redeploy.path`,
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

function renderUpdateService(c: RenderContext): string {
  return `[Unit]
Description=Podium headless self-update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=PODIUM_INSTANCE=${c.instanceId}
ExecStart=/usr/bin/env sh -c '%h/.local/bin/${c.command} update; ec=$?; [ "$ec" = 10 ] && systemctl --user try-restart ${c.daemonUnit}; exit 0'
`
}

function renderUpdateTimer(c: RenderContext): string {
  return `[Unit]
Description=Podium headless self-update (daily)

[Timer]
OnCalendar=daily
Persistent=true
Unit=${c.updateUnit}

[Install]
WantedBy=default.target
`
}

function renderDevWeb(c: RenderContext): string {
  return `[Unit]
# The backend serves the built PWA bundles itself; this unit only builds them.
Description=Podium web build — rebuilds apps/web/dist and apps/mobile/dist (served by the backend). Runs at boot and on every redeploy.
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${c.repoRoot}
Environment=HOME=${c.home}
Environment=PATH=${c.home}/.local/bin:${c.home}/.opencode/bin:${c.home}/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=PODIUM_INSTANCE=${c.instanceId}
ExecStart=/usr/bin/env bash -lc 'bun run --filter @podium/web build && bun run --filter @podium/mobile build:web'

[Install]
WantedBy=default.target
`
}

function renderDevBackend(c: RenderContext): string {
  return `[Unit]
Description=Podium relay + live agent daemon (backend, :${c.port})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${c.repoRoot}
Environment=HOME=${c.home}
Environment=PATH=${c.home}/.local/bin:${c.home}/.opencode/bin:${c.home}/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=PODIUM_PORT=${c.port}
Environment=PODIUM_INSTANCE=${c.instanceId}
ExecStart=${c.repoRoot}/node_modules/.bin/tsx --conditions=@podium/source scripts/host.ts
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`
}

function renderDevSystemDaemon(c: RenderContext): string {
  return `# /etc/systemd/system/podium-daemon.service (system-wide alternative to the --user unit)
# Install: sudo cp scripts/systemd/podium-daemon-system.service /etc/systemd/system/podium-daemon.service
# Requires a \`podium\` binary on PATH and a writable PODIUM_STATE_DIR.
[Unit]
Description=Podium agent daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
User=podium
Environment=PODIUM_STATE_DIR=/var/lib/podium${c.instanceId === 'default' ? '' : `/${c.instanceId}`}
Environment=PODIUM_INSTANCE=${c.instanceId}
ExecStart=/usr/local/bin/${c.command} daemon
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`
}

function renderDevRedeployService(c: RenderContext): string {
  return `[Unit]
Description=Podium redeploy — restart server + daemon + web + janitor to run the latest main (triggered by git HEAD change)
After=${c.serverUnit} ${c.daemonUnit}

[Service]
Type=oneshot
Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PODIUM_INSTANCE=${c.instanceId}
ExecStartPre=/usr/bin/env bash ${c.repoRoot}/scripts/redeploy-wait.sh ${c.repoRoot}
# The janitor is a long-lived process holding the module graph it booted with, so a
# redeploy that moves the maintenance protocol/schema leaves it skewed against the new
# server. It then exits ${DAEMON_BLOCKED_EXIT_CODE} and RestartPreventExitStatus keeps it
# stopped — durable maintenance (steward-poll, and with it ALL durable message delivery)
# silently stops until a human notices (POD-1663). "podium update" revives it via
# reviveCompatibilityBlockedJanitor, but this git-HEAD redeploy path is not that path.
# reset-failed clears both a ${DAEMON_BLOCKED_EXIT_CODE} block and a hit start-limit;
# restarting the janitor in the SAME step as the server also stops the skew arising at
# all, since both re-exec from the checkout this deploy just verified.
ExecStart=-/usr/bin/systemctl --user reset-failed ${c.janitorUnit}
ExecStart=/usr/bin/systemctl --user restart ${c.serverUnit} ${c.daemonUnit} ${c.webUnit} ${c.janitorUnit}
`
}

function renderDevRedeployPath(c: RenderContext): string {
  return `[Unit]
Description=Watch git HEAD on the Podium main checkout; redeploy backend when main moves

[Path]
# .git/logs/HEAD is append-only and changes whenever the checkout HEAD moves.
PathModified=${c.repoRoot}/.git/logs/HEAD
Unit=${c.redeployUnit}

[Install]
WantedBy=default.target
`
}

function renderDevHealthService(c: RenderContext): string {
  return `[Unit]
Description=Podium health probe — last-resort restart of a wedged-but-alive /health
After=${c.serverUnit}

[Service]
Type=oneshot
Environment=PODIUM_INSTANCE=${c.instanceId}
Environment=PODIUM_PORT=${c.port}
Environment=PODIUM_HEALTH_UNIT=${c.serverUnit}
ExecStart=/usr/bin/env bash ${c.repoRoot}/scripts/podium-health-probe.sh
`
}

function renderDevHealthTimer(c: RenderContext): string {
  return `[Unit]
Description=Probe Podium backend health every 45s (last-resort wedge recovery)

[Timer]
OnBootSec=45s
OnUnitActiveSec=45s
AccuracySec=5s
Unit=${c.healthUnit}

[Install]
WantedBy=timers.target
`
}

const HEALTH_PROBE_SCRIPT = String.raw`#!/usr/bin/env bash
# Health probe for the instance-scoped server health unit. It is a last-resort backstop for
# a wedged-but-alive HTTP surface; the systemd watchdog and Restart=always cover the rest.
#
# Guards make a false kill structurally impossible:
#   1. An inactive server is left to systemd.
#   2. A server active for less than GRACE seconds is left alone during cold boot/deploy.
#   3. Two failed curls are required, with the guards checked again between them.
set -u

port="\${PODIUM_PORT:-18787}"
unit="\${PODIUM_HEALTH_UNIT:-podium-server.service}"
grace="\${PODIUM_HEALTH_GRACE:-120}"
retry_sleep="\${PODIUM_HEALTH_RETRY_SLEEP:-15}"
curl_timeout="\${PODIUM_HEALTH_CURL_TIMEOUT:-10}"
url="http://localhost:\${port}/health"

# Returns 0 only when the unit is active and has been active for >= grace.
# Any doubt returns 1, which the caller treats as "do nothing".
guards_pass() {
  local state ts entered now
  state="$(systemctl --user show "$unit" -p ActiveState --value 2>/dev/null || true)"
  [ "$state" = "active" ] || return 1
  ts="$(systemctl --user show "$unit" -p ActiveEnterTimestamp --value 2>/dev/null || true)"
  [ -n "$ts" ] || return 1
  entered="$(date -d "$ts" +%s 2>/dev/null || true)"
  [ -n "$entered" ] || return 1
  now="$(date +%s)"
  [ $(( now - entered )) -ge "$grace" ] || return 1
  return 0
}

probe() {
  curl -fsS -m "$curl_timeout" "$url" >/dev/null 2>&1
}

guards_pass || exit 0
probe && exit 0

# First probe missed - give the server a second chance before doing anything.
sleep "$retry_sleep"
# Re-check the guards: a restart while sleeping is fresh and protected by the grace.
guards_pass || exit 0
probe && exit 0

echo "podium-health: /health on :\${port} failed both probes (\${retry_sleep}s apart) - restarting \${unit}"
systemctl --user restart "$unit"
`.replaceAll('\\${', '${')

export function renderHealthProbeScript(): string {
  return GENERATED_SCRIPT_NOTICE + HEALTH_PROBE_SCRIPT
}

/** Render the complete file set for either the release bundle or the dev host. */
export function renderSystemdFiles(opts: SystemdRenderOptions = {}): RenderedSystemdFiles {
  const c = context(opts)
  if (c.profile === 'packaged') {
    return {
      units: {
        [c.serverUnit]: renderServerUnit({ profile: 'packaged', instanceId: c.instanceId }),
        [c.janitorUnit]: renderJanitorUnit({ port: c.port, instanceId: c.instanceId }),
        [c.daemonUnit]: renderDaemonUnit({ profile: 'packaged', instanceId: c.instanceId }),
        [c.updateUnit]: generatedUnit(renderUpdateService(c)),
        [c.updateTimer]: generatedUnit(renderUpdateTimer(c)),
      },
    }
  }
  return {
    units: {
      [c.serverUnit]: renderServerUnit({ ...opts, profile: 'dev', instanceId: c.instanceId }),
      [c.daemonUnit]: renderDaemonUnit({ ...opts, profile: 'dev', instanceId: c.instanceId }),
      [c.webUnit]: generatedUnit(renderDevWeb(c)),
      [c.redeployUnit]: generatedUnit(renderDevRedeployService(c)),
      [c.redeployPath]: generatedUnit(renderDevRedeployPath(c)),
      [c.healthUnit]: generatedUnit(renderDevHealthService(c)),
      [c.healthTimer]: generatedUnit(renderDevHealthTimer(c)),
      [c.updateUnit]: generatedUnit(renderUpdateService(c)),
      [c.updateTimer]: generatedUnit(renderUpdateTimer(c)),
      [c.backendUnit]: generatedUnit(renderDevBackend(c)),
      [c.systemDaemonUnit]: generatedUnit(renderDevSystemDaemon(c)),
    },
    healthProbe: renderHealthProbeScript(),
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

/**
 * Render + install the `--user` units for `mode` and enable+start them. Host modes install the
 * server + janitor (and local daemon for all-in-one); `daemon` (a joined worker) installs
 * only the daemon unit (bare `podium daemon`, config-driven remote server). Best-effort: returns
 * {ok:false, reason} when systemd is absent or a step fails, so setup can fall back.
 */
export function installSystemd(
  mode: PodiumConfig['mode'],
  port: number,
  instanceId: string = resolveInstanceId(),
): InstallResult {
  if (!hasSystemctl())
    return {
      ok: false,
      reason: 'systemd is not installed on this host',
      remedy: 'To start it at boot, add an "@reboot" entry with `crontab -e`.',
    }
  if (!hasUserSystemd())
    return {
      ok: false,
      reason: 'this host has no systemd user session (nothing is listening on the user D-Bus)',
      remedy:
        `If the host does run systemd, \`sudo loginctl enable-linger ${userInfo().username}\`, ` +
        'reconnect over SSH, then re-run `podium setup` to convert this into a service.',
    }
  const dir = userUnitDir()
  const serverUnit = instanceServiceName('server', instanceId)
  const janitorUnit = instanceServiceName('janitor', instanceId)
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
      writeFileSync(join(dir, janitorUnit), renderJanitorUnit({ port, instanceId }))
      units.push(janitorUnit)
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
