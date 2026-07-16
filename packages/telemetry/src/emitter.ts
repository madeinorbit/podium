/**
 * The emitter [spec:SP-f933]: counters, the daily jittered flush, and the POST.
 *
 * Only the SERVER constructs one (D10) — joined daemons and clients are covered
 * by the hub's decision and never emit. Everything ambient (clock, fetch,
 * config, timers, randomness) is injected so the whole thing is testable
 * without a network, a state dir, or a day passing.
 *
 * Three rules this file exists to enforce:
 *
 *  - **Nothing is collected before consent** (D4). The counters short-circuit
 *    on a fresh consent read, so a tier that is off (or absent, or killed by
 *    DO_NOT_TRACK) accumulates NOTHING — there is no local-collect mode to
 *    later turn into a backlog.
 *  - **Consent is read fresh at flush** (D9), never cached at boot, so
 *    `podium telemetry off` takes effect on a running server with no restart —
 *    including dropping reports already queued for a tier that is now off.
 *  - **Failure is silent and free.** No retry storms against air-gapped
 *    installs, no thrown errors, no user-visible effect. A telemetry problem
 *    the user can see is a worse bug than no telemetry at all.
 */
import type { AgentKind } from '@podium/protocol'
import { type EnvSource, loadConfig, type PodiumConfig } from '@podium/runtime/config'
import { isTierOn, resolveTelemetryEndpoint } from './consent'
import { dropFromQueue, enqueueReport, readQueue, recordLastSent } from './queue'
import {
  bucketInstallAge,
  bucketMachines,
  type CrashReport,
  normalizeArch,
  normalizeOs,
  normalizeVersion,
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryFeature,
  type TelemetryReport,
  tierOf,
  type UsageReport,
} from './schema'
import { crashSignature, scrubError } from './scrub'

/** Base flush interval (D: one report per day). */
export const FLUSH_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Upper bound of the random jitter added to every interval, so a fleet that
 *  all updated on the same day doesn't hit the relay in the same second. */
export const FLUSH_JITTER_MS = 2 * 60 * 60 * 1000
/** Per-(errorType, top-frame) crash cooldown — a crash loop must not beacon. */
export const CRASH_SIGNATURE_COOLDOWN_MS = 24 * 60 * 60 * 1000
/** Absolute ceiling on crash reports queued per flush window, whatever their
 *  signatures — the backstop for a process finding many novel ways to die. */
export const MAX_CRASHES_PER_WINDOW = 5

/** Gauges the host reads at FLUSH time (never retained between flushes). */
export interface TelemetryGauges {
  /** Machines registered with this server; bucketed before it enters a payload. */
  machines: number
}

export interface EmitterDeps {
  /** Where the queue lives (`<state-dir>/telemetry/`). */
  stateDir: string
  /** Root of the Podium install — the containment test every stack frame must pass. */
  installRoot: string
  /** Baked-in app version; folded to the schema's alphabet ('dev' for source runs). */
  version?: string
  gauges: () => TelemetryGauges
  env?: EnvSource
  loadConfig?: () => PodiumConfig
  now?: () => number
  random?: () => number
  fetch?: typeof globalThis.fetch
  platform?: string
  arch?: string
  /** One debug line, at most, on failure. Default: silence. */
  log?: (message: string) => void
}

export class TelemetryEmitter {
  private sessions = new Map<AgentKind, number>()
  private features = new Set<TelemetryFeature>()
  private crashSignatures = new Map<string, number>()
  private crashesThisWindow = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly deps: Required<Omit<EmitterDeps, 'version'>> & { version: string }

  constructor(deps: EmitterDeps) {
    this.deps = {
      stateDir: deps.stateDir,
      installRoot: deps.installRoot,
      version: normalizeVersion(deps.version),
      gauges: deps.gauges,
      env: deps.env ?? process.env,
      loadConfig: deps.loadConfig ?? (() => loadConfig()),
      now: deps.now ?? (() => Date.now()),
      random: deps.random ?? Math.random,
      fetch: deps.fetch ?? globalThis.fetch,
      platform: deps.platform ?? process.platform,
      arch: deps.arch ?? process.arch,
      log: deps.log ?? (() => {}),
    }
  }

  /** Fresh read — never a boot-time cache (D9). */
  private tierOn(tier: 'usage' | 'crash'): boolean {
    try {
      return isTierOn(tier, this.deps.loadConfig(), this.deps.env)
    } catch {
      // An unreadable/corrupt config means we do not know we have consent,
      // and "we don't know" resolves to "no".
      return false
    }
  }

  /**
   * A session was created. Counted only while `usage` is on — the config read
   * per call is deliberate (D4/D9: no cached consent, no collection while off)
   * and sessions are human-paced, so it costs nothing that matters.
   */
  recordSession(kind: AgentKind): void {
    if (!this.tierOn('usage')) return
    this.sessions.set(kind, (this.sessions.get(kind) ?? 0) + 1)
  }

  /**
   * A feature surface was touched this window. The already-marked short-circuit
   * runs BEFORE the consent read, so a chatty caller (every issue mutation)
   * costs one config read per window, not one per event.
   */
  markFeature(feature: TelemetryFeature): void {
    if (this.features.has(feature)) return
    if (!this.tierOn('usage')) return
    this.features.add(feature)
  }

