import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { LineDecoder } from '@podium/harness'
import type { UsageBucketWire, UsageModelTotalWire, UsageSourceWire } from '@podium/model'

/**
 * Harvest token usage from harness transcript JSONLs — Claude Code (each
 * assistant record carries message.usage), Codex (each turn emits a
 * `token_count` event), and Grok (per-session `signals.json` + `summary.json`).
 * ccusage-style coverage, in-house so it flows over Podium's own wire, folded
 * into one hour×model bucket set by `scanHostUsage`.
 *
 * Files whose mtime predates the window are skipped without reading — a 7-day
 * scan touches only recently-active transcripts.
 *
 * THE WALK HAS TWO PRODUCTS SINCE POD-1858. The bucket set is the host's spend
 * by hour and model; `sources` is the same records folded PER FILE, which is the
 * one fact the hour×model fold discards. Per-task cost is that fact and nothing
 * more, so it is harvested here rather than by a second walk of the same 4GB —
 * see `scanHostUsageSources`, and section 10 of the POD-1604 design for why a
 * second walk on the daemon's event loop is not an option.
 *
 * WHAT THIS DOES NOT DO: MOVE THE WALK OFF THE DAEMON'S EVENT LOOP. There is no
 * worker thread here. `rescanUsage` still calls `scanHostUsageSources` on the
 * loop that carries PTY traffic, and `runUsageScan` still awaits it on a request
 * path the first time a window is asked for. Measured against main the cold walk
 * is not a regression (9,943ms vs 8,855ms, then 7,703ms vs 7,479ms — noise), and
 * the cursor makes the STEADY STATE roughly ten times cheaper (620-857ms warm),
 * but cheaper is not the same as elsewhere. Anyone who needs that loop actually
 * protected still has to build it; believing it is already done is worse than
 * knowing it is not, because it stops the next person looking.
 *
 * THE CURSOR IS THE OFFSET AFTER THE LAST NEWLINE, NEVER THE FILE SIZE. A
 * transcript is appended to WHILE it is read, so the final line of any read is
 * routinely a torn write. Advancing to the file size would resume mid-line and
 * lose that record; counting the partial line and advancing past it would count
 * the finished record twice. So a torn tail is counted for the answer being
 * given now and re-read next time, and the cursor stops at the last byte that is
 * provably a record boundary.
 */

export interface UsageRecord {
  tsMs: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Subset of cacheCreationTokens written with Anthropic's 1-hour TTL. */
  cacheCreation1hTokens: number
  /** Reply count for this record. Absent means one, matching Claude/Codex rows. */
  messages?: number
  /** Stable provider response identity; absent when the transcript carries none. */
  responseId?: string
}

/**
 * Parse one JSONL record; null when it carries no usage.
 *
 * A record whose model is a `<…>` sentinel is NOT usage. Claude Code writes its
 * API-error and session-limit placeholders as assistant turns stamped
 * `"model": "<synthetic>"` with an all-zero usage block — no model ran, and no
 * tokens were billed. Counted, they added a permanent 0-token `<synthetic>` row
 * to the usage sheet's model table and inflated every reply count by however
 * many times an agent hit a limit. `claudeRecordModel` already filters the same
 * sentinel for the transcript reader; this is the usage path's copy of that rule.
 */
