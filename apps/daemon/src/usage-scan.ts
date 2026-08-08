import type { Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LineDecoder } from '@podium/harness'
import type { UsageBucketWire } from '@podium/model'

/**
 * Harvest token usage from harness transcript JSONLs — Claude Code (each
 * assistant record carries message.usage) and Codex (each turn emits a
 * `token_count` event). ccusage-style coverage, in-house so it flows over
 * Podium's own wire, folded into one hour×model bucket set by `scanHostUsage`.
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

/**
 * The model a Codex `turn_context` record announces, or undefined for any other
 * record. Codex's `token_count` events do NOT name a model, and `session_meta`
 * doesn't either — `turn_context.payload.model` is the only source, so a scan
 * carries the last one it saw forward. Every rollout observed writes its first
 * `turn_context` before its first `token_count`, so nothing is attributed to the
 * fallback in practice; a rollout old enough to lack the record entirely reads
 * as `unknown` rather than being silently dropped.
 */
export function codexModelOf(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const r = record as Record<string, unknown>
  if (r.type !== 'turn_context') return undefined
  const payload = r.payload as Record<string, unknown> | undefined
  return typeof payload?.model === 'string' ? payload.model : undefined
}

/**
 * Parse one Codex rollout record into a usage delta; null when it carries none.
 *
 * `last_token_usage` is the billable delta for THIS request, and is the only
 * figure safe to sum: `total_token_usage` is a mutable running snapshot that
 * compaction and resume rewrite, so summing it would multiply the session's
 * cost by its turn count.
 *
 * Two of Codex's fields are nested inside others and double-count if taken at
 * face value, so both are unpacked to the disjoint shape the cost model (and
 * Claude's own usage record) assumes:
 *   - `cached_input_tokens` is a SUBSET of `input_tokens` — billed at a tenth,
 *     so leaving it in would charge the same tokens twice, once at full rate.
 *     Older builds spell it `cache_read_input_tokens`.
 *   - `reasoning_output_tokens` is a subset of `output_tokens` — dropped, since
 *     the total already contains it.
 * `cache_write_input_tokens` is reported but has been 0 in every rollout seen
 * (OpenAI doesn't bill cache writes); it is carried across unmodified rather
 * than assumed to be nested.
 */
export function codexUsageFromRecord(record: unknown, model: string): UsageRecord | null {
  if (typeof record !== 'object' || record === null) return null
  const r = record as Record<string, unknown>
  if (r.type !== 'event_msg') return null
  const payload = r.payload as Record<string, unknown> | undefined
  if (payload?.type !== 'token_count') return null
  // A `token_count` event can carry rate-limit news and no usage at all.
  const info = payload.info as Record<string, unknown> | undefined
  const usage = info?.last_token_usage as Record<string, unknown> | undefined
  if (!usage) return null
  const tsMs = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : Number.NaN
  if (Number.isNaN(tsMs)) return null
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const input = n(usage.input_tokens)
  // Clamped: a cached count above the input it belongs to would otherwise make
  // the uncached remainder negative.
  const cacheRead = Math.min(n(usage.cached_input_tokens ?? usage.cache_read_input_tokens), input)
  return {
    tsMs,
    model,
    inputTokens: input - cacheRead,
    outputTokens: n(usage.output_tokens),
    cacheReadTokens: cacheRead,
    cacheCreationTokens: n(usage.cache_write_input_tokens),
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

/**
 * Every harness on this box, folded into one bucket set.
 *
 * Settled independently on purpose: a Codex tree that throws mid-walk must cost
 * the sheet its Codex figures, not the Claude ones it already had. The caller
 * has one try/catch and would zero out both.
 */
export async function scanHostUsage(opts: {
  sinceMs: number
  homeDir?: string
}): Promise<UsageBucketWire[]> {
  const scans = await Promise.allSettled([scanClaudeUsage(opts), scanCodexUsage(opts)])
  return mergeBuckets(scans.flatMap((s) => (s.status === 'fulfilled' ? s.value : [])))
}

/**
 * Re-fold already-bucketized lists into one. Two harnesses that ran the same
 * model in the same hour (nothing stops a future one) must land in a single
 * bucket, not two rows the sheet's model table would print twice.
 */
export function mergeBuckets(buckets: UsageBucketWire[]): UsageBucketWire[] {
  const merged = new Map<string, UsageBucketWire>()
  for (const b of buckets) {
    const key = `${b.hour}|${b.model}`
    const seen = merged.get(key)
    if (!seen) {
      merged.set(key, { ...b })
      continue
    }
    seen.inputTokens += b.inputTokens
    seen.outputTokens += b.outputTokens
    seen.cacheReadTokens += b.cacheReadTokens
    seen.cacheCreationTokens += b.cacheCreationTokens
    seen.messages += b.messages
  }
  return [...merged.values()].sort((a, b) => a.hour.localeCompare(b.hour))
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
        records.push(...(await readClaudeRecords(path, opts.sinceMs)))
      } catch {
        // unreadable file — skip
      }
    }
  }
  return bucketize(records)
}

