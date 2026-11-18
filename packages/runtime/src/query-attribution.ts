/**
 * Per-statement attribution — the RECORDING core, paired with `startLoopAccounting`.
 *
 * WHY THIS EXISTS (POD-1630). The server's stall reporter could say a tick burned
 * 500ms of own-CPU but not WHAT ran, and the tRPC/phase counters could not fill the
 * gap: a 180s live window with 15 stalls (4787ms of own-CPU) recorded ZERO tRPC
 * calls and ~1ms of instrumented phase work. The stalls are background work, and
 * `/proc/<pid>/io` showed why — the process was reading 4KB pages out of the one
 * file it holds open (podium.db) in bursts of 20-56MB/s, one ~7.3MB / ~1900-page
 * scan at a time, several times per second. Flat JS heap against RSS swinging
 * 350MB -> 1.2GB is that scan's row materialization being allocated and dropped.
 *
 * So the missing number is per-SQL: which statement, how often, how long, how many
 * rows. That is what this records. It is a diagnostic, not a budget — nothing here
 * changes behavior, and below the `attribution` level no instrument is installed
 * at all, so an install that is not profiling carries no per-query cost.
 *
 * WHY IT IS NOT UNDER `sqlite/` ANY MORE (POD-3281). It records `(sql, wallMs,
 * rows)` and has never known what a connection is; the SQLite-shaped half is the
 * `SqlDatabase` wrapper, which stayed behind in `sqlite/query-attribution.ts` and
 * re-exports everything here so no consumer's import changed. The reason to
 * separate them is that the store's statements no longer all pass through a
 * `SqlDatabase`: they pass through the executor's DRIVER, which on E.5 is a
 * remote libsql client with no handle of any kind (spec §6 rule 8 — observability
 * moves with the queries, at the execution seam). Two instruments, one set of
 * numbers, so `formatTopQueries` and the stall reporter keep reading one window.
 */

import { openSync, readSync } from 'node:fs'
import { attribute } from './loop-accounting'
import { atLeast } from './loop-profile'

const ENABLED = atLeast('attribution')
export const queryAttributionEnabled = ENABLED

export interface QueryCost {
  /** Statement executions in the current window. */
  count: number
  /** Summed wall time of those executions, ms. */
  wallMs: number
  /** Rows handed back across those executions (`all` only; `get` counts 0/1). */
  rows: number
  /** The slowest single execution, ms. Absent only on a hand-built cost. */
  maxMs?: number
  /**
   * Bytes SQLite read from the database file across the SAMPLED executions — see
   * {@link sampleStatementRead}. Absent when no execution of this statement was
   * sampled, which is not the same as zero.
   */
  readBytes?: number
  /** How many executions {@link readBytes} covers. */
  readSamples?: number
}

const costs = new Map<string, QueryCost>()

/**
 * Collapse a statement to a stable, log-safe key. Whitespace folds so the same
 * query written across several lines aggregates as one, and the key is truncated
 * because a stall line has to stay readable — the leading clause is what
 * identifies the offender.
 *
 * A CUT KEY KEEPS ITS TABLE AND STAYS UNIQUE [POD-6189]. A builder select lists
 * every column before its `FROM`, so a cut at 120 characters dropped the table:
 * POD-6155's A/B could only report +11.5k/min of "select (table cut off)", and
 * every select of the same column list (one resource's grants, many resources',
 * a whole kind's) collapsed into ONE key. So when the cut loses the first
 * `FROM <table>`, that clause is appended after the cut, and every cut key ends
 * in a short hash of the whole statement. The prefix still reads as before.
 */
export function queryKey(sql: string, maxLength = 120): string {
  if (maxLength === 120) {
    const memo = keys.get(sql)
    if (memo !== undefined) return memo
  }
  const key = foldedKey(sql, maxLength)
  if (maxLength === 120 && keys.size < KEY_MEMO_CAP) keys.set(sql, key)
  return key
}

/**
 * The key of each statement text already seen. Every execution used to fold and
 * hash its text again; the texts are a small, fixed set per process (prepared
 * definitions and their families), so the fold is paid once. The cap only
 * guards against a caller that inlines values into its SQL: past it, a text is
 * folded each time as before.
 */
const keys = new Map<string, string>()
const KEY_MEMO_CAP = 8192

