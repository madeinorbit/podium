import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentQuotaWire, QuotaWindowWire } from '@podium/model'

/** Private Build CLI billing surface used by Grok's `/usage` slash command. */
const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing'

export interface GrokBillingResponse {
  config?: {
    monthlyLimit?: { val?: number }
    used?: { val?: number }
    onDemandCap?: { val?: number }
    billingPeriodStart?: string
    billingPeriodEnd?: string
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

/** used / limit as 0..100, one decimal (same rounding as Claude). */
function usedPercent(used: number, limit: number): number {
  if (limit <= 0) return 0
  return Math.round(Math.min(100, Math.max(0, (used / limit) * 100)) * 10) / 10
}

function windowMinutesFromPeriod(startIso: string | undefined, endIso: string | undefined): number {
  if (!startIso || !endIso) return 0
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  return Math.max(1, Math.round((end - start) / 60_000))
}

/**
 * Map Grok Build's monthly credit pool to a single quota window.
 * SuperGrok multi-product weekly pools and public API RPS/TPM are out of scope.
 */
export function parseGrokBilling(body: GrokBillingResponse): QuotaWindowWire[] {
  const cfg = body.config
  if (!cfg) return []
  const limit = moneyVal(cfg.monthlyLimit)
  if (limit === undefined || limit <= 0) return []
  const used = moneyVal(cfg.used) ?? 0
  const resetsAt =
    typeof cfg.billingPeriodEnd === 'string' && cfg.billingPeriodEnd.trim()
      ? cfg.billingPeriodEnd.trim()
      : ''
  return [
    {
      key: 'monthly',
      label: 'Monthly',
      usedPercent: usedPercent(used, limit),
      resetsAt,
      windowMinutes: windowMinutesFromPeriod(cfg.billingPeriodStart, cfg.billingPeriodEnd),
    },
  ]
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

  try {
    const res = await fetchImpl(BILLING_URL, {
      headers: {
        Authorization: `Bearer ${entry.key}`,
        Accept: 'application/json',
        'User-Agent': 'podium-daemon/1.0',
      },
    })
    if (res.status === 401) {
      return {
        ...withAcct,
        status: 'expired',
        error: 'token expired (refreshes on next Grok use)',
      }
    }
    if (!res.ok) return { ...withAcct, status: 'error', error: `billing endpoint ${res.status}` }
    const body = (await res.json()) as GrokBillingResponse
    return { ...withAcct, status: 'ok', windows: parseGrokBilling(body) }
  } catch (e) {
    return { ...withAcct, status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}
