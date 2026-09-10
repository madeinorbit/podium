/// <reference path="./bun-jsc.d.ts" />
/**
 * ON-DEMAND CPU PROFILES for a process whose loop is in trouble
 * (docs/internal/superpowers/specs/2026-09-10-loop-profile-levels-design.md §8).
 *
 * Accounting says HOW MUCH the loop was blocked and the attribution seams name
 * the costs they wrap. Neither can name work that runs through no seam at all,
 * which after POD-1931 was most of the blocked time. A sampling profile is the
 * only instrument that names it, so `attribution` and above capture one on a
 * long stall or on `SIGUSR2`.
 *
 * WHY bun:jsc AND NOT `bun --cpu-prof` OR `perf`. `--cpu-prof` writes at exit
 * only, which is useless for a server that must keep running, and Linux `perf`
 * is unavailable on the reference host and cannot name JIT frames anyway
 * (spec §8). `bun:jsc`'s in-process sampler is what is left.
 *
 * WHAT THE PRIMITIVE ACTUALLY DOES — measured on Bun 1.3.14, 2026-09-10,
 * because the spec assumed an arm/disarm pair and there is none:
 *
 *  - `bun:jsc` exports `startSamplingProfiler` and `samplingProfilerStackTraces`
 *    and NO stop. Once armed, the sampler thread runs for the life of the
 *    process.
 *  - `samplingProfilerStackTraces()` DRAINS: it returns the traces accumulated
 *    since the previous call, not since the start. Calling
 *    `startSamplingProfiler()` a second time does NOT clear the buffer (re-armed
 *    after a 2 s burn, then burned 100 ms and drained: 1457 traces, the old ones
 *    still there). The drain is therefore the ONLY way to empty it.
 *  - The buffer grows LINEARLY with busy time and never plateaus: on a fully
 *    busy loop RSS grew 14.2 / 21.0 / 26.9 / 33.7 / 39.9 / 48.3 MB at
 *    t = 5/10/15/20/25/30 s — about 1.6 MB and 540 traces per second.
 *  - Draining costs about 12.5 µs per trace (16 148 traces in 201 ms) and it
 *    blocks the MAIN thread.
 *
 * So "arm it and forget it" would leak roughly 480 MB across one five-minute
 * rate-limit window and then block the loop for about two seconds draining it —
 * a diagnostic causing a worse stall than the one it was sent to explain. Hence
 * the KEEP-CLEAR TIMER below: once armed, a short unref'd interval drains and
 * throws the result away whenever no capture is in flight, so the buffer holds
 * at most one interval's worth. It costs about 6.75 ms per second on a fully
 * busy loop (0.7 percent of wall) and nothing on an idle one, it starts only
 * after this process's FIRST capture, and {@link LoopProfileCapture.keepClearMs}
 * reports the cost it has actually spent so the overhead stays a field rather
 * than a claim this comment makes (invariant §2.4).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOOP_PROFILE_LEVELS, type LoopProfileLevel } from './config'
import type { LoopComponent, LoopMinute } from './loop-accounting'

/** What armed the capture. `stall` is automatic, `signal` is `SIGUSR2`. */
export type ProfileTrigger = 'stall' | 'signal'

/** Why a request produced no profile. */
export type ProfileSuppressedReason =
  /** The process is below `attribution`. */
  | 'level'
  /** A capture is already in flight. */
  | 'running'
  /** Inside the five-minute window since the last capture finished. */
  | 'rate-limited'
  /** No `bun:jsc` sampling profiler in this runtime; a refusal record is written. */
  | 'unavailable'
  /** {@link LoopProfileCapture.stop} has been called; this handle is finished. */
  | 'stopped'

/** Bun's sampler, as the two calls this module makes. Injected in tests. */
export interface SamplingProfilerApi {
  startSamplingProfiler(): void
  samplingProfilerStackTraces(): unknown
}

/**
 * The file written per capture (spec §8). `stacks` holds what Bun returns —
 * §8 fixes the format as "what Bun returns", and what it returns is a structured
 * `{ interval, traces, sources }` object, not the text the spec's prose assumed.
 * `traceCount` and `interval` are lifted out of it so a reader can size and date
 * a profile without parsing megabytes of frames.
 */