function foldedKey(sql: string, maxLength: number): string {
  const folded = sql.replace(/\s+/g, ' ').trim()
  if (folded.length <= maxLength) return folded
  const head = folded.slice(0, maxLength - 1)
  const tableInHead = /\b(?:from|into)\s+["`]?\w|^\s*update\s/i.test(head)
  const from = tableInHead ? undefined : /\bfrom\s+["`]?[\w.]+["`]?/i.exec(folded)?.[0]
  return `${head}…${from ? ` ${from}` : ''} #${fnv1a(folded)}`
}

/** 32-bit FNV-1a as 8 hex digits: a short, stable name for one statement text. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Depth of the claim {@link claimQueryAttribution} holds. Depth, not a boolean,
 * because the claim nests: nothing here assumes one seam.
 */
let claimDepth = 0

/**
 * Run `claimed` as the ONE instrument recording the executions inside it
 * [POD-3852].
 *
 * WHY THIS EXISTS. There are two instruments and they are NESTED, not
 * alternatives. A statement issued through the executor's driver passes the
 * driver seam (`store/executor/statement-probe.ts`) AND, on a bun-backed store,
 * the `SqlDatabase` wrapper underneath it — so one execution called
 * {@link recordQuery} twice and every count, every wall time and every row total
 * in the profile was exactly double what ran. POD-3281's "two instruments, one
 * set of numbers" was written for the case where only ONE of them can see a
 * statement (the libsql driver has no `SqlDatabase` to wrap at all); it was
 * never a licence for both to fire on one execution.
 *
 * So the OUTER instrument claims the execution and everything under it stands
 * down. Outer rather than inner because the outer one is the better witness: it
 * knows the declared write intent, the batch the statement rode in, and the call
 * site that issued it, none of which the handle wrapper can see. That is also
 * what stopped half the caller-stack samples naming `bun-driver.ts` instead of a
 * repository.
 *
 * THE SCOPE IS SYNCHRONOUS AND THAT IS THE WHOLE SAFETY ARGUMENT. `claimDepth`
 * is process-wide, so a claim held across an `await` would silence whatever
 * unrelated statement happened to run in the gap. `claimed` must therefore do
 * its recording work synchronously and return — returning a promise is fine and
 * expected (a driver's `execute` is `async`), but the claim ends the moment that
 * promise is HANDED BACK, not when it settles. The bun driver does all of its
 * SQLite work in that synchronous body, which is precisely the window the
 * wrapper underneath it records in. A driver that genuinely defers its work is a
 * driver with no `SqlDatabase` beneath it, so there is nothing to stand down.
 */
export function claimQueryAttribution<T>(claimed: () => T): T {
  claimDepth += 1
  try {
    return claimed()
  } finally {
    claimDepth -= 1
  }
}

/**
 * Record one statement execution. The enabled-gate lives at the wrapping decision
 * in {@link attributeQueries}, not here: a wrapper only exists when attribution is
 * on, so re-checking an ambient env var per execution would be a second source of
 * truth for the same question.
 *
 * `issueStack` is the caller's stack, captured by the seam that saw the statement
 * ISSUED rather than built here — see {@link recordCallerStack} for why the
 * difference is the whole value of the number. A seam that has no such capture
 * omits it and this module falls back to its own stack, which is right for the
 * synchronous `SqlDatabase` wrapper and wrong for anything that awaited.
 *
 * The claim check is the other exception, and it belongs here rather than at a
 * wrapping decision because it is per-EXECUTION, not per-handle: the same wrapper
 * records for statements a driver claimed and for statements nobody else can see.
 */
export function recordQuery(
  sql: string,
  wallMs: number,
  rows: number,
  issueStack?: string,
  readBytes?: number,
): void {
  if (claimDepth > 0) return
  const key = queryKey(sql)
  const cost = costs.get(key) ?? { count: 0, wallMs: 0, rows: 0 }
  addCost(cost, wallMs, rows, readBytes)
  costs.set(key, cost)
  const total = totals.get(key) ?? { count: 0, wallMs: 0, rows: 0 }
  addCost(total, wallMs, rows, readBytes)
  totals.set(key, total)
  // A slow execution arms read sampling for the statement's later executions
  // (see sampleStatementRead): the first walk is only timed, every later one is
  // also measured.
  if (wallMs >= READ_SAMPLE_ARM_MS && armed.size < ARMED_CAP) armed.add(sql)
  if (readBytes !== undefined && readBytes >= HEAVY_READ_BYTES && heavyReads.length < HEAVY_CAP) {
    heavyReads.push({ key, readBytes, wallMs, rows })
  }
  // The `sql` cost bucket (§6.1). Declared NESTED in the minute record, because
  // every statement here ran inside a region some other bucket is already
  // timing — an rpc handler, a timer callback, a socket frame — so a coverage
  // figure that counted it again would claim far more of the minute was
  // explained than any seam actually explains.
  attribute('sql', wallMs)
  if (STACKS) recordCallerStack(key, issueStack)
}

function addCost(cost: QueryCost, wallMs: number, rows: number, readBytes?: number): void {
  cost.count++
  cost.wallMs += wallMs
  cost.rows += rows
  if (cost.maxMs === undefined || wallMs > cost.maxMs) cost.maxMs = wallMs
  if (readBytes !== undefined) {
    cost.readBytes = (cost.readBytes ?? 0) + readBytes
    cost.readSamples = (cost.readSamples ?? 0) + 1
  }
}

/**
 * Lifetime totals, deliberately NOT cleared by {@link resetQueryAttribution}.
 *
 * The window exists so a stall line reports the second that stalled; a bench run
 * asking "how many times did this statement run over a minute" needs the opposite,
 * and reading the window from outside its 1s reset cadence answers neither
 * question (POD-1638 first measured ~0 statements that way). Same recording path,
 * two retention policies.
 */
const totals = new Map<string, QueryCost>()

/** Lifetime per-statement totals since process start. Never reset. */
export function queryAttributionTotals(): ReadonlyMap<string, QueryCost> {
  return new Map(totals)
}

/**
 * Caller attribution, one level deeper than the SQL (POD-1638).
 *
 * A statement key names WHAT ran; when the defect is a call COUNT the question is
 * immediately WHO ran it, and the SQL cannot answer that — `SELECT * FROM issues
 * WHERE id = ?` is prepared in one place and reached from dozens. Capturing a stack
 * is far more expensive than the timing pair above, so it sits one level up, at
 * `full`, rather than riding along with attribution: this is a bench/repro
 * instrument, not something a live host should carry.
 */
const STACKS = atLeast('full')

/**
 * Whether caller stacks are being recorded, for the seams that have to CAPTURE
 * one to make them worth anything (see {@link recordCallerStack}).
 *
 * It is exported for the same reason `attributeQueries` takes an `enabled`
 * parameter: a capture site pays a real per-statement cost, so it must be able
 * to ask the one resolved answer rather than re-reading the environment and
 * becoming a second source of truth for it.
 */
export const queryCallerStacksEnabled = STACKS

/**
 * Frames that belong to the PLUMBING between a caller and this recorder, never
 * to a caller — see {@link recordCallerStack}.
 *
 * Two instruments: this module's `SqlDatabase` wrapper
 * (`sqlite/query-attribution.ts`) and the executor's driver seam
 * (`store/executor/statement-probe.ts`), which is where a converted
 * repository's statements are seen (POD-3281). Then the path a captured stack
 * now starts in: the query client's verb (`store/executor/driver.ts`), the
 * drizzle bridge that called it (`store/executor/sync-drizzle.ts`), and
 * drizzle's own session frames, none of which name a caller.
 *
 * A marker missing from this list does not lose the stack, it just buries the
 * caller one frame deeper — which is exactly how a stack stops answering "who".
 * So the markers are as specific as the path allows: `driver.ts` alone would
 * also swallow `packages/harness/src/driver/driver.ts`, which CAN be a caller.
 */
const INSTRUMENT_FRAMES = [
  'query-attribution',
  'statement-probe',
  'executor/driver.ts',
  'executor/sync-drizzle.ts',
  'node_modules/drizzle-orm',
] as const

/** How many caller frames a sample keeps. A stall line has to stay readable. */
const CALLER_FRAME_CAP = 12

const stacks = new Map<string, Map<string, number>>()

/**
 * The caller frames of a raw stack: plumbing dropped, capped.
 *
 * Exported because the dropping is the part that decides whether a dump answers
 * "who ran this" or not, and it is a pure string transform — testable without a
 * process that is actually profiling.
 */
export function callerFrames(raw: string, cap = CALLER_FRAME_CAP): string {
  return raw
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => !INSTRUMENT_FRAMES.some((marker) => line.includes(marker)))
    .slice(0, cap)
    .join('\n')
}

/**
 * Record one sample of who issued `key`.
 *
 * `issued` IS THE WHOLE POINT (POD-3851). Building the stack here names nobody:
 * this runs from the driver probe's `finally`, one await past the call, and the
 * caller's frames are gone by then — a `full` dump on the live host showed only
 * `driver.ts`, `scheduler.ts` and `executor.ts` for every hot statement. So the
 * store-facing entry captures the stack synchronously, in the caller's own turn,
 * and hands it down with the statement. The fallback below is still correct for
 * the one seam that has no await between the caller and here — the synchronous
 * `SqlDatabase` wrapper.
 */
function recordCallerStack(key: string, issued?: string): void {
  const frames = callerFrames(issued ?? new Error().stack ?? '')
  const perKey = stacks.get(key) ?? new Map<string, number>()
  perKey.set(frames, (perKey.get(frames) ?? 0) + 1)
  stacks.set(key, perKey)
}

/** Sampled caller stacks per statement key, hottest first. Empty unless stacks are on. */
export function queryCallerStacks(): Map<string, { count: number; stack: string }[]> {
  const out = new Map<string, { count: number; stack: string }[]>()
  for (const [key, perKey] of stacks) {
    out.set(
      key,
      [...perKey].map(([stack, count]) => ({ stack, count })).sort((a, b) => b.count - a.count),
    )
  }
  return out
}

/**
 * The current window's statements, most expensive first by summed wall time.
 * `limit` bounds the log line, not the measurement.
 */
export function formatTopQueries(
  limit = 3,
  source: ReadonlyMap<string, QueryCost> = costs,
): string {
  return [...source]
    .sort((a, b) => b[1].wallMs - a[1].wallMs || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, c]) => formatQueryCost(key, c))
    .join(' | ')
}

