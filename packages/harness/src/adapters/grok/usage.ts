/**
 * Grok quota + usage layouts — the Inventory usage section (POD-4414 §4.4,
 * issue 3.3).
 *
 * KNOWLEDGE, not mechanism: the Build billing surface, its two response
 * shapes, the per-session snapshot harvest over `~/.grok/sessions`, and the
 * unified-log recovery parser. The inventory mechanism fans these out and
 * merges the folds without naming the harness.
 */
import type { Dirent } from 'node:fs'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentQuotaWire, QuotaWindowWire } from '@podium/model'
import type { QuotaHistorySampleWire } from '@podium/protocol'
import {
  supported,
  type HarnessUsage,
  type QuotaProbeOptions,
} from '../../manifest.js'
import {
  bucketize,
  type UsageFileScan,
  type UsageRecord,
  type UsageScanCache,
} from '../../usage-records.js'

/** Private Build CLI billing surface used by Grok's `/usage` slash command. */
const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing'
/** Newer credits response: the included allowance is a rolling weekly pool. */
const CREDITS_BILLING_URL = `${BILLING_URL}?format=credits`

export interface GrokBillingResponse {
  config?: {
    monthlyLimit?: { val?: number }
    used?: { val?: number }
    onDemandCap?: { val?: number }
    billingPeriodStart?: string
    billingPeriodEnd?: string
    creditUsagePercent?: number
    currentPeriod?: {
      type?: string
      start?: string
      end?: string
    }
  }
}