export function usageFromRecord(record: unknown): UsageRecord | null {
  if (typeof record !== 'object' || record === null) return null
  const r = record as Record<string, unknown>
  if (r.type !== 'assistant') return null
  const message = r.message as Record<string, unknown> | undefined
  const usage = message?.usage as Record<string, unknown> | undefined
  if (!usage) return null
  if (typeof message?.model === 'string' && message.model.startsWith('<')) return null
  const tsMs = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : Number.NaN
  if (Number.isNaN(tsMs)) return null
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined
  const cacheCreation1hTokens = n(cacheCreation?.ephemeral_1h_input_tokens)
  const reportedCacheCreationTokens = n(usage.cache_creation_input_tokens)
  // The aggregate predates the TTL breakdown and remains the fallback for old
  // Claude Code records. When a partial/future breakdown does not add up to the
  // aggregate, conservatively assign the unexplained remainder to the default
  // 5-minute tier instead of losing tokens.
  const cacheCreation5mTokens = cacheCreation
    ? Math.max(
        n(cacheCreation.ephemeral_5m_input_tokens),
        reportedCacheCreationTokens - cacheCreation1hTokens,
      )
    : reportedCacheCreationTokens
  const requestId = typeof r.requestId === 'string' && r.requestId ? r.requestId : undefined
  const messageId = typeof message?.id === 'string' && message.id ? message.id : undefined
  return {
    tsMs,
    model: typeof message?.model === 'string' ? (message.model as string) : 'unknown',
    inputTokens: n(usage.input_tokens),
    outputTokens: n(usage.output_tokens),
    cacheReadTokens: n(usage.cache_read_input_tokens),
    cacheCreationTokens: cacheCreation1hTokens + cacheCreation5mTokens,
    cacheCreation1hTokens,
    ...(requestId
      ? { responseId: `request:${requestId}` }
      : messageId
        ? { responseId: `message:${messageId}` }
        : {}),
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
 * `cache_write_input_tokens` is reported but has been 0 in every rollout seen.
 * It is carried across unmodified rather than assumed to be nested; current
 * gpt-5.6 pricing does bill a nonzero write at 1.25x input.
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
    cacheCreation1hTokens: 0,
  }
}

/**
 * Fold records into hour×model buckets.
 *
 * Claude Code can persist the same API assistant response once per streamed
 * content block. Those rows have different transcript UUIDs/timestamps but the
 * same requestId/message.id and the same complete usage block. Select the
 * earliest row for each stable provider response identity before bucketing.
 * Records without an identity remain distinct: token-shape or timestamp
 * heuristics would collapse legitimate requests that merely cost the same.
 */
export function bucketize(records: UsageRecord[]): UsageBucketWire[] {
  const identified = new Map<string, UsageRecord>()
  const distinct: UsageRecord[] = []
  for (const rec of records) {
    if (!rec.responseId) {
      distinct.push(rec)
      continue
    }
    const seen = identified.get(rec.responseId)
    if (!seen || rec.tsMs < seen.tsMs) identified.set(rec.responseId, rec)
  }

  const buckets = new Map<string, UsageBucketWire>()
  for (const rec of [...distinct, ...identified.values()]) {
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
        cacheCreation1hTokens: 0,
        messages: 0,
      }
      buckets.set(key, b)
    }
    b.inputTokens += rec.inputTokens
    b.outputTokens += rec.outputTokens
    b.cacheReadTokens += rec.cacheReadTokens
    b.cacheCreationTokens += rec.cacheCreationTokens
    b.cacheCreation1hTokens = (b.cacheCreation1hTokens ?? 0) + rec.cacheCreation1hTokens
    b.messages += rec.messages ?? 1
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
  return (await scanHostUsageSources(opts)).buckets
}

/**
 * The same walk, keeping WHICH FILE each record came from.
 *
 * `sources` is what makes per-task cost affordable: the server turns a path into
 * a session — and therefore into an issue — with one indexed lookup per FILE,
 * never per record. Two folds per source, on purpose. `windowModels` covers the
 * requested window and answers the usage sheet's by-task section; `models`
 * covers the whole file and is what the durable per-session row stores, because
 * "what did this task cost" outlives any window.
 *
 * `cache` is the incremental half. Transcripts are append-only, so a file whose
 * size and mtime are unchanged is not opened at all, and one that grew is read
 * from its cursor rather than from byte zero. Pass the SAME cache across scans
 * or every walk is a cold one.
 */
export async function scanHostUsageSources(opts: {
  sinceMs: number
  homeDir?: string
  cache?: UsageScanCache
}): Promise<{ buckets: UsageBucketWire[]; sources: UsageSourceWire[] }> {
  const scans = await Promise.allSettled([
    scanClaudeFiles(opts),
    scanCodexFiles(opts),
    scanGrokFiles(opts),
  ])
  const files = scans.flatMap((s) => (s.status === 'fulfilled' ? s.value : []))
  // Files the window has moved past are never re-read, so holding their folds
  // would be a leak that grows with the age of the box.
  opts.cache?.prune(opts.sinceMs)
  return {
    buckets: mergeBuckets(files.flatMap((f) => windowBuckets(fileBuckets(f), opts.sinceMs))),
    sources: files.map((f) => toSource(f, opts.sinceMs)),
  }
}

const HOUR_MS = 3_600_000