/**
 * One statement's cost as a stall line prints it: `count x / ms / rows`, the
 * bytes it read when a sampled execution measured them, then its definition
 * name in brackets when one is known, then the key.
 */
export function formatQueryCost(
  key: string,
  c: QueryCost,
  nameOf: (key: string) => string | undefined = queryDefinitionName,
): string {
  const read = c.readBytes === undefined ? '' : `/${formatBytes(c.readBytes)}read`
  const name = nameOf(key)
  return `${c.count}x/${c.wallMs.toFixed(0)}ms/${c.rows}rows${read} ${name ? `[${name}] ` : ''}${key}`
}

/** Bytes as the largest unit that keeps one decimal readable. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}

/** Drop the window. The reset cadence is owned by the caller that reports stalls. */
export function resetQueryAttribution(): void {
  costs.clear()
}

/** Snapshot of the current window, for tests and for callers that format their own. */
export function queryAttributionSnapshot(): ReadonlyMap<string, QueryCost> {
  return new Map(costs)
}

// ---------------------------------------------------------------------------
// Bytes read per statement [POD-7037]
// ---------------------------------------------------------------------------

/**
 * WHY BYTES AND NOT ROWS EXAMINED. The incident behind this (POD-7027 finding 1)
 * returned 0 rows per call while walking 24k rows, about 130 MB, and a stall line
 * that only says "0rows" hides exactly that. SQLite counts what a statement
 * examined (`sqlite3_stmt_status` VM_STEP / FULLSCAN_STEP), but Bun exposes none
 * of it: no statement-status call, no `sqlite_stmt` table (Bun 1.4.4's SQLite
 * 3.53.4 is built without SQLITE_ENABLE_STMTVTAB), and no exported `sqlite3_*`
 * symbols to reach through FFI.
 *
 * What IS measurable is what the statement made SQLite read. The store sets no
 * `mmap_size` and keeps SQLite's default 2 MB page cache, so every page a walk
 * touches beyond that cache arrives through `pread(2)` on the calling thread,
 * and `/proc/thread-self/io` `rchar` counts those bytes whether the OS served
 * them from its page cache or from disk. A statement runs synchronously on one
 * thread, so the difference across it is that statement's reads and nothing
 * else's. Measured on Bun 1.4.4 (vega): the incident's shape over 24k rows of
 * 5.6 KB read 50 MB in 12.2k preads for 0 rows; a point read reads 12 KB.
 *
 * WHY ONLY SOME EXECUTIONS. One sample of the counter costs about 2.5 µs and a
 * point read about 8 µs, so measuring every statement would add more than half
 * to the cheapest ones. A statement is sampled only once one of its executions
 * took {@link READ_SAMPLE_ARM_MS} or more: the walks that matter are slow, and
 * every other statement pays one set lookup.
 */
