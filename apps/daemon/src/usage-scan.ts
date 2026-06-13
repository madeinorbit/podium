import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LineDecoder } from '@podium/agent-bridge'
import type { UsageBucketWire } from '@podium/protocol'

/**
 * Harvest token usage from Claude Code transcript JSONLs (each assistant record
 * carries message.usage). ccusage-style coverage, in-house so it flows over
 * Podium's own wire. Codex's session logs can join behind the same bucket shape.
 *
 * Files whose mtime predates the window are skipped without reading — a 7-day
 * scan touches only recently-active transcripts.
 */

export interface UsageRecord {
  tsMs: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/** Parse one JSONL record; null when it carries no usage. */
export function usageFromRecord(record: unknown): UsageRecord | null {
  if (typeof record !== 'object' || record === null) return null
  const r = record as Record<string, unknown>
  if (r.type !== 'assistant') return null
  const message = r.message as Record<string, unknown> | undefined
  const usage = message?.usage as Record<string, unknown> | undefined
  if (!usage) return null
  const tsMs = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : Number.NaN
  if (Number.isNaN(tsMs)) return null
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    tsMs,
    model: typeof message?.model === 'string' ? (message.model as string) : 'unknown',
    inputTokens: n(usage.input_tokens),
    outputTokens: n(usage.output_tokens),
    cacheReadTokens: n(usage.cache_read_input_tokens),
    cacheCreationTokens: n(usage.cache_creation_input_tokens),
  }
}

/** Fold records into hour×model buckets. */
export function bucketize(records: UsageRecord[]): UsageBucketWire[] {
  const buckets = new Map<string, UsageBucketWire>()
  for (const rec of records) {
    const hour = new Date(Math.floor(rec.tsMs / 3_600_000) * 3_600_000).toISOString()
    const key = `${hour}|${rec.model}`
    let b = buckets.get(key)
    if (!b) {
      b = {
        hour,
        model: rec.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        messages: 0,
      }
      buckets.set(key, b)
    }
    b.inputTokens += rec.inputTokens
    b.outputTokens += rec.outputTokens
    b.cacheReadTokens += rec.cacheReadTokens
    b.cacheCreationTokens += rec.cacheCreationTokens
    b.messages += 1
  }
  return [...buckets.values()].sort((a, b) => a.hour.localeCompare(b.hour))
}

export async function scanClaudeUsage(opts: {
  sinceMs: number
  homeDir?: string
}): Promise<UsageBucketWire[]> {
  const projectsDir = join(opts.homeDir ?? homedir(), '.claude', 'projects')
  const records: UsageRecord[] = []
  let projectDirs: string[]
  try {
    projectDirs = await readdir(projectsDir)
  } catch {
    return [] // no Claude installation on this box
  }
  for (const project of projectDirs) {
    const dir = join(projectsDir, project)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(dir, file)
      try {
        const info = await stat(path)
        if (info.mtimeMs < opts.sinceMs) continue
        records.push(...(await readUsageRecords(path, opts.sinceMs)))
      } catch {
        // unreadable file — skip
      }
    }
  }
  return bucketize(records)
}

async function readUsageRecords(path: string, sinceMs: number): Promise<UsageRecord[]> {
  const handle = await open(path, 'r')
  const out: UsageRecord[] = []
  try {
    const { size } = await handle.stat()
    // Transcripts are append-only and can be large; stream in 1 MiB slabs.
    // LineDecoder keeps undecoded trailing bytes as a Buffer, so a multi-byte
    // character split across a slab boundary is reassembled, not mangled.
    const CHUNK = 1024 * 1024
    const decoder = new LineDecoder()
    let offset = 0
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset)
      const buffer = Buffer.alloc(len)
      await handle.read(buffer, 0, len, offset)
      offset += len
      for (const line of decoder.push(buffer)) collect(line, sinceMs, out)
    }
    const last = decoder.flush()
    if (last !== null) collect(last, sinceMs, out)
  } finally {
    await handle.close()
  }
  return out
}

function collect(line: string, sinceMs: number, out: UsageRecord[]): void {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.includes('"usage"')) return
  try {
    const rec = usageFromRecord(JSON.parse(trimmed))
    if (rec && rec.tsMs >= sinceMs) out.push(rec)
  } catch {
    // torn line — skip
  }
}
