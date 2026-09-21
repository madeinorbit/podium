/**
 * Codex quota + usage layouts — the Inventory usage section (POD-4414 §4.4,
 * issue 3.3).
 *
 * KNOWLEDGE, not mechanism: the wham usage endpoint, its window grammar, the
 * rollout harvest walk over `~/.codex/sessions`, and the `rate_limits`
 * recovery parser. The inventory mechanism fans these out and merges the folds
 * without naming the harness.
 *
 * `history` is DECLINED with the evidence, deliberately: the rollouts do carry
 * `rate_limits`, and the scanner below reads them correctly, but the series
 * does not mean what the ledger would claim — `used_percent` climbs to 100
 * and returns to 0 inside a single afternoon while `resets_at` moves
 * backwards. Codex history is left to LIVE sampling; the scanner stays
 * exported and tested so re-enabling it is one line.
 */
import type { Dirent } from 'node:fs'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentQuotaWire, QuotaWindowWire } from '@podium/model'
import type { QuotaHistorySampleWire } from '@podium/protocol'
import {
  supported,
  unsupported,
  type HarnessUsage,
  type QuotaProbeOptions,
} from '../../manifest.js'
import {
  collectJsonlFiles,
  parseLine,
  scanJsonlTranscripts,
  type UsageFileScan,
  type UsageRecord,
  type UsageScanCache,
} from '../../usage-records.js'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

export interface WhamUsageResponse {
  email?: string
  plan_type?: string
  rate_limit?: {
    primary_window?: { used_percent?: number; limit_window_seconds?: number; reset_at?: number }
    secondary_window?: { used_percent?: number; limit_window_seconds?: number; reset_at?: number }
  }
}

const isoFromUnix = (s: number | undefined): string =>
  typeof s === 'number' && Number.isFinite(s) ? new Date(s * 1000).toISOString() : ''

const pct = (p: number | undefined): number => (typeof p === 'number' && Number.isFinite(p) ? p : 0)

// Codex sometimes drops the 5h window entirely and reports only the weekly
// limit as primary_window, so classify by limit_window_seconds instead of
// assuming primary=5h / secondary=weekly. Fallbacks (no window seconds) keep
// the old positional assumption.
const DAY_SECONDS = 86_400

function classifyWindow(
  w: NonNullable<NonNullable<WhamUsageResponse['rate_limit']>['primary_window']>,
  fallbackKey: '5h' | 'weekly',
): QuotaWindowWire {
  const seconds = w.limit_window_seconds
  const key =
    typeof seconds === 'number' && Number.isFinite(seconds)
      ? seconds >= DAY_SECONDS
        ? 'weekly'
        : '5h'
      : fallbackKey
  return {
    key,
    label: key === '5h' ? '5-hour' : 'Weekly',
    usedPercent: pct(w.used_percent),
    resetsAt: isoFromUnix(w.reset_at),
    windowMinutes:
      typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
        ? Math.round(seconds / 60)
        : key === '5h'
          ? 300
          : 10_080,
  }
}

export function parseWhamUsage(body: WhamUsageResponse): QuotaWindowWire[] {
  const windows: QuotaWindowWire[] = []
  const rl = body.rate_limit
  if (!rl) return windows
  if (rl.primary_window) windows.push(classifyWindow(rl.primary_window, '5h'))
  if (rl.secondary_window) windows.push(classifyWindow(rl.secondary_window, 'weekly'))
  return windows
}

export async function fetchCodexQuota(
  deps: QuotaProbeOptions = {},
): Promise<AgentQuotaWire> {
  const now = deps.now ?? Date.now()
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = {
    agent: 'codex' as const,
    windows: [] as QuotaWindowWire[],
    fetchedAt: new Date(now).toISOString(),
  }
  const authPath = join(deps.homeDir ?? homedir(), '.codex', 'auth.json')
  let accessToken: string | undefined
  let accountId: string | undefined
  try {
    const raw = JSON.parse(await readFile(authPath, 'utf8')) as {
      /** UNBRANDED BY DECISION: a provider account id, not a server-minted Podium AccountId. */
      tokens?: { access_token?: string; account_id?: string }
    }
    accessToken = raw.tokens?.access_token
    accountId = raw.tokens?.account_id
  } catch {
    return { ...base, status: 'unauthenticated' }
  }
  if (!accessToken) return { ...base, status: 'unauthenticated' }
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      },
    })
    if (res.status === 401) return { ...base, status: 'expired' }
    if (!res.ok) return { ...base, status: 'error', error: `usage endpoint ${res.status}` }
    const body = (await res.json()) as WhamUsageResponse
    const account =
      body.email || body.plan_type
        ? {
            ...(body.email ? { email: body.email } : {}),
            ...(body.plan_type ? { plan: body.plan_type } : {}),
          }
        : undefined
    return {
      ...base,
      status: 'ok',
      windows: parseWhamUsage(body),
      ...(account ? { account } : {}),
    }
  } catch (e) {
    return { ...base, status: 'error', error: e instanceof Error ? e.message : String(e) }
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
}): Promise<UsageFileScan[]> {
  const sessionsDir = join(opts.homeDir ?? homedir(), '.codex', 'sessions')
  const paths: string[] = []
  await collectJsonlFiles(sessionsDir, paths)
  return scanJsonlTranscripts(paths, 'codex', opts, {
    usageFromLine: (line, model) => {
      if (!line.includes('"token_count"')) return null
      return parseLine(line, (record) => codexUsageFromRecord(record, model))
    },
    modelFromLine: (line) => {
      if (!line.includes('"turn_context"')) return undefined
      return parseLine(line, codexModelOf) ?? undefined
    },
  })
}