/**
 * ONE TRANSCRIPT, as this walk leaves it and as the next walk finds it.
 *
 * `buckets` covers complete lines only and is never re-derived; `tailBuckets` is
 * the torn final line, re-read every pass. Reported together by `fileBuckets`.
 */
export interface UsageFileScan {
  path: string
  harness: UsageSourceWire['harness']
  /** Bytes of complete lines folded into `buckets`. The incremental cursor. */
  scannedBytes: number
  /** Size and mtime at the last read — the "has anything happened" test. */
  fileSize: number
  mtimeMs: number
  firstTsMs: number
  lastTsMs: number
  buckets: UsageBucketWire[]
  tailBuckets: UsageBucketWire[]
  /** Codex's model in force at the cursor, carried across appends. */
  model: string
  /** Recent response identities, so an append cannot recount a straddler. */
  tailIds: string[]
  /**
   * A hash of the file's first bytes — the OTHER half of the append test.
   *
   * "Transcripts are append-only" is load-bearing and, on its own, unverified:
   * a rewrite in place that leaves the file the same length or longer changes
   * the mtime, passes a `size >= priorSize` check, and resumes at a cursor that
   * now points into different content. Measured, that reads 10 records where a
   * cold walk reads 99, or 930 where a cold walk reads 2,400 — wrong in both
   * directions, and the wrong fold is then banked in the durable row for good.
   * So the head is fingerprinted, and a head that moved forces a cold read.
   *
   * `headBytes` is how many bytes that hash covers, and it is stored rather than
   * recomputed because the two files being compared are different lengths: the
   * next walk hashes exactly THIS many bytes of the new file, so a pure append
   * to a file shorter than the sample still compares like with like instead of
   * reading as a changed head.
   */
  headHash: string
  headBytes: number
}

/**
 * How many response identities are carried across an append.
 *
 * Claude Code can persist one API response as several rows, and those rows are
 * CONSECUTIVE — the same message's content blocks, written in one burst. The
 * only way a pair straddles a cursor is for a scan to land between the two, so
 * remembering the tail of the previous read is what closes it. 256 is orders of
 * magnitude more slack than a burst needs and costs a few KB per live file.
 */
const TAIL_ID_MEMORY = 256

/**
 * The folds of every recently-active transcript, kept between walks.
 *
 * Deliberately NOT module-global: two daemon runtimes in one process (the test
 * lane makes them routinely) must not read one another's cursors.
 */
export class UsageScanCache {
  private readonly files = new Map<string, UsageFileScan>()

  get(path: string): UsageFileScan | undefined {
    return this.files.get(path)
  }

  put(scan: UsageFileScan): void {
    this.files.set(scan.path, scan)
  }

  /** Forget files older than the window; the walk skips them on mtime anyway. */
  prune(beforeMs: number): void {
    for (const [path, scan] of this.files) if (scan.mtimeMs < beforeMs) this.files.delete(path)
  }

  get size(): number {
    return this.files.size
  }
}

/** Everything the file has, torn tail included. */
export function fileBuckets(scan: UsageFileScan): UsageBucketWire[] {
  return scan.tailBuckets.length === 0
    ? scan.buckets
    : mergeBuckets([...scan.buckets, ...scan.tailBuckets])
}

/** Bucket hours are hour-aligned, so the window edge is too. */
const windowHourStart = (sinceMs: number): number => Math.floor(sinceMs / HOUR_MS) * HOUR_MS

function windowBuckets(buckets: UsageBucketWire[], sinceMs: number): UsageBucketWire[] {
  const from = windowHourStart(sinceMs)
  return buckets.filter((b) => Date.parse(b.hour) >= from)
}

function foldByModel(buckets: UsageBucketWire[]): UsageModelTotalWire[] {
  const byModel = new Map<string, UsageModelTotalWire>()
  for (const b of buckets) {
    let m = byModel.get(b.model)
    if (!m) {
      m = {
        model: b.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        messages: 0,
      }
      byModel.set(b.model, m)
    }
    m.inputTokens += b.inputTokens
    m.outputTokens += b.outputTokens
    m.cacheReadTokens += b.cacheReadTokens
    m.cacheCreationTokens += b.cacheCreationTokens
    m.cacheCreation1hTokens = (m.cacheCreation1hTokens ?? 0) + (b.cacheCreation1hTokens ?? 0)
    m.messages += b.messages
  }
  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model))
}

