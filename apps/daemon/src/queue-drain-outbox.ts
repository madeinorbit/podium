import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  RuntimeQueueDrainAbandonedMessage,
  type RuntimeQueueDrainAbandonedMessage as QueueDrainMessage,
} from '@podium/protocol/daemon'

const FILE_NAME = 'queue-drain-outbox.json'
const FILE_VERSION = 1

export type DurableQueueDrainReport = QueueDrainMessage & { reportId: string }

export interface QueueDrainOutbox {
  enqueue(report: DurableQueueDrainReport): void
  acknowledge(reportId: string): boolean
  pending(): readonly DurableQueueDrainReport[]
}

function fsyncDirectory(dir: string): void {
  try {
    const dirFd = openSync(dir, 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch (error) {
    // Windows does not permit opening directories as file descriptors. The
    // temp file itself was still fsynced before the atomic rename.
    if (process.platform !== 'win32') throw error
  }
}

function parseReports(raw: string, path: string): DurableQueueDrainReport[] {
  const parsed = JSON.parse(raw) as { version?: unknown; reports?: unknown }
  if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.reports)) {
    throw new Error(`invalid queue-drain outbox: ${path}`)
  }
  return parsed.reports.map((value) => {
    const report = RuntimeQueueDrainAbandonedMessage.parse(value)
    if (!report.reportId) {
      throw new Error(`queue-drain outbox report has no reportId: ${path}`)
    }
    return { ...report, reportId: report.reportId }
  })
}

/**
 * The one durable daemon queue whose loss would strand a server receipt.
 *
 * Enqueue is synchronous on purpose: the terminal driver drops its in-memory
 * turn immediately after this call returns, so returning before the report is
 * on disk would merely move the disconnect window one layer down. The temp file
 * is fsynced before rename and the containing directory is fsynced afterwards;
 * a complete temp file left by a crash is the next generation and supersedes
 * the previous complete file when the daemon starts again.
 */
export function createQueueDrainOutbox(dir: string): QueueDrainOutbox {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, FILE_NAME)
  const temporary = `${path}.tmp`
  let reports = new Map<string, DurableQueueDrainReport>()

  if (existsSync(temporary)) {
    let recovered: DurableQueueDrainReport[] | undefined
    try {
      // Every write starts from the canonical generation. A parseable temp is
      // therefore its complete successor, even when the older file exists.
      recovered = parseReports(readFileSync(temporary, 'utf8'), temporary)
    } catch (error) {
      // A crash during the temp write can leave an incomplete successor. The
      // previous canonical generation remains safe in that case.
      if (!existsSync(path)) throw error
    }
    if (recovered) {
      reports = new Map(recovered.map((report) => [report.reportId, report]))
      renameSync(temporary, path)
      fsyncDirectory(dir)
    } else {
      reports = new Map(
        parseReports(readFileSync(path, 'utf8'), path).map((report) => [report.reportId, report]),
      )
    }
  } else if (existsSync(path)) {
    reports = new Map(
      parseReports(readFileSync(path, 'utf8'), path).map((report) => [report.reportId, report]),
    )
  }

  const persist = (next: Map<string, DurableQueueDrainReport>): void => {
    const body = `${JSON.stringify({ version: FILE_VERSION, reports: [...next.values()] }, null, 2)}\n`
    const fd = openSync(temporary, 'w', 0o600)
    try {
      writeFileSync(fd, body)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
    fsyncDirectory(dir)
  }

  return {
    enqueue(report) {
      const existing = reports.get(report.reportId)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(report)) {
          throw new Error(`queue-drain report id collision: ${report.reportId}`)
        }
        return
      }
      const next = new Map(reports)
      next.set(report.reportId, report)
      persist(next)
      reports = next
    },
    acknowledge(reportId) {
      if (!reports.has(reportId)) return false
      const next = new Map(reports)
      next.delete(reportId)
      persist(next)
      reports = next
      return true
    },
    pending: () => [...reports.values()],
  }
}
