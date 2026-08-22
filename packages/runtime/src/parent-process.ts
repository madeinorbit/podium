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
 *     connected. If the successor never gets there, this parent kills it and
 *     takes supervision back — restoring the `.old` bundle first when decision 4
 *     allows it, because the children would otherwise come back on the very
 *     release that just failed to boot. See `abortHandover`.
 *  3. THE SUPERVISION LOOP HOLDS THE PROCESS OPEN. The tick is NOT `unref`'d.
 *     An unref'd interval plus signal listeners does not keep Bun alive, so the
 *     parent drained and exited the moment its last child died — which is
 *     precisely the crash the backoff ladder and the rollback exist for.
 */
import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@podium/logger'
import { resolveInstallDir } from './config'
import { readConnectivity } from './connectivity'
import {
  clearParentRequest,
  PARENT_HANDOVER_SIGNAL,
  type ParentRequest,
  readParentRequest,
  writeParentOutcome,
  writeParentResult,
} from './parent-control'
import {
  applyChildExit,
  applyChildRunning,
  beginHandoverOutgoing,
  CHILD_START_ORDER,
  clearPostUpdate,
  componentsProjection,
  type DaemonHandoverHealthProbe,
  emptyParentSnapshot,
  type HandoverHealthProbe,
  isDaemonHandoverHealthy,
  isHandoverHealthy,
  isPostUpdateCrashLoop,
  markPostUpdate,
  markRollbackUnavailable,
  type ParentSnapshot,
  rollbackDecision,
  type SupervisedChild,
  type WatchdogAdvance,
  watchdogPetDecision,
} from './parent-supervisor'
import { type ParentUpdateSwapResult, parseUpdateTarget } from './parent-update-swap'
import { liveRecord, logDir } from './run-registry'
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
/**
 * `1` / `0`: did the release now on disk carry migrations this database had not
 * applied?
 *
 * ONLY THE PARENT THAT RAN THE SWAP CAN ANSWER THAT — it is the process that
 * compared the target's declared migrations against the live ledger — and that
 * parent EXITS at the end of a successful handover. The successor is then the
 * only process that can observe a post-update crash loop, so the fact has to
 * travel with it. Without this, the successor read `undefined`, took it for
 * `false`, and would roll a migrating release back: exactly what decision 4
 * exists to forbid (re-review R1).
 */
export const PARENT_RELEASE_MIGRATIONS_ENV = 'PODIUM_PARENT_RELEASE_MIGRATIONS'

/** Termination signals the parent handles itself, from before the first spawn. */
const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

export type SpawnChildFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export type HealthProbeFn = (port: number) => Promise<HandoverHealthProbe>
export type DaemonHealthProbeFn = () => Promise<DaemonHandoverHealthProbe>

export interface ParentProcessDeps {
  installDir?: string
  /**
   * Where `run/` lives. Distinct from `installDir`: a rollback RENAMES the
   * install directory, so the control files must not be inside it. Defaults to
   * this instance's state dir.
   */
  stateDir?: string
  /** Override the install binary used for children AND successor parents. */
  installBinary?: string
  port: number
  /** Which OS children to supervise. Default: server then daemon. */
  children?: readonly SupervisedChild[]
  env?: NodeJS.ProcessEnv
  spawn?: SpawnChildFn
  /** Probe used for boot readiness and handover health (disposition 24). */
  probeHealth?: HealthProbeFn
  /** Daemon-only readiness proof from the remote connection + boot reconciliation record. */
  probeDaemonHealth?: DaemonHealthProbeFn
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
  /**
   * How long a successor gets to become healthy before the handover is aborted.
   * Default 90s. Injectable so a real-process test can drive the ABORT path
   * (rollback, reporting, respawn) instead of only asserting what holds while
   * the gate is still open — the gap the re-review called R8.
   */
  handoverTimeoutMs?: number
}

