/**
 * Process-driving loop for the thin parent: spawn children from the install
 * path, restart on crash, park on refusal, run self-handover, roll back when
 * allowed. [POD-2505]
 *
 * THREE INVARIANTS THIS FILE EXISTS TO HOLD, each of which was broken in the
 * first cut and is now pinned by a real-process test:
 *
 *  1. NO ORPHANS, EVER, INCLUDING DURING BOOT. Termination signals are handled
 *     from before the first child is spawned until after the last one is reaped.
 *     `registerProcess` installs a SIGTERM listener of its own that only unlinks
 *     a pidfile — and a listener EXISTING is what suppresses the default
 *     terminate action. So a parent that installed its real handler after boot
 *     did not die on SIGTERM, it IGNORED it, was SIGKILLed by whoever was
 *     waiting, and SIGKILL cannot run `stopChildren()`. Server and daemon were
 *     re-parented to init, still holding the port and the SQLite file.
 *  2. THE OLD PARENT OWNS THE EXIT DECISION. The successor never reclaims its
 *     predecessor. This parent spawns the successor, watches it over HTTP, and
 *     exits only once the successor is serving the new version with its daemon
 *     connected. If the successor never gets there, this parent kills it,
 *     restores its own children and keeps serving the OLD version.
 *  3. THE SUPERVISION LOOP HOLDS THE PROCESS OPEN. The tick is NOT `unref`'d.
 *     An unref'd interval plus signal listeners does not keep Bun alive, so the
 *     parent drained and exited the moment its last child died — which is
 *     precisely the crash the backoff ladder and the rollback exist for.
 */
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@podium/logger'
import { resolveInstallDir } from './config'
import {
  clearParentRequest,
  PARENT_HANDOVER_SIGNAL,
  type ParentRequest,
  readParentRequest,
  writeParentResult,
} from './parent-control'
import {
  applyChildExit,
  applyChildRunning,
  beginHandoverOutgoing,
  CHILD_START_ORDER,
  clearPostUpdate,
  componentsProjection,
  emptyParentSnapshot,
  isHandoverHealthy,
  isPostUpdateCrashLoop,
  markPostUpdate,
  type HandoverHealthProbe,
  type ParentSnapshot,
  type SupervisedChild,
  type WatchdogAdvance,
  rollbackDecision,
  watchdogPetDecision,
} from './parent-supervisor'
import { parseUpdateTarget, type ParentUpdateSwapResult } from './parent-update-swap'
import { logDir } from './run-registry'
import { sdNotify, watchdogPetIntervalMs } from './sd-notify'
import { oldBundlePresent, pruneOldBundle, restoreOldBundle } from './update-install'

const log = createLogger('runtime:parent')

export const PARENT_SUCCESSOR_PID_ENV = 'PODIUM_PARENT_SUCCESSOR_PID'
export const PARENT_HANDOVER_EXPECTED_VERSION_ENV = 'PODIUM_HANDOVER_EXPECTED_VERSION'
export const PARENT_POST_UPDATE_ENV = 'PODIUM_PARENT_POST_UPDATE'
/**
 * Set on a successor parent. The successor MUST NOT reclaim the pidfile: doing
 * so SIGTERMs its own predecessor, whose shutdown then takes down the healthy
 * children the successor was about to replace. See invariant 2.
 */
export const PARENT_SUCCESSOR_ENV = 'PODIUM_PARENT_SUCCESSOR'

