import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentQuotaWire, QuotaWindowWire } from '@podium/protocol'

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

  const weeklyPercent =
    typeof cfg.creditUsagePercent === 'number' && Number.isFinite(cfg.creditUsagePercent)
      ? cfg.creditUsagePercent
      : undefined
  const periodType = cfg.currentPeriod?.type?.trim().toUpperCase()
  if (weeklyPercent !== undefined && (!periodType || periodType.includes('WEEKLY'))) {
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
  deps: { homeDir?: string; now?: number; fetchImpl?: typeof fetch } = {},
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