export const READ_SAMPLE_ARM_MS = 20

/**
 * One execution reading this much is a walk, not a lookup: about 10k rows of
 * 1 KB, or 2,560 pages. Reported through {@link drainHeavyStatementReads}.
 */
export const HEAVY_READ_BYTES = 10 * 1024 * 1024

/** Statement texts with a slow execution. Bounded: a text past it is never sampled. */
const armed = new Set<string>()
const ARMED_CAP = 4096

/** A measured execution that read at least {@link HEAVY_READ_BYTES}. */
export interface HeavyStatementRead {
  readonly key: string
  readonly readBytes: number
  readonly wallMs: number
  readonly rows: number
}

const heavyReads: HeavyStatementRead[] = []
/** The queue drains every second; this bounds a second that walks without end. */
const HEAVY_CAP = 64

/** The heavy executions since the last drain, oldest first. Empties the queue. */
export function drainHeavyStatementReads(): HeavyStatementRead[] {
  return heavyReads.splice(0)
}

/** The calling thread's cumulative bytes read through read(2)-family calls. */
export type ThreadReadMeter = () => number | undefined

/** `undefined` until first asked; `false` once known to be unavailable. */
let meter: ThreadReadMeter | false | undefined

/**
 * Replace the meter (tests), or pass `undefined` to resolve the platform's again.
 * Also forgets which statements were armed, so a test starts unarmed.
 */