/** Termination signals the parent handles itself, from before the first spawn. */
const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

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
  /**
   * Schema-gate + verified fetch + swap + VERSION re-read, run HERE rather than
   * in the server (disposition 11). Wired by the composition root.
   */
  performUpdateSwap?: (
    target: unknown,
    opts: { pinnedPubkey?: string },
  ) => Promise<ParentUpdateSwapResult>
  /**
   * Claim the `parent` role in the run registry. Called once the boot health
   * gate has passed, so a successor never overwrites (or reclaims) the record of
   * a predecessor that is still supervising a serving stack.
   */
  claimRole?: () => Promise<void> | void
  /** Called on the way out so the composition root can flush its own logging. */
  onExit?: (code: number) => Promise<void> | void
  /** Test seam; production terminates the process. */
  exit?: (code: number) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onSnapshot?: (snap: ParentSnapshot) => void
  /** How long a component may claim to be running without advancing (watchdog). */
  componentWedgedMs?: number
  /** Watchdog pet cadence. Default: half of WATCHDOG_USEC, per systemd's margin. */
  watchdogPetMs?: number
}

function defaultInstallBinary(installDir: string, env: NodeJS.ProcessEnv): string {
  const named = join(installDir, 'podium')
  if (existsSync(named)) return named
  // Source / test fallback: the running binary, still invoked with install-dir env.
  return env.PODIUM_PARENT_BIN || process.execPath
}

function childArgs(child: SupervisedChild): string[] {
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
  const extra = role === 'parent' ? ['parent', '--takeover'] : childArgs(role)
  const cli = opts.env.PODIUM_PARENT_CLI
  if (cli) {
    return {
      command: opts.installBinary,
      args: ['--conditions=@podium/source', cli, ...extra],
    }
  }
  return { command: opts.installBinary, args: extra }
}

/**
 * The default probe: the server's own `GET /version`.
 *
 * `daemonConnected` comes from the server's `daemonConnected` field, which the
 * server computes for THIS HOST's machine id. The older reading of
 * `components.daemon` as a bare string is gone: the server emits an object
 * (`{state: 'connected'}`), so that branch was dead and the declared type lied.
 */