interface GrokAuthEntry {
  key?: string
  email?: string
  expires_at?: string
  auth_mode?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function moneyVal(field: { val?: number } | undefined): number | undefined {
  const v = field?.val
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Clamp a provider percentage to 0..100, with one decimal (same rounding as Claude). */
function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
}

/** used / limit as 0..100, one decimal (same rounding as Claude). */
function usedPercent(used: number, limit: number): number {
  if (limit <= 0) return 0
  return clampPercent((used / limit) * 100)
}

function windowMinutesFromPeriod(startIso: string | undefined, endIso: string | undefined): number {
  if (!startIso || !endIso) return 0
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  return Math.max(1, Math.round((end - start) / 60_000))
}

/**
 * Map Grok Build's monthly credit ledger and weekly included allowance to quota
 * windows. The provider exposes the two windows through two response formats:
 * the legacy response has monthlyLimit/used, while `format=credits` has
 * creditUsagePercent/currentPeriod.
 */
export function parseGrokBilling(body: GrokBillingResponse): QuotaWindowWire[] {
  const cfg = body.config
  if (!cfg) return []
  const windows: QuotaWindowWire[] = []

  const monthlyLimit = moneyVal(cfg.monthlyLimit)
  if (monthlyLimit !== undefined && monthlyLimit > 0) {
    const used = moneyVal(cfg.used) ?? 0
    const resetsAt =
      typeof cfg.billingPeriodEnd === 'string' && cfg.billingPeriodEnd.trim()
        ? cfg.billingPeriodEnd.trim()
        : ''
    windows.push({
      key: 'monthly',
      label: 'Monthly',
      usedPercent: usedPercent(used, monthlyLimit),
      resetsAt,
      windowMinutes: windowMinutesFromPeriod(cfg.billingPeriodStart, cfg.billingPeriodEnd),
    })
  }

  const periodType = cfg.currentPeriod?.type?.trim().toUpperCase()
  const hasWeeklyPeriod = periodType?.includes('WEEKLY') ?? false
  const weeklyPercent =
    typeof cfg.creditUsagePercent === 'number' && Number.isFinite(cfg.creditUsagePercent)
      ? cfg.creditUsagePercent
      : cfg.creditUsagePercent === undefined && hasWeeklyPeriod
        ? 0
        : undefined
  if (weeklyPercent !== undefined && (!periodType || hasWeeklyPeriod)) {
    const start = cfg.currentPeriod?.start ?? cfg.billingPeriodStart
    const end = cfg.currentPeriod?.end ?? cfg.billingPeriodEnd
    windows.push({
      key: 'weekly',
      label: 'Weekly',
      usedPercent: clampPercent(weeklyPercent),
      resetsAt: typeof end === 'string' && end.trim() ? end.trim() : '',
      windowMinutes: windowMinutesFromPeriod(start, end),
    })
  }

  return windows
}

function appendWindows(
  current: QuotaWindowWire[],
  additional: QuotaWindowWire[],
): QuotaWindowWire[] {
  const windows = [...current]
  for (const window of additional) {
    if (!windows.some((existing) => existing.key === window.key)) windows.push(window)
  }
  return windows
}

function grokHome(homeDir?: string): string {
  if (homeDir) return join(homeDir, '.grok')
  const env = process.env.GROK_HOME?.trim()
  if (env) return env
  return join(homedir(), '.grok')
}

/** First OIDC entry in ~/.grok/auth.json that has an access token. */
function pickAuthEntry(raw: unknown): GrokAuthEntry | undefined {
  if (!isRecord(raw)) return undefined
  for (const value of Object.values(raw)) {
    if (!isRecord(value)) continue
    const key = value.key
    if (typeof key === 'string' && key.trim()) {
      return {
        key: key.trim(),
        ...(typeof value.email === 'string' && value.email.trim()
          ? { email: value.email.trim() }
          : {}),
        ...(typeof value.expires_at === 'string' && value.expires_at.trim()
          ? { expires_at: value.expires_at.trim() }
          : {}),
        ...(typeof value.auth_mode === 'string' ? { auth_mode: value.auth_mode } : {}),
      }
    }
  }
  return undefined
}

export async function fetchGrokQuota(
  deps: QuotaProbeOptions = {},
): Promise<AgentQuotaWire> {
  const now = deps.now ?? Date.now()
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = {
    agent: 'grok' as const,
    windows: [] as QuotaWindowWire[],
    fetchedAt: new Date(now).toISOString(),
  }
  const authPath = join(grokHome(deps.homeDir), 'auth.json')
  let entry: GrokAuthEntry | undefined
  try {
    entry = pickAuthEntry(JSON.parse(await readFile(authPath, 'utf8')))
  } catch {
    return { ...base, status: 'unauthenticated' }
  }
  if (!entry?.key) return { ...base, status: 'unauthenticated' }

  const account = entry.email ? { email: entry.email } : undefined
  const withAcct = account ? { ...base, account } : base

  if (entry.expires_at) {
    const exp = Date.parse(entry.expires_at)
    if (Number.isFinite(exp) && exp <= now) {
      return {
        ...withAcct,
        status: 'expired',
        error: 'token expired (refreshes on next Grok use)',
      }
    }
  }

  const headers = {
    Authorization: `Bearer ${entry.key}`,
    Accept: 'application/json',
    'User-Agent': 'podium-daemon/1.0',
    'X-XAI-Token-Auth': 'xai-grok-cli',
  }
  type BillingResult =
    | { status: 'ok'; body: GrokBillingResponse }
    | { status: 'expired'; error: string }
    | { status: 'error'; error: string }

  const fetchBilling = async (url: string): Promise<BillingResult> => {
    try {
      const res = await fetchImpl(url, { headers })
      if (res.status === 401) {
        return {
          status: 'expired',
          error: 'token expired (refreshes on next Grok use)',
        }
      }
      if (!res.ok) return { status: 'error', error: `billing endpoint ${res.status}` }
      return { status: 'ok', body: (await res.json()) as GrokBillingResponse }
    } catch (e) {
      return { status: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  }

  const monthlyResult = await fetchBilling(BILLING_URL)
  let windows = monthlyResult.status === 'ok' ? parseGrokBilling(monthlyResult.body) : []
  let creditsResult: BillingResult | undefined

  // The legacy response remains the source of the monthly ledger. Ask for the
  // newer credits shape when it did not also carry the weekly pool. A failed
  // supplement must not hide a valid monthly reading.
  if (!windows.some((window) => window.key === 'weekly')) {
    creditsResult = await fetchBilling(CREDITS_BILLING_URL)
    if (creditsResult.status === 'ok') {
      windows = appendWindows(windows, parseGrokBilling(creditsResult.body))
    }
  }

  if (monthlyResult.status === 'ok' || creditsResult?.status === 'ok') {
    return { ...withAcct, status: 'ok', windows }
  }
  if (monthlyResult.status === 'expired' || creditsResult?.status === 'expired') {
    return {
      ...withAcct,
      status: 'expired',
      error: 'token expired (refreshes on next Grok use)',
    }
  }
  return {
    ...withAcct,
    status: 'error',
    error:
      monthlyResult.status === 'error'
        ? monthlyResult.error
        : creditsResult?.status === 'error'
          ? creditsResult.error
          : 'billing endpoint unavailable',
  }
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
}): Promise<UsageFileScan[]> {
  return scanGrokSnapshots(opts)
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

function grokSessionsDir(homeDir?: string): string {
  if (homeDir) return join(homeDir, '.grok', 'sessions')
  const env = process.env.GROK_HOME?.trim()
  if (env) return join(env, 'sessions')
  return join(homedir(), '.grok', 'sessions')
}

/**
 * No incremental read here, and none is wanted: a Grok source is a two-file JSON
 * SNAPSHOT of the session, not an append-only log, so a byte cursor into it
 * would name nothing. Unchanged size and mtime still skip the read entirely.
 */
async function scanGrokSnapshots(opts: {
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

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * One `billing: fetched credits config` line from Grok's unified log.
 *
 * Maps 1:1 onto the `format=credits` branch of the live probe above:
 * `creditUsagePercent → usedPercent`, `currentPeriod.end → resetsAt`, and the
 * period's own start/end pair → `windowMinutes`. Grok is the one harness that
 * actually reports a window START; everywhere else it has to be derived.
 */
export function grokSampleFromLogLine(
  line: string,
  machineId: string,
  email?: string,
): QuotaHistorySampleWire | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const rec = parsed as { ts?: unknown; msg?: unknown; ctx?: unknown }
  if (typeof rec.msg !== 'string' || !rec.msg.includes('fetched credits config')) return undefined
  const atMs = typeof rec.ts === 'string' ? Date.parse(rec.ts) : Number.NaN
  if (!Number.isFinite(atMs)) return undefined
  const config = (rec.ctx as { config?: unknown } | undefined)?.config
  if (!config || typeof config !== 'object') return undefined
  const c = config as {
    creditUsagePercent?: unknown
    currentPeriod?: { type?: unknown; start?: unknown; end?: unknown }
  }
  const usedPercent = num(c.creditUsagePercent)
  const period = c.currentPeriod
  if (usedPercent === undefined || !period) return undefined
  const start = typeof period.start === 'string' ? Date.parse(period.start) : Number.NaN
  const end = typeof period.end === 'string' ? Date.parse(period.end) : Number.NaN
  if (!Number.isFinite(end)) return undefined
  const windowMinutes = Number.isFinite(start) ? Math.round((end - start) / 60_000) : 0
  // `USAGE_PERIOD_TYPE_WEEKLY` etc. — the live fetcher only accepts a weekly
  // period on this branch, and the ledger must agree with it or the recovered
  // rows would sit in a series the live sampler never writes to.
  const type = typeof period.type === 'string' ? period.type : ''
  if (!type.includes('WEEKLY')) return undefined
  return {
    agent: 'grok',
    // WITHOUT THE EMAIL, RECOVERED WINDOWS LAND IN A DIFFERENT SERIES. The live
    // fetcher reports `account.email`, so `quotaAccountKey` keys the live pool
    // `grok::<email>`; a sample that omits it is keyed `grok::machine:<id>`. The
    // two never converge, and the ledger draws two indistinguishable Grok strips
    // instead of one continuous history.
    ...(email ? { email } : {}),
    machineId,
    windowKey: 'weekly',
    label: 'Weekly',
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    resetsAtMs: end,
    windowMinutes,
    atMs,
  }
}

/**
 * The account email from `~/.grok/auth.json` — the first entry carrying a token,
 * the same one `pickAuthEntry` selects in the live fetcher. It has to be the same
 * choice, or backfill and live sampling key the same pool differently.
 */
async function grokAccountEmail(home: string): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))
    if (!raw || typeof raw !== 'object') return undefined
    for (const value of Object.values(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as { key?: unknown; email?: unknown }
      if (typeof entry.key !== 'string' || !entry.key.trim()) continue
      return typeof entry.email === 'string' && entry.email.trim() ? entry.email.trim() : undefined
    }
  } catch {
    // No readable auth. The sample still lands, keyed by machine — which is what
    // the live path does in the same situation, so the two still agree.
  }
  return undefined
}

export async function scanGrokQuotaHistory(opts: {
  sinceMs: number
  machineId: string
  homeDir?: string
}): Promise<QuotaHistorySampleWire[]> {
  const home = grokHome(opts.homeDir)
  const email = await grokAccountEmail(home)
  const path = join(home, 'logs', 'unified.jsonl')
  const samples: QuotaHistorySampleWire[] = []
  try {
    const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        if (!line.includes('fetched credits config')) continue
        const sample = grokSampleFromLogLine(line, opts.machineId, email)
        if (sample && sample.atMs >= opts.sinceMs) samples.push(sample)
      }
    } finally {
      rl.close()
    }
  } catch {
    // No Grok installation, or no log yet.
  }
  return samples
}

export const grokUsage: HarnessUsage = {
  quota: supported({ fetchQuota: fetchGrokQuota }),
  history: supported({ scan: scanGrokQuotaHistory }),
  transcripts: supported({
    scan: scanGrokUsage,
    // A Grok "transcript" is a session snapshot read from `signals.json`,
    // while the registry indexes its sibling `summary.json` — both candidates
    // go into the one batch lookup so it stays a single query.
    siblingPaths: (path) => [path, join(dirname(path), 'summary.json')],
  }),
}