/**
 * Codex rollouts live under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
 * Walked rather than date-indexed: those directory names are LOCAL dates while
 * the record timestamps inside are UTC, so pruning by directory would need a
 * day of slack on both ends to stay correct, and the mtime check below already
 * costs one stat and skips the read.
 *
 * A non-default `CODEX_HOME` is not followed — the daemon's environment is not
 * the shell codex was launched from, so reading it there would be a guess.
 *
 * Every rollout counts, including the "guardian" subagent rollout Codex ≥0.142
 * writes alongside an interactive session. The sheet answers what the account
 * spent, and a subagent's tokens are billed like any other.
 */
export async function scanCodexUsage(opts: {
  sinceMs: number
  homeDir?: string
}): Promise<UsageBucketWire[]> {
  const sessionsDir = join(opts.homeDir ?? homedir(), '.codex', 'sessions')
  const files: string[] = []
  await collectJsonlFiles(sessionsDir, files)
  const records: UsageRecord[] = []
  for (const path of files) {
    try {
      const info = await stat(path)
      if (info.mtimeMs < opts.sinceMs) continue
      records.push(...(await readCodexRecords(path, opts.sinceMs)))
    } catch {
      // unreadable file — skip
    }
  }
  return bucketize(records)
}

/** Depth-first `.jsonl` walk; a directory that can't be read is simply absent. */
async function collectJsonlFiles(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // no Codex installation on this box, or an unreadable subtree
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await collectJsonlFiles(path, out)
    else if (entry.name.endsWith('.jsonl')) out.push(path)
  }
}

async function readClaudeRecords(path: string, sinceMs: number): Promise<UsageRecord[]> {
  const out: UsageRecord[] = []
  await streamJsonl(path, (line) => {
    // Cheap reject before JSON.parse: most transcript lines carry no usage.
    if (!line.includes('"usage"')) return
    const rec = parseLine(line, (record) => usageFromRecord(record))
    if (rec && rec.tsMs >= sinceMs) out.push(rec)
  })
  return out
}

async function readCodexRecords(path: string, sinceMs: number): Promise<UsageRecord[]> {
  const out: UsageRecord[] = []
  // The model in force, carried forward from the last `turn_context` — see
  // codexModelOf. Per file, because a rollout is one session's model history.
  let model = 'unknown'
  await streamJsonl(path, (line) => {
    if (line.includes('"turn_context"')) {
      model = parseLine(line, codexModelOf) ?? model
      return
    }
    if (!line.includes('"token_count"')) return
    const rec = parseLine(line, (record) => codexUsageFromRecord(record, model))
    if (rec && rec.tsMs >= sinceMs) out.push(rec)
  })
  return out
}

/** `JSON.parse` + extract, treating a torn or non-JSON line as nothing. */
function parseLine<T>(line: string, extract: (record: unknown) => T | null | undefined): T | null {
  try {
    return extract(JSON.parse(line)) ?? null
  } catch {
    return null
  }
}

/** Read a JSONL file line by line, without holding it in memory. */
async function streamJsonl(path: string, onLine: (line: string) => void): Promise<void> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    // Transcripts are append-only and can be large; stream in 1 MiB slabs.
    // LineDecoder keeps undecoded trailing bytes as a Buffer, so a multi-byte
    // character split across a slab boundary is reassembled, not mangled.
    const CHUNK = 1024 * 1024
    const decoder = new LineDecoder()
    let offset = 0
    const emit = (line: string): void => {
      const trimmed = line.trim()
      if (trimmed) onLine(trimmed)
    }
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset)
      const buffer = Buffer.alloc(len)
      await handle.read(buffer, 0, len, offset)
      offset += len
      for (const line of decoder.push(buffer)) emit(line)
    }
    const last = decoder.flush()
    if (last !== null) emit(last)
  } finally {
    await handle.close()
  }
}
