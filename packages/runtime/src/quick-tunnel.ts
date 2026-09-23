/**
 * THE QUICK-TUNNEL WRAPPER: a supervised `cloudflared` whose rotating URL is
 * written into this box's config every time it changes (POD-4640).
 *
 * A Cloudflare QUICK tunnel mints a fresh `https://<random>.trycloudflare.com`
 * on every start. Before this, nothing told Podium the new one: config.json
 * kept the dead URL, the Connect publisher kept republishing it, and the
 * locator (POD-4533) faithfully handed that dead URL to every daemon that went
 * looking. The reader was right and the record was wrong. This is the writer.
 *
 * SHAPE. `podium tunnel run` is a long-running service that OWNS cloudflared as
 * its child: it starts it, reads the URL it prints, records that URL, restarts
 * it with backoff whenever it dies, and takes it down on shutdown. It is a
 * separate process from the server on purpose — a quick tunnel's URL only
 * changes when cloudflared restarts, so tying cloudflared to the SERVER would
 * mint a new URL (and strand the fleet for a moment) on every server restart
 * and every update. As its own service it survives both, exactly like the
 * cloudflared an operator used to leave running in tmux.
 *
 * OPT-IN, NEVER AUTOMATIC. The design rule is "never auto-run a tunnel"
 * (docs/internal/superpowers/specs/2026-06-30-distribution-onboarding-design.md).
 * Nothing in setup, install or the parent starts this; the operator runs
 * `podium tunnel run` or `podium tunnel enable`, and {@link quickTunnelPreflight}
 * refuses unless they already chose the cloudflare-tunnel reachability option.
 *
 * The pieces are separate so each can be tested without a real cloudflared:
 * {@link parseQuickTunnelUrl} (what it printed), {@link QuickTunnelSupervisor}
 * (the lifecycle, over an injected process), {@link recordQuickTunnelUrl} (the
 * config write), {@link acquireTunnelLock} (one wrapper, and no orphan from a
 * wrapper that died hard) and {@link spawnCloudflared} (the real process).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type EnvSource,
  LAYERED_ENV,
  loadConfig,
  type PodiumConfig,
  resolveLocalServerHost,
  resolveSetting,
} from './config'
import {
  defaultInstanceGuardIo,
  holderIsLive,
  identityIsVerifiable,
  type InstanceGuardIo,
  type ProcessIdentityTriple,
  selfIdentityTriple,
} from './instance-guard'
import { runDir } from './run-registry'
import { applySetup, commandExists, networkOptionTool, validatePublicUrl } from './setup'

// ---------------------------------------------------------------------------
// What cloudflared prints
// ---------------------------------------------------------------------------

/**
 * A quick-tunnel origin: one DNS label under trycloudflare.com. Matched by
 * SHAPE, anywhere in the output, because cloudflared prints it inside an ASCII
 * box whose borders, padding and line position have changed between releases.
 * The host must END at `.com` — `https://x.trycloudflare.com.attacker.net` is
 * someone else's host — while a sentence-ending period after it is fine.
 */
const QUICK_TUNNEL_URL_RE =
  /https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.trycloudflare\.com(?![a-z0-9-]|\.[a-z0-9])/gi

/**
 * Labels that are Cloudflare's own endpoints, never a tunnel. cloudflared's
 * failure lines quote them — `failed to request quick Tunnel: Post
 * "https://api.trycloudflare.com/tunnel": ...` — and adopting one as the
 * public URL would publish Cloudflare's API as this server's address.
 */
const NOT_A_TUNNEL = new Set(['api', 'www'])