export function setThreadReadMeter(next: ThreadReadMeter | undefined): void {
  meter = next
  armed.clear()
  heavyReads.length = 0
}

function resolvedMeter(): ThreadReadMeter | undefined {
  if (meter === undefined) meter = procThreadReadMeter() ?? false
  return meter === false ? undefined : meter
}

/**
 * `rchar` of `/proc/thread-self/io`, read through one descriptor held open.
 *
 * The descriptor names the thread that OPENED it, which is the thread this
 * module instance runs on: a worker gets its own instance and its own
 * descriptor. Parsed off the bytes because `rchar` is the first line, and a
 * string decode would cost more than the read.
 */
function procThreadReadMeter(): ThreadReadMeter | undefined {
  if (process.platform !== 'linux') return undefined
  let fd: number
  try {
    fd = openSync('/proc/thread-self/io', 'r')
  } catch {
    return undefined
  }
  const buf = Buffer.alloc(256)
  const read: ThreadReadMeter = () => {
    try {
      const n = readSync(fd, buf, 0, buf.length, 0)
      return parseRchar(buf, n)
    } catch {
      return undefined
    }
  }
  return read() === undefined ? undefined : read
}

/** The `rchar: <n>` value at the start of a proc io record, or undefined. */
export function parseRchar(buf: Uint8Array, length: number): number | undefined {
  const prefix = 'rchar: '
  if (length <= prefix.length) return undefined
  for (let i = 0; i < prefix.length; i++) {
    if (buf[i] !== prefix.charCodeAt(i)) return undefined
  }
  let value = 0
  let i = prefix.length
  for (; i < length; i++) {
    const c = buf[i]!
    if (c < 48 || c > 57) break
    value = value * 10 + (c - 48)
  }
  return i === prefix.length ? undefined : value
}

/**
 * The thread's read counter before a statement, when this execution is to be
 * measured; `undefined` otherwise. A seam calls it right before the SQLite call
 * and passes the result to {@link readBytesSince} right after it.
 *
 * Inside a claim the outer seam measures, so the wrapper underneath does not.
 */