function defaultInstallBinary(installDir: string, env: NodeJS.ProcessEnv): string {
  const named = join(installDir, 'podium')
  if (existsSync(named)) return named
  // Source / test fallback: the running binary, still invoked with install-dir env.
  return env.PODIUM_PARENT_BIN || process.execPath
}

function childArgs(child: SupervisedChild, localDaemon: boolean): string[] {
  if (child === 'server') return ['server', '--takeover']
  return ['daemon', ...(localDaemon ? ['--local'] : []), '--takeover']
}

/**
 * Resolve how to invoke a component from the install path.
 * Compiled install: `<installDir>/podium <role> …`
 * Source checkout tests may point PODIUM_PARENT_BIN at `bun` and pass the CLI
 * via PODIUM_PARENT_CLI.
 */
export function installInvocation(
  role: SupervisedChild | 'parent',
  opts: {
    installBinary: string
    port: number
    env: NodeJS.ProcessEnv
    /** A co-located server authenticates its daemon with the local secret. A daemon-only
     *  fleet member must instead read the pair code / machine token from its config. */
    localDaemon?: boolean
  },
): { command: string; args: string[] } {
  const extra =
    role === 'parent' ? ['parent', '--takeover'] : childArgs(role, opts.localDaemon ?? true)
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

async function defaultProbeDaemonHealth(): Promise<DaemonHandoverHealthProbe> {
  const connectivity = readConnectivity()
  const daemon = liveRecord('daemon')
  const isCurrentProcess =
    connectivity?.processId !== undefined && connectivity.processId === daemon?.pid
  return {
    connected: isCurrentProcess && connectivity?.state === 'connected',
    appVersion: isCurrentProcess ? (connectivity?.appVersion ?? null) : null,
    convergedVersion: isCurrentProcess ? (connectivity?.convergedVersion ?? null) : null,
  }
}

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms))