/** The first quick-tunnel URL in `text`, as a bare origin, or undefined. */
export function parseQuickTunnelUrl(text: string): string | undefined {
  for (const match of text.matchAll(QUICK_TUNNEL_URL_RE)) {
    const label = (match[1] ?? '').toLowerCase()
    if (NOT_A_TUNNEL.has(label)) continue
    return `https://${label}.trycloudflare.com`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

export type QuickTunnelPreflight =
  | { ok: true; origin: string }
  | { ok: false; reason: string }

/**
 * Whether this box may run the wrapper, and if so which local origin it tunnels.
 *
 * Every refusal is a sentence the operator can act on. Order matters only for
 * which sentence they read first: the environment owning the URL is the one no
 * amount of re-running setup can fix, so it comes first.
 */
export function quickTunnelPreflight(
  input: {
    config?: PodiumConfig
    env?: EnvSource
    hasBinary?: (binary: string) => boolean
  } = {},
): QuickTunnelPreflight {
  const env = input.env ?? process.env
  const config = input.config ?? loadConfig()
  // THE DEPLOYMENT OWNS THE URL. With PODIUM_PUBLIC_URL set, every write this
  // wrapper made would be overridden on read — and applySetup refuses it
  // anyway. Running would mean fighting the environment on every rotation.
  if (resolveSetting('publicUrl', {}, env).source === 'env') {
    return {
      ok: false,
      reason:
        `${LAYERED_ENV.publicUrl} is set in this deployment's environment; the deployment owns ` +
        'the public URL, so a quick tunnel cannot record its rotating URL here. Unset it to use ' +
        '`podium tunnel`, or point it at a durable URL instead.',
    }
  }
  const mode = resolveSetting('mode', config, env).value
  if (mode !== 'all-in-one' && mode !== 'server') {
    return {
      ok: false,
      reason: `a quick tunnel exposes this box's server, and this box is ${
        mode ? `mode=${mode}` : 'not configured'
      }. Run it on the box that hosts the server.`,
    }
  }
  // THE OPT-IN. The operator chose this option in setup; this command is the
  // second, explicit step. Neither happens by default.
  if (config.networkOption !== 'cloudflare-tunnel') {
    return {
      ok: false,
      reason:
        'this box is not set up for a Cloudflare quick tunnel. Choose "Cloudflare quick tunnel" ' +
        'in `podium setup` first — the supervised tunnel only runs when you have opted in to it.',
    }
  }
  const tool = networkOptionTool('cloudflare-tunnel')
  const hasBinary = input.hasBinary ?? ((binary: string) => commandExists(binary, env))
  if (tool && !hasBinary(tool.binary)) {
    return {
      ok: false,
      reason:
        `${tool.binary} is not installed (not on PATH).` +
        (tool.install ? ` Install it with:\n${tool.install}` : '') +
        `\nOther ways to install it: ${tool.docs}`,
    }
  }
  const port = resolveSetting('port', config, env).value
  return { ok: true, origin: quickTunnelOrigin(port, env) }
}

/**
 * The local origin cloudflared forwards to. IPv4 loopback rather than
 * `localhost`, matching the command setup prints (networkOptionCommand): a
 * `localhost` that resolves to ::1 first reaches nothing when the server bound
 * 127.0.0.1. A server bound to one specific interface is reachable only there.
 */
export function quickTunnelOrigin(port: number, env: EnvSource = process.env): string {
  const host = resolveLocalServerHost(env)
  return `http://${host === 'localhost' ? '127.0.0.1' : host}:${port}`
}

/** cloudflared's argv for a quick tunnel to `origin`. */
export function quickTunnelArgs(origin: string): string[] {
  // --no-autoupdate: cloudflared replacing its own binary and restarting would
  // be a rotation nobody asked for. Updating it is the operator's business.
  return ['tunnel', '--no-autoupdate', '--url', origin]
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

/**
 * Record a quick tunnel's URL as this server's public URL.
 *
 * NOT `applyServerUrl` (`podium set-server`): that re-points a daemon or client
 * at a server, and throws on a hosting box. This box IS the server, so the
 * write is the one setup makes — {@link applySetup} — which also carries its
 * guards: a corrupt config is not overwritten, and PODIUM_MODE or
 * PODIUM_PUBLIC_URL in the environment refuse the write.
 *
 * Returns whether anything was written. The same URL writes nothing, so an
 * unchanged restart costs no config churn and no republish.
 */
export function recordQuickTunnelUrl(url: string): boolean {
  const valid = validatePublicUrl(url)
  if (!valid.ok) throw new Error(`not a tunnel URL (${url}): ${valid.error}`)
  const prev = loadConfig()
  // Re-checked at write time, not just at start: a box re-set as a daemon
  // while the wrapper ran must not be turned back into a host by it.
  if (prev.mode !== 'all-in-one' && prev.mode !== 'server') {
    throw new Error(
      `refusing to record the tunnel URL: this box is ${
        prev.mode ? `mode=${prev.mode}` : 'not configured'
      }, not a server`,
    )
  }
  if (prev.publicUrl === valid.normalized) return false
  applySetup({
    publicUrl: valid.normalized,
    mode: prev.mode,
    // WHY THIS IS SAFE TO CONFIRM. The guard exists because replacing a live
    // public URL strands every machine that joined at the old one. A rotating
    // quick tunnel does that BY DESIGN — the old URL is already dead when we
    // get here — and the operator accepted it when they chose a quick tunnel
    // and then opted in to this wrapper. What un-strands those machines is
    // Podium Connect: the publisher republishes this URL, and a daemon whose
    // dial fails asks the locator (POD-4533) and adopts it. Refusing here
    // would keep the dead URL on record, which strands them for good.
    confirmUrlChange: true,
  })
  return true
}

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

/** One cloudflared run, as the supervisor sees it. */
export interface TunnelProcess {
  readonly pid: number | undefined
  /** Every chunk it writes, stdout and stderr alike (the URL is on stderr). */
  onOutput(listener: (chunk: string) => void): void
  /** Exactly once, including for a process that failed to spawn at all. */
  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): void
  kill(signal: NodeJS.Signals): void
}

export type QuickTunnelState = 'idle' | 'starting' | 'running' | 'backoff' | 'stopping' | 'stopped'

export interface QuickTunnelLog {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

export interface QuickTunnelSupervisorDeps {
  spawn: () => TunnelProcess
  /** Write a URL that differs from the last one recorded. May throw. */
  recordUrl: (url: string) => void | Promise<void>
  /** The URL already on record (config's publicUrl), so the same URL is no write. */
  recordedUrl?: string
  /** Told the pid of each child as it starts, and undefined as it goes. */
  onChild?: (pid: number | undefined) => void
  log: QuickTunnelLog
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
  /** How long a start may go without printing a URL before it counts as failed. */
  urlTimeoutMs?: number
  /** SIGTERM, then SIGKILL after this long. */
  stopGraceMs?: number
  backoffMs?: readonly number[]
  /** A run that printed a URL and lived this long resets the backoff. */
  stableAfterMs?: number
}

export const QUICK_TUNNEL_URL_TIMEOUT_MS = 30_000
export const QUICK_TUNNEL_STOP_GRACE_MS = 5_000
export const QUICK_TUNNEL_STABLE_AFTER_MS = 60_000
/**
 * Restart delays. It starts fast because a quick tunnel dying is NORMAL — that
 * is the whole reason this exists — and it climbs to five minutes because a
 * cloudflared that cannot start (no network, a rate-limited trycloudflare API,
 * a broken binary) must not hammer anything. Longer than the parent's crash
 * ladder on purpose: every attempt here is a request to Cloudflare's API.
 */
export const QUICK_TUNNEL_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const

/** Bytes of unterminated output kept while looking for the URL. */
const LINE_BUFFER_MAX = 8_192

export class QuickTunnelSupervisor {
  #state: QuickTunnelState = 'idle'
  #child: TunnelProcess | undefined
  #lineBuffer = ''
  #urlSeenAt: number | undefined
  #currentUrl: string | undefined
  #recordedUrl: string | undefined
  #attempts = 0
  #starts = 0
  #urlTimer: unknown
  #killTimer: unknown
  #restartTimer: unknown
  #stopWaiters: (() => void)[] = []
  #writes: Promise<void> = Promise.resolve()
  readonly #deps: QuickTunnelSupervisorDeps
  readonly #setTimer: (fn: () => void, ms: number) => unknown
  readonly #clearTimer: (handle: unknown) => void
  readonly #now: () => number
  readonly #backoff: readonly number[]

  constructor(deps: QuickTunnelSupervisorDeps) {
    this.#deps = deps
    this.#recordedUrl = deps.recordedUrl
    this.#setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.#clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout))
    this.#now = deps.now ?? (() => Date.now())
    this.#backoff = deps.backoffMs ?? QUICK_TUNNEL_BACKOFF_MS
  }

  get state(): QuickTunnelState {
    return this.#state
  }

  /** The URL the live cloudflared printed, if it has printed one. */
  get url(): string | undefined {
    return this.#currentUrl
  }

  /** How many cloudflared processes this supervisor has started. */
  get starts(): number {
    return this.#starts
  }

  /** Awaitable for tests and shutdown: every URL write queued so far. */
  get settled(): Promise<void> {
    return this.#writes
  }

  /** Start cloudflared. A second call while one is alive does nothing. */
  start(): void {
    if (this.#state !== 'idle') return
    this.#launch()
  }

  /**
   * Stop for good and take cloudflared with it. Resolves once the child has
   * EXITED, not merely been signalled, so a caller that exits afterwards
   * leaves nothing behind.
   */
  stop(): Promise<void> {
    if (this.#state === 'stopped' || this.#state === 'idle') {
      this.#state = 'stopped'
      return this.#writes
    }
    const exited = new Promise<void>((resolve) => this.#stopWaiters.push(resolve))
    if (this.#state !== 'stopping') {
      this.#state = 'stopping'
      this.#clear('restart')
      this.#clear('url')
      if (this.#child) this.#terminate(this.#child)
      else this.#finishStop()
    }
    return exited.then(() => this.#writes)
  }

  #launch(): void {
    // The invariant everything else leans on: a new child only after the old
    // one's EXIT was observed. Two cloudflareds would be two URLs racing.
    if (this.#child) return
    this.#state = 'starting'
    this.#lineBuffer = ''
    this.#urlSeenAt = undefined
    this.#currentUrl = undefined
    this.#starts += 1
    let child: TunnelProcess
    try {
      child = this.#deps.spawn()
    } catch (error) {
      this.#deps.log.warn('tunnel: could not start cloudflared', {
        message: (error as Error).message,
      })
      this.#scheduleRestart()
      return
    }
    this.#child = child
    this.#deps.onChild?.(child.pid)
    child.onOutput((chunk) => this.#output(child, chunk))
    child.onExit((exit) => this.#exited(child, exit))
    this.#urlTimer = this.#setTimer(() => this.#noUrl(child), this.#deps.urlTimeoutMs ?? QUICK_TUNNEL_URL_TIMEOUT_MS)
  }

  #output(child: TunnelProcess, chunk: string): void {
    if (child !== this.#child || this.#urlSeenAt !== undefined) return
    const text = this.#lineBuffer + chunk
    const lastBreak = text.lastIndexOf('\n')
    // Only COMPLETE lines are parsed: a URL split across two chunks would
    // otherwise match as its own truncated prefix.
    const complete = lastBreak < 0 ? '' : text.slice(0, lastBreak)
    this.#lineBuffer = (lastBreak < 0 ? text : text.slice(lastBreak + 1)).slice(-LINE_BUFFER_MAX)
    const url = parseQuickTunnelUrl(complete)
    if (url === undefined) return
    this.#clear('url')
    this.#urlSeenAt = this.#now()
    this.#currentUrl = url
    if (this.#state === 'starting') this.#state = 'running'
    this.#deps.log.info('tunnel: cloudflared is serving', { url, pid: child.pid })
    if (url !== this.#recordedUrl) this.#record(url)
  }

  #record(url: string): void {
    this.#writes = this.#writes.then(async () => {
      // A later run may already have recorded something newer; the queue keeps
      // the writes in order, and this check keeps a stale one from landing.
      if (url === this.#recordedUrl || url !== this.#currentUrl) return
      try {
        await this.#deps.recordUrl(url)
        this.#recordedUrl = url
        this.#deps.log.info('tunnel: recorded the new public URL', { url })
      } catch (error) {
        // Left unrecorded, so the next run that prints a URL tries again.
        this.#deps.log.warn('tunnel: could not record the tunnel URL', {
          url,
          message: (error as Error).message,
        })
      }
    })
  }

  #noUrl(child: TunnelProcess): void {
    this.#urlTimer = undefined
    if (child !== this.#child || this.#urlSeenAt !== undefined) return
    this.#deps.log.warn('tunnel: cloudflared printed no tunnel URL in time; treating it as a failed start', {
      pid: child.pid,
      timeoutMs: this.#deps.urlTimeoutMs ?? QUICK_TUNNEL_URL_TIMEOUT_MS,
    })
    // Its exit schedules the restart, so a wedged start and a crash share one path.
    this.#terminate(child)
  }

  #terminate(child: TunnelProcess): void {
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone; its exit is on the way.
    }
    this.#clear('kill')
    this.#killTimer = this.#setTimer(() => {
      this.#killTimer = undefined
      if (child !== this.#child) return
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }, this.#deps.stopGraceMs ?? QUICK_TUNNEL_STOP_GRACE_MS)
  }

  #exited(child: TunnelProcess, exit: { code: number | null; signal: string | null }): void {
    if (child !== this.#child) return
    this.#child = undefined
    this.#clear('url')
    this.#clear('kill')
    this.#deps.onChild?.(undefined)
    if (this.#state === 'stopping') {
      this.#finishStop()
      return
    }
    const ranFor = this.#urlSeenAt === undefined ? undefined : this.#now() - this.#urlSeenAt
    if (ranFor !== undefined && ranFor >= (this.#deps.stableAfterMs ?? QUICK_TUNNEL_STABLE_AFTER_MS)) {
      this.#attempts = 0
    }
    // A restart is the normal case, not an error: quick tunnels die.
    this.#deps.log.info('tunnel: cloudflared exited; restarting it', {
      code: exit.code,
      signal: exit.signal,
      servedUrl: ranFor !== undefined,
    })
    this.#scheduleRestart()
  }

  #scheduleRestart(): void {
    const delay = this.#backoff[Math.min(this.#attempts, this.#backoff.length - 1)] ?? 0
    this.#attempts += 1
    this.#state = 'backoff'
    this.#clear('restart')
    this.#restartTimer = this.#setTimer(() => {
      this.#restartTimer = undefined
      if (this.#state === 'backoff') this.#launch()
    }, delay)
  }

  #finishStop(): void {
    this.#state = 'stopped'
    this.#clear('kill')
    const waiters = this.#stopWaiters
    this.#stopWaiters = []
    for (const resolve of waiters) resolve()
  }

  #clear(which: 'url' | 'kill' | 'restart'): void {
    const handle =
      which === 'url' ? this.#urlTimer : which === 'kill' ? this.#killTimer : this.#restartTimer
    if (handle !== undefined) this.#clearTimer(handle)
    if (which === 'url') this.#urlTimer = undefined
    else if (which === 'kill') this.#killTimer = undefined
    else this.#restartTimer = undefined
  }
}