export function sampleStatementRead(sql: string): number | undefined {
  if (claimDepth > 0 || armed.size === 0 || !armed.has(sql)) return undefined
  return resolvedMeter()?.()
}

/** Like {@link sampleStatementRead}, for a batch: sampled when any member is. */
export function sampleBatchRead(sqls: readonly string[]): number | undefined {
  if (claimDepth > 0 || armed.size === 0 || !sqls.some((sql) => armed.has(sql))) return undefined
  return resolvedMeter()?.()
}

/** Bytes read since `before`, or undefined when there was no sample. */
export function readBytesSince(before: number | undefined): number | undefined {
  if (before === undefined) return undefined
  const after = resolvedMeter()?.()
  return after === undefined ? undefined : Math.max(0, after - before)
}

// ---------------------------------------------------------------------------
// Definition names [POD-7037]
// ---------------------------------------------------------------------------

/**
 * A key names a statement by its SQL; an operator reading a digest needs the
 * DEFINITION, the file and line that made it. Each `prepared(...)` or
 * `preparedFamily(...)` definition already keeps the stack of where it was made
 * (`packages/sync/src/adapters/sqlite/prepared.ts`), so when it builds a
 * statement it hands that stack here with the SQL text.
 *
 * WHY AT BUILD AND NOT AT BOOT. A family's SQL depends on its key (an IN-list
 * size, a set of optional filters), so the texts a boot could compute are only
 * the ones a census of keys lists. A build is when the text exists, it happens
 * once per shape per connection, and it covers exactly the statements that can
 * run. The stack is only turned into a name when a log line asks for it.
 */
interface DefinitionSite {
  readonly site: Error
  readonly shape?: string
  name?: string | null
}

const definitionSites = new Map<string, DefinitionSite>()
const DEFINITION_SITE_CAP = 20_000

/**
 * Whether builds record their definition. On exactly when the profiler is, so
 * an install that is not profiling keeps no map; a test states it instead.
 */
let naming = ENABLED

/** Read by `prepared.ts` on each build. */
export function queryDefinitionNamingEnabled(): boolean {
  return naming
}

/** Turn definition naming on or off regardless of the profile level (tests). */
export function setQueryDefinitionNaming(enabled: boolean): void {
  naming = enabled
}

/** Remember which definition built `sql`. The first definition of a text wins. */
export function nameQueryDefinition(sql: string, site: Error, shape?: string | number): void {
  if (definitionSites.size >= DEFINITION_SITE_CAP) return
  const key = queryKey(sql)
  if (definitionSites.has(key)) return
  definitionSites.set(key, shape === undefined ? { site } : { site, shape: String(shape) })
}

/** `file:line [shape]` of the definition behind `key`, when one was recorded. */
export function queryDefinitionName(key: string): string | undefined {
  const entry = definitionSites.get(key)
  if (entry === undefined) return undefined
  if (entry.name === undefined) {
    const at = definitionSiteName(entry.site.stack ?? '')
    entry.name = at === undefined ? null : entry.shape === undefined ? at : `${at} ${entry.shape}`
  }
  return entry.name ?? undefined
}

/** Forget every recorded definition (tests). */
export function clearQueryDefinitionNames(): void {
  definitionSites.clear()
}

/**
 * The definition's position in a stack captured inside `prepared.ts`: the first
 * frame that is neither that module nor its registering functions.
 *
 * Matched by function name as well as by file because a packaged server is one
 * bundle without a source map, where every frame names the same file; there the
 * name is the bundle position, still a stable pointer for one build. With a
 * map (dev builds embed one) or from source it is the repository path.
 */
export function definitionSiteName(stack: string): string | undefined {
  for (const line of stack.split('\n').slice(1)) {
    const frame = line.trim()
    if (/^at (?:register|prepared|preparedFamily) /.test(frame)) continue
    if (frame.includes('adapters/sqlite/prepared.')) continue
    const match = /\(?((?:file:\/\/)?[^\s()]+):(\d+):\d+\)?$/.exec(frame)
    if (!match) continue
    const path = match[1]!.replace(/^file:\/\//, '')
    const repo = /(?:^|\/)((?:apps|packages)\/.+)$/.exec(path)
    const file = repo ? repo[1]! : path.slice(path.lastIndexOf('/') + 1)
    return `${file}:${match[2]}`
  }
  return undefined
}
