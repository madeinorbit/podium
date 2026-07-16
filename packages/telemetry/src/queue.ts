/**
 * The pending-report queue [spec:SP-f933].
 *
 * `<state-dir>/telemetry/queue.jsonl` — one JSON report per line, capped, and
 * plain text on purpose: "you can read exactly what is waiting to be sent, with
 * `cat`" is worth more to a skeptical user than any amount of prose, and it is
 * what `podium telemetry show` prints.
 *
 * Capped both ways (entries and bytes) because an air-gapped install queues
 * forever: telemetry must never grow without bound in someone's state dir. When
 * the cap is hit the OLDEST entries are dropped — a stale report has less value
 * than a fresh one, and dropping the new one would make the queue permanently
 * self-blocking.
 *
 * Every function here is best-effort: a telemetry file being unwritable must
 * never surface to a user, so IO failures are swallowed (the caller has no
 * recovery worth taking, and there is no user-visible feature to degrade).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type TelemetryReport, TelemetryReport as TelemetryReportSchema } from './schema'

/** At one report a day, 32 is a month of offline backlog — far past the point
 *  where old usage counters are worth sending. */
export const MAX_QUEUE_ENTRIES = 32
/** Hard byte ceiling, independent of the entry count. */
export const MAX_QUEUE_BYTES = 64 * 1024

export function telemetryDir(stateDir: string): string {
  return join(stateDir, 'telemetry')
}

export function queuePath(stateDir: string): string {
  return join(telemetryDir(stateDir), 'queue.jsonl')
}

export function lastSentPath(stateDir: string): string {
  return join(telemetryDir(stateDir), 'last-sent.json')
}

function readLines(path: string): string[] {
  try {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
  } catch {
    return []
  }
}

function writeLines(path: string, lines: string[]): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, lines.length ? `${lines.join('\n')}\n` : '')
  } catch {
    // best-effort by design — see the file header
  }
}

/** Enforce both caps, dropping from the FRONT (oldest first). */
function applyCaps(lines: string[]): string[] {
  let kept = lines.slice(-MAX_QUEUE_ENTRIES)
  while (kept.length > 1 && kept.join('\n').length > MAX_QUEUE_BYTES) kept = kept.slice(1)
  return kept
}

/**
 * Append a report. Re-validates against the schema first: nothing reaches the
 * queue — and therefore nothing can reach the wire — that the published schema
 * does not admit, even if a caller hand-built the object.
 */
export function enqueueReport(stateDir: string, report: TelemetryReport): boolean {
  const parsed = TelemetryReportSchema.safeParse(report)
  if (!parsed.success) return false
  const path = queuePath(stateDir)
  writeLines(path, applyCaps([...readLines(path), JSON.stringify(parsed.data)]))
  return true
}

/** Every pending report. Malformed or unschema'd lines are skipped, not thrown:
 *  a corrupt queue file must never break a boot or a flush. */
export function readQueue(stateDir: string): TelemetryReport[] {
  const reports: TelemetryReport[] = []
  for (const line of readLines(queuePath(stateDir))) {
    try {
      const parsed = TelemetryReportSchema.safeParse(JSON.parse(line))
      if (parsed.success) reports.push(parsed.data)
    } catch {
      // skip
    }
  }
  return reports
}

export function queueLength(stateDir: string): number {
  return readLines(queuePath(stateDir)).length
}

/** Drop the first `count` entries (the ones a flush just sent). */
export function dropFromQueue(stateDir: string, count: number): void {
  if (count <= 0) return
  const path = queuePath(stateDir)
  writeLines(path, readLines(path).slice(count))
}

export function clearQueue(stateDir: string): void {
  writeLines(queuePath(stateDir), [])
}

export interface LastSent {
  /** ISO timestamp of the successful POST. */
  at: string
  report: TelemetryReport
}

/** Record what actually went over the wire, so `podium telemetry show` can show
 *  the user the real thing rather than a re-derived approximation of it. */
export function recordLastSent(stateDir: string, report: TelemetryReport, at = new Date()): void {
  try {
    mkdirSync(telemetryDir(stateDir), { recursive: true })
    writeFileSync(
      lastSentPath(stateDir),
      `${JSON.stringify({ at: at.toISOString(), report } satisfies LastSent, null, 2)}\n`,
    )
  } catch {
    // best-effort by design
  }
}

export function readLastSent(stateDir: string): LastSent | undefined {
  try {
    if (!existsSync(lastSentPath(stateDir))) return undefined
    const raw = JSON.parse(readFileSync(lastSentPath(stateDir), 'utf8')) as LastSent
    const parsed = TelemetryReportSchema.safeParse(raw?.report)
    if (!parsed.success || typeof raw.at !== 'string') return undefined
    return { at: raw.at, report: parsed.data }
  } catch {
    return undefined
  }
}
