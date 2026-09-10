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
 * at most one interval's worth.
 *
 * WHAT PRODUCTION THEN DID TO THAT ESTIMATE (POD-3834). The 0.7 percent above
 * came from a synthetic loop with shallow stacks. On the reference server the
 * same code cost a mean 2427 ms per minute — 4.05 percent of wall, worst minute
 * 6350 ms — and wrote 2.0 to 30.6 MB per profile, because a real trace is about
 * 2 KB of frames rather than 600 bytes and a real loop is deep. Three things
 * bound it now, and the order is the order of how much they buy:
 *
 *  1. THE SAMPLE PERIOD, which is the only lever that reduces cost at all.
 *     Cost is traces-per-second times microseconds-per-trace, and traces per
 *     second is set by the sampler, so 10 ms instead of 1 ms is roughly a tenth
 *     of the cost AND a tenth of the file. It cannot be set from in here —
 *     `startSamplingProfiler` takes a directory, and a number passed to it is
 *     accepted and ignored — only through `BUN_JSC_sampleInterval` in the
 *     process's environment at startup. {@link LoopProfileCaptureOptions.effectiveSample}
 *     is how this module learns what it got, and arming is REFUSED on a 1 ms
 *     period nobody stated: arming cannot be undone, so the decision to pay is
 *     taken once, in front, rather than discovered a minute later.
 *  2. THE BYTE CAPS. A capture keeps as many traces as fit in
 *     {@link PROFILE_MAX_BYTES}, spread evenly across the window so the profile
 *     still names the right function, and a component's profiles together stay
 *     under {@link PROFILE_MAX_COMPONENT_BYTES}.
 *  3. THE DRAIN INTERVAL, which buys LATENCY and not cost. Interleaved A/B on
 *     the same box: 5.2 ms per busy second draining every 1000 ms, 5.9 ms
 *     draining every 250 ms. Draining more often does not do less work, it does
 *     the same work in smaller pieces — which is still worth having, because a
 *     single 200 ms drain lands on the loop as a stall. The interval adapts to
 *     hold one drain near {@link PROFILE_KEEP_CLEAR_TARGET_MS}.
 *
 * {@link LoopProfileCapture.keepClearMs} reports the cost actually spent so the
 * overhead stays a field rather than a claim this comment makes (invariant §2.4).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  JSC_SAMPLE_INTERVAL_ENV,
  LOOP_PROFILE_LEVELS,
  type LoopProfileLevel,
  PROFILE_MIN_SAMPLE_US,
  resolveEffectiveSampleUs,
} from './config'
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
  /**
   * The sampler would run at a period nobody chose, and arming is permanent
   * (POD-3834). A refusal record is written naming the variable to set.
   */
  | 'sample-rate'
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
  /**
   * The period this process's sampler runs at, microseconds, as the environment
   * set it. Present on refusals too — it is the number the refusal is about.
   */
  sampleIntervalUs?: number
  /** Traces in the file. Below {@link tracesSampled} when the byte cap bit. */
  traceCount?: number
  /** Traces the window actually produced, present only when some were dropped. */
  tracesSampled?: number
  /** How many the byte cap removed, present only when it removed any. */
  tracesDropped?: number
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
  /** The interval the keep-clear is currently running at; 0 when it is not. */
  readonly keepClearIntervalMs: number
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
/** What one drain should cost. Above this the interval shortens — latency, not cost. */
export const PROFILE_KEEP_CLEAR_TARGET_MS = 5
/** However expensive a drain gets, never drain more often than this. */
export const PROFILE_KEEP_CLEAR_MIN_MS = 100
/**
 * The most one profile may weigh. 4 MB is about 2000 production traces, which
 * is a 20 s window at a 10 ms period on a busy loop — enough to name the work,
 * and a twentieth of the 30.6 MB the daemon wrote unbounded.
 */
export const PROFILE_MAX_BYTES = 4 * 1024 * 1024
/**
 * The most one component's profiles may weigh together. Per component and not
 * per directory for the same reason the file cap is: a daemon must not be able
 * to delete the server's evidence mid-investigation. Two components, so the
 * directory's own ceiling is twice this.
 */