export interface LoopProfileEnvelope {
  component: LoopComponent
  level: LoopProfileLevel
  trigger: ProfileTrigger
  /** ISO, when the sampling window opened. */
  startedAt: string
  /** ISO, when it was drained. */
  endedAt: string
  seconds: number
  /** The stall that armed this capture, ms — `stall` trigger only. */
  stallMs?: number
  /** The minute record current when the trigger fired, when the caller has one. */
  minute?: LoopMinute
  /** Sampler period in seconds, as Bun reports it. */
  interval?: number
  traceCount?: number
  /**
   * True once this process has armed the sampler. Bun exposes no way to stop it,
   * so from the first capture onward the sampler thread runs for the life of the
   * process and this module drains its buffer on a timer to bound it. The flag
   * is in the file because a reader holding one profile would otherwise have no
   * way to know the process is still paying for it.
   */
  profilerArmedForProcessLifetime?: boolean
  /** Present INSTEAD of `stacks` when the runtime has no sampling profiler. */
  refused?: string
  stacks?: unknown
}

export type ProfileCaptureResult =
  | { suppressed: true; reason: ProfileSuppressedReason; path?: string }
  | { suppressed: false; path: string; traceCount: number; bytes: number }

/** Extra facts about the trigger, folded into the envelope. */
export interface ProfileRequestContext {
  stallMs?: number
  minute?: LoopMinute
}

export interface LoopProfileCapture {
  request(
    trigger: ProfileTrigger,
    seconds: number,
    context?: ProfileRequestContext,
  ): Promise<ProfileCaptureResult>
  /** Where profiles land. Created on the first write and not before. */
  readonly dir: string
  /** Main-thread ms this module has spent keeping the sampler's buffer clear. */
  readonly keepClearMs: number
  /**
   * Give up the keep-clear timer and refuse all further requests.
   *
   * The sampler thread itself cannot be stopped — Bun exposes no call for it —
   * so this is only as final as the process allows. It is final for THIS handle
   * though, which matters: the daemon's signal listener can outlive the close
   * that stopped the capture, and a request served afterwards would re-arm the
   * very timer `stop` was called to drop.
   */
  stop(): void
}

/** One capture per five minutes per component (spec §8). */
export const PROFILE_MIN_INTERVAL_MS = 5 * 60_000
/** Files kept per component; the oldest beyond this are deleted before a write. */
export const PROFILE_MAX_FILES = 20
/** How often the armed sampler's buffer is drained and discarded between captures. */
export const PROFILE_KEEP_CLEAR_MS = 1000
/** Requested durations are clamped into this range (spec §8: 10 s default, 1–60 s). */
export const PROFILE_MIN_SECONDS = 1
export const PROFILE_MAX_SECONDS = 60

export interface LoopProfileCaptureOptions {
  component: LoopComponent
  level: LoopProfileLevel
  /** The perf directory; profiles go in `<dir>/profiles`. */
  dir: string
  /** Wall clock ms — filenames, timestamps and the rate-limit window. */
  now?: () => number
  /**
   * The sampler. Omitted in production, where `bun:jsc` is imported once on the
   * first request; `null` states outright that there is none, for the test that
   * proves the refusal path.
   */
  jsc?: SamplingProfilerApi | null
  /** How the capture window is timed. Injected so a test need not take 10 s. */
  sleep?: (ms: number) => Promise<void>
  minIntervalMs?: number
  maxFiles?: number
  keepClearMs?: number
  /**
   * Called with the main-thread ms each drain cost. The keep-clear runs on the
   * loop it is measuring, so its cost belongs in the minute record next to
   * everything else this process spends on itself rather than in a comment —
   * both components feed it to `LoopAccountingHandle.noteProfilerCost`.
   */
  onKeepClearCost?: (ms: number) => void
}

function atLeastAttribution(level: LoopProfileLevel): boolean {
  return LOOP_PROFILE_LEVELS.indexOf(level) >= LOOP_PROFILE_LEVELS.indexOf('attribution')
}

/**
 * `2026-09-10T12:00:00.000Z` → `2026-09-10T12-00-00-000Z`. Still ISO-derived and
 * still sorts lexicographically, which is what the retention sweep relies on;
 * the colons are dropped only because they are not legal in a Windows filename
 * and this directory is read by whatever a reader has to hand.
 */
function fileStamp(atMs: number): string {
  return new Date(atMs).toISOString().replace(/:/g, '-')
}

