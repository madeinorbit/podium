import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const RELEASE_BUILD_TIMING_EVIDENCE = 'release-build-timing' as const
export const RELEASE_BUILD_TIMING_ENABLED_ENV = 'PODIUM_RELEASE_BUILD_TIMING'
export const RELEASE_BUILD_TIMING_DIR_ENV = 'PODIUM_RELEASE_TIMING_DIR'
export const RELEASE_BUILD_TIMING_VERSION_ENV = 'PODIUM_RELEASE_TIMING_VERSION'
export const RELEASE_BUILD_TIMING_SHA_ENV = 'PODIUM_RELEASE_TIMING_SHA'

export interface ReleaseBuildTimingRecord {
  evidence: typeof RELEASE_BUILD_TIMING_EVIDENCE
  granularity: 'phase' | 'task'
  phase: string
  task?: string
  outcome: 'success' | 'failure'
  durationMs: number
  channel?: string
  version?: string
  sourceSha?: string
  target?: string
}

export type ReleaseBuildTimingLabels = Omit<
  ReleaseBuildTimingRecord,
  'evidence' | 'outcome' | 'durationMs'
>

export interface ReleaseBuildTimingDeps {
  /** Explicit activation for the local development publisher. Defaults to the opt-in env flag. */
  enabled?: boolean
  emit?: (record: ReleaseBuildTimingRecord) => void
  /** Test seam; production uses the process monotonic clock. */
  now?: () => number
  /** Durable evidence directory. No file is written when this and the env seam are absent. */
  outputDirectory?: string
  context?: Partial<Pick<ReleaseBuildTimingRecord, 'channel' | 'version' | 'sourceSha'>>
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-')
}

/** The staging filename shared by the timing sink and the build-ledger mover. */
export function releaseBuildTimingFileName(identity: string): string {
  return `${safePart(identity)}.jsonl`
}

export function releaseBuildTimingEnabled(deps: ReleaseBuildTimingDeps = {}): boolean {
  return deps.enabled ?? (deps.env ?? process.env)[RELEASE_BUILD_TIMING_ENABLED_ENV] === '1'
}

function environmentContext(
  env: NodeJS.ProcessEnv,
): Partial<Pick<ReleaseBuildTimingRecord, 'channel' | 'version' | 'sourceSha' | 'target'>> {
  return {
    ...(env.PODIUM_RELEASE_CHANNEL ? { channel: env.PODIUM_RELEASE_CHANNEL } : {}),
    ...(env[RELEASE_BUILD_TIMING_VERSION_ENV]
      ? { version: env[RELEASE_BUILD_TIMING_VERSION_ENV] }
      : {}),
    ...(env[RELEASE_BUILD_TIMING_SHA_ENV] ? { sourceSha: env[RELEASE_BUILD_TIMING_SHA_ENV] } : {}),
    ...(env.PODIUM_RELEASE_TIMING_TARGET ? { target: env.PODIUM_RELEASE_TIMING_TARGET } : {}),
  }
}

export function formatReleaseBuildTiming(record: ReleaseBuildTimingRecord): string {
  return `[release-build-timing] ${JSON.stringify(record)}`
}

/** Fail-open log and JSONL sink shared by the server and its detached build processes. */
export function emitReleaseBuildTiming(
  record: ReleaseBuildTimingRecord,
  deps: ReleaseBuildTimingDeps = {},
): void {
  ;(deps.log ?? console.log)(formatReleaseBuildTiming(record))
  const env = deps.env ?? process.env
  const root = deps.outputDirectory ?? env[RELEASE_BUILD_TIMING_DIR_ENV]
  if (!root) return
  mkdirSync(root, { recursive: true })
  const identity = record.version ?? record.sourceSha ?? 'development-release'
  appendFileSync(join(root, releaseBuildTimingFileName(identity)), `${JSON.stringify(record)}\n`)
}

