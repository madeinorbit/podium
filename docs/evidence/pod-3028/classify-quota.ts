/**
 * Read-only quota window classifier for POD-3028.
 *
 * Uses the production usage seam from apps/daemon/src/quota-claude.ts:
 * GET https://api.anthropic.com/api/oauth/usage with an unexpired access token.
 * Does not launch Claude, does not copy credentials, and does not refresh OAuth.
 * Skips the GET when the access token is expired or inside the ten-minute floor.
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const now = Date.now()
const credPath = join(homedir(), '.claude', '.credentials.json')

if (!existsSync(credPath)) {
  console.log(
    JSON.stringify(
      {
        at: new Date(now).toISOString(),
        classification: 'oauth-missing; usage GET skipped; no Claude launch; no refresh',
        credential: { path: credPath, exists: false },
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const st = statSync(credPath)
const raw = JSON.parse(await Bun.file(credPath).text()) as {
  claudeAiOauth?: {
    accessToken?: string
    expiresAt?: number
    refreshToken?: string
    refreshTokenExpiresAt?: number
    subscriptionType?: string
    rateLimitTier?: string
    scopes?: string[]
  }
}
const oauth = raw.claudeAiOauth ?? {}
const token = oauth.accessToken
const expiresAt = oauth.expiresAt
const credential = {
  path: credPath,
  mtime: st.mtime.toISOString(),
  mode: st.mode.toString(8),
  sizeBytes: st.size,
  subscriptionType: oauth.subscriptionType ?? null,
  rateLimitTier: oauth.rateLimitTier ?? null,
  scopes: Array.isArray(oauth.scopes) ? oauth.scopes : null,
  expiresAtIso: typeof expiresAt === 'number' ? new Date(expiresAt).toISOString() : null,
  refreshTokenExpiresAtIso:
    typeof oauth.refreshTokenExpiresAt === 'number'
      ? new Date(oauth.refreshTokenExpiresAt).toISOString()
      : null,
  expired: typeof expiresAt === 'number' ? expiresAt <= now : null,
  remainingMinutes: typeof expiresAt === 'number' ? Math.round((expiresAt - now) / 60_000) : null,
  insideTenMinuteFloor: typeof expiresAt === 'number' ? expiresAt <= now + 600_000 : null,
  hasAccessToken: typeof token === 'string' && token.length > 0,
  hasRefreshToken: typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0,
}

const base = {
  at: new Date(now).toISOString(),
  seam: 'GET https://api.anthropic.com/api/oauth/usage (apps/daemon/src/quota-claude.ts)',
  credential,
}

if (typeof expiresAt !== 'number' || !token || expiresAt <= now) {
  console.log(
    JSON.stringify(
      {
        ...base,
        classification: 'oauth-expired-or-missing; usage GET skipped; no Claude launch; no refresh',
        usage: null,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}
if (expiresAt <= now + 600_000) {
  console.log(
    JSON.stringify(
      {
        ...base,
        classification: 'oauth-inside-ten-minute-floor; usage GET skipped; no Claude launch; no refresh',
        usage: null,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const res = await fetch(USAGE_URL, {
  headers: {
    authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'user-agent': 'claude-code/2.1.0',
  },
})

if (res.status === 401) {
  console.log(
    JSON.stringify(
      {
        ...base,
        usageHttpStatus: 401,
        classification: 'usage-401; treat as oauth-expired; no refresh attempted',
        usage: null,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}
if (!res.ok) {
  console.log(
    JSON.stringify(
      {
        ...base,
        usageHttpStatus: res.status,
        classification: `usage-endpoint-${res.status}; cannot classify quota`,
        usage: null,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const body = (await res.json()) as Record<string, unknown>
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const windows: Array<{
  kind: string | null
  group: string | null
  percent: number
  resetsAt: string | null
  labels: string[]
  severity: string | null
  isActive: boolean | null
}> = []
if (Array.isArray(body.limits)) {
  for (const rawLimit of body.limits) {
    if (!isRecord(rawLimit)) continue
    const percent = rawLimit.percent
    if (typeof percent !== 'number' || !Number.isFinite(percent)) continue
    const labels: string[] = []
    if (isRecord(rawLimit.scope)) {
      for (const value of Object.values(rawLimit.scope)) {
        if (isRecord(value) && stringField(value.display_name)) labels.push(value.display_name)
      }
    }
    windows.push({
      kind: stringField(rawLimit.kind) ?? null,
      group: stringField(rawLimit.group) ?? null,
      percent: Math.round(percent * 10) / 10,
      resetsAt: stringField(rawLimit.resets_at) ?? null,
      labels,
      severity: stringField(rawLimit.severity) ?? null,
      isActive: typeof rawLimit.is_active === 'boolean' ? rawLimit.is_active : null,
    })
  }
}

const spend = isRecord(body.spend) ? body.spend : null
const extra = isRecord(body.extra_usage) ? body.extra_usage : null
const spendPercent = typeof spend?.percent === 'number' ? spend.percent : null
const spendLimitReached = extra?.spend_limit_reached === true
const monthlyExhausted = spendPercent !== null && spendPercent >= 100 || spendLimitReached
const exhausted = windows.filter((window) => window.percent >= 100)
const monthly = windows.filter((window) => /month|spend/i.test(`${window.kind} ${window.group}`))
const weekly = windows.filter((window) => /week/i.test(`${window.kind} ${window.group}`))

let classification: string
if (monthlyExhausted) {
  classification = 'claude-monthly-spend-exhausted; oauth unexpired'
} else if (weekly.some((window) => window.percent >= 100)) {
  classification = 'claude-weekly-quota-exhausted; monthly-spend-not-exhausted; oauth unexpired'
} else if (exhausted.length > 0) {
  classification = 'some-limit-at-100; monthly-spend-not-exhausted; oauth unexpired'
} else {
  classification =
    'provider-quota-not-exhausted; honest window classification; do not manufacture a failure'
}

const pick = (value: unknown) => {
  if (!isRecord(value)) return value
  const next: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (/token|secret|authorization|key/i.test(key)) continue
    next[key] = entry
  }
  return next
}

console.log(
  JSON.stringify(
    {
      ...base,
      usageHttpStatus: res.status,
      classification,
      exhaustedWindows: exhausted,
      monthlyWindows: monthly,
      weeklyWindows: weekly,
      usage: {
        windowCount: windows.length,
        windows,
        fiveHour: pick(body.five_hour),
        sevenDay: pick(body.seven_day),
        extraUsage: pick(extra),
        spend: pick(spend),
        topLevelKeys: Object.keys(body).sort(),
      },
    },
    null,
    2,
  ),
)