export const PROFILE_MAX_COMPONENT_BYTES = 64 * 1024 * 1024
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
  keepClearTargetMs?: number
  maxBytes?: number
  maxComponentBytes?: number
  /**
   * What the sampler in this process will run at, and whether anyone chose it.
   * Read from the environment in production; injected in tests, which have no
   * `BUN_JSC_sampleInterval` and would otherwise all be refused.
   */
  effectiveSample?: { us: number; stated: boolean }
  /** The monotonic clock a drain is measured on. Injected so a test can price one. */
  monotonic?: () => number
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
  const keepClearTargetMs = opts.keepClearTargetMs ?? PROFILE_KEEP_CLEAR_TARGET_MS
  const maxBytes = opts.maxBytes ?? PROFILE_MAX_BYTES
  const maxComponentBytes = opts.maxComponentBytes ?? PROFILE_MAX_COMPONENT_BYTES
  const sample = opts.effectiveSample ?? resolveEffectiveSampleUs()
  const monotonic = opts.monotonic ?? (() => performance.now())
  const prefix = `${opts.component}-`

  let running = false
  let stopped = false
  let lastFinishedAt: number | undefined
  let armed = false
  let keepClearTimer: ReturnType<typeof setInterval> | undefined
  let keepClearSpentMs = 0
  /** The interval the timer is running at now; it moves with what a drain costs. */
  let keepClearNowMs = keepClearMs
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
  function discard(api: SamplingProfilerApi): number {
    const startedAt = monotonic()
    try {
      api.samplingProfilerStackTraces()
    } catch {
      // A sampler that cannot be drained is a diagnostic failing. Losing the
      // interval is strictly better than letting it throw out of a timer.
    }
    const spent = monotonic() - startedAt
    keepClearSpentMs += spent
    opts.onKeepClearCost?.(spent)
    return spent
  }

  /**
   * Move the interval so ONE drain stays near the target.
   *
   * This does not reduce the total cost and is not meant to — the sample period
   * sets that (module comment, measurement 3). What it stops is a single drain
   * landing on the loop as a stall of its own: a busy minute that went
   * undrained cost 200 ms in one piece, which is exactly the shape of event the
   * profile was armed to explain.
   */
  function retuneKeepClear(api: SamplingProfilerApi, spentMs: number): void {
    const next =
      spentMs > keepClearTargetMs
        ? Math.max(
            PROFILE_KEEP_CLEAR_MIN_MS,
            Math.floor((keepClearNowMs * keepClearTargetMs) / spentMs),
          )
        : spentMs * 4 < keepClearTargetMs
          ? Math.min(keepClearMs, keepClearNowMs * 2)
          : keepClearNowMs
    if (next === keepClearNowMs) return
    keepClearNowMs = next
    if (keepClearTimer === undefined) return
    // Re-arm at the new period. `setInterval` has no way to change one in place,
    // and leaving the old timer would leave two drains racing the same buffer.
    clearInterval(keepClearTimer)
    keepClearTimer = setInterval(() => tick(api), keepClearNowMs)
    keepClearTimer.unref?.()
  }

  function tick(api: SamplingProfilerApi): void {
    retuneKeepClear(api, discard(api))
  }

  function startKeepClear(api: SamplingProfilerApi): void {
    if (stopped || keepClearTimer !== undefined || keepClearMs <= 0) return
    keepClearTimer = setInterval(() => tick(api), keepClearNowMs)
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

  /**
   * Keep `count` of `items`, spread EVENLY and keeping both ends.
   *
   * Which traces survive the cap decides what the profile says. A prefix would
   * be a profile of the first fraction of the window, and on a 16 s stall that
   * is a profile of the wrong thing; an even stride is a real sample of the
   * whole window, so the proportions between hot functions survive.
   */
  function evenly<T>(items: readonly T[], count: number): T[] {
    if (count >= items.length) return [...items]
    if (count <= 1) return items.length > 0 ? [items[0] as T] : []
    const step = (items.length - 1) / (count - 1)
    const out: T[] = []
    for (let i = 0; i < count; i += 1) out.push(items[Math.round(i * step)] as T)
    return out
  }

  /**
   * Serialize the envelope under {@link maxBytes}, dropping traces if it does
   * not fit, and recording that it did.
   *
   * The size is ESTIMATED from a sample and then verified, rather than measured
   * by stringifying everything first: the file this bounds was 30.6 MB, and
   * building that string to discover it is too big is the memory spike the cap
   * exists to prevent. Two verified passes are enough in practice; the loop is
   * bounded either way and the last resort drops every trace, which still
   * leaves a readable envelope saying what happened.
   */
  function serializeUnderCap(envelope: LoopProfileEnvelope): {
    body: string
    bytes: number
    traceCount: number
  } {
    const stacks = envelope.stacks as { traces?: unknown[] } | undefined
    const traces = Array.isArray(stacks?.traces) ? stacks.traces : undefined
    if (!traces || traces.length === 0) {
      const body = JSON.stringify(envelope)
      return { body, bytes: Buffer.byteLength(body), traceCount: envelope.traceCount ?? 0 }
    }

    const build = (count: number): { body: string; bytes: number; traceCount: number } => {
      const capped = count >= traces.length
      const kept = capped ? traces : evenly(traces, count)
      const next: LoopProfileEnvelope = {
        ...envelope,
        traceCount: kept.length,
        ...(capped
          ? {}
          : { tracesSampled: traces.length, tracesDropped: traces.length - kept.length }),
        stacks: { ...(stacks as object), traces: kept },
      }
      const body = JSON.stringify(next)
      return { body, bytes: Buffer.byteLength(body), traceCount: kept.length }
    }

    // The envelope's own weight, so the trace budget is what is actually left.
    const empty = Buffer.byteLength(
      JSON.stringify({ ...envelope, stacks: { ...(stacks as object), traces: [] } }),
    )
    const probe = evenly(traces, Math.min(64, traces.length))
    const perTrace = Math.max(1, Buffer.byteLength(JSON.stringify(probe)) / probe.length)
    let count = Math.max(0, Math.min(traces.length, Math.floor((maxBytes - empty) / perTrace)))

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const built = build(count)
      if (built.bytes <= maxBytes || count === 0) return built
      // Shrink by the ratio the real body just proved, with a little margin.
      count = Math.max(0, Math.floor((count * maxBytes * 0.95) / built.bytes))
    }
    return build(0)
  }

  /**
   * Delete this component's oldest profiles until they weigh no more than
   * `budget` together. The count cap alone left 20 files of up to 30.6 MB —
   * 600 MB per component of a directory nobody swept (POD-3834).
   */
  function pruneToBytes(budget: number): void {
    if (!existsSync(dir)) return
    const mine = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort()
      .map((name) => ({ name, bytes: statSync(join(dir, name)).size }))
    let total = mine.reduce((sum, file) => sum + file.bytes, 0)
    for (const file of mine) {
      if (total <= budget) return
      rmSync(join(dir, file.name), { force: true })
      total -= file.bytes
    }
  }

  function write(
    envelope: LoopProfileEnvelope,
    trigger: ProfileTrigger,
    atMs: number,
  ): {
    path: string
    bytes: number
    traceCount: number
  } {
    mkdirSync(dir, { recursive: true })
    const { body, bytes, traceCount } = serializeUnderCap(envelope)
    // Prune to one BELOW the cap first: this write is about to add one back, so
    // the directory is at `maxFiles` when it lands and never above it. The byte
    // budget is what is left after this file, for the same reason.
    pruneTo(maxFiles - 1)
    pruneToBytes(Math.max(0, maxComponentBytes - bytes))
    const path = join(dir, `${prefix}${fileStamp(atMs)}-${trigger}.json`)
    writeFileSync(path, body)
    return { path, bytes, traceCount }
  }

  return {
    get dir() {
      return dir
    },
    get keepClearMs() {
      return keepClearSpentMs
    },
    get keepClearIntervalMs() {
      return keepClearTimer === undefined ? 0 : keepClearNowMs
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
        // Refused, and the record says so (spec §8) — an agent that sent SIGUSR2
        // finds a file explaining why there are no stacks in it.
        const refuse = (
          reason: 'unavailable' | 'sample-rate',
          why: string,
        ): ProfileCaptureResult => {
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
            sampleIntervalUs: sample.us,
            refused: why,
          }
          const { path } = write(refusal, trigger, at)
          return { suppressed: true, reason, path }
        }

        const api = await resolveJsc()
        if (!api) return refuse('unavailable', 'no bun:jsc sampling profiler in this runtime')
        // THE COST BOUND (POD-3834). Arming cannot be undone, so a period nobody
        // chose is refused BEFORE it is paid for rather than discovered in the
        // next minute record. Already-armed processes fall straight through:
        // the cost is sunk and refusing would only strand the buffer undrained.
        if (!armed && !sample.stated && sample.us < PROFILE_MIN_SAMPLE_US) {
          return refuse(
            'sample-rate',
            `the sampler would run at ${sample.us}us, which nothing asked for, and it cannot be ` +
              `stopped once armed — start this process with ${JSC_SAMPLE_INTERVAL_ENV}=` +
              `${PROFILE_MIN_SAMPLE_US} or more (10000 is the default this install ships), ` +
              `or state ${JSC_SAMPLE_INTERVAL_ENV}=${sample.us} to accept the cost`,
          )
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
          sampleIntervalUs: sample.us,
          traceCount,
          profilerArmedForProcessLifetime: true,
          stacks,
        }
        // `write` may drop traces to hold the file under the byte cap, so the
        // count it reports is the one in the file, not the one in the window.
        const written = write(envelope, trigger, startedAt)
        return {
          suppressed: false,
          path: written.path,
          traceCount: written.traceCount,
          bytes: written.bytes,
        }
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
