/**
 * STALL EARLY WARNING [POD-7037, POD-7027 guards 2, 5 and 6].
 *
 * Every server stall already writes one line naming the statements of its
 * second. That is enough to reconstruct an incident afterwards and not enough
 * to notice one: on 2026-11-16 one statement held the server for 203 s over 21
 * calls in 16 minutes, and the only way to see it was to aggregate 254 stall
 * lines by a hash by hand. This module does that aggregation in the process and
 * says so in a few lines:
 *
 *   - IMMEDIATE ALERTS, each at most once an hour: a statement that has spent
 *     more than 30 s inside stalls this hour, any stall over 5 s, and any
 *     single execution that read more than 10 MB from the database file.
 *   - AN HOURLY DIGEST of the five statements with the most stall time, by
 *     definition name (`queryDefinitionName`) rather than by hash. Nothing is
 *     written for an hour without stalls.
 *   - A POST-DEPLOY CHECK: the first 30 minutes of a build's stall time are
 *     compared with the previous build's first 30 minutes, kept in a small JSON
 *     file next to the loop minute files. A build worse by the factor warns as
 *     soon as its sum crosses the line, not at the end of the window: the sum
 *     only grows, so waiting adds nothing but delay.
 *
 * It holds no timer of its own. The server feeds it each stall and each second's
 * heavy reads, and calls {@link StallWatch.tick} once a minute.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  formatBytes,
  formatQueryCost,
  type HeavyStatementRead,
  type QueryCost,
  queryDefinitionName,
} from './query-attribution'

export interface StallWatchThresholds {
  /** How often the digest is written, and the period every alert is limited to. */
  digestIntervalMs: number
  /** Statements listed in a digest. */
  digestTop: number
  /** One statement's time inside stalls in one period that raises an alert. */
  statementStallMs: number
  /** A single stall this long raises an alert. */
  longStallMs: number
  /** Heavy-read alerts per period, over all statements. */
  heavyReadAlerts: number
  /** The post-deploy window, measured from {@link StallWatchOptions.startedAt}. */
  deployWindowMs: number
  /** A build is a regression when its window's stall time exceeds the previous one's by this factor. */
  regressionFactor: number
  /** ...and is at least this much: a quiet build that doubles a quiet build is still quiet. */
  regressionFloorMs: number
  /** The previous build's figure is never taken as less than this when comparing. */
  baselineFloorMs: number
  /** Build summaries kept in the file. */
  keepBuilds: number
}

export const STALL_WATCH_DEFAULTS: StallWatchThresholds = {
  digestIntervalMs: 60 * 60_000,
  digestTop: 5,
  statementStallMs: 30_000,
  longStallMs: 5_000,
  heavyReadAlerts: 20,
  deployWindowMs: 30 * 60_000,
  regressionFactor: 2,
  regressionFloorMs: 30_000,
  baselineFloorMs: 5_000,
  keepBuilds: 10,
}

/** One build's first window, as persisted. */
export interface BuildStallSummary {
  build: string
  /** ISO time the process that measured it started. */
  startedAt: string
  windowMinutes: number
  stalls: number
  stallMs: number
  maxStallMs: number
}

interface SummaryFile {
  builds: BuildStallSummary[]
}