function toSource(scan: UsageFileScan, sinceMs: number): UsageSourceWire {
  const all = fileBuckets(scan)
  return {
    path: scan.path,
    harness: scan.harness,
    scannedBytes: scan.scannedBytes,
    firstTsMs: scan.firstTsMs,
    lastTsMs: scan.lastTsMs,
    models: foldByModel(all),
    windowModels: foldByModel(windowBuckets(all, sinceMs)),
  }
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
    seen.cacheCreation1hTokens = (seen.cacheCreation1hTokens ?? 0) + (b.cacheCreation1hTokens ?? 0)
    seen.messages += b.messages
  }
  return [...merged.values()].sort((a, b) => a.hour.localeCompare(b.hour))
}

export async function scanClaudeUsage(opts: {
  sinceMs: number
  homeDir?: string
  cache?: UsageScanCache
}): Promise<UsageBucketWire[]> {
  const files = await scanClaudeFiles(opts)
  return mergeBuckets(files.flatMap((f) => windowBuckets(fileBuckets(f), opts.sinceMs)))
}

/**
 * `~/.claude/projects/<project>/<nativeId>.jsonl`, AND the delegate transcripts
 * at `<nativeId>/subagents/<agentId>.jsonl`.
 *
 * The subagent files were missed by the one-level read this replaces, and they
 * are not a rounding error: on this machine they carried $85 of Claude spend in
 * a single 7-day window, all of it attributable — every one of them has a
 * conversation-segment row whose parent identity names the session that spawned
 * it. Codex has said the same thing about its own subagent rollouts since
 * POD-570 ("the sheet answers what the account spent, and a subagent's tokens
 * are billed like any other"); this makes the Claude half agree. They do not
 * double-count: a delegate's records appear in its own file and nowhere else.
 */
async function scanClaudeFiles(opts: {
  sinceMs: number
  homeDir?: string
  cache?: UsageScanCache
}): Promise<UsageFileScan[]> {
  const projectsDir = join(opts.homeDir ?? homedir(), '.claude', 'projects')
  let projectDirs: string[]
  try {
    projectDirs = await readdir(projectsDir)
  } catch {
    return [] // no Claude installation on this box
  }
  const paths: string[] = []
  for (const project of projectDirs) await collectJsonlFiles(join(projectsDir, project), paths)
  return scanJsonlTranscripts(paths, 'claude-code', opts)
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
  cache?: UsageScanCache
}): Promise<UsageBucketWire[]> {
  const files = await scanCodexFiles(opts)
  return mergeBuckets(files.flatMap((f) => windowBuckets(fileBuckets(f), opts.sinceMs)))
}

async function scanCodexFiles(opts: {
  sinceMs: number
  homeDir?: string
  cache?: UsageScanCache
}): Promise<UsageFileScan[]> {
  const sessionsDir = join(opts.homeDir ?? homedir(), '.codex', 'sessions')
  const paths: string[] = []
  await collectJsonlFiles(sessionsDir, paths)
  return scanJsonlTranscripts(paths, 'codex', opts)
}

/**
 * Grok does not persist per-turn input/output/cache on disk. What it does write
 * is a session snapshot: `signals.json` carries `contextTokensUsed` (current
 * context size, not billed lifetime spend) plus a reply count, and
 * `summary.json` names the model and last-active time. One record per session,
 * stamped at last-active, is the honest harvest — the sheet will understate a
 * long compacted thread and cannot split cache/output, but Grok still appears
 * as xAI instead of vanishing.
 *
 * Sessions live under `~/.grok/sessions/<percent-encoded-cwd>/<id>/`, with
 * optional children at `<id>/subagents/<child>/`. The walk follows that shape
 * only — it does not recurse into `terminal/` or other session scratch. A
 * non-default `GROK_HOME` is followed only when the caller did not pass
 * `homeDir` (tests pin a fake home; production may isolate accounts).
 */
