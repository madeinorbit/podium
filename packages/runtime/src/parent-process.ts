/**
 * Process-driving loop for the thin parent: spawn children from the install
 * path, restart on crash, park on refusal, run self-handover, roll back when
 * allowed. [POD-2505]
 */
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@podium/logger'
import { resolveInstallDir } from './config'
import {
  clearHandoverRequest,
  PARENT_HANDOVER_SIGNAL,
  readHandoverRequest,
} from './parent-control'
import {
  applyChildExit,
  applyChildRunning,
  beginHandoverOutgoing,
  CHILD_START_ORDER,
  clearPostUpdate,
  emptyParentSnapshot,
  isHandoverHealthy,
  isPostUpdateCrashLoop,
  markPostUpdate,
  type HandoverHealthProbe,
  type ParentSnapshot,
  type SupervisedChild,
  rollbackDecision,
} from './parent-supervisor'
import { sdNotify } from './sd-notify'
import { oldBundlePresent, pruneOldBundle, restoreOldBundle } from './update-install'

const log = createLogger('runtime:parent')

export const PARENT_SUCCESSOR_PID_ENV = 'PODIUM_PARENT_SUCCESSOR_PID'
export const PARENT_HANDOVER_EXPECTED_VERSION_ENV = 'PODIUM_HANDOVER_EXPECTED_VERSION'
export const PARENT_POST_UPDATE_ENV = 'PODIUM_PARENT_POST_UPDATE'

export type SpawnChildFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export type HealthProbeFn = (port: number) => Promise<HandoverHealthProbe>

export interface ParentProcessDeps {
  installDir?: string
  /** Override the install binary used for children AND successor parents. */
  installBinary?: string
  port: number
  /** Which OS children to supervise. Default: server then daemon. */
  children?: readonly SupervisedChild[]
  env?: NodeJS.ProcessEnv
  spawn?: SpawnChildFn
  /** Probe used for boot readiness and handover health (disposition 24). */
  probeHealth?: HealthProbeFn
  /** Whether the release that just swapped carried new migrations (decision 4). */
  releaseHadMigrations?: boolean
  /** Notify systemd (READY / MAINPID / WATCHDOG). */
  notify?: (state: string) => void
  /** Report successor PID to a desktop shell (macOS). */
  reportSuccessorPid?: (pid: number) => void
  /** Optional: run schema-gate + fetch + swap before handover when request says so. */
  performUpdateSwap?: (expectedVersion: string) => Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onSnapshot?: (snap: ParentSnapshot) => void
}

function defaultInstallBinary(installDir: string, env: NodeJS.ProcessEnv): string {
  const named = join(installDir, 'podium')
  if (existsSync(named)) return named
  // Source / test fallback: the running binary, still invoked with install-dir env.
  return env.PODIUM_PARENT_BIN || process.execPath
}

function childArgs(child: SupervisedChild, port: number): string[] {
  if (child === 'server') return ['server', '--takeover']
  return ['daemon', '--local', '--takeover']
}

/**
 * Resolve how to invoke a component from the install path.
 * Compiled install: `<installDir>/podium <role> …`
 * Source checkout tests may point PODIUM_PARENT_BIN at `bun` and pass the CLI
 * via PODIUM_PARENT_CLI.
 */
export function installInvocation(
  role: SupervisedChild | 'parent',
  opts: { installBinary: string; port: number; env: NodeJS.ProcessEnv },
): { command: string; args: string[] } {
  const extra =
    role === 'parent' ? ['parent', '--takeover'] : childArgs(role, opts.port)
  const cli = opts.env.PODIUM_PARENT_CLI
  if (cli) {
    return {
      command: opts.installBinary,
      args: ['--conditions=@podium/source', cli, ...extra],
    }
  }
  return { command: opts.installBinary, args: extra }
}

