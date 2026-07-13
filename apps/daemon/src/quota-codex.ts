import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentQuotaWire, QuotaWindowWire } from '@podium/protocol'

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
  deps: { homeDir?: string; now?: number; fetchImpl?: typeof fetch } = {},
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