export interface StallWatchLog {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

export interface StallWatchOptions {
  /** This process's build identity, as `/version` reports it. */
  build: string
  log: StallWatchLog
  /** Wall clock, ms. */
  now?: () => number
  /** When this process started, ms. Defaults to the first reading of `now`. */
  startedAt?: number
  /** The build summary file. Absent turns the post-deploy check off. */
  summaryPath?: string
  thresholds?: Partial<StallWatchThresholds>
  /** Definition name of a statement key. Defaults to the profiler's. */
  nameOf?: (key: string) => string | undefined
  readFile?: (path: string) => string | undefined
  writeFile?: (path: string, contents: string) => void
}

export interface StallWatch {
  /** One stall, with the statements of the window it happened in. */
  noteStall(durationMs: number, window: ReadonlyMap<string, QueryCost>): void
  /** The executions that read past the heavy-read line since the last call. */
  noteHeavyReads(reads: readonly HeavyStatementRead[]): void
  /** Writes a due digest and closes a due post-deploy window. Call once a minute. */
  tick(): void
}

interface PeriodCost {
  count: number
  stallMs: number
  rows: number
  readBytes?: number
  readSamples?: number
}

export function createStallWatch(options: StallWatchOptions): StallWatch {
  const t = { ...STALL_WATCH_DEFAULTS, ...options.thresholds }
  const now = options.now ?? Date.now
  const log = options.log
  const nameOf = options.nameOf ?? queryDefinitionName
  const readFile = options.readFile ?? readSummaryFile
  const writeFile = options.writeFile ?? writeSummaryFile
  const startedAt = options.startedAt ?? now()

  // The current period: what the digest reports and what every alert is limited to.
  let periodStart = startedAt
  let stalls = 0
  let stallMs = 0
  let maxStallMs = 0
  let longStalls = 0
  let heavyReads = 0
  let heavyAlerts = 0
  const statements = new Map<string, PeriodCost>()
  const alerted = new Set<string>()

  // The post-deploy window: one per process.
  const deploy = { stalls: 0, stallMs: 0, maxStallMs: 0, closed: false, warned: false }
  const previous = options.summaryPath ? previousBuild(readSummary()) : undefined

  function readSummary(): SummaryFile {
    if (!options.summaryPath) return { builds: [] }
    try {
      const text = readFile(options.summaryPath)
      if (text === undefined) return { builds: [] }
      const parsed = JSON.parse(text) as Partial<SummaryFile>
      return { builds: Array.isArray(parsed.builds) ? parsed.builds.filter(isSummary) : [] }
    } catch {
      return { builds: [] }
    }
  }

  /** The newest summary of a DIFFERENT build: a restart compares with the deploy before it. */
  function previousBuild(file: SummaryFile): BuildStallSummary | undefined {
    for (let i = file.builds.length - 1; i >= 0; i--) {
      if (file.builds[i]!.build !== options.build) return file.builds[i]
    }
    return undefined
  }

  const label = (key: string): string => {
    const name = nameOf(key)
    return name ? `[${name}] ${key}` : key
  }

  function rollPeriod(at: number): void {
    if (at - periodStart < t.digestIntervalMs) return
    writeDigest(at)
    periodStart = at
    stalls = 0
    stallMs = 0
    maxStallMs = 0
    longStalls = 0
    heavyReads = 0
    heavyAlerts = 0
    statements.clear()
    alerted.clear()
  }

  function writeDigest(at: number): void {
    if (stalls === 0) return
    const top = [...statements]
      .sort((a, b) => b[1].stallMs - a[1].stallMs || a[0].localeCompare(b[0]))
      .slice(0, t.digestTop)
    const overBudget = top.filter(([, cost]) => cost.stallMs >= t.statementStallMs).length
    const fields = {
      build: options.build,
      minutes: Math.round((at - periodStart) / 60_000),
      stalls,
      stallMs: Math.round(stallMs),
      maxStallMs: Math.round(maxStallMs),
      longStalls,
      statementsOverBudget: overBudget,
      heavyReads,
      top: top.map(([key, cost]) => digestLine(key, cost)),
    }
    if (longStalls > 0 || overBudget > 0) log.warn('server stall digest', fields)
    else log.info('server stall digest', fields)
  }

  function digestLine(key: string, cost: PeriodCost): string {
    return formatQueryCost(
      key,
      {
        count: cost.count,
        wallMs: cost.stallMs,
        rows: cost.rows,
        ...(cost.readBytes === undefined ? {} : { readBytes: cost.readBytes }),
      },
      nameOf,
    )
  }

  function checkRegression(final: boolean): void {
    if (!previous || deploy.warned) return
    const limit = t.regressionFactor * Math.max(previous.stallMs, t.baselineFloorMs)
    if (deploy.stallMs < t.regressionFloorMs || deploy.stallMs <= limit) {
      if (final) {
        log.info('post-deploy stall check passed', {
          build: options.build,
          previousBuild: previous.build,
          stallMs: Math.round(deploy.stallMs),
          previousStallMs: Math.round(previous.stallMs),
          windowMinutes: t.deployWindowMs / 60_000,
        })
      }
      return
    }
    deploy.warned = true
    log.warn('post-deploy stall regression', {
      build: options.build,
      previousBuild: previous.build,
      stallMs: Math.round(deploy.stallMs),
      previousStallMs: Math.round(previous.stallMs),
      stalls: deploy.stalls,
      previousStalls: previous.stalls,
      ratio: Number((deploy.stallMs / Math.max(previous.stallMs, t.baselineFloorMs)).toFixed(1)),
      minutesSinceStart: Math.round((now() - startedAt) / 60_000),
      windowMinutes: t.deployWindowMs / 60_000,
    })
  }

  function closeDeployWindow(at: number): void {
    if (deploy.closed || at - startedAt < t.deployWindowMs) return
    deploy.closed = true
    checkRegression(true)
    if (!options.summaryPath) return
    const file = readSummary()
    // The first full window of a build is its figure; a restart of the same
    // build does not replace it.
    if (file.builds.some((each) => each.build === options.build)) return
    file.builds.push({
      build: options.build,
      startedAt: new Date(startedAt).toISOString(),
      windowMinutes: t.deployWindowMs / 60_000,
      stalls: deploy.stalls,
      stallMs: Math.round(deploy.stallMs),
      maxStallMs: Math.round(deploy.maxStallMs),
    })
    file.builds = file.builds.slice(-t.keepBuilds)
    try {
      writeFile(options.summaryPath, `${JSON.stringify(file, null, 2)}\n`)
    } catch (error) {
      log.warn('post-deploy stall summary not written', {
        path: options.summaryPath,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    noteStall(durationMs, window) {
      const at = now()
      rollPeriod(at)
      stalls += 1
      stallMs += durationMs
      maxStallMs = Math.max(maxStallMs, durationMs)
      for (const [key, cost] of window) {
        const held = statements.get(key) ?? { count: 0, stallMs: 0, rows: 0 }
        held.count += cost.count
        held.stallMs += cost.wallMs
        held.rows += cost.rows
        if (cost.readBytes !== undefined) {
          held.readBytes = (held.readBytes ?? 0) + cost.readBytes
          held.readSamples = (held.readSamples ?? 0) + (cost.readSamples ?? 0)
        }
        statements.set(key, held)
        if (held.stallMs >= t.statementStallMs && !alerted.has(`statement ${key}`)) {
          alerted.add(`statement ${key}`)
          log.warn('statement stall time over budget', {
            statement: label(key),
            stallMs: Math.round(held.stallMs),
            calls: held.count,
            rows: held.rows,
            ...(held.readBytes === undefined ? {} : { read: formatBytes(held.readBytes) }),
            budgetMs: t.statementStallMs,
            periodMinutes: t.digestIntervalMs / 60_000,
          })
        }
      }
      if (durationMs >= t.longStallMs) {
        longStalls += 1
        if (!alerted.has('long stall')) {
          alerted.add('long stall')
          const worst = [...window].sort((a, b) => b[1].wallMs - a[1].wallMs)[0]
          log.warn('server stall over limit', {
            durationMs: Math.round(durationMs),
            limitMs: t.longStallMs,
            ...(worst
              ? { statement: label(worst[0]), statementMs: Math.round(worst[1].wallMs) }
              : {}),
            // Later long stalls this period are counted in the digest, not logged.
            nextAlertInMinutes: Math.round((periodStart + t.digestIntervalMs - at) / 60_000),
          })
        }
      }
      if (!deploy.closed && at - startedAt < t.deployWindowMs) {
        deploy.stalls += 1
        deploy.stallMs += durationMs
        deploy.maxStallMs = Math.max(deploy.maxStallMs, durationMs)
        checkRegression(false)
      }
    },

    noteHeavyReads(reads) {
      if (reads.length === 0) return
      rollPeriod(now())
      for (const read of reads) {
        heavyReads += 1
        if (alerted.has(`read ${read.key}`) || heavyAlerts >= t.heavyReadAlerts) continue
        alerted.add(`read ${read.key}`)
        heavyAlerts += 1
        log.warn('statement read heavy', {
          statement: label(read.key),
          read: formatBytes(read.readBytes),
          readBytes: read.readBytes,
          wallMs: Math.round(read.wallMs),
          rows: read.rows,
          // Bytes per returned row is the walk's signature: a lookup reads a
          // few pages per row, a walk reads megabytes for none.
          bytesPerRow: Math.round(read.readBytes / Math.max(1, read.rows)),
        })
      }
    },

    tick() {
      const at = now()
      rollPeriod(at)
      closeDeployWindow(at)
    },
  }
}

function isSummary(value: unknown): value is BuildStallSummary {
  if (value === null || typeof value !== 'object') return false
  const each = value as Record<string, unknown>
  return typeof each.build === 'string' && typeof each.stallMs === 'number'
}

function readSummaryFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Write-then-rename, so a crash mid-write leaves the previous file whole. */
function writeSummaryFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, contents)
  renameSync(temporary, path)
}