export function grokUsageFromSession(
  signals: unknown,
  summary: unknown,
  fallbackTsMs: number,
): UsageRecord | null {
  if (!isRecord(signals)) return null
  const contextTokensUsed = finiteNumber(signals.contextTokensUsed)
  const assistantMessageCount = finiteNumber(signals.assistantMessageCount)
  const turnCount = finiteNumber(signals.turnCount)
  const messages =
    assistantMessageCount > 0 ? Math.round(assistantMessageCount) : Math.round(turnCount)
  if (contextTokensUsed <= 0 && messages <= 0) return null

  const summaryRec = isRecord(summary) ? summary : undefined
  const model = grokSessionModel(signals, summaryRec)
  const tsMs = grokSessionTsMs(summaryRec, fallbackTsMs)
  if (!Number.isFinite(tsMs)) return null
  const sessionId = grokSessionId(summaryRec)
  return {
    tsMs,
    model,
    inputTokens: Math.max(0, Math.round(contextTokensUsed)),
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    messages: Math.max(messages, contextTokensUsed > 0 ? 1 : 0),
    ...(sessionId ? { responseId: `grok-session:${sessionId}` } : {}),
  }
}

export async function scanGrokUsage(opts: {
  sinceMs: number
  homeDir?: string
  cache?: UsageScanCache
}): Promise<UsageBucketWire[]> {
  const files = await scanGrokFiles(opts)
  return mergeBuckets(files.flatMap((f) => windowBuckets(fileBuckets(f), opts.sinceMs)))
}

/**
 * No incremental read here, and none is wanted: a Grok source is a two-file JSON
 * SNAPSHOT of the session, not an append-only log, so a byte cursor into it
 * would name nothing. Unchanged size and mtime still skip the read entirely.
 */
async function scanGrokFiles(opts: {
  sinceMs: number
  homeDir?: string
  cache?: UsageScanCache
}): Promise<UsageFileScan[]> {
  const sessionsDir = grokSessionsDir(opts.homeDir)
  const paths: string[] = []
  await collectGrokSignalFiles(sessionsDir, 'roots', paths)
  const out: UsageFileScan[] = []
  for (const path of paths) {
    try {
      const info = await stat(path)
      if (info.mtimeMs < opts.sinceMs) continue
      const prior = opts.cache?.get(path)
      if (prior && prior.fileSize === info.size && prior.mtimeMs === info.mtimeMs) {
        out.push(prior)
        continue
      }
      const signals = parseJson(await readFile(path, 'utf8'))
      let summary: unknown = null
      try {
        summary = parseJson(await readFile(join(dirname(path), 'summary.json'), 'utf8'))
      } catch {
        // summary is optional — last-active falls back to signals mtime
      }
      const rec = grokUsageFromSession(signals, summary, info.mtimeMs)
      if (!rec) continue
      const scan: UsageFileScan = {
        path,
        harness: 'grok',
        scannedBytes: info.size,
        fileSize: info.size,
        mtimeMs: info.mtimeMs,
        firstTsMs: rec.tsMs,
        lastTsMs: rec.tsMs,
        buckets: bucketize([rec]),
        tailBuckets: [],
        model: rec.model,
        tailIds: [],
        // Never read incrementally, so the fingerprint has nothing to guard;
        // size and mtime alone decide whether a snapshot is re-read.
        headHash: '',
        headBytes: 0,
      }
      opts.cache?.put(scan)
      out.push(scan)
    } catch {
      // unreadable session — skip
    }
  }
  return out
}

function grokSessionsDir(homeDir?: string): string {
  if (homeDir) return join(homeDir, '.grok', 'sessions')
  const env = process.env.GROK_HOME?.trim()
  if (env) return join(env, 'sessions')
  return join(homedir(), '.grok', 'sessions')
}

function grokSessionModel(
  signals: Record<string, unknown>,
  summary: Record<string, unknown> | undefined,
): string {
  if (typeof signals.primaryModelId === 'string' && signals.primaryModelId.trim()) {
    return signals.primaryModelId.trim()
  }
  if (typeof summary?.current_model_id === 'string' && summary.current_model_id.trim()) {
    return summary.current_model_id.trim()
  }
  const used = signals.modelsUsed
  if (Array.isArray(used)) {
    const first = used.find((id): id is string => typeof id === 'string' && id.trim().length > 0)
    if (first) return first.trim()
  }
  return 'unknown'
}