  /**
   * Record a crash for the `crash` tier. The error's MESSAGE is not accepted,
   * stored, or reachable — `scrubError` takes the throwable and returns only a
   * closed-enum type plus Podium-relative frames.
   *
   * A report with no surviving frames is dropped entirely: an errorType alone
   * cannot be actioned and still costs a request.
   */
  recordCrash(err: unknown): void {
    if (!this.tierOn('crash')) return
    if (this.crashesThisWindow >= MAX_CRASHES_PER_WINDOW) return
    const scrubbed = scrubError(err, this.deps.installRoot)
    if (scrubbed.frames.length === 0) return
    const signature = crashSignature(scrubbed)
    const now = this.deps.now()
    const last = this.crashSignatures.get(signature)
    if (last !== undefined && now - last < CRASH_SIGNATURE_COOLDOWN_MS) return
    const identity = this.identity()
    if (!identity) return
    const report: CrashReport = {
      schema: TELEMETRY_SCHEMA_VERSION,
      ...identity,
      errorType: scrubbed.errorType,
      frames: scrubbed.frames,
    }
    if (!enqueueReport(this.deps.stateDir, report)) return
    this.crashSignatures.set(signature, now)
    this.crashesThisWindow += 1
  }

  /** The identity fields both reports share, or undefined when we have no
   *  installId — which means nobody has ever opted in, so nothing may be built. */
  private identity():
    | {
        installId: string
        version: string
        os: ReturnType<typeof normalizeOs>
        arch: ReturnType<typeof normalizeArch>
      }
    | undefined {
    const installId = this.deps.loadConfig().telemetry?.installId
    if (!installId) return undefined
    return {
      installId,
      version: this.deps.version,
      os: normalizeOs(this.deps.platform),
      arch: normalizeArch(this.deps.arch),
    }
  }

  /**
   * Build the usage report from the current counters + flush-time gauges.
   * Public so `telemetry.preview` / `podium telemetry show` render the REAL
   * thing rather than a hand-written example that can drift from the code.
   */
  buildUsageReport(): UsageReport | undefined {
    const identity = this.identity()
    if (!identity) return undefined
    const config = this.deps.loadConfig()
    const since = config.telemetry?.since ?? this.deps.now()
    const sessions: Partial<Record<AgentKind, number>> = {}
    for (const [kind, count] of this.sessions) sessions[kind] = count
    const features: Partial<Record<TelemetryFeature, boolean>> = {}
    for (const feature of this.features) features[feature] = true
    let machines = 1
    try {
      machines = this.deps.gauges().machines
    } catch {
      // a gauge that throws must not break the flush
    }
    return {
      schema: TELEMETRY_SCHEMA_VERSION,
      ...identity,
      installAge: bucketInstallAge(Math.max(0, this.deps.now() - since)),
      machines: bucketMachines(machines),
      sessions,
      features,
    }
  }

  /** Start the daily jittered flush. The timer is unref'd — telemetry must
   *  never be the reason a process refuses to exit. */
  start(): void {
    if (this.timer) return
    this.scheduleNext()
  }

  private scheduleNext(): void {
    const delay = FLUSH_INTERVAL_MS + Math.floor(this.deps.random() * FLUSH_JITTER_MS)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().finally(() => {
        // Only re-arm if stop() hasn't run in the meantime.
        if (this.stopped) return
        this.scheduleNext()
      })
    }, delay)
    this.timer.unref?.()
  }

  private stopped = false

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /**
   * Flush: enqueue the window's usage report (if `usage` is on), then send
   * everything pending whose tier is STILL on. Never throws.
   *
   * A queued report for a tier the user has since turned off is DROPPED, not
   * held: "off" means the data stops leaving, including data we already
   * gathered while it was on.
   */
  async flush(): Promise<void> {
    try {
      await this.flushInner()
    } catch (err) {
      this.deps.log(`[podium:telemetry] flush failed: ${(err as Error)?.message ?? 'unknown'}`)
    }
  }

  private async flushInner(): Promise<void> {
    const usageOn = this.tierOn('usage')
    if (usageOn) {
      const report = this.buildUsageReport()
      if (report) enqueueReport(this.deps.stateDir, report)
    }
    // The window is over either way: counters reset even when the report could
    // not be built, so a missing installId can't make them accumulate forever.
    this.resetWindow()

    const pending = readQueue(this.deps.stateDir)
    if (pending.length === 0) return
    const config = this.deps.loadConfig()
    const endpoint = resolveTelemetryEndpoint(config, this.deps.env)

    // Walk from the front; the queue is FIFO and dropFromQueue removes a prefix.
    let settled = 0
    for (const report of pending) {
      if (!isTierOn(tierOf(report), config, this.deps.env)) {
        settled += 1 // consent revoked → drop it, don't send it
        continue
      }
      const sent = await this.post(endpoint, report)
      if (!sent) break // leave this and everything after it queued for next time
      recordLastSent(this.deps.stateDir, report, new Date(this.deps.now()))
      settled += 1
    }
    dropFromQueue(this.deps.stateDir, settled)
  }

  private resetWindow(): void {
    this.sessions.clear()
    this.features.clear()
    this.crashesThisWindow = 0
  }

  /** One POST, one timeout, no retry. Any failure = false, silently. */
  private async post(endpoint: string, report: TelemetryReport): Promise<boolean> {
    try {
      const res = await this.deps.fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(10_000),
      })
      // A 4xx means the relay refused this body — retrying it forever would be
      // a beacon. Treat it as settled (drop); only transport/5xx keeps it.
      if (res.status >= 500) return false
      return true
    } catch (err) {
      this.deps.log(`[podium:telemetry] post failed: ${(err as Error)?.message ?? 'unknown'}`)
      return false
    }
  }
}