interface CodexRateLimitWindow {
  used_percent?: unknown
  window_minutes?: unknown
  resets_at?: unknown
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * One `token_count` event's `rate_limits` block.
 *
 * The rollout's key names differ from the app-server shape the live probe
 * consumes (`primary` vs `primary_window`, `window_minutes` vs
 * `limit_window_seconds`) while carrying the identical upstream numbers, so this
 * is a rename and a unit change, not a second source of truth.
 *
 * `resets_at` is EPOCH SECONDS here.
 */
export function codexSamplesFromEvent(
  payload: unknown,
  accountKeyEmail: string | undefined,
  machineId: string,
  atMs: number,
): QuotaHistorySampleWire[] {
  if (!payload || typeof payload !== 'object') return []
  // `rate_limits` sits beside `info` on the payload, not inside it — verified
  // against real rollouts. Both are read anyway: the sibling `info` block has
  // moved between Codex versions before, and reading either costs nothing.
  const p = payload as { rate_limits?: unknown; info?: { rate_limits?: unknown } }
  const limits = p.rate_limits ?? p.info?.rate_limits
  if (!limits || typeof limits !== 'object') return []
  const l = limits as {
    primary?: CodexRateLimitWindow
    secondary?: CodexRateLimitWindow
    plan_type?: unknown
  }
  const plan = typeof l.plan_type === 'string' ? l.plan_type : undefined
  const out: QuotaHistorySampleWire[] = []
  // `secondary` was null in every one of the 89,843 measured rows — this account
  // gets no Codex 5-hour window — but the shape allows one, so both are read.
  for (const [slot, window] of [
    ['primary', l.primary],
    ['secondary', l.secondary],
  ] as const) {
    if (!window || typeof window !== 'object') continue
    const usedPercent = num(window.used_percent)
    const resetsAtSec = num(window.resets_at)
    const windowMinutes = num(window.window_minutes) ?? 0
    if (usedPercent === undefined || resetsAtSec === undefined) continue
    // Classify by the provider's own duration, matching the live probe, rather
    // than by slot: Codex sometimes reports only the weekly limit, as primary.
    const key = windowMinutes >= 1440 ? 'weekly' : windowMinutes > 0 ? '5h' : slot
    out.push({
      agent: 'codex',
      ...(accountKeyEmail ? { email: accountKeyEmail } : {}),
      machineId,
      windowKey: key,
      label: key === 'weekly' ? 'Weekly' : '5-hour',
      ...(plan ? { plan } : {}),
      usedPercent,
      resetsAtMs: resetsAtSec * 1000,
      windowMinutes,
      atMs,
    })
  }
  return out
}

async function readCodexRollout(
  path: string,
  email: string | undefined,
  machineId: string,
): Promise<QuotaHistorySampleWire[]> {
  const out: QuotaHistorySampleWire[] = []
  // Rollouts run to hundreds of megabytes across a fleet of sessions; streaming
  // keeps peak memory flat where readFile would not.
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.includes('rate_limits')) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== 'object') continue
      const rec = parsed as { timestamp?: unknown; type?: unknown; payload?: unknown }
      if (rec.type !== 'event_msg') continue
      const atMs = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN
      if (!Number.isFinite(atMs)) continue
      out.push(...codexSamplesFromEvent(rec.payload, email, machineId, atMs))
    }
  } finally {
    rl.close()
  }
  return out
}

async function collectRollouts(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // no Codex installation on this box, or an unreadable subtree
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await collectRollouts(path, out)
    else if (entry.name.endsWith('.jsonl')) out.push(path)
  }
}

async function codexAccountEmail(homeDir: string): Promise<string | undefined> {
  try {
    const auth: unknown = JSON.parse(await readFile(join(homeDir, '.codex', 'auth.json'), 'utf8'))
    const tokens = (auth as { tokens?: { id_token?: unknown } }).tokens
    const idToken = tokens?.id_token
    if (typeof idToken !== 'string') return undefined
    const body = idToken.split('.')[1]
    if (!body) return undefined
    const claims: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    const email = (claims as { email?: unknown }).email
    return typeof email === 'string' ? email : undefined
  } catch {
    // No readable auth, or a token shape we don't recognise. The sample still
    // lands, keyed by machine instead of account — see quotaAccountKey.
    return undefined
  }
}

/**
 * Recover Codex quota history from session rollouts. Exported and tested, but
 * NOT wired into the section — see the module header for why live sampling
 * owns this series.
 */
export async function scanCodexQuotaHistory(opts: {
  sinceMs: number
  machineId: string
  homeDir?: string
}): Promise<QuotaHistorySampleWire[]> {
  const home = opts.homeDir ?? homedir()
  const email = await codexAccountEmail(home)
  const files: string[] = []
  await collectRollouts(join(home, '.codex', 'sessions'), files)
  const samples: QuotaHistorySampleWire[] = []
  for (const path of files) {
    try {
      const info = await stat(path)
      if (info.mtimeMs < opts.sinceMs) continue
      samples.push(...(await readCodexRollout(path, email, opts.machineId)))
    } catch {
      // unreadable rollout — skip
    }
  }
  return samples.filter((sample) => sample.atMs >= opts.sinceMs)
}

export const codexUsage: HarnessUsage = {
  quota: supported({ fetchQuota: fetchCodexQuota }),
  history: unsupported(
    'Recovered Codex windows disagree with live sampling (used_percent resets inside a window while resets_at moves backwards); Codex history is left to live sampling',
  ),
  transcripts: supported({ scan: scanCodexUsage }),
}