async function defaultProbeHealth(port: number): Promise<HandoverHealthProbe> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/version`)
    if (!res.ok) {
      return {
        serverRunning: false,
        daemonRunning: false,
        serverVersion: null,
        daemonConnected: false,
      }
    }
    const body = (await res.json()) as {
      appVersion?: string
      components?: { daemon?: string; degraded?: string[] }
      daemonConnected?: boolean
    }
    const daemonConnected =
      body.daemonConnected === true ||
      body.components?.daemon === 'running' ||
      body.components?.daemon === 'connected'
    return {
      serverRunning: true,
      daemonRunning: daemonConnected,
      serverVersion: body.appVersion ?? null,
      daemonConnected,
    }
  } catch {
    return {
      serverRunning: false,
      daemonRunning: false,
      serverVersion: null,
      daemonConnected: false,
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class ParentProcess {
  private snap: ParentSnapshot
  private readonly childProcs = new Map<SupervisedChild, ChildProcess>()
  private readonly childOrder: readonly SupervisedChild[]
  private readonly deps: Required<
    Pick<ParentProcessDeps, 'port' | 'spawn' | 'probeHealth' | 'notify' | 'now' | 'sleep'>
  > &
    ParentProcessDeps
  private readonly installDir: string
  private readonly installBinary: string
  private readonly env: NodeJS.ProcessEnv
  private stopping = false
  private tickTimer: ReturnType<typeof setInterval> | undefined
  private handoverInFlight: Promise<void> | undefined

  constructor(deps: ParentProcessDeps) {
    this.env = { ...(deps.env ?? process.env) }
    this.installDir = deps.installDir ?? resolveInstallDir(this.env)
    this.installBinary = deps.installBinary ?? defaultInstallBinary(this.installDir, this.env)
    this.childOrder = deps.children ?? CHILD_START_ORDER
    this.deps = {
      ...deps,
      port: deps.port,
      spawn: deps.spawn ?? spawn,
      probeHealth: deps.probeHealth ?? defaultProbeHealth,
      notify: deps.notify ?? sdNotify,
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? sleep,
    }
    const incoming = this.env[PARENT_HANDOVER_EXPECTED_VERSION_ENV]
    this.snap = incoming
      ? { ...emptyParentSnapshot('handover_incoming'), expectedVersion: incoming }
      : emptyParentSnapshot('booting')
    if (this.env[PARENT_POST_UPDATE_ENV] === '1') {
      this.snap = markPostUpdate(this.snap, this.deps.now())
    }
  }

  snapshot(): ParentSnapshot {
    return this.snap
  }

  private publish(): void {
    this.deps.onSnapshot?.(this.snap)
  }

  /** Boot children in priority order and signal READY once the health gate passes. */
  async start(): Promise<void> {
    for (const child of this.childOrder) {
      await this.spawnChild(child)
    }
    const expected =
      this.snap.expectedVersion ??
      this.env.PODIUM_APP_VERSION ??
      (await this.readInstalledVersion())
    const healthy = await this.waitForHealthy(expected, 60_000)
    if (!healthy) {
      log.error('parent boot health gate failed', { expected })
    }
    this.snap = {
      ...this.snap,
      phase: Object.keys(this.snap.refusals).length > 0 ? 'degraded' : 'running',
    }
    this.publish()
    this.deps.notify('READY=1')
    this.deps.notify('WATCHDOG=1')
    this.tickTimer = setInterval(() => {
      void this.tick()
    }, 500)
    this.tickTimer.unref?.()
    process.on(PARENT_HANDOVER_SIGNAL, () => {
      void this.onHandoverSignal()
    })
  }

  private async onHandoverSignal(): Promise<void> {
    if (this.handoverInFlight) return
    const request = readHandoverRequest()
    if (!request) {
      log.warn('handover signal received but no request file present')
      return
    }
    this.handoverInFlight = (async () => {
      try {
        if (request.performSwap) {
          if (!this.deps.performUpdateSwap) {
            throw new Error('handover request asked for swap but no performUpdateSwap is configured')
          }
          await this.deps.performUpdateSwap(request.expectedVersion)
        }
        this.deps.releaseHadMigrations = request.releaseHadMigrations
        await this.handover(request.expectedVersion)
      } catch (error) {
        log.error('handover failed', { err: error })
        clearHandoverRequest()
      } finally {
        this.handoverInFlight = undefined
      }
    })()
    await this.handoverInFlight
  }

  private async readInstalledVersion(): Promise<string> {
    try {
      const { readFileSync } = await import('node:fs')
      return readFileSync(join(this.installDir, 'VERSION'), 'utf8').trim()
    } catch {
      return this.env.PODIUM_APP_VERSION ?? 'dev'
    }
  }

  private requiresDaemon(): boolean {
    return this.childOrder.includes('daemon')
  }

  private async waitForHealthy(expectedVersion: string, budgetMs: number): Promise<boolean> {
    const deadline = this.deps.now() + budgetMs
    const wantsDaemon = this.requiresDaemon()
    while (this.deps.now() < deadline) {
      const probe = await this.deps.probeHealth(this.deps.port)
      const versionOk =
        expectedVersion === 'dev' ||
        !expectedVersion ||
        probe.serverVersion === expectedVersion
      const handover =
        this.snap.phase === 'handover_incoming' || this.snap.phase === 'handover_outgoing'
      const ok = handover
        ? wantsDaemon
          ? isHandoverHealthy(probe, expectedVersion)
          : probe.serverRunning && versionOk && probe.serverVersion === expectedVersion
        : probe.serverRunning && versionOk && (!wantsDaemon || probe.daemonConnected)
      if (ok) return true
      await this.deps.sleep(200)
    }
    return false
  }

  private async spawnChild(child: SupervisedChild): Promise<void> {
    if (this.stopping) return
    const { command, args } = installInvocation(child, {
      installBinary: this.installBinary,
      port: this.deps.port,
      env: this.env,
    })
    const childEnv: NodeJS.ProcessEnv = {
      ...this.env,
      PODIUM_PORT: String(this.deps.port),
      PODIUM_HOME: this.installDir,
      PODIUM_UNDER_PARENT: '1',
    }
    // Children must not inherit the parent's notify socket — the parent pets systemd.
    delete childEnv.NOTIFY_SOCKET
    delete childEnv.WATCHDOG_USEC
    delete childEnv.INVOCATION_ID

    log.info('spawning child', { child, command, args })
    const proc = this.deps.spawn(command, args, {
      env: childEnv,
      stdio: 'inherit',
    })
    this.childProcs.set(child, proc)
    if (proc.pid) {
      this.snap = applyChildRunning(this.snap, child, proc.pid)
      this.publish()
    }
    proc.once('exit', (code, signal) => {
      this.childProcs.delete(child)
      if (this.stopping) return
      // Outgoing handover: the successor reclaims children via --takeover. Do not
      // treat those exits as crashes or schedule restarts that race the new parent.
      if (this.snap.phase === 'handover_outgoing') return
      this.snap = applyChildExit(this.snap, child, {
        exitCode: code,
        signal,
        nowMs: this.deps.now(),
      })
      this.publish()
      void this.considerRollback()
    })
  }

  private async tick(): Promise<void> {
    if (this.stopping) return
    this.deps.notify('WATCHDOG=1')
    if (this.snap.phase === 'handover_outgoing' || this.snap.phase === 'rolling_back') return
    const now = this.deps.now()
    for (const child of this.childOrder) {
      const state = this.snap.children[child]
      if (state.status !== 'restarting') continue
      if (state.nextAtMs > now) continue
      await this.spawnChild(child)
    }
  }

  private async considerRollback(): Promise<void> {
    if (!isPostUpdateCrashLoop(this.snap, this.deps.now())) return
    const decision = rollbackDecision({
      crashLoop: true,
      oldBundlePresent: oldBundlePresent(this.installDir),
      releaseHadMigrations: this.deps.releaseHadMigrations === true,
    })
    if (decision.action === 'continue') return
    if (decision.action === 'unavailable') {
      log.error('post-update crash loop; rollback unavailable', { why: decision.why })
      this.snap = { ...this.snap, phase: 'degraded' }
      this.publish()
      return
    }
    await this.rollback()
  }

  /** Restore `.old`, restart children on it, clear post-update arming. */
  async rollback(): Promise<void> {
    this.snap = { ...this.snap, phase: 'rolling_back' }
    this.publish()
    log.warn('rolling back to .old bundle after post-update crash loop')
    await this.stopChildren()
    restoreOldBundle(this.installDir)
    this.snap = clearPostUpdate(emptyParentSnapshot('booting'))
    this.publish()
    for (const child of this.childOrder) {
      await this.spawnChild(child)
    }
    this.snap = { ...this.snap, phase: 'running' }
    this.publish()
  }

  /**
   * Self-handover: spawn a new parent from the install path, wait until it is
   * healthy on the expected version, re-declare MAINPID, then exit.
   */
  async handover(expectedVersion: string): Promise<void> {
    this.snap = beginHandoverOutgoing(markPostUpdate(this.snap, this.deps.now()), expectedVersion)
    this.publish()

    const { command, args } = installInvocation('parent', {
      installBinary: this.installBinary,
      port: this.deps.port,
      env: this.env,
    })
    const childEnv: NodeJS.ProcessEnv = {
      ...this.env,
      PODIUM_PORT: String(this.deps.port),
      PODIUM_HOME: this.installDir,
      [PARENT_HANDOVER_EXPECTED_VERSION_ENV]: expectedVersion,
      [PARENT_POST_UPDATE_ENV]: '1',
    }
    // Successor inherits NOTIFY_SOCKET so it can READY + MAINPID under the same unit.

    log.info('spawning successor parent', { command, args, expectedVersion })
    const successor = this.deps.spawn(command, args, {
      env: childEnv,
      stdio: 'inherit',
      detached: true,
    })
    successor.unref?.()
    const successorPid = successor.pid
    if (!successorPid) throw new Error('handover failed: successor parent spawned without a pid')

    this.deps.reportSuccessorPid?.(successorPid)
    // nginx-reload pattern: declare the new main PID before we exit.
    this.deps.notify(`MAINPID=${successorPid}`)

    const deadline = this.deps.now() + 90_000
    while (this.deps.now() < deadline) {
      const probe = await this.deps.probeHealth(this.deps.port)
      if (isHandoverHealthy(probe, expectedVersion)) {
        pruneOldBundle(this.installDir)
        clearHandoverRequest()
        this.stopping = true
        // Successor owns children; do not SIGTERM them — just exit.
        this.childProcs.clear()
        log.info('handover complete; old parent exiting', { successorPid, expectedVersion })
        process.exit(0)
        return
      }
      await this.deps.sleep(250)
    }
    throw new Error(
      `handover timed out waiting for healthy successor (expected version ${expectedVersion})`,
    )
  }

  private async stopChildren(): Promise<void> {
    this.stopping = true
    for (const child of [...this.childOrder].reverse()) {
      const proc = this.childProcs.get(child)
      if (!proc || proc.exitCode !== null) continue
      proc.kill('SIGTERM')
    }
    const deadline = this.deps.now() + 5_000
    while (this.deps.now() < deadline && this.childProcs.size > 0) {
      await this.deps.sleep(50)
    }
    for (const proc of this.childProcs.values()) {
      if (proc.exitCode === null) proc.kill('SIGKILL')
    }
    this.childProcs.clear()
    this.stopping = false
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer)
    await this.stopChildren()
    this.snap = { ...this.snap, phase: 'stopping' }
    this.publish()
  }
}
