import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type ShippingJobRequestMessage as ShippingJobRequest,
  ShippingJobRequestMessage,
  ShippingJobResult,
  type ShippingJobResult as ShippingJobResultValue,
} from '@podium/protocol'

const MAX_LOG_LINES = 64
const MAX_LOG_LINE_BYTES = 2_048
const MAX_ARTIFACT_REFS = 16

export interface ShippingJournalEntry {
  request: Omit<ShippingJobRequest, 'type' | 'requestId' | 'action'>
  result: ShippingJobResultValue
  acknowledgedAt?: string
}

export type ShippingJournalCrashPoint =
  | 'after-file-fsync'
  | 'after-rename'
  | 'after-directory-fsync'

const boundedLine = (line: string): string =>
  Buffer.from(line).subarray(0, MAX_LOG_LINE_BYTES).toString('utf8')

export function boundShippingResult(result: ShippingJobResultValue): ShippingJobResultValue {
  return ShippingJobResult.parse({
    ...result,
    summary: boundedLine(result.summary),
    logs: result.logs.slice(-MAX_LOG_LINES).map(boundedLine),
    artifactRefs: result.artifactRefs.slice(0, MAX_ARTIFACT_REFS).map(boundedLine),
  })
}

const durableRequest = (
  input: ShippingJobRequest,
): Omit<ShippingJobRequest, 'type' | 'requestId' | 'action'> => {
  const { type: _type, requestId: _requestId, action: _action, ...request } = input
  return request
}

const sameRequest = (
  left: ShippingJournalEntry['request'],
  right: ShippingJournalEntry['request'],
) => JSON.stringify(left) === JSON.stringify(right)

const assertResultBinding = (
  request: ShippingJournalEntry['request'],
  result: ShippingJobResultValue,
): void => {
  if (
    result.jobId !== request.jobId ||
    result.requestDigest !== request.requestDigest ||
    result.orderId !== request.orderId ||
    result.attemptId !== request.attemptId ||
    result.generation !== request.generation ||
    result.operation !== request.operation
  ) {
    throw new Error(`shipping job ${request.jobId} result binding collision`)
  }
}

/** Restart-safe, generation-fenced journal. Every mutation is one temp-file
 * rename, and job ids are hashed before becoming filenames. */
export class ShippingJobJournal {
  constructor(
    private readonly dir: string,
    private readonly crashPoint?: (point: ShippingJournalCrashPoint) => void,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  private path(jobId: string): string {
    return join(this.dir, `${createHash('sha256').update(jobId).digest('hex')}.json`)
  }

  get(jobId: string): ShippingJournalEntry | null {
    const path = this.path(jobId)
    if (!existsSync(path)) return null
    return this.read(path)
  }

  list(): ShippingJournalEntry[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.read(join(this.dir, name)))
  }

  private read(path: string): ShippingJournalEntry {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ShippingJournalEntry
    const request = ShippingJobRequestMessage.omit({
      type: true,
      requestId: true,
      action: true,
    }).parse(parsed.request)
    const result = ShippingJobResult.parse(parsed.result)
    assertResultBinding(request, result)
    return {
      request,
      result,
      ...(typeof parsed.acknowledgedAt === 'string'
        ? { acknowledgedAt: parsed.acknowledgedAt }
        : {}),
    }
  }

  latestGeneration(orderId: string): number | null {
    let latest: number | null = null
    for (const entry of this.list()) {
      if (entry.request.orderId !== orderId) continue
      latest = Math.max(latest ?? 0, entry.request.generation)
    }
    return latest
  }

  begin(input: ShippingJobRequest, result: ShippingJobResultValue): ShippingJournalEntry {
    const request = durableRequest(input)
    assertResultBinding(request, result)
    const existing = this.get(input.jobId)
    if (existing) {
      if (existing.request.generation > input.generation) return existing
      if (existing.request.generation === input.generation) {
        if (!sameRequest(existing.request, request)) {
          throw new Error(
            `shipping job ${input.jobId} generation ${input.generation} changed inputs`,
          )
        }
        return existing
      }
    }
    return this.write({ request, result })
  }

  update(jobId: string, generation: number, result: ShippingJobResultValue): ShippingJournalEntry {
    const existing = this.get(jobId)
    if (!existing || existing.request.generation !== generation) {
      throw new Error(`shipping job ${jobId} generation fence failed`)
    }
    assertResultBinding(existing.request, result)
    return this.write({
      request: existing.request,
      result,
      ...(existing.acknowledgedAt ? { acknowledgedAt: existing.acknowledgedAt } : {}),
    })
  }

  acknowledge(jobId: string, generation: number, at: string): ShippingJournalEntry {
    const existing = this.get(jobId)
    if (!existing || existing.request.generation !== generation) {
      throw new Error(`shipping job ${jobId} generation fence failed`)
    }
    if (existing.result.state === 'running') {
      throw new Error(`running shipping job ${jobId} cannot be acknowledged`)
    }
    if (existing.acknowledgedAt) return existing
    return this.write({ ...existing, acknowledgedAt: at })
  }

  private write(entry: ShippingJournalEntry): ShippingJournalEntry {
    const next = {
      request: entry.request,
      result: boundShippingResult(entry.result),
      ...(entry.acknowledgedAt ? { acknowledgedAt: entry.acknowledgedAt } : {}),
    }
    const target = this.path(entry.request.jobId)
    const temporary = join(this.dir, `.${randomUUID()}.tmp`)
    const file = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(file, `${JSON.stringify(next)}\n`)
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    this.crashPoint?.('after-file-fsync')
    renameSync(temporary, target)
    this.crashPoint?.('after-rename')
    const directory = openSync(this.dir, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
    this.crashPoint?.('after-directory-fsync')
    return next
  }
}
