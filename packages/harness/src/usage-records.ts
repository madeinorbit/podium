/**
 * Shared usage-record plumbing for the Inventory usage harvest (POD-4414 §4.4,
 * issue 3.3).
 *
 * NEUTRAL, not a mechanism: record shapes, pure hour×model folds and the
 * incremental JSONL cursor machinery — no harness knowledge. Per-harness
 * strategies (`adapters/<harness>/usage.ts`) compose these primitives with
 * their own record parsers and session walks; the `inventory/usage.ts`
 * mechanism fans the strategies out across the registry and merges the folds.
 * Nothing here names a harness: the JSONL driver is an injected port and the
 * harness label flows as a value.
 */
import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  UsageBucketWire,
  UsageModelTotalWire,
  UsageSourceWire,
} from '@podium/model'
import { LineDecoder } from './jsonl-stream.js'

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
   * So the head is fingerprinted, and A REWRITE THAT CHANGES THE HEAD forces a
   * cold read.
   *
   * WHAT THAT DOES NOT COVER, said here because the property a reader will take
   * from the sentence above is stronger than the one it buys: a rewrite that
   * preserves the first `HEAD_SAMPLE_BYTES` VERBATIM and replaces everything
   * after still resumes at a stale cursor (measured: warm 730 against cold
   * 1,800). That is the inherent limit of sampling a head, and it is exactly the
   * shape of a compaction — keep the session header, rewrite the body. Closing
   * it needs a second fingerprint near the CURSOR rather than a bigger sample,
   * and it is deliberately not built: no harness observed on this box rewrites a
   * transcript that way, and an unused guard costs a read per file per walk
   * forever.
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

export function windowBuckets(buckets: UsageBucketWire[], sinceMs: number): UsageBucketWire[] {
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

export function toSource(scan: UsageFileScan, sinceMs: number): UsageSourceWire {
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

/** Depth-first `.jsonl` walk; a directory that can't be read is simply absent. */
export async function collectJsonlFiles(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // no harness installation on this box, or an unreadable subtree
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await collectJsonlFiles(path, out)
    else if (entry.name.endsWith('.jsonl')) out.push(path)
  }
}

/**
 * The per-line half of a JSONL usage harvest, owned by the harness that wrote
 * the lines. The incremental cursor, torn-tail and model-carry machinery below
 * calls it without knowing which harness it is.
 */
export interface JsonlUsageDriver {
  /** Extract a usage record from one line (`model` is the harness's model in force); null when the line carries none. */
  usageFromLine(line: string, model: string): UsageRecord | null
  /** A model announced by a non-usage line (Codex `turn_context`); undefined for any other line. */
  modelFromLine?(line: string): string | undefined
}

/** Stat, skip, read — the loop the JSONL harvests share. */
export async function scanJsonlTranscripts(
  paths: string[],
  harness: UsageSourceWire['harness'],
  opts: { sinceMs: number; cache?: UsageScanCache },
  driver: JsonlUsageDriver,
): Promise<UsageFileScan[]> {
  const out: UsageFileScan[] = []
  for (const path of paths) {
    try {
      const info = await stat(path)
      if (info.mtimeMs < opts.sinceMs) continue
      const scan = await scanJsonlTranscript(path, harness, info, opts.cache?.get(path), driver)
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
 * response identities the previous read already counted, and carry the model's
 * announcement forward across the seam (a `turn_context` before the cursor is
 * the only place the model is ever named).
 */
async function scanJsonlTranscript(
  path: string,
  harness: UsageSourceWire['harness'],
  info: { size: number; mtimeMs: number },
  prior: UsageFileScan | undefined,
  driver: JsonlUsageDriver,
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
    const announced = driver.modelFromLine?.(line)
    if (announced !== undefined) {
      model = announced
      return
    }
    const rec = driver.usageFromLine(line, model)
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

  // FOLDED, NOT SPREAD. `Math.min(...stamps)` passes one argument per usage
  // record, and the cold path no longer filters by `sinceMs`, so `stamps` is the
  // whole transcript rather than the window. Past the engine's argument limit the
  // spread throws RangeError, `scanJsonlTranscripts` swallows it per file, and
  // the transcript vanishes from the buckets AND the sources silently, forever,
  // re-failing on every walk because it is never cached either.
  //
  // NAME THE ENGINE, BECAUSE THE TWO LIMITS DIFFER BY AN ORDER OF MAGNITUDE. The
  // ~125k figure quoted for this failure is NODE/V8's. The daemon runs on
  // BUN/JSC, where the limit is roughly 500k-1M — measured, and a 1.1M-record
  // 262MB transcript was built to confirm the old code threw there while this
  // fold does not. So on the runtime that actually runs this, the bug needed a
  // far larger transcript than "125k records" suggests. The fold stays
  // regardless: an unbounded spread over attacker-free but unbounded input is a
  // landmine whatever the constant, and folding costs nothing.
  let minTsMs = Number.POSITIVE_INFINITY
  let maxTsMs = 0
  for (const list of [complete, torn]) {
    for (const rec of list) {
      if (rec.tsMs < minTsMs) minTsMs = rec.tsMs
      if (rec.tsMs > maxTsMs) maxTsMs = rec.tsMs
    }
  }
  const seen = complete.length + torn.length > 0
  // A file with nothing in it yet reads 0/0 rather than an infinity, because the
  // wire says these are non-negative integers and a cold file is not an error.
  const firstTsMs = base?.firstTsMs || (seen ? minTsMs : 0)
  const ids = [...(base?.tailIds ?? [])]
  for (const rec of complete) if (rec.responseId) ids.push(rec.responseId)
  return {
    path,
    harness,
    scannedBytes: consumedBytes,
    fileSize: info.size,
    mtimeMs: info.mtimeMs,
    firstTsMs: seen ? Math.min(firstTsMs || Number.POSITIVE_INFINITY, minTsMs) : firstTsMs,
    lastTsMs: Math.max(base?.lastTsMs ?? 0, maxTsMs, 0),
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
export function parseLine<T>(
  line: string,
  extract: (record: unknown) => T | null | undefined,
): T | null {
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