function grokSessionTsMs(
  summary: Record<string, unknown> | undefined,
  fallbackTsMs: number,
): number {
  for (const key of ['last_active_at', 'updated_at', 'created_at'] as const) {
    const value = summary?.[key]
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return fallbackTsMs
}

function grokSessionId(summary: Record<string, unknown> | undefined): string | undefined {
  const info = summary?.info
  if (isRecord(info) && typeof info.id === 'string' && info.id.trim()) return info.id.trim()
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Grok layout is `sessions/<cwd>/<id>/signals.json`, plus the same file under
 * `<id>/subagents/<child>/`. Anything else in a session dir — `terminal/` logs,
 * recap dumps — is skipped so a large ~/.grok does not turn the harvest into a
 * full-tree walk.
 */
type GrokWalk = 'roots' | 'cwd' | 'session'

async function collectGrokSignalFiles(dir: string, kind: GrokWalk, out: string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  if (kind === 'session') {
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'signals.json') out.push(join(dir, entry.name))
      else if (entry.isDirectory() && entry.name === 'subagents') {
        await collectGrokSignalFiles(join(dir, entry.name), 'cwd', out)
      }
    }
    return
  }
  const next: GrokWalk = kind === 'roots' ? 'cwd' : 'session'
  for (const entry of entries) {
    if (entry.isDirectory()) await collectGrokSignalFiles(join(dir, entry.name), next, out)
  }
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

/** Stat, skip, read — the loop both JSONL harnesses share. */
async function scanJsonlTranscripts(
  paths: string[],
  harness: 'claude-code' | 'codex',
  opts: { sinceMs: number; cache?: UsageScanCache },
): Promise<UsageFileScan[]> {
  const out: UsageFileScan[] = []
  for (const path of paths) {
    try {
      const info = await stat(path)
      if (info.mtimeMs < opts.sinceMs) continue
      const scan = await scanJsonlTranscript(path, harness, info, opts.cache?.get(path))
      // Cached even when it carries no usage at all: the cursor is what stops a
      // transcript full of tool output from being re-read end to end every walk.
      opts.cache?.put(scan)
      if (scan.buckets.length > 0 || scan.tailBuckets.length > 0) out.push(scan)
    } catch {
      // unreadable file — skip
    }
  }
  return out
}

/**
 * Fold one transcript, reading only what is new.
 *
 * A file that shrank was rotated or rewritten in place, so the stored cursor no
 * longer names a boundary in THIS file and nothing about the previous read may
 * be reused. Anything else is an append: resume at the cursor, suppress the
 * response identities the previous read already counted, and carry Codex's model
 * forward across the seam (a `turn_context` before the cursor is the only place
 * the model is ever named).
 */
async function scanJsonlTranscript(
  path: string,
  harness: 'claude-code' | 'codex',
  info: { size: number; mtimeMs: number },
  prior: UsageFileScan | undefined,
): Promise<UsageFileScan> {
  if (prior && prior.fileSize === info.size && prior.mtimeMs === info.mtimeMs) return prior
  // THE APPEND TEST IS TWO-SIDED. Growing (or holding) length is necessary and
  // nowhere near sufficient: a rewrite in place satisfies it while invalidating
  // every byte before the cursor. The head fingerprint is what makes "this is
  // the same file, only longer" a checked claim rather than an assumption; when
  // it fails the file is read cold, which is always correct and merely slower.
  const head = await readHead(path, Math.min(HEAD_SAMPLE_BYTES, info.size))
  const headMatches =
    prior !== undefined &&
    prior.headBytes <= head.length &&
    hashOf(head.subarray(0, prior.headBytes)) === prior.headHash
  const base = prior && info.size >= prior.fileSize && headMatches ? prior : undefined

  const complete: UsageRecord[] = []
  const torn: UsageRecord[] = []
  const counted = new Set(base?.tailIds ?? [])
  // Ids banked in THIS pass. The torn tail is folded separately from the
  // complete lines, so without this a response whose duplicate rows straddle
  // the file's last newline would be counted in both folds.
  const thisPass = new Set<string>()
  let model = base?.model ?? 'unknown'
  const consumedBytes = await streamJsonl(path, base?.scannedBytes ?? 0, (line, whole) => {
    let rec: UsageRecord | null
    if (harness === 'claude-code') {
      // Cheap reject before JSON.parse: most transcript lines carry no usage.
      if (!line.includes('"usage"')) return
      rec = parseLine(line, (record) => usageFromRecord(record))
    } else {
      if (line.includes('"turn_context"')) {
        model = parseLine(line, codexModelOf) ?? model
        return
      }
      if (!line.includes('"token_count"')) return
      rec = parseLine(line, (record) => codexUsageFromRecord(record, model))
    }
    if (!rec) return
    if (rec.responseId && counted.has(rec.responseId)) return
    if (whole) {
      if (rec.responseId) thisPass.add(rec.responseId)
      complete.push(rec)
      return
    }
    if (rec.responseId && thisPass.has(rec.responseId)) return
    torn.push(rec)
  })

  const stamps = [...complete, ...torn].map((r) => r.tsMs)
  // A file with nothing in it yet reads 0/0 rather than an infinity, because the
  // wire says these are non-negative integers and a cold file is not an error.
  const firstTsMs = base?.firstTsMs || (stamps.length > 0 ? Math.min(...stamps) : 0)
  const ids = [...(base?.tailIds ?? [])]
  for (const rec of complete) if (rec.responseId) ids.push(rec.responseId)
  return {
    path,
    harness,
    scannedBytes: consumedBytes,
    fileSize: info.size,
    mtimeMs: info.mtimeMs,
    firstTsMs:
      stamps.length > 0 ? Math.min(firstTsMs || Number.POSITIVE_INFINITY, ...stamps) : firstTsMs,
    lastTsMs: Math.max(base?.lastTsMs ?? 0, ...stamps, 0),
    buckets: base ? mergeBuckets([...base.buckets, ...bucketize(complete)]) : bucketize(complete),
    tailBuckets: bucketize(torn),
    model,
    tailIds: ids.slice(-TAIL_ID_MEMORY),
    headHash: hashOf(head),
    headBytes: head.length,
  }
}

/**
 * Fingerprint the first `HEAD_SAMPLE_BYTES` of a file.
 *
 * A transcript's head is its `session_meta` / first records — stable for the
 * life of an append-only file and different in any file rewritten from scratch.
 * Sampling the head rather than the whole file is what keeps this O(1) per walk
 * instead of re-reading the 4GB the cursor exists to avoid.
 */
const HEAD_SAMPLE_BYTES = 4096

async function readHead(path: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

const hashOf = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 32)

/** `JSON.parse` + extract, treating a torn or non-JSON line as nothing. */
function parseLine<T>(line: string, extract: (record: unknown) => T | null | undefined): T | null {
  try {
    return extract(JSON.parse(line)) ?? null
  } catch {
    return null
  }
}

/**
 * Read a JSONL file line by line from `fromByte`, without holding it in memory,
 * and return the offset AFTER THE LAST NEWLINE consumed.
 *
 * That return value is the whole point of the signature: it is the only offset a
 * later read may resume from without either losing or repeating a record. The
 * unterminated remainder is still handed to `onLine` with `whole: false`, so the
 * answer being computed right now includes it — it is simply not banked.
 */
async function streamJsonl(
  path: string,
  fromByte: number,
  onLine: (line: string, whole: boolean) => void,
): Promise<number> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    // Transcripts are append-only and can be large; stream in 1 MiB slabs.
    // LineDecoder keeps undecoded trailing bytes as a Buffer, so a multi-byte
    // character split across a slab boundary is reassembled, not mangled.
    const CHUNK = 1024 * 1024
    const decoder = new LineDecoder()
    let offset = Math.min(Math.max(fromByte, 0), size)
    let consumed = offset
    const emit = (line: string, whole: boolean): void => {
      const trimmed = line.trim()
      if (trimmed) onLine(trimmed, whole)
    }
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset)
      const buffer = Buffer.alloc(len)
      // ADVANCE BY WHAT WAS ACTUALLY READ, never by the slab length. A short
      // read is legal, and treating it as a full one would both feed the decoder
      // the untouched tail of the buffer as content and skip the bytes that were
      // never read — a silent hole in the middle of a transcript.
      const { bytesRead } = await handle.read(buffer, 0, len, offset)
      if (bytesRead <= 0) break
      const chunk = buffer.subarray(0, bytesRead)
      const lastNewline = chunk.lastIndexOf(0x0a)
      if (lastNewline >= 0) consumed = offset + lastNewline + 1
      offset += bytesRead
      for (const line of decoder.push(chunk)) emit(line, true)
    }
    const last = decoder.flush()
    if (last !== null) emit(last, false)
    return consumed
  } finally {
    await handle.close()
  }
}