async function defaultProbeHealth(port: number): Promise<HandoverHealthProbe> {
  const down: HandoverHealthProbe = {
    serverRunning: false,
    serverVersion: null,
    daemonConnected: false,
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/version`)
    if (!res.ok) return down
    const body = (await res.json()) as {
      appVersion?: string
      daemonConnected?: boolean
      components?: {
        daemon?: { state?: string }
        janitor?: { state?: string; progressVersion?: number }
      }
    }
    const janitorState = body.components?.janitor?.state
    return {
      serverRunning: true,
      serverVersion: body.appVersion ?? null,
      daemonConnected:
        body.daemonConnected === true || body.components?.daemon?.state === 'connected',
      ...(janitorState === 'running' || janitorState === 'degraded' || janitorState === 'stopped'
        ? {
            janitor: {
              state: janitorState,
              ...(typeof body.components?.janitor?.progressVersion === 'number'
                ? { progressVersion: body.components.janitor.progressVersion }
                : {}),
            },
          }
        : {}),
    }
  } catch {
    return down
  }
}

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms))

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
  /** True while children are being torn down on purpose (stop / rollback). */
  private stopping = false
  /** Latches once a termination signal has been accepted; never unlatches. */
  private terminating = false
  private tickTimer: ReturnType<typeof setInterval> | undefined
  private handoverInFlight: Promise<void> | undefined
  private successor: ChildProcess | undefined
  private signalsInstalled = false
  private readonly installedHandlers: Array<[NodeJS.Signals, () => void]> = []
  private mainPidDeclared = false
  private advance: WatchdogAdvance = {}
  private lastPetMs = 0
  private readonly petIntervalMs: number

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
    this.petIntervalMs = deps.watchdogPetMs ?? watchdogPetIntervalMs(this.env.WATCHDOG_USEC)
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

  /** True when this process was spawned as another parent's successor. */
  isSuccessor(): boolean {
    return this.env[PARENT_SUCCESSOR_ENV] === '1'
  }

  private publish(): void {
    this.deps.onSnapshot?.(this.snap)
  }

  /**
   * Install every signal handler this process needs. Idempotent, and safe to
   * call BEFORE `start()` — the composition root does exactly that so the
   * unhandled window does not even span the dynamic imports between claiming the
   * role and spawning the first child (invariant 1).
   */
  installSignalHandlers(): void {
    if (this.signalsInstalled) return
    this.signalsInstalled = true
    for (const sig of TERMINATION_SIGNALS) {
      const handler = (): void => {
        void this.onTerminationSignal(sig)
      }
      this.installedHandlers.push([sig, handler])
      process.on(sig, handler)
    }
    const handover = (): void => {
      void this.onHandoverSignal()
    }
    this.installedHandlers.push([PARENT_HANDOVER_SIGNAL, handover])
    process.on(PARENT_HANDOVER_SIGNAL, handover)
  }

  /** Detach the handlers again. For tests, which share one process across cases. */
  removeSignalHandlers(): void {
    for (const [sig, handler] of this.installedHandlers.splice(0)) {
      process.removeListener(sig, handler)
    }
    this.signalsInstalled = false
  }

  /**
   * A termination signal, at ANY point in the lifecycle.
   *
   * A second signal while the first is still draining means "you are taking too
   * long": children are SIGKILLed and we exit immediately. That is still strictly
   * better than being SIGKILLed ourselves, which cannot reap anything.
   */
  private async onTerminationSignal(sig: NodeJS.Signals): Promise<void> {
    if (this.terminating) {
      log.warn('second termination signal — killing children now', { sig })
      for (const proc of this.childProcs.values()) proc.kill('SIGKILL')
      this.successor?.kill('SIGKILL')
      if (this.deps.exit) this.deps.exit(0)
      else process.exit(0)
      return
    }
    this.terminating = true
    log.info('parent shutting down', { sig, phase: this.snap.phase })
    // A handover in flight is abandoned rather than completed: whoever is
    // stopping us wants this unit DOWN, and leaving a half-adopted successor
    // behind would be a second supervisor nobody asked for.
    if (this.successor) {
      log.warn('abandoning in-flight handover — terminating successor', {
        successorPid: this.successor.pid,
      })
      this.successor.kill('SIGTERM')
    }
    await this.stop()
    await this.deps.onExit?.(0)
    if (this.deps.exit) this.deps.exit(0)
    else process.exit(0)
  }

  private async onHandoverSignal(): Promise<void> {
    if (this.handoverInFlight) return
    const request = readParentRequest()
    if (!request) {
      log.warn('parent signalled but no request file present')
      return
    }
    this.handoverInFlight = (async () => {
      try {
        if (request.kind === 'swap') {
          await this.runSwapRequest(request)
          return
        }
        clearParentRequest()
        await this.handover(request.expectedVersion)
      } catch (error) {
        log.error('parent request failed', { kind: request.kind, err: error })
        clearParentRequest()
      } finally {
        this.handoverInFlight = undefined
      }
    })()
    await this.handoverInFlight
  }

  /**
   * Run a `swap` request and ANSWER it. The asking server is still alive and its
   * `server` step is blocked on the result, so a failure here must come back as a
   * sentence rather than as silence.
   */
  private async runSwapRequest(request: ParentRequest): Promise<void> {
    const answer = (result: {
      ok: boolean
      error?: string
      releaseHadMigrations?: boolean
    }): void => {
      writeParentResult({
        requestId: request.requestId,
        kind: request.kind,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        ...(result.releaseHadMigrations !== undefined
          ? { releaseHadMigrations: result.releaseHadMigrations }
          : {}),
        completedAt: new Date(this.deps.now()).toISOString(),
      })
      clearParentRequest()
    }
    try {
      if (!this.deps.performUpdateSwap) {
        throw new Error('this parent was started without an update-swap capability')
      }
      if (!request.target) throw new Error('swap request carried no update target')
      // Parse here so a malformed target fails as a swap error, not a crash.
      const target = parseUpdateTarget(request.target)
      const result = await this.deps.performUpdateSwap(target, {
        ...(request.pinnedPubkey ? { pinnedPubkey: request.pinnedPubkey } : {}),
      })
      this.deps.releaseHadMigrations = result.releaseHadMigrations
      log.info('parent completed update swap', {
        version: result.version,
        swapped: result.swapped,
        releaseHadMigrations: result.releaseHadMigrations,
      })
      answer({ ok: true, releaseHadMigrations: result.releaseHadMigrations })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('parent update swap failed', { err: error })
      answer({ ok: false, error: message })
    }
  }

  /** Boot children in priority order and signal READY once the health gate passes. */
  async start(): Promise<void> {
    // BEFORE the first spawn. See invariant 1.
    this.installSignalHandlers()
    for (const child of this.childOrder) {
      if (this.terminating) return
      await this.spawnChild(child)
    }
    const expected =
      this.snap.expectedVersion ??
      this.env.PODIUM_APP_VERSION ??
      (await this.readInstalledVersion())
    const healthy = await this.waitForHealthy(expected, 60_000)
    if (this.terminating) return
    if (!healthy) {
      log.error('parent boot health gate failed', { expected })
    }
    this.snap = {
      ...this.snap,
      phase: Object.keys(this.snap.refusals).length > 0 ? 'degraded' : 'running',
    }
    this.publish()
    // Only now does this process own the `parent` role: a successor that claimed
    // it at spawn time would have reclaimed — that is, SIGTERMed — the parent
    // still supervising the serving stack.
    await this.deps.claimRole?.()
    this.deps.notify('READY=1')
    // First pet immediately, so a stall right after boot has the full
    // WatchdogSec budget rather than that minus one pet interval.
    this.deps.notify('WATCHDOG=1')
    this.lastPetMs = this.deps.now()
    // NOT unref'd — the supervision loop is what keeps this process alive when no
    // child does. See invariant 3.
    this.tickTimer = setInterval(() => {
      void this.tick()
    }, 500)
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
      if (this.terminating) return false
      const probe = await this.deps.probeHealth(this.deps.port)
      const versionOk =
        expectedVersion === 'dev' || !expectedVersion || probe.serverVersion === expectedVersion
      const ok = wantsDaemon
        ? isHandoverHealthy(probe, expectedVersion) ||
          (expectedVersion === 'dev' && probe.serverRunning && probe.daemonConnected)
        : probe.serverRunning && versionOk
      if (ok) return true
      await this.deps.sleep(200)
    }
    return false
  }

  /**
   * Where a child's raw stdout/stderr goes.
   *
   * `inherit` under systemd (journald is the sink) and on a TTY (a foreground
   * `podium parent` should print). Otherwise per-role files, because under
   * detached persistence the parent's own stdout is `logs/parent.log`, and
   * inheriting it put server and daemon output there while `podium logs server`
   * tailed an empty `logs/server.log`.
   */
  private childStdio(child: SupervisedChild): SpawnOptions['stdio'] {
    if (this.env.NOTIFY_SOCKET || process.stdout.isTTY) return 'inherit'
    try {
      mkdirSync(logDir(), { recursive: true })
      const fd = openSync(join(logDir(), `${child}.log`), 'a')
      return ['ignore', fd, fd]
    } catch {
      return 'inherit'
    }
  }

  private async spawnChild(child: SupervisedChild): Promise<void> {
    if (this.stopping || this.terminating) return
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
    // Nor the handover markers: a child is not a successor parent.
    delete childEnv[PARENT_SUCCESSOR_ENV]
    delete childEnv[PARENT_HANDOVER_EXPECTED_VERSION_ENV]
    delete childEnv[PARENT_POST_UPDATE_ENV]

    log.info('spawning child', { child, command, args })
    const proc = this.deps.spawn(command, args, {
      env: childEnv,
      stdio: this.childStdio(child),
    })
    this.childProcs.set(child, proc)
    if (proc.pid) {
      this.snap = applyChildRunning(this.snap, child, proc.pid)
      this.publish()
    }
    proc.once('exit', (code, signal) => {
      this.childProcs.delete(child)
      if (this.stopping || this.terminating) return
      // Outgoing handover: the successor reclaims children via --takeover. Do not
      // treat those exits as crashes or schedule restarts that race the new parent.
      if (this.snap.phase === 'handover_outgoing') return
      this.snap = applyChildExit(this.snap, child, {
        exitCode: code,
        signal,
        nowMs: this.deps.now(),
      })
      this.publish()
      log.warn('supervised child exited', {
        child,
        code,
        signal,
        state: this.snap.children[child].status,
      })
      void this.considerRollback()
    })
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.terminating) return
    await this.pollComponents()
    this.petWatchdog()
    if (this.snap.phase === 'handover_outgoing' || this.snap.phase === 'rolling_back') return
    const now = this.deps.now()
    for (const child of this.childOrder) {
      const state = this.snap.children[child]
      if (state.status !== 'restarting') continue
      if (state.nextAtMs > now) continue
      await this.spawnChild(child)
    }
  }

  /**
   * Pet the systemd watchdog — unless a component says it is RUNNING while its
   * progress token has been frozen long enough to call it wedged (§8, gap 9).
   * A stopped or degraded component always pets: degraded never bubbles.
   */
  private petWatchdog(): void {
    // ON THE WATCHDOG'S CADENCE, NOT THE SUPERVISION TICK'S. `sdNotify` shells
    // out to `systemd-notify`, so petting on every 500 ms tick forks two
    // processes a second for the life of the parent, ~90× more often than
    // WatchdogSec asks for. Half the window is systemd's own recommended margin.
    const now = this.deps.now()
    if (now - this.lastPetMs < this.petIntervalMs) return
    this.lastPetMs = now
    const decision = watchdogPetDecision({
      ...(this.lastProbeJanitor ? { janitor: this.lastProbeJanitor } : {}),
      advance: this.advance,
      nowMs: this.deps.now(),
      ...(this.deps.componentWedgedMs !== undefined
        ? { wedgedAfterMs: this.deps.componentWedgedMs }
        : {}),
    })
    this.advance = decision.advance
    if (decision.wedged) {
      log.error('withholding watchdog pet — a component is running but not advancing', {
        janitor: this.lastProbeJanitor,
      })
      return
    }
    if (decision.pet) this.deps.notify('WATCHDOG=1')
  }

  private lastProbeJanitor: HandoverHealthProbe['janitor']

  /**
   * Refresh the component-advance signal the watchdog rule reads. Runs on the
   * supervision loop at a much slower cadence than the tick — one HTTP call per
   * 500 ms tick would be a self-inflicted load.
   */
  private lastComponentPollMs = 0
  private async pollComponents(): Promise<void> {
    const now = this.deps.now()
    if (now - this.lastComponentPollMs < 15_000) return
    this.lastComponentPollMs = now
    const probe = await this.deps.probeHealth(this.deps.port)
    this.lastProbeJanitor = probe.janitor
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
   *
   * The successor is spawned DETACHED (its own process group) so a signal aimed
   * at this parent's group cannot hit it, and it is NOT given the `parent` role
   * to claim until its own health gate passes — see invariant 2. MAINPID is
   * declared only after the gate: declaring it up front pointed systemd at a
   * process that might never become healthy, and nothing ever pointed it back.
   */
  async handover(expectedVersion: string): Promise<void> {
    const priorPhase = this.snap.phase
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
      [PARENT_SUCCESSOR_ENV]: '1',
      [PARENT_HANDOVER_EXPECTED_VERSION_ENV]: expectedVersion,
      [PARENT_POST_UPDATE_ENV]: '1',
    }
    // Successor inherits NOTIFY_SOCKET so it can READY + MAINPID under the same unit.

    log.info('spawning successor parent', { command, args, expectedVersion })
    const successor = this.deps.spawn(command, args, {
      env: childEnv,
      stdio: this.childStdio('server') === 'inherit' ? 'inherit' : 'ignore',
      detached: true,
    })
    this.successor = successor
    successor.unref?.()
    const successorPid = successor.pid
    if (!successorPid) {
      this.successor = undefined
      this.abandonHandover(priorPhase)
      throw new Error('handover failed: successor parent spawned without a pid')
    }
    this.deps.reportSuccessorPid?.(successorPid)

    const deadline = this.deps.now() + 90_000
    while (this.deps.now() < deadline) {
      if (this.terminating) return
      const probe = await this.deps.probeHealth(this.deps.port)
      if (isHandoverHealthy(probe, expectedVersion)) {
        // The gate has passed: NOW tell systemd where its main process moved.
        // nginx-reload pattern, but strictly after health, never before.
        this.deps.notify(`MAINPID=${successorPid}`)
        this.mainPidDeclared = true
        pruneOldBundle(this.installDir)
        clearParentRequest()
        this.stopping = true
        if (this.tickTimer) clearInterval(this.tickTimer)
        // Successor owns children; do not SIGTERM them — just exit.
        this.childProcs.clear()
        this.successor = undefined
        log.info('handover complete; old parent exiting', { successorPid, expectedVersion })
        await this.deps.onExit?.(0)
        if (this.deps.exit) this.deps.exit(0)
    else process.exit(0)
        return
      }
      await this.deps.sleep(250)
    }
    await this.abortHandover(successor, expectedVersion, priorPhase)
    throw new Error(
      `handover timed out waiting for healthy successor (expected version ${expectedVersion})`,
    )
  }

  /**
   * The successor never got healthy. Kill it, take supervision back, and restore
   * whatever it reclaimed on its way through — this parent is still the one that
   * has to keep the machine serving, on the OLD version if that is what works.
   */
  private async abortHandover(
    successor: ChildProcess,
    expectedVersion: string,
    priorPhase: ParentSnapshot['phase'],
  ): Promise<void> {
    log.error('handover failed — reclaiming supervision on the previous version', {
      successorPid: successor.pid,
      expectedVersion,
    })
    try {
      successor.kill('SIGTERM')
      const deadline = this.deps.now() + 5_000
      while (this.deps.now() < deadline && successor.exitCode === null) {
        await this.deps.sleep(100)
      }
      if (successor.exitCode === null) successor.kill('SIGKILL')
    } catch {
      /* the successor may already be gone */
    }
    this.successor = undefined
    if (this.mainPidDeclared) {
      this.deps.notify(`MAINPID=${process.pid}`)
      this.mainPidDeclared = false
    }
    this.abandonHandover(priorPhase)
    // Whatever the successor reclaimed is not running under anybody now.
    for (const child of this.childOrder) {
      if (this.childProcs.has(child)) continue
      await this.spawnChild(child)
    }
  }

  /** Leave `handover_outgoing` so the tick and the exit handler work again. */
  private abandonHandover(priorPhase: ParentSnapshot['phase']): void {
    const phase =
      Object.keys(this.snap.refusals).length > 0
        ? 'degraded'
        : priorPhase === 'handover_outgoing' || priorPhase === 'handover_incoming'
          ? 'running'
          : priorPhase
    this.snap = clearPostUpdate({ ...this.snap, phase })
    this.publish()
  }

  private async stopChildren(): Promise<void> {
    const wasStopping = this.stopping
    this.stopping = true
    for (const child of [...this.childOrder].reverse()) {
      const proc = this.childProcs.get(child)
      if (!proc || proc.exitCode !== null) continue
      try {
        proc.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    const deadline = this.deps.now() + 5_000
    while (this.deps.now() < deadline && this.childProcs.size > 0) {
      await this.deps.sleep(50)
    }
    for (const proc of this.childProcs.values()) {
      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
    this.childProcs.clear()
    this.stopping = wasStopping
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = undefined
    }
    this.stopping = true
    await this.stopChildren()
    this.stopping = true
    this.snap = { ...this.snap, phase: 'stopping' }
    this.publish()
  }

  /** Components projection for `/version` and the desktop shell. */
  components(): ReturnType<typeof componentsProjection> {
    return componentsProjection(this.snap)
  }
}