export function profileDir(perfDir: string): string {
  return join(perfDir, 'profiles')
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function createProfileCapture(opts: LoopProfileCaptureOptions): LoopProfileCapture {
  const dir = profileDir(opts.dir)
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? sleepMs
  const minIntervalMs = opts.minIntervalMs ?? PROFILE_MIN_INTERVAL_MS
  const maxFiles = opts.maxFiles ?? PROFILE_MAX_FILES
  const keepClearMs = opts.keepClearMs ?? PROFILE_KEEP_CLEAR_MS
  const prefix = `${opts.component}-`

  let running = false
  let stopped = false
  let lastFinishedAt: number | undefined
  let armed = false
  let keepClearTimer: ReturnType<typeof setInterval> | undefined
  let keepClearSpentMs = 0
  /** `undefined` until the first request; `null` once the import has failed. */
  let jsc: SamplingProfilerApi | null | undefined = opts.jsc
  let jscResolved = opts.jsc !== undefined

  async function resolveJsc(): Promise<SamplingProfilerApi | null> {
    if (jscResolved) return jsc ?? null
    jscResolved = true
    try {
      const mod = (await import('bun:jsc')) as Partial<SamplingProfilerApi>
      jsc =
        typeof mod.startSamplingProfiler === 'function' &&
        typeof mod.samplingProfilerStackTraces === 'function'
          ? (mod as SamplingProfilerApi)
          : null
    } catch {
      // Not Bun, or a Bun without the sampler. Either way there is no profile to
      // take and the caller gets a refusal record rather than an exception.
      jsc = null
    }
    return jsc
  }

  /**
   * Drain and discard. This is the whole reason the keep-clear timer exists —
   * see the measurements in the module comment — and its cost is accumulated so
   * `keepClearMs` can report it.
   */
  function discard(api: SamplingProfilerApi): void {
    const startedAt = performance.now()
    try {
      api.samplingProfilerStackTraces()
    } catch {
      // A sampler that cannot be drained is a diagnostic failing. Losing the
      // interval is strictly better than letting it throw out of a timer.
    }
    const spent = performance.now() - startedAt
    keepClearSpentMs += spent
    opts.onKeepClearCost?.(spent)
  }

  function startKeepClear(api: SamplingProfilerApi): void {
    if (stopped || keepClearTimer !== undefined || keepClearMs <= 0) return
    keepClearTimer = setInterval(() => discard(api), keepClearMs)
    keepClearTimer.unref?.()
  }

  function stopKeepClear(): void {
    if (keepClearTimer === undefined) return
    clearInterval(keepClearTimer)
    keepClearTimer = undefined
  }

  /**
   * Keep at most `maxFiles` of THIS component's profiles. Only its own: the two
   * components share the directory, and a daemon deleting the server's evidence
   * mid-investigation is a worse outcome than a directory holding two capped
   * sets. Names begin with a sortable stamp, so lexicographic order is age.
   */
  function pruneTo(limit: number): void {
    if (!existsSync(dir)) return
    const mine = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort()
    for (const name of mine.slice(0, Math.max(0, mine.length - limit))) {
      rmSync(join(dir, name), { force: true })
    }
  }

  function write(
    envelope: LoopProfileEnvelope,
    trigger: ProfileTrigger,
    atMs: number,
  ): {
    path: string
    bytes: number
  } {
    mkdirSync(dir, { recursive: true })
    // Prune to one BELOW the cap first: this write is about to add one back, so
    // the directory is at `maxFiles` when it lands and never above it.
    pruneTo(maxFiles - 1)
    const path = join(dir, `${prefix}${fileStamp(atMs)}-${trigger}.json`)
    const body = JSON.stringify(envelope)
    writeFileSync(path, body)
    return { path, bytes: Buffer.byteLength(body) }
  }

  return {
    get dir() {
      return dir
    },
    get keepClearMs() {
      return keepClearSpentMs
    },
    stop() {
      stopped = true
      stopKeepClear()
    },

    async request(trigger, seconds, context) {
      if (!atLeastAttribution(opts.level)) return { suppressed: true, reason: 'level' }
      if (stopped) return { suppressed: true, reason: 'stopped' }
      if (running) return { suppressed: true, reason: 'running' }
      if (lastFinishedAt !== undefined && now() - lastFinishedAt < minIntervalMs) {
        return { suppressed: true, reason: 'rate-limited' }
      }

      // Claim the slot SYNCHRONOUSLY, before the first await. Two triggers can
      // land in the same tick — the probe's `onLongTick` and a SIGUSR2 handler
      // are both loop callbacks — and a guard sitting behind an await lets both
      // through, which is how this was found.
      running = true
      // The keep-clear must not run DURING the window — it would drain exactly
      // the traces this capture exists to collect.
      stopKeepClear()
      try {
        const api = await resolveJsc()
        if (!api) {
          // Refused, and the record says so (spec §8) — an agent that sent
          // SIGUSR2 finds a file explaining why there are no stacks in it.
          const at = now()
          const refusal: LoopProfileEnvelope = {
            component: opts.component,
            level: opts.level,
            trigger,
            startedAt: new Date(at).toISOString(),
            endedAt: new Date(at).toISOString(),
            seconds: 0,
            ...(context?.stallMs === undefined ? {} : { stallMs: context.stallMs }),
            ...(context?.minute ? { minute: context.minute } : {}),
            refused: 'no bun:jsc sampling profiler in this runtime',
          }
          const { path } = write(refusal, trigger, at)
          return { suppressed: true, reason: 'unavailable', path }
        }
        const windowSeconds = Math.min(
          PROFILE_MAX_SECONDS,
          Math.max(PROFILE_MIN_SECONDS, Math.round(seconds)),
        )
        if (!armed) {
          api.startSamplingProfiler()
          armed = true
        }
        // Open the window on an empty buffer: whatever accumulated since the
        // last keep-clear tick belongs to before this trigger.
        discard(api)
        const startedAt = now()
        await sleep(windowSeconds * 1000)
        const stacks = api.samplingProfilerStackTraces()
        const endedAt = now()
        const shape = stacks as { interval?: number; traces?: unknown[] } | undefined
        const traceCount = Array.isArray(shape?.traces) ? shape.traces.length : 0
        const envelope: LoopProfileEnvelope = {
          component: opts.component,
          level: opts.level,
          trigger,
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          seconds: windowSeconds,
          ...(context?.stallMs === undefined ? {} : { stallMs: context.stallMs }),
          ...(context?.minute ? { minute: context.minute } : {}),
          ...(typeof shape?.interval === 'number' ? { interval: shape.interval } : {}),
          traceCount,
          profilerArmedForProcessLifetime: true,
          stacks,
        }
        const { path, bytes } = write(envelope, trigger, startedAt)
        return { suppressed: false, path, traceCount, bytes }
      } finally {
        // The window closed however it closed; the rate limit runs from here and
        // the buffer goes back under the keep-clear timer's care.
        lastFinishedAt = now()
        running = false
        if (armed && jsc) startKeepClear(jsc)
      }
    },
  }
}

/**
 * `<perfDir>/profile-request.json` — the side channel that carries a DURATION
 * alongside `SIGUSR2`.
 *
 * A signal has no payload, and adding a control socket to ask a server for ten
 * versus sixty seconds of profile would be a new listening surface for a
 * diagnostic. A file the requester writes and the handler consumes needs
 * neither, and the handler defaults sensibly when the file is absent — which is
 * also what happens when an operator sends the signal by hand from a shell.
 */
export function profileRequestPath(perfDir: string): string {
  return join(perfDir, 'profile-request.json')
}

/** Ask the next `SIGUSR2` in `perfDir`'s process for a window of `seconds`. */
export function writeProfileRequest(perfDir: string, seconds: number): void {
  mkdirSync(perfDir, { recursive: true })
  writeFileSync(profileRequestPath(perfDir), JSON.stringify({ seconds }))
}

/**
 * Read and CONSUME the pending request, returning the seconds it asked for.
 *
 * Consuming is the point: the file is a one-shot instruction, and one left on
 * disk would silently re-apply to every later signal — including the hand-sent
 * ones that are supposed to get the default.
 */
export function takeProfileRequest(perfDir: string, fallbackSeconds = 10): number {
  const path = profileRequestPath(perfDir)
  try {
    if (!existsSync(path)) return fallbackSeconds
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { seconds?: unknown }
    rmSync(path, { force: true })
    const seconds = Number(raw.seconds)
    return Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds
  } catch {
    // Unreadable or malformed: drop it and take the default, rather than let a
    // corrupt one-line file turn a signal handler into an exception.
    rmSync(path, { force: true })
    return fallbackSeconds
  }
}