function readClock(now: () => number): number | undefined {
  try {
    const value = now()
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

function record(
  labels: ReleaseBuildTimingLabels,
  outcome: ReleaseBuildTimingRecord['outcome'],
  startedAt: number | undefined,
  deps: ReleaseBuildTimingDeps,
): void {
  if (startedAt === undefined) return
  const now = deps.now ?? (() => globalThis.performance.now())
  const finishedAt = readClock(now)
  if (finishedAt === undefined) return
  const durationMs = Math.round(Math.max(0, finishedAt - startedAt) * 1_000) / 1_000
  const env = deps.env ?? process.env
  const timingRecord: ReleaseBuildTimingRecord = {
    evidence: RELEASE_BUILD_TIMING_EVIDENCE,
    ...environmentContext(env),
    ...deps.context,
    ...labels,
    outcome,
    durationMs,
  }
  try {
    ;(deps.emit ?? ((item) => emitReleaseBuildTiming(item, deps)))(timingRecord)
  } catch {
    // Timing observes the build. A broken evidence sink must never change its result.
  }
}

export function timeReleaseBuildSync<T>(
  labels: ReleaseBuildTimingLabels,
  run: () => T,
  deps: ReleaseBuildTimingDeps = {},
): T {
  if (!releaseBuildTimingEnabled(deps)) return run()
  const now = deps.now ?? (() => globalThis.performance.now())
  const startedAt = readClock(now)
  try {
    const result = run()
    record(labels, 'success', startedAt, deps)
    return result
  } catch (error) {
    record(labels, 'failure', startedAt, deps)
    throw error
  }
}

export async function timeReleaseBuild<T>(
  labels: ReleaseBuildTimingLabels,
  run: () => Promise<T> | T,
  deps: ReleaseBuildTimingDeps = {},
): Promise<T> {
  if (!releaseBuildTimingEnabled(deps)) return run()
  const now = deps.now ?? (() => globalThis.performance.now())
  const startedAt = readClock(now)
  try {
    const result = await run()
    record(labels, 'success', startedAt, deps)
    return result
  } catch (error) {
    record(labels, 'failure', startedAt, deps)
    throw error
  }
}

type ReleaseBuildTimingTaskLabels = Omit<ReleaseBuildTimingLabels, 'granularity' | 'task'> & {
  task: string
}

/** Emit a phase sample and its exact task boundary from one monotonic interval. */
export function timeReleaseBuildTaskSync<T>(
  labels: ReleaseBuildTimingTaskLabels,
  run: () => T,
  deps: ReleaseBuildTimingDeps = {},
): T {
  return timeReleaseBuildSync(
    { ...labels, granularity: 'phase' },
    () => timeReleaseBuildSync({ ...labels, granularity: 'task' }, run, deps),
    deps,
  )
}

/** Async counterpart used by the local approval-to-publish path. */
export function timeReleaseBuildTask<T>(
  labels: ReleaseBuildTimingTaskLabels,
  run: () => Promise<T> | T,
  deps: ReleaseBuildTimingDeps = {},
): Promise<T> {
  return timeReleaseBuild(
    { ...labels, granularity: 'phase' },
    () => timeReleaseBuild({ ...labels, granularity: 'task' }, run, deps),
    deps,
  )
}

/** Environment inherited by the approved checkout's build processes. */
export function releaseBuildTimingEnvironment(
  deps: ReleaseBuildTimingDeps,
  context: Pick<ReleaseBuildTimingRecord, 'channel' | 'version' | 'sourceSha'>,
): NodeJS.ProcessEnv {
  if (!releaseBuildTimingEnabled(deps)) return {}
  return {
    [RELEASE_BUILD_TIMING_ENABLED_ENV]: '1',
    ...(deps.outputDirectory ? { [RELEASE_BUILD_TIMING_DIR_ENV]: deps.outputDirectory } : {}),
    PODIUM_RELEASE_CHANNEL: context.channel,
    [RELEASE_BUILD_TIMING_VERSION_ENV]: context.version,
    [RELEASE_BUILD_TIMING_SHA_ENV]: context.sourceSha,
  }
}