export class ParentProcess {
  private snap: ParentSnapshot
  private readonly childProcs = new Map<SupervisedChild, ChildProcess>()
  private readonly childOrder: readonly SupervisedChild[]
  private readonly deps: Required<
    Pick<
      ParentProcessDeps,
      'port' | 'spawn' | 'probeHealth' | 'probeDaemonHealth' | 'notify' | 'now' | 'sleep'
    >
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
  private bootHealthy = false

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
      probeDaemonHealth: deps.probeDaemonHealth ?? defaultProbeDaemonHealth,
      notify: deps.notify ?? sdNotify,
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? sleep,
    }
    this.petIntervalMs = deps.watchdogPetMs ?? watchdogPetIntervalMs(this.env.WATCHDOG_USEC)
    // Inherited from the predecessor that ran the swap. An explicit dep wins:
    // the composition root may know better, and a test must be able to say so.
    if (deps.releaseHadMigrations === undefined) {
      const carried = this.env[PARENT_RELEASE_MIGRATIONS_ENV]
      if (carried === '1' || carried === '0') this.deps.releaseHadMigrations = carried === '1'
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

  /** True when the boot health gate (disposition 24) passed. */
  isBootHealthy(): boolean {
    return this.bootHealthy
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
        // A remote packaged daemon performs its own artifact swap, so this old
        // parent did not run `runSwapRequest` and cannot learn the migration
        // fact anywhere else. Preserve UNKNOWN: only an explicit publisher-
        // proved boolean is allowed to arm automatic rollback.
        if (request.releaseHadMigrations !== undefined) {
          this.deps.releaseHadMigrations = request.releaseHadMigrations
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
      answer({
        ok: true,
        ...(result.releaseHadMigrations !== undefined
          ? { releaseHadMigrations: result.releaseHadMigrations }
          : {}),
      })
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
    this.bootHealthy = healthy
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
    this.pruneStaleOldBundle(healthy)
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

  /**
   * Drop a `.old` bundle left behind by something that had no parent to prune it
   * — the standalone `podium update` path, which retains the backup and has
   * nobody to declare the new bundle healthy (review finding 17). Only on a
   * HEALTHY, non-post-update boot: inside the post-update window `.old` is the
   * rollback target and the outgoing parent prunes it after its own gate.
   */
  private pruneStaleOldBundle(healthy: boolean): void {
    if (!healthy) return
    if (this.snap.postUpdateSinceMs !== undefined) return
    if (!oldBundlePresent(this.installDir)) return
    log.info('pruning a .old bundle left by an unsupervised install', {
      installDir: this.installDir,
    })
    pruneOldBundle(this.installDir)
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
    const wantsServer = this.childOrder.includes('server')
    while (this.deps.now() < deadline) {
      if (this.terminating) return false
      if (!wantsServer && wantsDaemon) {
        const probe = await this.deps.probeDaemonHealth()
        const versionOk =
          expectedVersion === 'dev' || !expectedVersion || probe.appVersion === expectedVersion
        const ok =
          this.snap.phase === 'handover_incoming'
            ? isDaemonHandoverHealthy(probe, expectedVersion)
            : probe.connected && versionOk
        if (ok) return true
        await this.deps.sleep(200)
        continue
      }
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
      // A parent with no server is a joined fleet member. `--local` there would
      // manufacture a host secret the remote source has never seen and turn a
      // legitimate pair code into `peerHelloRejected auth-failed`.
      localDaemon: this.childOrder.includes('server'),
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
    delete childEnv[PARENT_RELEASE_MIGRATIONS_ENV]

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
      releaseHadMigrations: this.deps.releaseHadMigrations,
    })
    if (decision.action === 'continue') return
    if (decision.action === 'unavailable') {
      this.reportRollbackUnavailable(
        decision.why,
        'the children kept crashing after the update was installed',
      )
      return
    }
    await this.rollback('the children kept crashing after the update was installed')
  }

  /**
   * Say WHY the machine is stuck on a release it cannot undo (decision 4).
   *
   * Logging alone is not a report: nothing reads the parent's journal, and the
   * process that would have told the user died with the update. The note goes on
   * disk for the next server to boot, which folds it into the update operation
   * it adopts — see {@link writeParentOutcome}.
   */
  private reportRollbackUnavailable(why: string, because: string): void {
    log.error('rollback unavailable', { why, because })
    this.snap = markRollbackUnavailable(this.snap, why)
    this.publish()
    try {
      writeParentOutcome(
        {
          at: new Date(this.deps.now()).toISOString(),
          outcome: 'rollback-unavailable',
          why: `${why} (${because})`,
        },
        this.deps.stateDir,
      )
    } catch (error) {
      log.error('could not write the parent outcome report', { err: error })
    }
  }

  /** Restore `.old`, restart children on it, clear post-update arming, report. */
  async rollback(because = 'a post-update crash loop'): Promise<void> {
    this.snap = { ...this.snap, phase: 'rolling_back' }
    this.publish()
    log.warn('rolling back to .old bundle', { because })
    await this.stopChildren()
    restoreOldBundle(this.installDir)
    const restored = await this.readInstalledVersion()
    this.snap = clearPostUpdate(emptyParentSnapshot('booting'))
    this.publish()
    try {
      writeParentOutcome(
        {
          at: new Date(this.deps.now()).toISOString(),
          outcome: 'rolled-back',
          why: `the update was rolled back because ${because}; the machine is running ${restored} again`,
          version: restored,
        },
        this.deps.stateDir,
      )
    } catch (error) {
      log.error('could not write the parent outcome report', { err: error })
    }
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
      // The migration fact travels WITH the successor, or the successor guesses
      // — and a guess here is a data-loss bug (R1). Omitted when this parent
      // does not know either, so the successor refuses rather than assuming.
      ...(this.deps.releaseHadMigrations !== undefined
        ? { [PARENT_RELEASE_MIGRATIONS_ENV]: this.deps.releaseHadMigrations ? '1' : '0' }
        : {}),
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

    const deadline = this.deps.now() + (this.deps.handoverTimeoutMs ?? 90_000)
    const wantsServer = this.childOrder.includes('server')
    while (this.deps.now() < deadline) {
      if (this.terminating) return
      const healthy = wantsServer
        ? isHandoverHealthy(await this.deps.probeHealth(this.deps.port), expectedVersion)
        : isDaemonHandoverHealthy(await this.deps.probeDaemonHealth(), expectedVersion)
      if (healthy) {
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
   * The successor never got healthy. Kill it, take supervision back, and put the
   * machine on a version that works.
   *
   * "THE VERSION THAT WORKS" IS NOT THE ONE ON DISK. The swap ran before the
   * handover was asked for, so the install path already holds the release the
   * successor just failed to boot; children respawned from it are respawned onto
   * the suspect bundle. The first cut did exactly that AND cleared the
   * post-update arming on the way, which meant the crash loop that followed
   * could never reach `considerRollback` — the rollback substrate was disarmed
   * on the one path it exists for (re-review R2).
   *
   * So a `.old` bundle on disk changes what an abort means. `.old` is retained
   * by the swap and pruned only once a successor has proved healthy, so its
   * presence says: an unproven release is installed and its predecessor is still
   * here. Then this is a release failure, and decision 4 decides —
   *   - no migrations: restore `.old` and come back on it, and report it;
   *   - migrations, or an unknown migration fact: the arming STAYS (so later
   *     crashes still reach `considerRollback`), the parent goes degraded, and
   *     it says why rather than sitting on a broken release silently.
   * With no `.old` there was no retained predecessor to go back to — a plain
   * handover, or one whose backup was already pruned — and the old behaviour is
   * right: drop the arming and take the children back.
   *
   * Rolling back on a failed handover is deliberately eager: a handover fails
   * because the successor could not serve for 90 seconds, and the cost of being
   * wrong is one re-download on the next attempt, against a machine left on a
   * release that has already failed to boot once.
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
    const because = `the successor parent never became healthy on ${expectedVersion}`
    const decision = oldBundlePresent(this.installDir)
      ? rollbackDecision({
          crashLoop: true,
          oldBundlePresent: true,
          releaseHadMigrations: this.deps.releaseHadMigrations,
        })
      : ({ action: 'continue' } as const)

    if (decision.action === 'rollback') {
      // Leave `handover_outgoing` first: `rollback()` respawns children, and
      // spawns are suppressed while a handover is nominally in flight.
      this.abandonHandover(priorPhase, { keepPostUpdate: true })
      await this.rollback(because)
      return
    }
    if (decision.action === 'unavailable') {
      this.abandonHandover(priorPhase, { keepPostUpdate: true })
      this.reportRollbackUnavailable(decision.why, because)
    } else {
      this.abandonHandover(priorPhase)
    }
    // Whatever the successor reclaimed is not running under anybody now.
    for (const child of this.childOrder) {
      if (this.childProcs.has(child)) continue
      await this.spawnChild(child)
    }
  }

  /**
   * Leave `handover_outgoing` so the tick and the exit handler work again.
   *
   * `keepPostUpdate` holds the rollback window open across an abort: the release
   * on disk is still unproven, so the crashes that follow are still post-update
   * crashes and must still be counted as such.
   */
  private abandonHandover(
    priorPhase: ParentSnapshot['phase'],
    opts: { keepPostUpdate?: boolean } = {},
  ): void {
    const phase =
      Object.keys(this.snap.refusals).length > 0
        ? 'degraded'
        : priorPhase === 'handover_outgoing' || priorPhase === 'handover_incoming'
          ? 'running'
          : priorPhase
    const next = { ...this.snap, phase }
    this.snap = opts.keepPostUpdate ? next : clearPostUpdate(next)
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