// ---------------------------------------------------------------------------
// One wrapper per box, and no orphan from a wrapper that died hard
// ---------------------------------------------------------------------------

interface TunnelLockRecord {
  wrapper: ProcessIdentityTriple
  cloudflared?: ProcessIdentityTriple
}

export class TunnelAlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`another \`podium tunnel\` (pid ${pid}) is already running on this box`)
    this.name = 'TunnelAlreadyRunningError'
  }
}

export interface TunnelLockHandle {
  /** The cloudflared pid a hard-killed predecessor left behind and we stopped. */
  reapedOrphan?: number
  /** Record (or clear) the live cloudflared, so a successor can reap it. */
  setChild(pid: number | undefined): void
  release(): void
}

export function tunnelLockPath(): string {
  return join(runDir(), 'tunnel.json')
}

function readLock(path: string): TunnelLockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TunnelLockRecord>
    if (typeof parsed.wrapper?.pid !== 'number') return undefined
    return parsed as TunnelLockRecord
  } catch {
    // Absent, or torn by a writer that died mid-write: either way, not binding.
    return undefined
  }
}

function writeLock(path: string, record: TunnelLockRecord): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const staging = `${path}.${record.wrapper.pid}.tmp`
  writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(staging, path)
}

/**
 * Claim the box's one tunnel wrapper.
 *
 * Refuses while another wrapper is alive: two wrappers are two cloudflareds
 * writing two URLs over each other. A predecessor that is DEAD but whose
 * cloudflared is still running — a SIGKILLed foreground wrapper; systemd kills
 * the whole cgroup and never leaves one — had its child reaped here, before
 * ours starts, so there are never two alive at once. Only a child whose
 * identity (boot id AND start time) still matches is signalled: a bare pid may
 * have been recycled by an unrelated process, and that is not ours to kill.
 */
