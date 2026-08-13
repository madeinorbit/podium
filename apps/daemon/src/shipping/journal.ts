import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
}

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

/** Restart-safe, generation-fenced journal. Every mutation is one temp-file
 * rename, and job ids are hashed before becoming filenames. */
export class ShippingJobJournal {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  private path(jobId: string): string {
    return join(this.dir, `${createHash('sha256').update(jobId).digest('hex')}.json`)
  }

  get(jobId: string): ShippingJournalEntry | null {
    try {
      const parsed = JSON.parse(readFileSync(this.path(jobId), 'utf8')) as ShippingJournalEntry
      const request = ShippingJobRequestMessage.omit({
        type: true,
        requestId: true,
        action: true,
      }).parse(parsed.request)
      return { request, result: ShippingJobResult.parse(parsed.result) }
    } catch {
      return null
    }
  }

  list(): ShippingJournalEntry[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        try {
          const parsed = JSON.parse(
            readFileSync(join(this.dir, name), 'utf8'),
          ) as ShippingJournalEntry
          return [
            {
              request: ShippingJobRequestMessage.omit({
                type: true,
                requestId: true,
                action: true,
              }).parse(parsed.request),
              result: ShippingJobResult.parse(parsed.result),
            },
          ]
        } catch {
          return []
        }
      })
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
    return this.write({ request: existing.request, result })
  }

  private write(entry: ShippingJournalEntry): ShippingJournalEntry {
    const next = { request: entry.request, result: boundShippingResult(entry.result) }
    const target = this.path(entry.request.jobId)
    const temporary = join(this.dir, `.${randomUUID()}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 })
    renameSync(temporary, target)
    return next
  }
}