export function acquireTunnelLock(
  opts: {
    path?: string
    io?: InstanceGuardIo
    kill?: (pid: number, signal: NodeJS.Signals) => void
  } = {},
): TunnelLockHandle {
  const path = opts.path ?? tunnelLockPath()
  const io = opts.io ?? defaultInstanceGuardIo
  const kill = opts.kill ?? ((pid, signal) => process.kill(pid, signal))
  const self = selfIdentityTriple(io)
  const existing = readLock(path)
  let reapedOrphan: number | undefined
  if (existing && existing.wrapper.pid !== self.pid && holderIsLive(existing.wrapper, io)) {
    throw new TunnelAlreadyRunningError(existing.wrapper.pid)
  }
  const orphan = existing?.cloudflared
  if (orphan && holderIsLive(orphan, io) && identityIsVerifiable(orphan, io)) {
    try {
      kill(orphan.pid, 'SIGTERM')
      reapedOrphan = orphan.pid
    } catch {
      // Gone between the check and the signal.
    }
  }
  writeLock(path, { wrapper: self })
  // Last writer wins on the rename; whoever is on disk now holds it.
  const settled = readLock(path)
  if (!settled || settled.wrapper.pid !== self.pid) {
    throw new TunnelAlreadyRunningError(settled?.wrapper.pid ?? -1)
  }
  return {
    ...(reapedOrphan === undefined ? {} : { reapedOrphan }),
    setChild(pid) {
      const current = readLock(path)
      if (current && current.wrapper.pid !== self.pid) return
      writeLock(path, {
        wrapper: self,
        ...(pid === undefined ? {} : { cloudflared: { pid, bootId: io.bootId(), startTime: io.startTime(pid) } }),
      })
    },
    release() {
      const current = readLock(path)
      if (current && current.wrapper.pid !== self.pid) return
      rmSync(path, { force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// The real process
// ---------------------------------------------------------------------------

/**
 * Start a real cloudflared. Its own process group, so a stop signals the whole
 * group — cloudflared is one process today, and this keeps a future helper of
 * it from outliving us.
 */
export function spawnCloudflared(opts: {
  args: string[]
  binary?: string
  env?: NodeJS.ProcessEnv
  /** Every chunk it writes is also handed here (the wrapper echoes it to its log). */
  echo?: (chunk: string) => void
}): TunnelProcess {
  const child = spawn(opts.binary ?? 'cloudflared', opts.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: opts.env ?? process.env,
  })
  const outputListeners: ((chunk: string) => void)[] = []
  const exitListeners: ((exit: { code: number | null; signal: string | null }) => void)[] = []
  let exit: { code: number | null; signal: string | null } | undefined
  const onChunk = (data: Buffer): void => {
    const chunk = data.toString('utf8')
    opts.echo?.(chunk)
    for (const listener of outputListeners) listener(chunk)
  }
  child.stdout?.on('data', onChunk)
  child.stderr?.on('data', onChunk)
  const finish = (value: { code: number | null; signal: string | null }): void => {
    if (exit) return
    exit = value
    for (const listener of exitListeners) listener(value)
  }
  child.on('exit', (code, signal) => finish({ code, signal }))
  // ENOENT/EACCES arrive here, with no 'exit' after them.
  child.on('error', () => finish({ code: null, signal: null }))
  return {
    pid: child.pid,
    onOutput(listener) {
      outputListeners.push(listener)
    },
    onExit(listener) {
      if (exit) listener(exit)
      else exitListeners.push(listener)
    },
    kill(signal) {
      if (exit || child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    },
  }
}
